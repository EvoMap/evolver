import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { AuditWriteSkipped } from '../events/boundedAudit.js';
import { ProtectedAuditUnavailableError } from '../events/protectedAuditRpc.js';
const diagnostic = new AsyncLocalStorage();
const MAX_STAGES = 16;
const phases = new Set(['worker_first_ipc', 'worker_close', 'gene_snapshot',
    'related_snapshot', 'prompt_selection', 'prompt_assembly', 'delivery_prepare',
    'delivery_validate', 'delivery_journal_open', 'delivery_journal_transaction',
    'delivery_journal_begin', 'delivery_journal_commit', 'delivery_journal_rollback',
    'delivery_journal_close', 'delivery_cleanup', 'worker_bootstrap', 'worker_native_ready', 'worker_lstat', 'snapshot_owned',
    'delivery_rpc_connect', 'delivery_rpc_submit', 'delivery_rpc_first_byte', 'delivery_rpc_reply']);
const rejectionCodes = new Map([
    ['transport_timeout_unknown', 'transport_timeout_unknown'], ['transport_aborted_unknown', 'transport_aborted_unknown'],
    ['transport_closed_unknown', 'transport_closed_unknown'], ['admission_expired', 'admission_expired'],
    ['request_expired', 'request_expired'], ['request_invalid_or_expired', 'request_invalid_or_expired'],
    ['cancelled_or_expired', 'cancelled_or_expired'],
]);
const preparationCodes = new Set(['prepared', 'rejected', 'invalid_capability', 'deadline', 'timeout', 'not_configured',
    ...rejectionCodes.values()]);
const snapshotCodes = new Set(['snapshot_aborted', 'snapshot_rejected']);
const transactionParts = ['begin', 'body', 'commit', 'rollback'];
function safeTransactionTiming(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => !transactionParts.includes(key)))
            return undefined;
        const result = {};
        for (const part of transactionParts) {
            const timing = value[part];
            if (timing === undefined)
                continue;
            if (!Array.isArray(timing) || timing.length !== 2)
                return undefined;
            const durationMs = timing[0], outcome = timing[1];
            if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > Number.MAX_SAFE_INTEGER
                || !['fulfilled', 'rejected'].includes(outcome))
                return undefined;
            result[part] = [durationMs, outcome];
        }
        return Object.keys(result).length ? result : undefined;
    }
    catch {
        return undefined;
    } // Untrusted diagnostic access cannot mask the original error.
}
const snapshotParts = ['root', 'assets', 'metadata', 'verify', 'cleanup'];
/** Copy finite primitives once; optional diagnostic objects never reach serialization. */
function safeSnapshotOwnedTiming(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => key !== 'kind' && !snapshotParts.includes(key)))
            return undefined;
        const kind = Reflect.get(value, 'kind');
        if (kind !== 'gene' && kind !== 'related')
            return undefined;
        const result = { kind };
        let parts = 0;
        for (const part of snapshotParts) {
            const timing = Reflect.get(value, part);
            if (timing === undefined)
                continue;
            if (!Array.isArray(timing) || timing.length !== 2)
                return undefined;
            const duration = timing[0], outcome = timing[1];
            if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > Number.MAX_SAFE_INTEGER
                || (outcome !== 'fulfilled' && outcome !== 'rejected'))
                return undefined;
            result[part] = [duration, outcome];
            parts++;
        }
        return parts ? result : undefined;
    }
    catch {
        return undefined;
    }
}
/** Classify only known typed failures; arbitrary service/error text never enters diagnostics. */
export function contextDeliveryRejectionCode(error) {
    try {
        if (error instanceof AuditWriteSkipped)
            return error.reason === 'cancelled_or_expired' ? 'cancelled_or_expired' : 'rejected';
        if (error instanceof ProtectedAuditUnavailableError) {
            const reason = error.reason;
            if (typeof reason !== 'string' || reason.length > 100)
                return 'rejected';
            if (reason === 'audit skipped: cancelled_or_expired')
                return 'cancelled_or_expired';
            const prefix = 'protected_audit_unavailable: ';
            return rejectionCodes.get(reason) ?? (reason.startsWith(prefix) ? rejectionCodes.get(reason.slice(prefix.length)) : undefined) ?? 'rejected';
        }
    }
    catch { /* Diagnostic access cannot replace the original preparation outcome. */ }
    return 'rejected';
}
function contextSnapshotRejectionCode(error) {
    try {
        return error instanceof Error && error.message === 'snapshot_aborted' ? 'snapshot_aborted' : 'snapshot_rejected';
    }
    catch {
        return 'snapshot_rejected';
    }
}
/** Retain one actual settlement, never attach a later detail to an earlier outcome/duration. */
function representativeStage(stages, phase) {
    return (phase === 'delivery_journal_transaction' ? stages.find(stage => stage.phase === phase && stage.transaction) : undefined)
        ?? stages.find(stage => stage.phase === phase);
}
/** Opt-in invocation diagnostics contain timings only, never records, paths or errors.
 * The observer runs after the operation and cannot spend its selection deadline. */
export function withContextReadDiagnostics(enabled, run, report) {
    if (!enabled)
        return run();
    const collector = { stages: [], truncated: false, pendingStages: 0 };
    return (async () => {
        try {
            return await diagnostic.run(collector, run);
        }
        finally {
            try {
                const value = { schema: 'evolver.context-read-timing.v1',
                    stages: collector.stages.map(stage => ({ ...stage })), truncated: collector.truncated, pendingStages: collector.pendingStages };
                // The stderr writer's existing 2048-byte limit drops an oversized line
                // entirely. Compact duplicate settlements instead, after the operation,
                // keeping every distinct phase and its first valid transaction settlement.
                if (Buffer.byteLength(`context-read-stage-diagnostic ${JSON.stringify(value)}\n`) > 2048) {
                    value.stages = value.stages.filter((stage, _index, stages) => representativeStage(stages, stage.phase) === stage);
                    value.truncated = true;
                }
                // Keep the writer's prefix/newline within the same byte cap. Only the
                // new optional detail may be sacrificed, never a legacy code/transaction.
                if (Buffer.byteLength(`context-read-stage-diagnostic ${JSON.stringify(value)}\n`) > 2048) {
                    value.stages = value.stages.map(({ snapshot: _snapshot, ...stage }) => stage);
                    value.truncated = true;
                }
                void Promise.resolve(report(value)).catch(() => undefined);
            }
            catch { /* A diagnostic observer must not replace the operation's outcome. */ }
        }
    })();
}
export function startContextReadStage(phase) {
    return startCollectedStage(diagnostic.getStore(), phase);
}
/** Capture this invocation; socket events must never switch to another caller's collector. */
export function contextDeliveryRpcObserver() {
    const collector = diagnostic.getStore();
    if (!collector)
        return undefined;
    const stages = { connect: 'delivery_rpc_connect', submit: 'delivery_rpc_submit',
        first_byte: 'delivery_rpc_first_byte', reply: 'delivery_rpc_reply' };
    return phase => startCollectedStage(collector, stages[phase]);
}
function startCollectedStage(collector, phase) {
    if (!collector || !phases.has(phase))
        return undefined;
    // Clock acquisition is observation, not operation admission. Do not leave a
    // phantom pending stage if it fails before a finish callback exists.
    let started;
    try {
        started = performance.now();
        if (!Number.isFinite(started)) {
            collector.truncated = true;
            return undefined;
        }
    }
    catch {
        collector.truncated = true;
        return undefined;
    }
    collector.pendingStages++;
    let recorded = false;
    return (outcome, code, transaction, snapshot) => {
        if (recorded)
            return;
        recorded = true;
        collector.pendingStages--;
        try {
            const elapsed = performance.now() - started;
            const durationMs = Math.round(elapsed * 100) / 100;
            if (!Number.isFinite(durationMs) || elapsed < 0) {
                collector.truncated = true;
                return;
            }
            const detail = phase === 'delivery_journal_transaction' ? safeTransactionTiming(transaction) : undefined;
            const owned = phase === 'snapshot_owned' ? safeSnapshotOwnedTiming(snapshot) : undefined;
            if (collector.stages.length >= MAX_STAGES) {
                collector.truncated = true;
                const representative = representativeStage(collector.stages, phase);
                if (representative) {
                    if (representative.transaction || !detail)
                        return;
                    // The first valid transaction replaces an empty representative as a whole
                    // stage. Append below to preserve the actual settlement order.
                    collector.stages.splice(collector.stages.indexOf(representative), 1);
                }
                else {
                    // Admit a missing phase within the fixed capacity by
                    // evicting only a duplicate, never its first valid transaction settlement.
                    const duplicate = collector.stages.findIndex(stage => representativeStage(collector.stages, stage.phase) !== stage);
                    if (duplicate < 0)
                        return;
                    collector.stages.splice(duplicate, 1);
                }
            }
            const allowedCode = code && ((phase === 'delivery_prepare' && preparationCodes.has(code))
                || ((phase === 'gene_snapshot' || phase === 'related_snapshot') && outcome === 'rejected' && snapshotCodes.has(code)));
            collector.stages.push({ phase, durationMs, outcome,
                ...(allowedCode ? { code } : {}), ...(detail ? { transaction: detail } : {}), ...(owned ? { snapshot: owned } : {}) });
        }
        catch {
            collector.truncated = true;
        } // Settlement must not replace the operation's result/error.
    };
}
export function measureContextReadStage(phase, run) {
    if (!diagnostic.getStore())
        return run();
    const finish = startContextReadStage(phase);
    if (!finish)
        return run();
    try {
        // Preserve the original dispatch scheduling; do not defer the reader into a new microtask.
        return run().then(value => { finish('fulfilled'); return value; }, error => {
            finish('rejected', phase === 'gene_snapshot' || phase === 'related_snapshot'
                ? contextSnapshotRejectionCode(error) : undefined);
            throw error;
        });
    }
    catch (error) {
        finish('rejected', phase === 'gene_snapshot' || phase === 'related_snapshot' ? contextSnapshotRejectionCode(error) : undefined);
        throw error;
    }
}