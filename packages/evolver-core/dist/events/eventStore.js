import { openSync, writeSync, fsyncSync, closeSync, fstatSync, constants, readSync, mkdirSync, existsSync, truncateSync, readFileSync, lstatSync, readdirSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { readRootEventHistory, readRootEventHistoryStrict, rootEventArchiveDir } from './eventArchive.js';
import { AuditBudget, AuditWriteSkipped, openAuditFile, commitAuditLine, withAuditLock, auditLockOwned } from './boundedAudit.js';
import { auditCleanupSequence, withAuditCleanup } from './auditCleanup.js';
import { contextDeliveryRootOwned, DeliveryMetadataInvalidError } from '../ops/geneContextDeliveryJournal.js';
import { protectedAuditConfigured, protectedAuditRpc, protectedAuditRpcSync, protectedAuditReadSnapshotSync, isProtectedAuditServiceProcess, ProtectedAuditUnavailableError } from './protectedAuditRpc.js';
// Monotonic ULIDs: plain ulid() randomizes the low 80 bits, so two ids minted in the SAME millisecond can sort
// out of order — the event log wants time-sortable eventIds (and a flaky CI test proved it). The monotonic
// factory increments within a millisecond, guaranteeing each successive eventId is strictly greater.
const makeUlid = monotonicFactory();
function namedIdentity(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new AuditWriteSkipped('path_changed');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function descriptorMatchesPath(stat, path) {
    // Windows admission holds a no-delete-share HANDLE and verifies its native
    // identity; POSIX names remain replaceable while the descriptor stays open.
    if (process.platform === 'win32')
        return true;
    const named = lstatSync(path);
    return named.isFile() && !named.isSymbolicLink() && named.nlink === 1
        && String(stat.dev) === String(named.dev) && String(stat.ino) === String(named.ino);
}
function targetMatches(expected, actual) {
    if (expected === null)
        return true;
    if (!expected.startsWith('['))
        return expected === actual;
    const values = JSON.parse(expected);
    return Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string') && values.includes(actual);
}
import { appendExperienceAudit, recoverExperienceAuditUnderLock, isExperienceAuditKey } from './experienceAuditJournal.js';
import { RootOperationError, assertNoPendingRootOperation, confirmRootOperation, readRootOperationHistory, repairRootOperation, rootOperationPrefixHash, rootOperationFileIdentity, rootOperationRootOwned, rootOperationRequestHash, rootOperationEventHash, snapshotRootOperation, validateRootOperationId, validateRootOperationReceipt, validateRootOperationTicket, withRootOperationJournal } from './rootEventOperations.js';
import { rootEvent, parseRootEvent, EVENT_SCHEMA_VERSION } from './eventSchema.js';
/** 单行字节上限, 保 O_APPEND+write 在 ext4 的原子性 (军杰 §3.2). */
export const MAX_LINE_BYTES = 4096;
export const MAX_PROTECTED_HISTORY_BYTES = 256 * 1024 * 1024;
const auditFileLimit = () => isProtectedAuditServiceProcess() ? MAX_PROTECTED_HISTORY_BYTES : 64 * 1024 * 1024;
function assertProtectedHistoryCapacity(path, incoming) {
    if (!isProtectedAuditServiceProcess())
        return;
    let bytes = existsSync(path) ? lstatSync(path).size : 0;
    const archive = rootEventArchiveDir(path);
    try {
        for (const name of readdirSync(archive)) {
            if (/^root-events-\d{16}-\d{16}\.jsonl$/.test(name))
                bytes += lstatSync(join(archive, name)).size;
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (bytes + incoming > MAX_PROTECTED_HISTORY_BYTES)
        throw new AuditWriteSkipped('protected_history_capacity');
}
function envelope(raw, identity) {
    return parseRootEvent({
        ...identity,
        type: raw.type,
        schemaVersion: raw.schemaVersion ?? EVENT_SCHEMA_VERSION,
        replayability: raw.replayability ?? 'deterministic',
        payload: raw.payload ?? {},
        human: raw.human,
        actor: raw.actor ?? { kind: 'machine' },
        ...(raw.auditOperationId ? { auditOperationId: raw.auditOperationId } : {}),
        ...(raw.auditRequestHash ? { auditRequestHash: raw.auditRequestHash } : {}),
    });
}
/** Size-only preflight using the writer's schema and the longest generated envelope. No I/O or IDs consumed. */
export function fitsRootEventLine(raw) {
    const value = envelope(raw, { seq: Number.MAX_SAFE_INTEGER, eventId: '0'.repeat(26), ts: '9999-12-31T23:59:59.999Z' });
    return Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8') <= MAX_LINE_BYTES;
}
export class LineTooLargeError extends Error {
    bytes;
    constructor(bytes) {
        super(`root_event line ${bytes}B exceeds ${MAX_LINE_BYTES}B; 大 payload 须走 artifact 引用`);
        this.bytes = bytes;
        this.name = 'LineTooLargeError';
    }
}
/** This error is minted only before append dispatch, never for an ambiguous filesystem failure. */
export class EventWriteNotCommittedError extends Error {
    operationId;
    constructor(operationId, cause) {
        super('event_write_not_committed', { cause });
        this.operationId = operationId;
    }
}
function checkWriteAdmission(options) {
    if (options.signal?.aborted || (options.deadlineAt !== undefined
        && (!Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt))) {
        throw new EventWriteNotCommittedError(options.operationId);
    }
}
const LOCAL_TARGET = Symbol('local event target');
const fileIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
function localMetadata(path, directory, named = lstatSync(path, { bigint: true })) {
    const valid = (stat) => directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n;
    if (named.isSymbolicLink() || !valid(named))
        throw new Error('event_path_changed: not a private regular file or directory');
    if (process.platform !== 'win32' || named.dev !== 0n)
        return named;
    // Older Node Windows pathname stats omit volume identity. Read it from a
    // real descriptor rather than substituting a fabricated dev value.
    const fd = openSync(path, constants.O_RDONLY | (directory ? (constants.O_DIRECTORY ?? 0) : 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
        if (!valid(opened) || current.isSymbolicLink() || !valid(current)
            || opened.ino !== named.ino || opened.birthtimeNs !== named.birthtimeNs
            || current.ino !== opened.ino || current.birthtimeNs !== opened.birthtimeNs)
            throw new Error('event_path_changed');
        return opened;
    }
    finally {
        closeSync(fd);
    }
}
function localParentIdentity(path) {
    return fileIdentity(localMetadata(dirname(path), true));
}
function localFileIdentity(path) {
    let named;
    try {
        named = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    return fileIdentity(localMetadata(path, false, named));
}
// A prototype and matching method descriptors do not establish construction:
// a Proxy can report those values during admission and switch its method later.
const builtInEventStores = new WeakSet();
const builtInClockFunctions = new WeakMap();
/** 唯一权威事件流 (AE). single-writer / append-only / seq 递增 / fsync. */
export class EventStore {
    static isBuiltInObservationStore(value) {
        try {
            return value !== null && typeof value === 'object'
                && builtInEventStores.has(value)
                && Object.getPrototypeOf(value) === EventStore.prototype;
        }
        catch {
            return false;
        }
    }
    static usesBuiltInClock(value) {
        if (!EventStore.isBuiltInObservationStore(value))
            return false;
        const expected = builtInClockFunctions.get(value);
        return expected !== undefined && Object.getOwnPropertyDescriptor(value, 'now')?.value === expected;
    }
    path;
    lockPath;
    now;
    chain = Promise.resolve();
    creation;
    constructor(opts) {
        this.path = opts.path;
        this.lockPath = `${opts.path}.lock`;
        this.now = opts.now ?? Date.now;
        if (!protectedAuditConfigured() && !isProtectedAuditServiceProcess())
            mkdirSync(canonicalEventPath(dirname(this.path)), { recursive: true });
        builtInEventStores.add(this);
        if (opts.now === undefined)
            builtInClockFunctions.set(this, this.now);
    }
    /** Experience audit has a persistent reservation; ordinary append's admission ID is not this protocol. */
    async appendExperienceAuditV1(raw, operationId, deadlineAt = Date.now() + 30_000, expectedNamespace) {
        const rootDeadlineAt = Number.isFinite(deadlineAt) ? Math.min(deadlineAt, Date.now() + 500) : deadlineAt;
        const budget = new AuditBudget({ deadlineAt });
        budget.check();
        if (protectedAuditConfigured()) {
            budget.check();
            return protectedAuditRpc('append_experience_audit_v1', this.path, { raw, ...(expectedNamespace !== undefined ? { expectedNamespace } : {}) }, { operationId, deadlineAt: rootDeadlineAt });
        }
        const path = canonicalEventPath(this.path);
        budget.check();
        const target = { parent: localParentIdentity(path), file: localFileIdentity(path) };
        if (target.file === undefined) {
            if (!this.creation || this.creation.path !== path || this.creation.parent !== target.parent || this.creation.file !== undefined)
                this.creation = { path, parent: target.parent };
            target.creation = this.creation;
        }
        const run = this.chain.then(() => {
            budget.check();
            const validate = () => {
                assertNoPendingRootOperation(path);
                if (canonicalEventPath(this.path) !== path || localParentIdentity(path) !== target.parent
                    || localFileIdentity(path) !== (target.file ?? target.creation?.file))
                    throw new AuditWriteSkipped('path_changed');
            };
            if (contextDeliveryRootOwned(path))
                throw new AuditWriteSkipped('delivery_cleanup_pending');
            return appendExperienceAudit(path, raw, operationId, { budget, expectedNamespace, maxFileBytes: auditFileLimit(),
                capacity: incoming => assertProtectedHistoryCapacity(path, incoming), lastSeq: () => this.lastSeqFromFile(path), validate,
                created: () => { target.creation.file = localFileIdentity(path); },
                assertHistory: check => {
                    const history = readRootEventHistoryStrict(path, { maxBytes: auditFileLimit(), check });
                    if (!existsSync(`${path}.experience-audit.sqlite`) && history.some(event => isExperienceAuditKey(event.auditOperationId)))
                        throw new AuditWriteSkipped('experience_audit_authority_missing');
                } });
        });
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    /** 唯一写路径: 生成 seq/eventId/ts, 校验, 原子 append + fsync. */
    async append(raw, options = {}) {
        options = { ...options };
        checkWriteAdmission(options);
        if (isExperienceAuditKey(raw.auditOperationId))
            throw new EventWriteNotCommittedError(options.operationId, new Error('experience_audit_method_required'));
        if (protectedAuditConfigured()) {
            try {
                return await protectedAuditRpc('append_root', this.path, raw, {
                    deadlineAt: options.deadlineAt ?? Date.now() + 30_000,
                    ...(options.operationId ? { operationId: options.operationId } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                });
            }
            catch (cause) {
                // Only the authenticated service's existing explicit no-dispatch reply
                // proves this outcome. Lost/late transport receipts remain ambiguous.
                if (cause instanceof ProtectedAuditUnavailableError
                    && cause.message === 'protected_audit_unavailable: event_write_not_committed') {
                    throw new EventWriteNotCommittedError(options.operationId, cause);
                }
                throw cause;
            }
        }
        let path, target;
        try {
            path = canonicalEventPath(this.path);
            if (options.expectedPath !== undefined && canonicalEventPath(options.expectedPath) !== path)
                throw new Error('event_path_changed');
            if (options.expectedAlias !== undefined && canonicalEventPath(options.expectedAlias) !== path)
                throw new Error('event_path_changed');
            target = { parent: localParentIdentity(path), file: localFileIdentity(path) };
            if (target.file === undefined) {
                // Only this store's exclusive creation can bind a cohort of queued
                // absent snapshots; a later external file never grants that authority.
                if (!this.creation || this.creation.path !== path || this.creation.parent !== target.parent || this.creation.file !== undefined) {
                    this.creation = { path, parent: target.parent };
                }
                target.creation = this.creation;
            }
        }
        catch (cause) {
            throw new EventWriteNotCommittedError(options.operationId, cause);
        }
        const run = this.chain.then(() => {
            checkWriteAdmission(options);
            try {
                if (canonicalEventPath(this.path) !== path
                    || (options.expectedAlias !== undefined && canonicalEventPath(options.expectedAlias) !== path)) {
                    throw new Error('event_path_changed');
                }
            }
            catch (cause) {
                throw new EventWriteNotCommittedError(options.operationId, cause);
            }
            return this.appendLocked(raw, { ...options, expectedPath: path, [LOCAL_TARGET]: target });
        });
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    /** Reserve the exact root line without dispatch; the caller checkpoints its namespace ticket first. */
    async prepareIdempotent(raw, admission) {
        return await this.rootOperation(raw, admission, true);
    }
    /** Root-lock-owned replay protocol. No external sink or checkpoint can certify this append. */
    async appendIdempotent(raw, admission) {
        return await this.rootOperation(raw, admission, false);
    }
    async rootOperation(raw, admission, preparing) {
        const options = { ...admission };
        validateRootOperationId(options.operationId);
        if (isExperienceAuditKey(options.operationId))
            throw new RootOperationError('experience_audit_method_required');
        raw = snapshotRootOperation(raw);
        const hash = rootOperationRequestHash(raw);
        if (options.legacyActivityId !== undefined && (raw.type !== 'experience.activity'
            || raw.payload?.id !== options.legacyActivityId
            || options.operationId !== `experience-activity-${options.legacyActivityId}`))
            throw new RootOperationError('legacy_identity_invalid');
        if (protectedAuditConfigured()) {
            const receipt = await protectedAuditRpc(preparing ? 'prepare_root_operation' : 'append_root_idempotent', this.path, { raw, ...(options.legacyActivityId ? { legacyActivityId: options.legacyActivityId } : {}),
                ...(options.namespaceId ? { namespaceId: options.namespaceId } : {}) }, { deadlineAt: options.deadlineAt ?? Date.now() + 500, operationId: options.operationId,
                ...(options.signal ? { signal: options.signal } : {}) });
            return preparing ? validateRootOperationTicket(receipt, raw, options.operationId) : validateRootOperationReceipt(receipt, raw, options);
        }
        const budget = new AuditBudget(options);
        budget.check();
        localFileIdentity(this.path); // Reject a final symlink before canonicalization can launder it.
        const path = canonicalEventPath(this.path), parent = localParentIdentity(path);
        const before = localFileIdentity(path);
        // A retained delivery owner forbids new dispatch, but without the root lock
        // we cannot certify that this replay key was never committed previously.
        if (contextDeliveryRootOwned(path))
            throw new RootOperationError('cleanup_pending');
        return withAuditLock(`${path}.lock`, budget, async () => {
            if (canonicalEventPath(this.path) !== path || localParentIdentity(path) !== parent)
                throw new RootOperationError('target_changed');
            if (before !== undefined && localFileIdentity(path) !== before)
                throw new RootOperationError('target_changed');
            if (contextDeliveryRootOwned(path))
                throw new RootOperationError('cleanup_pending');
            recoverExperienceAuditUnderLock(path, () => budget.check());
            return withRootOperationJournal(path, budget, async (journal) => {
                const prior = journal.admission(options.operationId, hash, options.namespaceId);
                const ticket = () => ({ schema: 1, operationId: options.operationId, requestHash: hash, namespaceId: journal.namespaceId() });
                if (prior)
                    validateRootOperationReceipt(JSON.parse(prior.line), raw, options);
                if (preparing && prior)
                    return ticket();
                const maxBytes = auditFileLimit();
                const handle = await openAuditFile(path, maxBytes, budget, prior !== undefined);
                return withAuditCleanup(async () => {
                    if (canonicalEventPath(this.path) !== path || localParentIdentity(path) !== parent)
                        throw new RootOperationError('target_changed');
                    if (prior) {
                        let submitted = false;
                        if (prior.state === 'planned' && await repairRootOperation(path, handle, prior, budget)) {
                            await commitAuditLine(handle, prior.line, maxBytes, budget);
                            submitted = true;
                        }
                        return confirmRootOperation(path, handle, prior, journal, budget, maxBytes, submitted);
                    }
                    const history = await readRootOperationHistory(path, handle, budget, maxBytes);
                    const historySequence = history.at(-1)?.event.seq ?? 0;
                    const matches = history.filter(item => item.event.auditOperationId === options.operationId
                        || options.legacyActivityId !== undefined && item.event.type === 'experience.activity'
                            && item.event.payload?.id === options.legacyActivityId);
                    if (matches.length > 1)
                        throw new RootOperationError('duplicate_history');
                    if (matches.length) {
                        const found = matches[0];
                        if (rootOperationEventHash(found.event) !== hash)
                            throw new RootOperationError('request_conflict');
                        validateRootOperationReceipt(found.event, raw, options);
                        const saved = { ...found, operationId: options.operationId, requestHash: hash,
                            prefixHash: await rootOperationPrefixHash(handle, 0, budget), state: 'committed' };
                        journal.prepare(saved, historySequence);
                        if (preparing)
                            return ticket();
                        return confirmRootOperation(path, handle, saved, journal, budget, maxBytes);
                    }
                    if (options.legacyActivityId !== undefined)
                        throw new RootOperationError('legacy_history_unknown');
                    const stat = await handle.stat();
                    const evt = envelope({ ...raw, auditOperationId: options.operationId, auditRequestHash: hash }, { seq: (history.at(-1)?.event.seq ?? 0) + 1, eventId: makeUlid(), ts: new Date(this.now()).toISOString() });
                    const line = `${JSON.stringify(evt)}\n`;
                    if (Buffer.byteLength(line) > MAX_LINE_BYTES)
                        throw new LineTooLargeError(Buffer.byteLength(line));
                    assertProtectedHistoryCapacity(path, Buffer.byteLength(line));
                    const record = { operationId: options.operationId, requestHash: hash, line, offset: stat.size,
                        identity: rootOperationFileIdentity(path), prefixHash: await rootOperationPrefixHash(handle, stat.size, budget), state: 'planned' };
                    journal.prepare(record, historySequence);
                    if (preparing)
                        return ticket();
                    await commitAuditLine(handle, line, maxBytes, budget);
                    return confirmRootOperation(path, handle, record, journal, budget, maxBytes, true);
                }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
            }, options.namespaceId !== undefined);
        });
    }
    appendLocked(raw, options) {
        const path = options.expectedPath ?? canonicalEventPath(this.path), target = options[LOCAL_TARGET];
        // A background caller may resume after a later async projection acquired
        // this root. Never synchronously wait on resources whose cleanup needs this
        // event loop; refuse before dispatch so its durable work remains retryable.
        try {
            if (!target || contextDeliveryRootOwned(this.path) || contextDeliveryRootOwned(path) || rootOperationRootOwned(path) || auditLockOwned(`${path}.lock`))
                throw new AuditWriteSkipped('delivery_cleanup_pending');
        }
        catch (cause) {
            throw new EventWriteNotCommittedError(options.operationId, cause);
        }
        let dispatched = false;
        const checkTarget = (fd, created = false) => {
            try {
                if (canonicalEventPath(this.path) !== path || localParentIdentity(path) !== target.parent
                    || (options.expectedAlias !== undefined && canonicalEventPath(options.expectedAlias) !== path))
                    throw new Error('event_path_changed');
                const named = localFileIdentity(path), expected = target.file ?? target.creation?.file;
                if (created ? expected !== undefined || !target.creation : named !== expected)
                    throw new Error('event_path_changed');
                if (fd !== undefined) {
                    const opened = fstatSync(fd, { bigint: true });
                    if (!opened.isFile() || opened.nlink !== 1n || fileIdentity(opened) !== named)
                        throw new Error('event_path_changed');
                }
                if (created)
                    target.creation.file = named;
                return named;
            }
            catch (cause) {
                if (dispatched)
                    throw new Error('event_path_changed_after_dispatch', { cause });
                throw new EventWriteNotCommittedError(options.operationId, cause);
            }
        };
        // Never hold this synchronous lock across an await. Keep reads and append
        // on the same checked descriptor, rather than reopening the named tail.
        const lockPath = path === this.path ? this.lockPath : `${path}.lock`;
        acquireLock(lockPath);
        let fd;
        const flags = constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
        const openTarget = (create) => {
            try {
                return openSync(path, flags | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
            }
            catch (cause) {
                throw new EventWriteNotCommittedError(options.operationId, cause);
            }
        };
        try {
            recoverExperienceAuditUnderLock(path);
            checkWriteAdmission(options);
            try {
                assertNoPendingRootOperation(path);
            }
            catch (cause) {
                throw new EventWriteNotCommittedError(options.operationId, cause);
            }
            if (checkTarget() !== undefined) {
                fd = openTarget(false);
                checkTarget(fd);
            }
            const seq = this.lastSeqFromFile(path, fd) + 1;
            const evt = envelope(raw, {
                seq,
                eventId: makeUlid(),
                ts: new Date(this.now()).toISOString(),
            });
            const line = `${JSON.stringify(evt)}\n`;
            const bytes = Buffer.byteLength(line, 'utf8');
            if (bytes > MAX_LINE_BYTES)
                throw new LineTooLargeError(bytes);
            assertProtectedHistoryCapacity(path, bytes);
            if (fd === undefined) {
                fd = openTarget(true);
                checkTarget(fd, true);
            }
            else
                checkTarget(fd);
            // This is the final no-event-commit boundary; all later errors remain ambiguous.
            checkWriteAdmission(options);
            dispatched = true;
            writeSync(fd, line);
            fsyncSync(fd);
            checkTarget(fd);
            return evt;
        }
        finally {
            try {
                if (fd !== undefined)
                    closeSync(fd);
            }
            finally {
                releaseLock(lockPath);
            }
        }
    }
    /** Bounded audit entry used only through Ingestor. Shares the envelope and cross-process writer lock. */
    static async appendBounded(raw, opts) {
        if (isExperienceAuditKey(raw.auditOperationId))
            throw new AuditWriteSkipped('experience_audit_method_required');
        if (protectedAuditConfigured())
            return protectedAuditRpc('append_root_bounded', opts.path, raw, {
                deadlineAt: opts.deadlineAt ?? Date.now() + 30_000,
                ...(opts.signal ? { signal: opts.signal } : {}),
            });
        const budget = new AuditBudget(opts);
        budget.check();
        if (!fitsRootEventLine(raw))
            throw new LineTooLargeError(MAX_LINE_BYTES + 1);
        opts = { ...opts, path: canonicalEventPath(opts.path) };
        return withAuditLock(`${opts.path}.lock`, budget, async () => {
            assertNoPendingRootOperation(opts.path);
            recoverExperienceAuditUnderLock(opts.path, () => budget.check());
            const maxFileBytes = auditFileLimit();
            const handle = await openAuditFile(opts.path, maxFileBytes, budget);
            return withAuditCleanup(async () => {
                const stat = await handle.stat();
                const size = Math.min(8192, stat.size);
                const buffer = Buffer.alloc(size);
                let seq = 0;
                if (size > 0) {
                    budget.check();
                    const { bytesRead } = await handle.read(buffer, 0, size, stat.size - size);
                    if (bytesRead !== size)
                        throw new AuditWriteSkipped('tail_changed');
                    // Do not append to a partial/corrupt tail and make a previously readable log worse. The regular
                    // recovery entrypoint repairs interrupted writes before a subsequent hook can append again.
                    if (buffer[size - 1] !== 10)
                        throw new AuditWriteSkipped('partial_event_tail');
                    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
                    let tail;
                    try {
                        tail = JSON.parse(lines.at(-1) ?? 'null');
                    }
                    catch {
                        throw new AuditWriteSkipped('invalid_event_tail');
                    }
                    const last = rootEvent.safeParse(tail);
                    if (!last.success || !Number.isSafeInteger(last.data.seq) || last.data.seq < 0 || last.data.seq >= Number.MAX_SAFE_INTEGER) {
                        throw new AuditWriteSkipped('invalid_event_tail');
                    }
                    seq = last.data.seq;
                }
                else
                    seq = readRootEventHistoryStrict(opts.path).at(-1)?.seq ?? 0;
                budget.check();
                const evt = envelope(raw, { seq: seq + 1, eventId: makeUlid(), ts: new Date((opts.now ?? Date.now)()).toISOString() });
                const line = `${JSON.stringify(evt)}\n`;
                assertProtectedHistoryCapacity(opts.path, Buffer.byteLength(line));
                await commitAuditLine(handle, line, maxFileBytes, budget);
                return evt;
            }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
        });
    }
    /** Operation-bound delivery projection. Only Ingestor supplies validated authority. */
    static async projectContextDelivery(authority, opts, validate) {
        if (protectedAuditConfigured())
            throw new ProtectedAuditUnavailableError('delivery_projection_requires_protected_authority');
        const budget = new AuditBudget(opts);
        opts = { ...opts, path: canonicalEventPath(opts.path) };
        return withAuditLock(`${opts.path}.lock`, budget, async () => {
            assertNoPendingRootOperation(opts.path);
            recoverExperienceAuditUnderLock(opts.path, () => budget.check());
            let saved;
            try {
                saved = authority.read();
            }
            catch (error) {
                if (!(error instanceof DeliveryMetadataInvalidError))
                    throw error;
                authority.unknown('metadata_invalid');
                return 'unknown';
            }
            validate?.(saved.raw);
            if (saved.state === 'projected')
                return 'projected';
            if (saved.state === 'projecting' || saved.state === 'projection_unknown') {
                const plan = saved.plan;
                if (!plan || typeof plan.line !== 'string' || Buffer.byteLength(plan.line) > MAX_LINE_BYTES || !plan.line.endsWith('\n')
                    || !Number.isSafeInteger(plan.offset) || plan.offset < 0 || typeof plan.identity !== 'string') {
                    authority.unknown('metadata_invalid');
                    return 'unknown';
                }
                let validLine = false;
                try {
                    const parsed = rootEvent.safeParse(JSON.parse(plan.line));
                    validLine = parsed.success && JSON.stringify(envelope(saved.raw, parsed.data)) + '\n' === plan.line;
                }
                catch { /* Invalid JSON/envelope cannot certify a persisted projection. */ }
                if (!validLine) {
                    authority.unknown('metadata_invalid');
                    return 'unknown';
                }
                for (const locator of [plan, ...(plan.previous ? [plan.previous] : [])]) {
                    const archive = locator.archive;
                    if ((archive !== undefined && !/^root-events-\d{16}-\d{16}\.jsonl$/.test(archive))
                        || !Number.isSafeInteger(locator.offset) || locator.offset < 0)
                        continue;
                    const path = archive ? join(rootEventArchiveDir(opts.path), archive) : opts.path;
                    try {
                        if (namedIdentity(path) !== locator.identity)
                            continue;
                    }
                    catch (error) {
                        if (error.code === 'ENOENT')
                            continue;
                        throw error;
                    }
                    // Existing-only handles: absence never creates a new log or grants permission to replay.
                    const handle = await openAuditFile(path, auditFileLimit(), budget, true);
                    const found = await withAuditCleanup(async () => {
                        if (!descriptorMatchesPath(await handle.stat(), path) || namedIdentity(path) !== locator.identity)
                            return false;
                        const bytes = Buffer.from(plan.line), actual = Buffer.alloc(bytes.length);
                        const read = await handle.read(actual, 0, actual.length, locator.offset);
                        if (read.bytesRead !== bytes.length || !actual.equals(bytes))
                            return false;
                        await handle.sync();
                        if (!descriptorMatchesPath(await handle.stat(), path) || namedIdentity(path) !== locator.identity)
                            return false;
                        authority.projected();
                        return true;
                    }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
                    if (found)
                        return 'projected';
                }
                authority.unknown('history_missing');
                return 'unknown';
            }
            if (saved.state !== 'confirmed')
                return 'unknown';
            if (!fitsRootEventLine(saved.raw))
                throw new LineTooLargeError(MAX_LINE_BYTES + 1);
            if (saved.targetIdentity) {
                try {
                    const named = lstatSync(opts.path);
                    if (!targetMatches(saved.targetIdentity, `${named.dev}:${named.ino}:${named.birthtimeMs}`) || named.isSymbolicLink() || named.nlink !== 1) {
                        authority.unknown('target_changed');
                        return 'unknown';
                    }
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                    authority.unknown('target_changed');
                    return 'unknown';
                }
            }
            const handle = await openAuditFile(opts.path, auditFileLimit(), budget);
            return withAuditCleanup(async () => {
                const stat = await handle.stat();
                const fileIdentity = namedIdentity(opts.path);
                if (!descriptorMatchesPath(stat, opts.path) || !targetMatches(saved.targetIdentity, fileIdentity)) {
                    authority.unknown('target_changed');
                    return 'unknown';
                }
                const size = Math.min(8192, stat.size), buffer = Buffer.alloc(size);
                let seq = 0;
                if (size > 0) {
                    const read = await handle.read(buffer, 0, size, stat.size - size);
                    if (read.bytesRead !== size || buffer[size - 1] !== 10)
                        throw new AuditWriteSkipped('partial_event_tail');
                    const tail = rootEvent.safeParse(JSON.parse(buffer.toString('utf8').split('\n').filter(Boolean).at(-1)));
                    if (!tail.success || !Number.isSafeInteger(tail.data.seq) || tail.data.seq < 0 || tail.data.seq >= Number.MAX_SAFE_INTEGER)
                        throw new AuditWriteSkipped('invalid_event_tail');
                    seq = tail.data.seq;
                }
                else
                    seq = readRootEventHistoryStrict(opts.path).at(-1)?.seq ?? 0;
                budget.check();
                const evt = envelope(saved.raw, { seq: seq + 1, eventId: makeUlid(), ts: new Date((opts.now ?? Date.now)()).toISOString() });
                const line = `${JSON.stringify(evt)}\n`;
                assertProtectedHistoryCapacity(opts.path, Buffer.byteLength(line));
                authority.plan({ line, offset: stat.size, identity: fileIdentity });
                let dispatched = false;
                try {
                    await commitAuditLine(handle, line, auditFileLimit(), budget, true, { dispatched: () => {
                            const fresh = authority.read();
                            if (fresh.state !== 'projecting' || fresh.plan?.line !== line || namedIdentity(opts.path) !== fileIdentity)
                                throw new AuditWriteSkipped('projection_changed');
                            budget.check(); // Generation validation can consume the remaining admission budget.
                            dispatched = true;
                        }, rolledBack: () => { dispatched = false; } });
                }
                catch (error) {
                    if (!dispatched)
                        authority.notDispatched();
                    else
                        authority.unknown();
                    throw error;
                }
                // If this marker fails, the persisted exact line/locator remains readback-only.
                if (!descriptorMatchesPath(await handle.stat(), opts.path) || namedIdentity(opts.path) !== fileIdentity) {
                    authority.unknown();
                    return 'unknown';
                }
                authority.projected();
                return 'projected';
            }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
        });
    }
    /** 读全部事件 (跳过尾部半行/损坏行). */
    readAll() {
        if (protectedAuditConfigured())
            return protectedAuditReadSnapshotSync('root', this.path);
        return readRootEventHistory(canonicalEventPath(this.path));
    }
    /** Fail-closed replay for decision policies that cannot safely consume a partial history. */
    readAllStrict() {
        if (protectedAuditConfigured())
            return protectedAuditReadSnapshotSync('root_strict', this.path);
        return readRootEventHistoryStrict(canonicalEventPath(this.path));
    }
    *iterate(fromSeq = 0) {
        for (const e of this.readAll())
            if (e.seq >= fromSeq)
                yield e;
    }
    tail(n = 1) {
        const all = this.readAll();
        return all.slice(Math.max(0, all.length - n));
    }
    /** 截断尾部半行 (崩溃恢复). */
    recover() {
        if (protectedAuditConfigured())
            return protectedAuditRpcSync('recover_root', this.path, undefined, { deadlineAt: Date.now() + 30_000 });
        const path = canonicalEventPath(this.path), lock = `${path}.lock`;
        if (rootOperationRootOwned(path))
            throw new RootOperationError('cleanup_pending');
        if (contextDeliveryRootOwned(path) || auditLockOwned(lock))
            throw new AuditWriteSkipped('audit_cleanup_pending');
        acquireLock(lock);
        try {
            if (canonicalEventPath(this.path) !== path)
                throw new AuditWriteSkipped('path_changed');
            assertNoPendingRootOperation(path);
            recoverExperienceAuditUnderLock(path);
            if (!existsSync(path))
                return { truncated: false };
            const buf = readFileSync(path);
            if (buf.length === 0)
                return { truncated: false };
            const lastNl = buf.lastIndexOf(0x0a);
            if (lastNl === buf.length - 1)
                return { truncated: false };
            truncateSync(path, lastNl + 1);
            return { truncated: true };
        }
        finally {
            releaseLock(lock);
        }
    }
    /** Repair only evidenced Experience slots, never truncate an unrelated tail. */
    async recoverExperienceAudit(deadlineAt = Date.now() + 30_000) {
        if (protectedAuditConfigured())
            throw new ProtectedAuditUnavailableError('experience_recovery_requires_service');
        const budget = new AuditBudget({ deadlineAt }), path = canonicalEventPath(this.path);
        await withAuditLock(`${path}.lock`, budget, async () => {
            if (canonicalEventPath(this.path) !== path)
                throw new AuditWriteSkipped('path_changed');
            assertNoPendingRootOperation(path);
            recoverExperienceAuditUnderLock(path, () => budget.check());
        });
    }
    lastSeqFromFile(path, opened) {
        if (opened === undefined && !existsSync(path))
            return readRootEventHistoryStrict(path).at(-1)?.seq ?? 0;
        const fd = opened ?? openSync(path, 'r');
        try {
            const size = fstatSync(fd).size;
            if (size === 0)
                return readRootEventHistoryStrict(path).at(-1)?.seq ?? 0;
            const readBytes = Math.min(8192, size);
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, size - readBytes);
            const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const o = JSON.parse(lines[i]);
                    if (typeof o.seq === 'number')
                        return o.seq;
                }
                catch { /* skip */ }
            }
            return 0;
        }
        finally {
            if (opened === undefined)
                closeSync(fd);
        }
    }
}