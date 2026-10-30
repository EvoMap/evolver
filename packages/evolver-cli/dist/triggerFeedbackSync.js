import { randomUUID } from 'node:crypto';
import { algo, hub } from '@evomap/evolver-core';
import { HubClientError } from '@evomap/evolver-adapter-public';
import { LocalMemoryGraph } from './localMemoryGraph.js';
import { deliverTriggerFeedback } from './triggerFeedbackDelivery.js';
export async function synchronizeTriggerFeedback(options) {
    const { graph, remote } = options;
    let snapshot = options.snapshot;
    let local = options.local ?? { committed: snapshot.commit, changed: false, resetSuppressed: false };
    const unavailable = (reason) => ({ snapshot, local, remote: { status: 'unverified', reason } });
    const assertCurrent = () => { options.signal?.throwIfAborted(); if (!remote.isCurrent())
        throw new Error('trigger_feedback_destination_changed'); };
    assertCurrent();
    const claimed = graph.claimTriggerFeedbackDelivery(snapshot.runId, remote.destinationId, randomUUID());
    if (!claimed.claimed) {
        if (claimed.state.status === 'confirmed' && claimed.state.acknowledgedRevision === (snapshot.commit?.revision ?? 0)) {
            return { snapshot, local, remote: { status: 'confirmed', from: 'durable-receipt' } };
        }
        return unavailable(claimed.state.reason ?? 'trigger_feedback_busy');
    }
    const id = claimed.state.claim.id;
    const observe = async () => {
        assertCurrent();
        const current = await options.readKernel();
        assertCurrent();
        if (current.runId !== snapshot.runId || current.triggerId !== snapshot.triggerId)
            throw new Error('trigger_feedback_source_mismatch');
        options.requireReceipt?.(current);
        local = graph.applyKernelTriggerFeedback(current);
        snapshot = algo.updateTriggerFeedbackState(graph.readTriggerFeedback(current.runId) ?? undefined, current).snapshot;
        return snapshot;
    };
    const settle = (status, reason) => {
        graph.settleTriggerFeedbackDelivery(snapshot.runId, id, { status, reason });
        return unavailable(reason);
    };
    try {
        if (claimed.reconcile) {
            let receipt = null;
            let absent = false;
            try {
                assertCurrent();
                receipt = await remote.get(snapshot.runId);
            }
            catch (error) {
                const body = error instanceof HubClientError && error.body && typeof error.body === 'object' ? error.body : {};
                absent = error instanceof HubClientError && error.status === 404 && body['error'] === 'trigger_feedback_not_found';
                if (!absent)
                    return settle('ambiguous', 'trigger_feedback_hub_unverified');
            }
            await observe();
            const latestReport = hub.triggerFeedbackReport(snapshot);
            if (receipt && hub.triggerFeedbackReceiptMatches(receipt, latestReport)) {
                if ((snapshot.commit?.revision ?? 0) !== claimed.state.claim.revision)
                    return settle('ambiguous', 'trigger_feedback_source_changed');
                graph.settleTriggerFeedbackDelivery(snapshot.runId, id, { status: 'confirmed', revision: snapshot.commit?.revision ?? 0, operationId: snapshot.commit?.operationId ?? null });
                return { snapshot, local, remote: { status: 'confirmed', receipt } };
            }
            if (!absent && (!receipt || (receipt.committed?.revision ?? 0) >= (snapshot.commit?.revision ?? 0)))
                return settle('blocked', 'trigger_feedback_remote_ahead');
            if (!options.force && claimed.state.retryAt > Date.now())
                return settle('ambiguous', 'trigger_feedback_retry_deferred');
        }
        const guarded = {
            async commit(value) {
                await observe();
                if (JSON.stringify(hub.triggerFeedbackReport(snapshot)) !== JSON.stringify(value))
                    throw new Error('trigger_feedback_source_changed');
                assertCurrent();
                graph.markTriggerFeedbackDispatched(snapshot.runId, id);
                return remote.commit(value);
            },
            async get(runId) { assertCurrent(); return remote.get(runId); },
        };
        const delivered = await deliverTriggerFeedback(snapshot, guarded);
        await observe();
        if (delivered.status === 'confirmed') {
            const receipt = delivered.receipt;
            graph.settleTriggerFeedbackDelivery(snapshot.runId, id, { status: 'confirmed', revision: receipt.committed?.revision ?? 0, operationId: receipt.committed?.operationId ?? null });
            if (!hub.triggerFeedbackReceiptMatches(receipt, hub.triggerFeedbackReport(snapshot)))
                return unavailable('trigger_feedback_pending_newer_revision');
            return { snapshot, local, remote: delivered };
        }
        graph.settleTriggerFeedbackDelivery(snapshot.runId, id, {
            status: delivered.status === 'rejected' ? 'blocked' : 'ambiguous', reason: delivered.reason,
        });
        return { snapshot, local, remote: delivered };
    }
    catch (error) {
        const reason = error instanceof Error && /^trigger_feedback_[a-z_]+$/.test(error.message) ? error.message : 'trigger_feedback_hub_unverified';
        if (remote.isCurrent()) {
            if (reason.startsWith('trigger_feedback_kernel_'))
                graph.markTriggerFeedbackSourceUnavailable(snapshot.runId);
            graph.settleTriggerFeedbackDelivery(snapshot.runId, id, { status: 'ambiguous', reason });
        }
        return unavailable(reason);
    }
}