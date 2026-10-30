import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { unlinkSync } from 'node:fs';
import { AuditBudget, AuditWriteSkipped, withAuditLock } from '../events/boundedAudit.js';
import { Ingestor } from '../events/ingest.js';
import { rootEventsPath } from '../events/paths.js';
import { assertAssetStoreDirectoryIdentity, captureAssetStoreDirectoryIdentity, ensureAssetStoreDirectory, readRegularBuffer, readUtf8Regular, regularFileFingerprint, replaceUtf8Durable, syncUtf8Regular } from './assetStoreStorage.js';
import { RootOperationError, rootOperationRequestHash, snapshotRootOperation, validateRootOperationReceipt, validateRootOperationTicket } from '../events/rootEventOperations.js';
import { ProtectedAuditUnavailableError } from '../events/protectedAuditRpc.js';
import { ExperienceError, ExperienceLibrary } from './experience.js';
import { ExperienceActivityReturns } from './experienceActivityReturns.js';
import { stableJson } from '../util/durableJournal.js';
import { fitsRootEventLine } from '../events/eventStore.js';
function activityAudit(row, human, legacy = false) {
    // Commit to the full projection without copying check codes or input/output into the root log.
    const activityDigest = createHash('sha256').update(JSON.stringify({ row, human })).digest('hex');
    return { type: 'experience.activity', payload: { ...row, input: undefined, output: undefined, code: undefined,
            ...(legacy ? {} : { activityDigest }) },
        actor: human ? { kind: 'human', id: 'local-experience-user' } : { kind: 'machine', id: row.client?.connectionId ?? 'experience-tool' },
        human: { title: `experience ${row.kind}`, severity: 'info' } };
}
const FILE_LIMIT = 16 * 1024 * 1024;
const RUNTIMES = new Set(['claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'kiro', 'workbuddy', 'deepseek-harness', 'openclaw', 'gemini-cli']);
const safeText = (value, max) => {
    if (typeof value !== 'string' || value.length > max || value.includes('\0'))
        throw new ExperienceError('INPUT_INVALID', '填写的内容过长或格式不正确。');
    return value.trim();
};
function client(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['cli', 'mcp_stdio'].includes(value.transport) || typeof value.connectionId !== 'string'
        || !value.connectionId || value.connectionId.length > 160 || typeof value.clientName !== 'string') {
        throw new ExperienceError('CLIENT_INVALID', '检查调用没有有效会话。');
    }
    return { connectionId: value.connectionId, transport: value.transport,
        clientName: /^[\w .:/-]{1,80}$/.test(value.clientName) ? value.clientName : 'MCP client',
        ...(value.runtime && RUNTIMES.has(value.runtime) ? { runtime: value.runtime } : {}),
    };
}
function sameCode(expected, actual) {
    const a = Buffer.from(expected), b = Buffer.from(actual);
    return a.length === b.length && timingSafeEqual(a, b);
}
function dateOutput(values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 100)
        throw new ExperienceError('INPUT_INVALID', '日期示例需要 1 到 100 条日期。');
    return values.map(value => {
        const text = safeText(value, 32), match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
        if (!match)
            throw new ExperienceError('INPUT_INVALID', '示例只能包含年月日。');
        const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (year < 1900 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
            throw new ExperienceError('INPUT_INVALID', '示例里有无效日期。');
        return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }).sort();
}
function validRecord(row) {
    const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
    if (!row || !uuid(row.id) || !text(row.at, 40) || !Number.isFinite(Date.parse(row.at))
        || (row.hostIdentityVerified !== undefined && row.hostIdentityVerified !== false))
        return false;
    if (row.client && (!text(row.client.connectionId, 160) || !row.client.connectionId
        || !['cli', 'mcp_stdio'].includes(row.client.transport) || !text(row.client.clientName, 80)
        || (row.client.runtime !== undefined && !RUNTIMES.has(row.client.runtime))))
        return false;
    const assets = () => Array.isArray(row.assetIds) && row.assetIds.length <= 5
        && row.assetIds.every(id => typeof id === 'string' && /^sha256:[a-f0-9]{64}$/.test(id));
    switch (row.kind) {
        case 'check_requested': return uuid(row.code) && Number.isSafeInteger(row.expiresAt) && RUNTIMES.has(row.runtime ?? '');
        case 'check_received': return uuid(row.code) && RUNTIMES.has(row.runtime ?? '') && !!row.client && row.hostIdentityVerified === false;
        case 'task_requested':
            if (!uuid(row.taskId) || row.taskId !== row.id || !text(row.title, 300) || !row.title || !text(row.query, 300) || !row.query)
                return false;
            if (row.validator === undefined)
                return row.input === undefined;
            if (row.validator !== 'iso-date-sort.v1')
                return false;
            try {
                dateOutput(row.input);
                return true;
            }
            catch {
                return false;
            }
        case 'delivered': return uuid(row.deliveryId) && row.deliveryId === row.id && assets() && text(row.query, 300)
            && !!row.client && (row.taskId === undefined || uuid(row.taskId));
        case 'use_reported': return uuid(row.deliveryId) && uuid(row.taskId) && assets()
            && (row.assetIds?.length === 1 || row.assetIds?.length === 0 && row.outcome === 'unused' && row.validation === 'not_requested')
            && !!row.client && ['success', 'failed', 'unused'].includes(row.outcome ?? '')
            && ['not_requested', 'passed', 'failed'].includes(row.validation ?? '') && row.usageEvidence === 'application_report'
            && row.hostIdentityVerified === false && (row.output === undefined || (Array.isArray(row.output) && row.output.length <= 100 && row.output.every(value => text(value, 32))));
        default: return false;
    }
}
function parseActivityRecords(raw) {
    const rows = [], identities = new Set();
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            throw new ExperienceError('ACTIVITY_INVALID', '调用记录不完整，请检查本地经验库。');
        }
        if (!validRecord(row) || identities.has(row.id)) {
            throw new ExperienceError('ACTIVITY_INVALID', '调用记录不完整或重复，请检查本地经验库。');
        }
        rows.push(row);
        identities.add(row.id);
    }
    return rows;
}
function removeCommittedPending(path, directory, fingerprint) {
    try {
        assertAssetStoreDirectoryIdentity(dirname(path), directory);
        if (regularFileFingerprint(path) !== fingerprint)
            throw new Error('pending identity changed');
        unlinkSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw new ExperienceError('ACTIVITY_CLEANUP_PENDING', '操作记录已保存，但恢复文件清理失败；请检查目录权限后再试。');
    }
}
/** Read-only recovery witness; shares the transaction's exact journal/ticket validation. */
export function readExperienceActivityPending(baseDir) {
    const path = join(baseDir, 'experience-activity.pending.json'), fingerprint = regularFileFingerprint(path);
    const raw = readUtf8Regular(path, 64 * 1024);
    if (regularFileFingerprint(path) !== fingerprint)
        throw new ExperienceError('ACTIVITY_INVALID', '待恢复的调用记录在读取期间发生变化。');
    if (raw === null)
        return;
    return parseActivityPending(raw);
}
function parseActivityPending(raw) {
    let pending;
    try {
        pending = JSON.parse(raw);
    }
    catch {
        throw new ExperienceError('ACTIVITY_INVALID', '待恢复的调用记录不完整。');
    }
    if (!pending || ![1, 2].includes(pending.schema) || typeof pending.human !== 'boolean'
        || (pending.audited !== undefined && typeof pending.audited !== 'boolean') || !validRecord(pending.row)) {
        throw new ExperienceError('ACTIVITY_INVALID', '待恢复的调用记录不完整。');
    }
    if (pending.schema === 1 && [pending.operationId, pending.auditPath, pending.requestHash, pending.legacyActivityId, pending.ticket, pending.receipt]
        .some(value => value !== undefined))
        throw new ExperienceError('ACTIVITY_INVALID', '旧恢复文件包含无法验证的审计信息。');
    if (pending.schema === 2) {
        try {
            const raw = activityAudit(pending.row, pending.human, pending.legacyActivityId !== undefined);
            if (pending.operationId !== `experience-activity-${pending.row.id}` || typeof pending.auditPath !== 'string'
                || !isAbsolute(pending.auditPath) || resolve(pending.auditPath) !== pending.auditPath
                || pending.requestHash !== rootOperationRequestHash(snapshotRootOperation(raw))
                || (pending.legacyActivityId !== undefined && pending.legacyActivityId !== pending.row.id))
                throw new Error('pending binding invalid');
            if (pending.ticket !== undefined)
                validateRootOperationTicket(pending.ticket, raw, pending.operationId);
            if (pending.receipt !== undefined && pending.ticket === undefined)
                throw new Error('receipt without namespace ticket');
            if (pending.receipt !== undefined)
                validateRootOperationReceipt(pending.receipt, raw, { operationId: pending.operationId, ...(pending.legacyActivityId ? { legacyActivityId: pending.legacyActivityId } : {}) });
        }
        catch {
            throw new ExperienceError('ACTIVITY_INVALID', '待恢复操作的审计绑定或回执不一致。');
        }
    }
    return pending;
}
function parseActivityReturn(raw) {
    const intent = parseActivityPending(raw);
    if (intent.schema !== 2 || !intent.ticket || !intent.receipt)
        throw new ExperienceError('ACTIVITY_INVALID', '恢复交接缺少原审计授权或回执。');
    return intent;
}
/** Only an exact known, still-unclaimed operation authorizes caller recovery. */
export function readExperienceActivityRecovery(baseDir, operationId) {
    const pending = readExperienceActivityPending(baseDir);
    if (pending?.operationId === operationId)
        return pending;
    const saved = new ExperienceActivityReturns(baseDir, parseActivityReturn).lookup(operationId);
    return saved?.state === 'awaiting_return' ? saved.intent : undefined;
}
function activityPendingError(error) {
    const reason = error instanceof RootOperationError ? error.reason
        : error instanceof ProtectedAuditUnavailableError ? error.reason.replace(/^root_operation_/, '') : undefined;
    if (reason === 'legacy_history_unknown' || reason === 'namespace_missing' || reason === 'namespace_changed') {
        return new ExperienceError('ACTIVITY_RECOVERY_UNVERIFIED', '无法确认原来的审计记录；恢复意图已保留，请联系维护者核对原审计目录和回执，不要重复创建。');
    }
    return new ExperienceError('ACTIVITY_PENDING', `这次操作已有恢复意图，但审计或显示记录没有写完；下次操作会恢复，请先核对，不要重复创建。${error instanceof Error ? ` (${error.message})` : ''}`);
}
/** Receipts are actual local tool operations, not configuration checks or authenticated vendor identities. */
export class ExperienceActivity {
    baseDir;
    audit;
    path;
    now;
    constructor(baseDir, audit, now = Date.now) {
        this.baseDir = baseDir;
        this.audit = audit;
        this.path = join(baseDir, 'experience-activity.jsonl');
        this.now = now;
    }
    records() {
        return parseActivityRecords(readUtf8Regular(this.path, FILE_LIMIT) ?? '');
    }
    async transaction(operation) {
        let entered = false, returnIdentity;
        try {
            ensureAssetStoreDirectory(this.baseDir);
            const budget = new AuditBudget({ deadlineAt: Date.now() + 500 });
            const directory = captureAssetStoreDirectoryIdentity(this.baseDir);
            const returns = new ExperienceActivityReturns(this.baseDir, parseActivityReturn);
            // Both witnesses belong to this invocation, not every equal historical request.
            const admitted = this.pending(), repairing = returns.rollbackPending(directory);
            // A readonly SELECT cannot settle a hot rollback journal. Recover it only after lock admission.
            const observed = repairing ? [] : returns.awaiting(budget, directory);
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
            budget.check();
            return await withAuditLock(join(this.baseDir, '.experience-activity.lock'), budget, () => {
                entered = true;
                return returns.withSession(directory, async (returns) => {
                    const context = { directory, pendingFingerprint: 'missing', returns, candidates: new Map(), verified: new Map() };
                    assertAssetStoreDirectoryIdentity(this.baseDir, directory);
                    const current = await this.recoverPending(context);
                    const records = this.records();
                    const add = (intent) => {
                        const committed = records.find(row => row.id === intent.row.id), previous = context.candidates.get(intent.row.id);
                        if (!committed || JSON.stringify(committed) !== JSON.stringify(intent.row)
                            || previous && stableJson(previous) !== stableJson(intent))
                            throw new ExperienceError('ACTIVITY_INVALID', '待领取的恢复回执与已有记录不一致。');
                        context.candidates.set(intent.row.id, intent);
                    };
                    // The caller's exact admission witnesses precede equal intents that arrived later.
                    for (const prior of [...(admitted ? [admitted] : []), ...observed]) {
                        const saved = returns.lookup(`experience-activity-${prior.row.id}`, directory)?.intent;
                        if (!saved || JSON.stringify(saved.row) !== JSON.stringify(prior.row) || saved.human !== prior.human
                            || prior.ticket && stableJson(saved.ticket) !== stableJson(prior.ticket)
                            || prior.receipt && stableJson(saved.receipt) !== stableJson(prior.receipt))
                            throw new ExperienceError('ACTIVITY_INVALID', '本次准入观察到的恢复意图缺少一致的领取回执。');
                        add(saved);
                    }
                    if (current)
                        add(context.verified.get(current.id));
                    for (const intent of returns.awaiting(undefined, directory))
                        add(intent);
                    const terminal = new Set();
                    let result, terminalError;
                    try {
                        result = await operation([...context.candidates.values()].map(intent => intent.row), (row, human = false) => {
                            if (repairing) {
                                const identities = [...context.candidates.values()].map(intent => intent.operationId).join(', ');
                                throw new ExperienceError('ACTIVITY_RETURN_UNCONFIRMED', `交接账本已恢复，但本次没有写入新的活动记录；请先核对原活动 ID，再取回原结果，不要重新创建。${identities ? ` (${identities})` : ''}`);
                            }
                            return this.append(row, human, context);
                        }, row => { terminal.add(row.id); });
                    }
                    catch (error) {
                        if (!(error instanceof ExperienceError) || error.code !== 'DELIVERY_RECOVERED' || !terminal.size)
                            throw error;
                        terminalError = error;
                    }
                    this.checkTransaction(context);
                    const returned = result && typeof result === 'object' ? result : undefined;
                    const id = returned?.id ?? returned?.deliveryId;
                    if (id) {
                        terminal.add(id);
                        const intended = context.verified.get(id) ?? context.candidates.get(id);
                        if (intended)
                            returnIdentity = intended.operationId;
                    }
                    for (const identity of terminal) {
                        const intent = context.verified.get(identity) ?? context.candidates.get(identity);
                        if (!intent)
                            continue; // A normal, already acknowledged check/report has no new handoff.
                        returnIdentity ??= intent.operationId;
                        await this.verifyReturn(intent, context);
                        this.checkTransaction(context);
                        returns.acknowledge(intent, directory);
                        this.checkTransaction(context);
                    }
                    if (terminalError) {
                        returnIdentity = undefined;
                        throw terminalError;
                    }
                    return result;
                });
            });
        }
        catch (error) {
            if (returnIdentity && !(error instanceof ExperienceError && error.code === 'ACTIVITY_RECOVERY_UNVERIFIED')) {
                throw new ExperienceError('ACTIVITY_RETURN_UNCONFIRMED', `原操作 ${returnIdentity} 的恢复回执已保存，但返回或清理未能确认；请核对该记录，不要重新创建。${error instanceof Error ? ` (${error.message})` : ''}`);
            }
            if (!entered && error instanceof AuditWriteSkipped && error.reason === 'cancelled_or_expired') {
                // This invocation never entered recovery or allocated a new operation.
                // Cleanup/transport errors and any post-entry failure remain terminal.
                throw new ExperienceError('ACTIVITY_NOT_ADMITTED', '这次操作尚未开始，可保持原请求重试。 (audit skipped: cancelled_or_expired)');
            }
            throw error;
        }
    }
    checkTransaction(context) {
        assertAssetStoreDirectoryIdentity(this.baseDir, context.directory);
        if (regularFileFingerprint(join(this.baseDir, 'experience-activity.pending.json')) !== context.pendingFingerprint) {
            throw new ExperienceError('ACTIVITY_INVALID', '恢复文件在操作结束前发生变化。');
        }
    }
    async verifyReturn(intent, context) {
        const current = context.verified.get(intent.row.id);
        if (current && stableJson(current) === stableJson(intent))
            return;
        this.checkTransaction(context);
        const fingerprint = regularFileFingerprint(this.path), projection = this.projection(intent.row, intent.legacyActivityId !== undefined);
        if (!projection.committed || regularFileFingerprint(this.path) !== fingerprint)
            throw new ExperienceError('ACTIVITY_INVALID', '待领取的恢复记录已变化。');
        const audit = this.audit ?? new Ingestor({ path: rootEventsPath() });
        if (typeof audit.ingestIdempotent !== 'function' || typeof audit.path !== 'string' || resolve(audit.path) !== intent.auditPath) {
            throw new ExperienceError('ACTIVITY_RECOVERY_UNVERIFIED', '待领取操作的原审计目录或写入器已变化。');
        }
        try {
            const raw = activityAudit(intent.row, intent.human, intent.legacyActivityId !== undefined);
            const admission = { operationId: intent.operationId, namespaceId: intent.ticket.namespaceId, deadlineAt: Date.now() + 500,
                ...(intent.legacyActivityId ? { legacyActivityId: intent.legacyActivityId } : {}) };
            const receipt = validateRootOperationReceipt(await audit.ingestIdempotent(raw, admission), raw, admission);
            if (JSON.stringify(receipt) !== JSON.stringify(intent.receipt))
                throw new ExperienceError('ACTIVITY_INVALID', '待领取操作的根回执已变化。');
            this.checkTransaction(context);
            syncUtf8Regular(this.path, projection.raw, { expectedFingerprint: fingerprint, expectedDirectory: context.directory });
            context.verified.set(intent.row.id, intent);
        }
        catch (error) {
            throw activityPendingError(error);
        }
    }
    pending(context) {
        const path = join(this.baseDir, 'experience-activity.pending.json');
        if (context)
            assertAssetStoreDirectoryIdentity(this.baseDir, context.directory);
        const fingerprint = regularFileFingerprint(path), pending = readExperienceActivityPending(this.baseDir);
        if (regularFileFingerprint(path) !== fingerprint)
            throw new ExperienceError('ACTIVITY_INVALID', '待恢复的调用记录在读取期间发生变化。');
        if (context) {
            assertAssetStoreDirectoryIdentity(this.baseDir, context.directory);
            context.pendingFingerprint = fingerprint;
        }
        return pending;
    }
    async recoverPending(context) {
        const pending = this.pending(context);
        if (!pending)
            return;
        return this.append(pending.row, pending.human, context, pending);
    }
    projection(row, legacy) {
        const bytes = readRegularBuffer(this.path, FILE_LIMIT) ?? Buffer.alloc(0);
        let raw = bytes.toString('utf8'), records;
        try {
            records = parseActivityRecords(raw);
        }
        catch (error) {
            const last = bytes.lastIndexOf(10), suffix = bytes.subarray(last + 1), expected = Buffer.from(`${JSON.stringify(row)}\n`);
            if (!legacy || !suffix.length || suffix.length >= expected.length || !expected.subarray(0, suffix.length).equals(suffix))
                throw error;
            // Upgrade only the precise old appender's incomplete suffix. Unknown bytes are preserved.
            raw = bytes.subarray(0, last + 1).toString('utf8');
            records = parseActivityRecords(raw);
        }
        const committed = records.find(item => item.id === row.id);
        if (committed && JSON.stringify(committed) !== JSON.stringify(row))
            throw new ExperienceError('ACTIVITY_INVALID', '待恢复操作与已有记录不一致。');
        return { raw, ...(committed ? { committed } : {}) };
    }
    async append(row, human, context, pending) {
        const { directory } = context;
        assertAssetStoreDirectoryIdentity(this.baseDir, directory);
        const pendingPath = join(this.baseDir, 'experience-activity.pending.json');
        if (regularFileFingerprint(pendingPath) !== context.pendingFingerprint)
            throw new ExperienceError('ACTIVITY_INVALID', '待恢复的调用记录已变化。');
        row = JSON.parse(JSON.stringify(row));
        if (!validRecord(row))
            throw new ExperienceError('ACTIVITY_INVALID', '调用信息不完整，没有保存记录。');
        const legacy = pending?.schema === 1 || pending?.legacyActivityId !== undefined;
        const projectionFingerprint = regularFileFingerprint(this.path);
        // The projection parser validates existing bytes before any new intent or audit.
        const projection = this.projection(row, legacy);
        if (regularFileFingerprint(this.path) !== projectionFingerprint)
            throw new ExperienceError('ACTIVITY_INVALID', '操作记录在读取期间发生变化。');
        const line = `${JSON.stringify(row)}\n`;
        const separator = projection.raw && !projection.raw.endsWith('\n') ? '\n' : '';
        const contents = projection.committed ? projection.raw : `${projection.raw}${separator}${line}`;
        if (Buffer.byteLength(contents) > FILE_LIMIT)
            throw new ExperienceError('ACTIVITY_FULL', '记录达到本地读取上限，请先归档。');
        const audit = this.audit ?? new Ingestor({ path: rootEventsPath() });
        if (typeof audit.prepareIdempotent !== 'function' || typeof audit.ingestIdempotent !== 'function' || typeof audit.path !== 'string') {
            throw new ExperienceError('ACTIVITY_AUDIT_UNSUPPORTED', '审计写入器不支持安全恢复，请更新写入器后重试。');
        }
        const auditPath = resolve(audit.path), operationId = `experience-activity-${row.id}`, raw = activityAudit(row, human, legacy);
        if (pending?.schema === 2 && pending.auditPath !== auditPath)
            throw new ExperienceError('ACTIVITY_INVALID', '待恢复操作的审计目录已变化，请先恢复原目录。');
        const requestHash = rootOperationRequestHash(snapshotRootOperation(raw));
        if (!pending && !fitsRootEventLine({ ...raw, auditOperationId: operationId, auditRequestHash: requestHash })) {
            throw new ExperienceError('INPUT_INVALID', '内容写入审计记录后过长，请缩短任务或查询内容。');
        }
        const journal = { schema: 2, row, human, operationId, auditPath,
            requestHash, ...(legacy ? { legacyActivityId: row.id } : {}),
            ...(pending?.ticket ? { ticket: pending.ticket } : {}), ...(pending?.receipt ? { receipt: pending.receipt } : {}) };
        const checkpoint = (value) => {
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
            const contents = JSON.stringify(value);
            replaceUtf8Durable(pendingPath, contents, { expectedDirectory: directory, expectedFingerprint: context.pendingFingerprint });
            const fingerprint = regularFileFingerprint(pendingPath);
            if (readUtf8Regular(pendingPath, 64 * 1024) !== contents || regularFileFingerprint(pendingPath) !== fingerprint) {
                throw new ExperienceError('ACTIVITY_INVALID', '恢复文件在保存后发生变化。');
            }
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
            context.pendingFingerprint = fingerprint;
        };
        if (!pending || pending.schema === 1)
            checkpoint(journal);
        try {
            const admission = { operationId, deadlineAt: Date.now() + 500, ...(legacy ? { legacyActivityId: row.id } : {}) };
            let ticket = pending?.ticket;
            if (!ticket) {
                ticket = validateRootOperationTicket(await audit.prepareIdempotent(raw, admission), raw, operationId);
                // No audit dispatch is possible until the namespace authority is durable here.
                checkpoint({ ...journal, ticket });
            }
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
            if (regularFileFingerprint(pendingPath) !== context.pendingFingerprint)
                throw new ExperienceError('ACTIVITY_INVALID', '恢复文件在审计前发生变化。');
            const receipt = validateRootOperationReceipt(await audit.ingestIdempotent(raw, { ...admission, namespaceId: ticket.namespaceId }), raw, admission);
            if (pending?.receipt && JSON.stringify(receipt) !== JSON.stringify(pending.receipt))
                throw new ExperienceError('ACTIVITY_INVALID', '审计返回的操作回执已变化。');
            checkpoint({ ...journal, ticket, receipt });
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
            if (projection.committed)
                syncUtf8Regular(this.path, contents, { expectedFingerprint: projectionFingerprint, expectedDirectory: directory });
            else
                replaceUtf8Durable(this.path, contents, { expectedFingerprint: projectionFingerprint, expectedDirectory: directory });
            const complete = parseActivityReturn(JSON.stringify({ ...journal, ticket, receipt }));
            context.returns.save(complete, directory);
            context.verified.set(row.id, complete);
        }
        catch (error) {
            throw activityPendingError(error);
        }
        removeCommittedPending(pendingPath, directory, context.pendingFingerprint);
        context.pendingFingerprint = 'missing';
        return row;
    }
    async startCheck(runtime) {
        if (!RUNTIMES.has(runtime))
            throw new ExperienceError('INPUT_INVALID', '请选择已支持的应用。');
        return this.transaction(async (candidates, append, terminal) => {
            for (const row of candidates)
                if (row.kind === 'check_requested' && row.runtime === runtime
                    && row.expiresAt !== undefined && this.now() >= row.expiresAt)
                    terminal(row);
            const recovered = candidates.find(row => row.kind === 'check_requested' && row.runtime === runtime
                && row.expiresAt !== undefined && this.now() < row.expiresAt);
            if (recovered)
                return recovered;
            return append({ id: randomUUID(), kind: 'check_requested', at: new Date(this.now()).toISOString(),
                code: randomUUID(), expiresAt: this.now() + 15 * 60_000, runtime }, true);
        });
    }
    async check(code, source) {
        code = safeText(code, 100);
        source = client(source);
        return this.transaction(async (_recovered, append) => {
            const records = this.records();
            const challenge = records.findLast(row => row.kind === 'check_requested' && row.code && sameCode(row.code, code));
            const previous = records.findLast(row => row.kind === 'check_received' && row.code === code);
            if (!challenge || !challenge.expiresAt || (!previous && this.now() >= challenge.expiresAt))
                throw new ExperienceError('CHECK_EXPIRED', '检查码没有找到或已经过期，请重新检查。');
            if (source.runtime !== challenge.runtime)
                throw new ExperienceError('RUNTIME_MISMATCH', '检查码不是为这个应用生成的。');
            if (previous) {
                if (previous.client?.connectionId !== source.connectionId || previous.client.transport !== source.transport) {
                    throw new ExperienceError('CHECK_USED', '这个检查码已在其他会话使用，请重新生成。');
                }
                return previous;
            }
            return append({ id: randomUUID(), kind: 'check_received', at: new Date(this.now()).toISOString(), code,
                runtime: challenge.runtime, client: source, hostIdentityVerified: false });
        });
    }
    async startTask(title, query, validationInput) {
        title = safeText(title, 300);
        query = safeText(query, 300);
        if (!title || !query)
            throw new ExperienceError('INPUT_INVALID', '请填写任务和查询关键词。');
        if (validationInput !== undefined) {
            if (!Array.isArray(validationInput))
                throw new ExperienceError('INPUT_INVALID', '日期示例需要有效数组。');
            validationInput = Array.from(validationInput, value => safeText(value, 32));
            dateOutput(validationInput);
        }
        return this.transaction(async (candidates, append) => {
            const recovered = candidates.find(row => row.kind === 'task_requested' && row.title === title && row.query === query
                && JSON.stringify(row.input ?? null) === JSON.stringify(validationInput ?? null));
            if (recovered)
                return recovered;
            const id = randomUUID();
            return append({ id, taskId: id, kind: 'task_requested', at: new Date(this.now()).toISOString(), title, query,
                ...(validationInput ? { validator: 'iso-date-sort.v1', input: validationInput } : {}) }, true);
        });
    }
    async search(query, source, taskId) {
        source = client(source);
        query = safeText(query, 300);
        return this.transaction(async (candidates, append, terminal) => {
            if (taskId) {
                const task = this.records().find(row => row.kind === 'task_requested' && row.taskId === taskId);
                if (!task)
                    throw new ExperienceError('TASK_NOT_FOUND', '没有找到这次任务。');
                if (task.query !== query)
                    throw new ExperienceError('TASK_QUERY_MISMATCH', '查询关键词与这次任务不一致；请使用任务中的关键词，或重新创建任务。');
            }
            const items = await new ExperienceLibrary(this.baseDir).search(query, 5);
            const recovered = candidates.find(row => row.kind === 'delivered' && row.query === query && row.taskId === taskId
                && row.client?.connectionId === source.connectionId && row.client.transport === source.transport
                && row.client.runtime === source.runtime);
            if (recovered) {
                if (JSON.stringify(items.map(item => item.assetId)) !== JSON.stringify(recovered.assetIds)) {
                    terminal(recovered);
                    throw new ExperienceError('DELIVERY_RECOVERED', '上次查询记录已恢复，但可用经验已变化，请重新查询。');
                }
                return { items, deliveryId: recovered.deliveryId };
            }
            const deliveryId = randomUUID();
            await append({ id: deliveryId, deliveryId, kind: 'delivered', at: new Date(this.now()).toISOString(),
                query: safeText(query, 300), assetIds: items.map(item => item.assetId), client: source, ...(taskId ? { taskId } : {}) });
            return { items, deliveryId };
        });
    }
    async report(deliveryId, assetId, taskId, outcome, source, output) {
        source = client(source);
        if (!['success', 'failed', 'unused'].includes(outcome))
            throw new ExperienceError('INPUT_INVALID', '使用结果不正确。');
        if (output !== undefined) {
            if (!Array.isArray(output) || output.length > 100)
                throw new ExperienceError('INPUT_INVALID', '回报结果过长或格式不正确。');
            output = output.map(value => safeText(value, 32));
        }
        return this.transaction(async (_recovered, append) => {
            const rows = this.records();
            const delivery = rows.findLast(row => row.kind === 'delivered' && row.deliveryId === deliveryId);
            const task = rows.findLast(row => row.kind === 'task_requested' && row.taskId === taskId);
            const empty = delivery?.assetIds?.length === 0 && assetId === '' && outcome === 'unused';
            if (!delivery || !task || delivery.taskId !== taskId || delivery.query !== task.query || delivery.client?.connectionId !== source.connectionId
                || delivery.client.transport !== source.transport || delivery.client.runtime !== source.runtime
                || !empty && !delivery.assetIds?.includes(assetId))
                throw new ExperienceError('DELIVERY_MISMATCH', '回报与这次查询或任务不匹配。');
            const previous = rows.findLast(row => row.kind === 'use_reported' && row.deliveryId === deliveryId
                && (empty ? row.assetIds?.length === 0 : row.assetIds?.includes(assetId)));
            if (previous) {
                if (previous.client?.runtime !== delivery.client.runtime)
                    throw new ExperienceError('DELIVERY_MISMATCH', '回报与这次查询或任务不匹配。');
                if (previous.outcome !== outcome || JSON.stringify(previous.output ?? []) !== JSON.stringify(output ?? [])) {
                    throw new ExperienceError('REPORT_CONFLICT', '这次查询已经收到不同结果，请重新创建任务。');
                }
                return previous;
            }
            let validation = 'not_requested';
            if (!empty && task.validator === 'iso-date-sort.v1') {
                const expected = dateOutput(task.input);
                const actual = Array.isArray(output) ? output.map(value => safeText(value, 32)) : [];
                validation = outcome === 'success' && JSON.stringify(actual) === JSON.stringify(expected) ? 'passed' : 'failed';
            }
            return append({ id: randomUUID(), kind: 'use_reported', at: new Date(this.now()).toISOString(), deliveryId,
                assetIds: empty ? [] : [assetId], taskId, outcome, validation, usageEvidence: 'application_report', hostIdentityVerified: false,
                client: source, ...(output ? { output: output.slice(0, 100) } : {}) });
        });
    }
    history(limit = 50) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ExperienceError('INPUT_INVALID', '记录数量不正确。');
        return this.records().filter(row => row.kind !== 'check_requested').slice(-limit).reverse().map(row => ({ ...row, code: undefined, input: undefined, output: undefined }));
    }
    checkStatus(id) {
        const rows = this.records(), request = rows.find(row => row.id === id && row.kind === 'check_requested');
        if (!request)
            return null;
        const result = rows.findLast(row => row.kind === 'check_received' && row.code === request.code);
        return result ? { ...result, code: undefined } : { ...request, code: undefined };
    }
}