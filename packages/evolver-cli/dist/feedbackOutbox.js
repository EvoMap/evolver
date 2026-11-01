/**
 * Durable autoexec applied-use feedback. The local event and the optional Hub
 * reuse-result have separate acknowledgements: local projection must complete
 * before the first network dispatch, and a started dispatch is never replayed
 * without independent reconciliation evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hub } from '@evomap/evolver-core';
import { prepareOutboxDirectory, withOutboxLock } from './outboxLock.js';
const SCHEMA_VERSION = 'autoexec-feedback-outbox.v1';
const OPERATION_PREFIX = 'autoexec-feedback:';
const EVENT_PREFIX = 'autoexec-applied-use:';
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^autoexec-feedback:[a-f0-9]{64}$/;
const ROW_NAME = /^[a-f0-9]{64}\.json$/;
const MAX_ROW_BYTES = 64 * 1024;
const MAX_SIGNALS = 32;
const MAX_SIGNAL_CHARS = 160;
const TERMINAL_DISPOSITIONS = new Set([
    'completed', 'denied', 'invalid_target', 'deadline_exceeded', 'budget_exceeded',
    'resource_denied', 'consent_denied', 'timed_out', 'cancelled', 'crashed',
    'rejected', 'unsafe_to_replay',
]);
export class FeedbackOutboxError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FeedbackOutboxError';
    }
}
/** Only a sender that proves no Hub request began may permit a later retry. */
export class FeedbackNotDispatchedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FeedbackNotDispatchedError';
    }
}
function digest(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
function hasControlCharacter(value) {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}
function stripControlCharacters(value) {
    return [...value].map((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? ' ' : character;
    }).join('');
}
function exactString(value, label, maxLength = 256) {
    if (typeof value !== 'string' || !value || value.length > maxLength || hasControlCharacter(value)) {
        throw new FeedbackOutboxError(`invalid ${label}`);
    }
    return value;
}
function safeReason(value, label) {
    const raw = exactString(value, label, 256);
    const cleaned = stripControlCharacters(hub.redactString(raw)).trim();
    if (!cleaned)
        throw new FeedbackOutboxError(`invalid ${label}`);
    return cleaned.slice(0, 256);
}
function safeSignals(signals) {
    if (!Array.isArray(signals))
        throw new FeedbackOutboxError('invalid task signals');
    const out = [];
    const seen = new Set();
    for (const item of signals) {
        if (out.length >= MAX_SIGNALS)
            break;
        if (typeof item !== 'string')
            continue;
        const text = stripControlCharacters(hub.redactString(item)).trim().slice(0, MAX_SIGNAL_CHARS);
        if (!text || seen.has(text))
            continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}
/** One operation per claim root and exact asset, even if the task id is later reused. */
export function feedbackIdentity(claimRoot, assetId) {
    const root = exactString(claimRoot, 'claim root', 1024);
    if (!SHA256_ID.test(assetId))
        throw new FeedbackOutboxError('invalid applied asset id');
    const claimRootDigest = digest(root);
    const operationDigest = digest(`${claimRootDigest}\u0000${assetId}`);
    return {
        operationId: `${OPERATION_PREFIX}${operationDigest}`,
        sourceEventId: `${EVENT_PREFIX}${operationDigest}`,
        claimRootDigest,
    };
}
function copyAppliedUse(use) {
    if (use.schemaVersion !== 'applied-use.v1'
        || !SHA256_ID.test(use.assetId)
        || !exactString(use.geneId, 'gene id')
        || !exactString(use.cycleId, 'cycle id')
        || !['hub', 'local', 'migrated', 'unknown'].includes(use.source)
        || !['success', 'failed', 'inert', 'inconclusive'].includes(use.outcome)
        || (use.producedValue !== null && typeof use.producedValue !== 'boolean')
        || use.applicationBinding !== 'selected_execution'
        || use.verification !== 'unverified') {
        throw new FeedbackOutboxError('invalid applied-use evidence');
    }
    if (use.outcome === 'success' && use.producedValue !== true)
        throw new FeedbackOutboxError('success lacks produced value');
    if (use.outcome === 'inert' && use.producedValue !== false)
        throw new FeedbackOutboxError('inert outcome has produced value');
    if (use.capsuleId !== undefined && !SHA256_ID.test(use.capsuleId))
        throw new FeedbackOutboxError('invalid capsule id');
    if (use.eventId !== undefined && !SHA256_ID.test(use.eventId))
        throw new FeedbackOutboxError('invalid event id');
    if (use.hubOriginDestinationId !== undefined) {
        if (!SHA256_ID.test(use.hubOriginDestinationId))
            throw new FeedbackOutboxError('invalid Hub origin destination id');
        if (use.source !== 'hub')
            throw new FeedbackOutboxError('non-Hub use has Hub origin');
    }
    if (use.terminalDisposition !== undefined && !TERMINAL_DISPOSITIONS.has(use.terminalDisposition)) {
        throw new FeedbackOutboxError('invalid terminal disposition');
    }
    return {
        schemaVersion: 'applied-use.v1', assetId: use.assetId, geneId: use.geneId,
        cycleId: use.cycleId, source: use.source, outcome: use.outcome,
        producedValue: use.producedValue, applicationBinding: 'selected_execution',
        verification: 'unverified',
        ...(use.capsuleId ? { capsuleId: use.capsuleId } : {}),
        ...(use.eventId ? { eventId: use.eventId } : {}),
        ...(use.hubOriginDestinationId ? { hubOriginDestinationId: use.hubOriginDestinationId } : {}),
        ...(use.terminalDisposition ? { terminalDisposition: use.terminalDisposition } : {}),
    };
}
function unboundHubReason(use, destinationId) {
    if (!use.hubOriginDestinationId)
        return 'hub_origin_unbound';
    if (!destinationId)
        return 'hub_destination_unbound';
    return 'hub_origin_mismatch';
}
function immutablePayload(record) {
    return {
        ...immutableAppliedUseEvidence(record),
        ...(record.report ? { report: record.report } : {}),
        ...(record.destinationId ? { destinationId: record.destinationId } : {}),
    };
}
function immutableAppliedUseEvidence(record) {
    return {
        schemaVersion: record.schemaVersion, operationId: record.operationId,
        sourceEventId: record.sourceEventId, claimRootDigest: record.claimRootDigest,
        taskId: record.taskId, signals: record.signals, appliedUse: record.appliedUse,
    };
}
function payloadDigest(record) {
    return digest(JSON.stringify(immutablePayload(record)));
}
function frozen(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value))
            frozen(child);
        Object.freeze(value);
    }
    return value;
}
function validateRecord(value, expectedOperationId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new FeedbackOutboxError('invalid feedback outbox record');
    const row = value;
    if (row.schemaVersion !== SCHEMA_VERSION || row.operationId !== expectedOperationId
        || !OPERATION_ID.test(row.operationId)
        || row.sourceEventId !== `${EVENT_PREFIX}${row.operationId.slice(OPERATION_PREFIX.length)}`
        || !/^[a-f0-9]{64}$/.test(row.claimRootDigest)
        || !Number.isSafeInteger(row.revision) || row.revision < 1
        || !['pending', 'acknowledged'].includes(row.localStatus)
        || !['not_applicable', 'pending', 'ambiguous', 'acknowledged', 'terminal'].includes(row.networkStatus)
        || !Array.isArray(row.signals) || row.signals.length > MAX_SIGNALS
        || row.signals.some((signal) => typeof signal !== 'string' || signal.length > MAX_SIGNAL_CHARS)
        || typeof row.preparedAt !== 'string') {
        throw new FeedbackOutboxError('invalid feedback outbox record');
    }
    exactString(row.taskId, 'task id');
    const use = copyAppliedUse(row.appliedUse);
    const expectedDigest = digest(`${row.claimRootDigest}\u0000${use.assetId}`);
    if (row.operationId !== `${OPERATION_PREFIX}${expectedDigest}`)
        throw new FeedbackOutboxError('feedback operation identity mismatch');
    const reportable = use.source === 'hub' && (use.outcome === 'success' || use.outcome === 'failed');
    const bound = Boolean(row.report);
    if (row.destinationId !== undefined && !SHA256_ID.test(row.destinationId)) {
        throw new FeedbackOutboxError('feedback destination binding mismatch');
    }
    if (bound && (!reportable || !row.destinationId
        || use.hubOriginDestinationId !== row.destinationId)) {
        throw new FeedbackOutboxError('feedback report/evidence mismatch');
    }
    if (!reportable && row.destinationId !== undefined) {
        throw new FeedbackOutboxError('feedback destination binding mismatch');
    }
    if (row.report) {
        if (use.source !== 'hub' || (use.outcome !== 'success' && use.outcome !== 'failed')
            || row.report.assetId !== use.assetId || row.report.outcome !== use.outcome
            || row.report.taskId !== row.taskId || row.report.traceId !== use.cycleId) {
            throw new FeedbackOutboxError('feedback report/evidence mismatch');
        }
    }
    if (reportable && !bound && (row.networkStatus !== 'terminal'
        || row.terminalReason !== unboundHubReason(use, row.destinationId) || !row.settledAt
        || row.dispatchStartedAt || row.receiptId || row.reconciliationEvidence)) {
        throw new FeedbackOutboxError('unbound Hub feedback must be terminal before dispatch');
    }
    if (reportable && !bound && row.destinationId
        && use.hubOriginDestinationId === row.destinationId) {
        throw new FeedbackOutboxError('matching Hub origin lacks feedback report');
    }
    if (reportable && bound && row.networkStatus === 'not_applicable')
        throw new FeedbackOutboxError('Hub feedback cannot be not applicable');
    if (!reportable && row.networkStatus !== (use.source === 'hub' ? 'terminal' : 'not_applicable')) {
        throw new FeedbackOutboxError('invalid non-reportable network state');
    }
    if ((row.networkStatus === 'ambiguous' || row.networkStatus === 'acknowledged'
        || (row.networkStatus === 'terminal' && bound && !row.reconciliationEvidence))
        && (!row.dispatchStartedAt || row.localStatus !== 'acknowledged')) {
        throw new FeedbackOutboxError('invalid ambiguous dispatch state');
    }
    if (row.networkStatus === 'terminal' && bound && !row.dispatchStartedAt
        && (!row.reconciliationEvidence || !row.terminalReason || row.localStatus !== 'acknowledged')) {
        throw new FeedbackOutboxError('invalid terminal reconciliation state');
    }
    if ((row.networkStatus === 'acknowledged' || row.networkStatus === 'terminal') && !row.settledAt) {
        throw new FeedbackOutboxError('settled feedback has no timestamp');
    }
    if (row.payloadDigest !== payloadDigest(row))
        throw new FeedbackOutboxError('feedback payload digest mismatch');
    return row;
}
function fsyncDirectory(path) {
    if (process.platform === 'win32')
        return;
    const fd = openSync(path, constants.O_RDONLY);
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function writeAtomic(path, record) {
    const dir = dirname(path);
    const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
    let fd;
    try {
        fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, path);
        fsyncDirectory(dir);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            unlinkSync(temp);
        }
        catch {
            // A failed cleanup leaves only an ignored temp file; preserve the write error, if any.
        }
    }
}
export class FeedbackOutbox {
    dir;
    directory;
    reportedUnreadable = new Set();
    constructor(dir) {
        try {
            this.directory = prepareOutboxDirectory(dir);
        }
        catch {
            throw new FeedbackOutboxError('unsafe feedback outbox directory');
        }
        this.dir = this.directory.path;
    }
    path(operationId) {
        if (!OPERATION_ID.test(operationId))
            throw new FeedbackOutboxError('invalid feedback operation id');
        return join(this.dir, `${operationId.slice(OPERATION_PREFIX.length)}.json`);
    }
    get(operationId) {
        this.directory.assertTrusted();
        const path = this.path(operationId);
        if (!existsSync(path)) {
            this.directory.assertTrusted();
            return null;
        }
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ROW_BYTES)
            throw new FeedbackOutboxError('unsafe feedback outbox record');
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            throw new FeedbackOutboxError('corrupt feedback outbox record');
        }
        const row = frozen(validateRecord(parsed, operationId));
        this.directory.assertTrusted();
        return row;
    }
    save(record) {
        record.payloadDigest = payloadDigest(record);
        writeAtomic(this.path(record.operationId), record);
        return frozen(record);
    }
    /** Persist exact applied-use evidence before any local projection or Hub call. */
    prepare(input) {
        const use = input.verdict.appliedUse;
        if (!use)
            return null;
        if (input.task.id !== input.verdict.taskId
            || input.task.generation !== input.verdict.generation) {
            throw new FeedbackOutboxError('task/verdict claim mismatch');
        }
        const taskId = exactString(input.task.id, 'task id');
        const appliedUse = copyAppliedUse(use);
        if (appliedUse.outcome === 'success' && input.verdict.status !== 'solidified')
            throw new FeedbackOutboxError('success verdict mismatch');
        if (appliedUse.outcome === 'inert' && input.verdict.status !== 'solidified')
            throw new FeedbackOutboxError('inert verdict mismatch');
        if (appliedUse.outcome === 'failed' && input.verdict.status !== 'failed')
            throw new FeedbackOutboxError('failure verdict mismatch');
        const identity = feedbackIdentity(input.claimRoot, appliedUse.assetId);
        if (input.operationId && input.operationId !== identity.operationId)
            throw new FeedbackOutboxError('feedback operation id mismatch');
        const reportable = appliedUse.source === 'hub'
            && (appliedUse.outcome === 'success' || appliedUse.outcome === 'failed');
        if (reportable && input.destinationId !== undefined && !SHA256_ID.test(input.destinationId)) {
            throw new FeedbackOutboxError('invalid Hub feedback destination id');
        }
        // The Hub records one event per (asset, reporter node, idempotency key). The outbox row IS
        // one logical reuse — its operation id is derived from (claim root, asset) and is stable on
        // disk across processes and restarts — so it mints exactly one stable key for that row. A
        // network retry of the same row therefore records once instead of double-counting the reuse.
        const report = appliedUse.source === 'hub'
            && (appliedUse.outcome === 'success' || appliedUse.outcome === 'failed')
            && input.destinationId
            && appliedUse.hubOriginDestinationId === input.destinationId
            ? {
                assetId: appliedUse.assetId,
                outcome: appliedUse.outcome,
                taskId,
                traceId: appliedUse.cycleId,
                idempotencyKey: hub.reuseResultIdempotencyKey([identity.operationId]),
            }
            : undefined;
        const networkStatus = report
            ? 'pending' : appliedUse.source === 'hub' ? 'terminal' : 'not_applicable';
        const candidate = {
            schemaVersion: SCHEMA_VERSION, ...identity, taskId,
            signals: safeSignals(input.task.signals), appliedUse,
            ...(report ? { report } : {}),
            ...(reportable && input.destinationId ? { destinationId: input.destinationId } : {}),
            payloadDigest: '',
            localStatus: 'pending', networkStatus, revision: 1,
            preparedAt: new Date().toISOString(),
            ...(networkStatus === 'terminal' ? {
                settledAt: new Date().toISOString(),
                terminalReason: reportable ? unboundHubReason(appliedUse, input.destinationId)
                    : `unrepresentable_hub_outcome:${appliedUse.outcome}`,
            } : {}),
        };
        candidate.payloadDigest = payloadDigest(candidate);
        return withOutboxLock(this.directory, () => {
            const existing = this.get(identity.operationId);
            if (existing) {
                if (existing.payloadDigest !== candidate.payloadDigest
                    && !(reportable
                        && digest(JSON.stringify(immutableAppliedUseEvidence(existing)))
                            === digest(JSON.stringify(immutableAppliedUseEvidence(candidate))))) {
                    throw new FeedbackOutboxError('feedback operation payload conflict');
                }
                // A committed claim may be recovered after Hub credentials or routing change.
                // Its original destination owns the debt; the current destination cannot inherit it.
                return existing;
            }
            return this.save(candidate);
        });
    }
    rows() {
        this.directory.assertTrusted();
        const rows = [];
        for (const name of readdirSync(this.dir).filter((item) => ROW_NAME.test(item)).sort()) {
            const operationId = `${OPERATION_PREFIX}${name.slice(0, -5)}`;
            try {
                const row = this.get(operationId);
                if (row)
                    rows.push(row);
            }
            catch (error) {
                if (!(error instanceof FeedbackOutboxError))
                    throw error;
                // An invalid row must remain untouched for repair, but it cannot hold
                // unrelated committed feedback hostage. The digest is safe to log.
                if (!this.reportedUnreadable.has(operationId)) {
                    this.reportedUnreadable.add(operationId);
                    try {
                        process.stderr.write(`[autoexec] feedback_outbox_record_unreadable operation=${operationId}\n`);
                    }
                    catch { /* A closed diagnostic stream cannot block healthy feedback. */ }
                }
            }
        }
        this.directory.assertTrusted();
        return rows;
    }
    localPending() {
        return this.rows().filter((row) => row.localStatus === 'pending');
    }
    /** This acknowledgement follows idempotent ingestion under sourceEventId. */
    acknowledgeLocal(operationId) {
        return withOutboxLock(this.directory, () => {
            const row = this.get(operationId);
            if (!row)
                throw new FeedbackOutboxError('feedback operation not found');
            if (row.localStatus === 'acknowledged')
                return row;
            return this.save({ ...row, localStatus: 'acknowledged', localAcknowledgedAt: new Date().toISOString(), revision: row.revision + 1 });
        });
    }
    /** Never dispatched Hub rows; ambiguous rows are intentionally excluded. */
    pending() {
        return this.rows().filter((row) => row.localStatus === 'acknowledged' && row.networkStatus === 'pending');
    }
    /** Mark ambiguous durably before first send. No replay from ambiguous state. */
    async deliver(operationId, destinationId, sender) {
        const started = withOutboxLock(this.directory, () => {
            const row = this.get(operationId);
            if (!row)
                throw new FeedbackOutboxError('feedback operation not found');
            if (row.localStatus !== 'acknowledged')
                throw new FeedbackOutboxError('local feedback event is pending');
            if (row.networkStatus !== 'pending' || !row.report)
                throw new FeedbackOutboxError('feedback dispatch is not pending');
            if (!SHA256_ID.test(destinationId) || destinationId !== row.destinationId) {
                throw new FeedbackOutboxError('feedback destination mismatch');
            }
            return this.save({ ...row, networkStatus: 'ambiguous', dispatchStartedAt: new Date().toISOString(), revision: row.revision + 1 });
        });
        let result;
        let notDispatched = false;
        try {
            result = await sender(started);
        }
        catch (error) {
            if (error instanceof FeedbackNotDispatchedError)
                notDispatched = true;
            else
                result = { status: 'ambiguous', reason: 'sender_threw' };
        }
        return withOutboxLock(this.directory, () => {
            const current = this.get(operationId);
            if (!current || current.payloadDigest !== started.payloadDigest) {
                throw new FeedbackOutboxError('feedback dispatch owner changed');
            }
            // An operator may have reconciled the ambiguous send while its callback
            // was still pending. Never overwrite that independent evidence.
            if (current.revision !== started.revision || current.networkStatus !== 'ambiguous')
                return current;
            if (notDispatched) {
                // The typed refusal is raised before the adapter begins HTTP. If the process
                // crashed before this transition, the durable ambiguous state would remain.
                const pending = { ...current, networkStatus: 'pending', revision: current.revision + 1 };
                delete pending.dispatchStartedAt;
                delete pending.ambiguousReason;
                return this.save(pending);
            }
            if (result?.status === 'acknowledged') {
                return this.save({ ...current, networkStatus: 'acknowledged', settledAt: new Date().toISOString(),
                    ...(result.receiptId ? { receiptId: safeReason(result.receiptId, 'receipt id') } : {}), revision: current.revision + 1 });
            }
            if (result?.status === 'terminal' && typeof result.reason === 'string' && result.reason) {
                return this.save({ ...current, networkStatus: 'terminal', settledAt: new Date().toISOString(),
                    terminalReason: safeReason(result.reason, 'terminal reason'), revision: current.revision + 1 });
            }
            const reason = result?.status === 'ambiguous' && result.reason ? safeReason(result.reason, 'ambiguous reason') : 'indeterminate_response';
            return this.save({ ...current, ambiguousReason: reason, revision: current.revision + 1 });
        });
    }
    /** External receipt or operator evidence can settle ambiguity without resending. */
    reconcile(operationId, resolution) {
        return withOutboxLock(this.directory, () => {
            const row = this.get(operationId);
            if (!row)
                throw new FeedbackOutboxError('feedback operation not found');
            if (row.networkStatus === 'pending') {
                if (resolution.status !== 'terminal')
                    throw new FeedbackOutboxError('feedback operation is not ambiguous');
                if (row.localStatus !== 'acknowledged')
                    throw new FeedbackOutboxError('local feedback event is pending');
            }
            else if (row.networkStatus !== 'ambiguous') {
                throw new FeedbackOutboxError('feedback operation is not ambiguous');
            }
            const evidence = safeReason(resolution.evidence, 'reconciliation evidence');
            if (resolution.status === 'acknowledged') {
                return this.save({ ...row, networkStatus: 'acknowledged', settledAt: new Date().toISOString(),
                    reconciliationEvidence: evidence,
                    ...(resolution.receiptId ? { receiptId: safeReason(resolution.receiptId, 'receipt id') } : {}),
                    revision: row.revision + 1 });
            }
            return this.save({ ...row, networkStatus: 'terminal', settledAt: new Date().toISOString(),
                reconciliationEvidence: evidence, terminalReason: safeReason(resolution.reason, 'terminal reason'),
                revision: row.revision + 1 });
        });
    }
}