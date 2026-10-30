import { join } from 'node:path';
import { awaitWithAbort } from '@evomap/evolver-adapter-public';
import { LocalMemoryGraph, resolveLocalMemoryUserIdentity } from './localMemoryGraph.js';
import { kernelTriggerFeedbackBinding, listKernelTriggerFeedback, readKernelTriggerFeedback } from './kernelTriggerFeedback.js';
import { createBoundTriggerFeedbackHub } from './triggerFeedbackHub.js';
import { synchronizeTriggerFeedback } from './triggerFeedbackSync.js';
export async function recoverTriggerFeedback(deps, localOnly) {
    const now = deps.now ?? Date.now;
    const deadline = now() + 20_000;
    const controller = new AbortController();
    const expired = new Error('trigger_feedback_deadline_exceeded');
    const timer = setTimeout(() => controller.abort(expired), 20_000);
    const check = () => {
        if (now() >= deadline && !controller.signal.aborted)
            controller.abort(expired);
        controller.signal.throwIfAborted();
    };
    const budget = { signal: controller.signal, check,
        async run(work) {
            check();
            const value = await awaitWithAbort(work(), controller.signal);
            check();
            return value;
        },
    };
    try {
        return await recoverWithinBudget(deps, localOnly, budget);
    }
    finally {
        clearTimeout(timer);
    }
}
async function recoverWithinBudget(deps, localOnly, budget) {
    const env = { ...(deps.env ?? process.env) };
    const binding = kernelTriggerFeedbackBinding(env);
    const dir = join(binding.agentDir, 'evolver', 'evolution');
    const graph = deps.createGraph?.(dir) ?? new LocalMemoryGraph({ dir, ...resolveLocalMemoryUserIdentity(dir) });
    const report = { ok: true, schemaVersion: 1, command: 'recover', localCommitted: false,
        scanned: 0, localChanged: 0, hubConfirmed: 0, pending: 0, blocked: 0, partial: false, reasons: {} };
    const failure = (error) => {
        const reason = error instanceof Error && /^trigger_feedback_[a-z_]+$/.test(error.message) ? error.message : 'trigger_feedback_recovery_unverified';
        report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
        report.ok = false;
        report.partial ||= budget.signal.aborted;
    };
    let after = graph.readTriggerFeedbackRecoveryCursor();
    try {
        const seen = new Set();
        for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
            const page = await budget.run(() => (deps.listKernel ?? listKernelTriggerFeedback)(binding, after, budget.signal));
            if (page.snapshots.length > 100 || (page.nextAfter !== null && (page.snapshots.length === 0 || page.nextAfter === after || seen.has(page.nextAfter))))
                throw new Error('trigger_feedback_kernel_invalid_output');
            if (page.snapshots.length > 0) {
                const local = graph.applyKernelTriggerFeedbackBatch(page.snapshots);
                report.scanned += page.snapshots.length;
                report.localChanged += local.filter((value) => value.changed).length;
                report.localCommitted = true;
                budget.check();
                graph.saveTriggerFeedbackRecoveryCursor(page.nextAfter);
            }
            else if (after !== null) {
                graph.saveTriggerFeedbackRecoveryCursor(null);
            }
            after = page.nextAfter;
            report.partial = after !== null;
            if (after === null)
                break;
            seen.add(after);
        }
        budget.check();
    }
    catch (error) {
        if (!budget.signal.aborted)
            graph.markTriggerFeedbackSourceUnavailable();
        failure(error);
        return report;
    }
    if (localOnly)
        return report;
    let cursor = graph.readTriggerFeedbackRecoveryCursor('delivery');
    let debt = graph.readTriggerFeedbackDeliveries(cursor, 25);
    if (debt.length === 0 && cursor !== null) {
        cursor = null;
        debt = graph.readTriggerFeedbackDeliveries(null, 25);
    }
    if (debt.length === 0)
        return report;
    let remote;
    try {
        budget.check();
        remote = (deps.createRemote ?? createBoundTriggerFeedbackHub)(binding, env, budget.signal);
    }
    catch (error) {
        failure(error);
        report.blocked += debt.length;
        return report;
    }
    for (const row of debt) {
        const readKernel = () => budget.run(() => (deps.readKernel ?? readKernelTriggerFeedback)(binding, row.snapshot.runId, budget.signal));
        try {
            // Cancelling the waiter retains the persisted claim; late work stays signal-fenced, not graph-closed.
            const result = await budget.run(() => synchronizeTriggerFeedback({ snapshot: row.snapshot, graph, remote, readKernel, signal: budget.signal }));
            if (result.remote.status === 'confirmed')
                report.hubConfirmed++;
            else {
                if (graph.readTriggerFeedbackDelivery(row.snapshot.runId)?.status === 'blocked')
                    report.blocked++;
                else
                    report.pending++;
                failure(new Error(result.remote.reason ?? 'trigger_feedback_hub_unverified'));
            }
        }
        catch (error) {
            if (!budget.signal.aborted)
                graph.markTriggerFeedbackSourceUnavailable(row.snapshot.runId);
            failure(error);
            report.pending++;
        }
        if (budget.signal.aborted)
            break;
        graph.saveTriggerFeedbackRecoveryCursor(row.snapshot.runId, 'delivery');
    }
    return report;
}