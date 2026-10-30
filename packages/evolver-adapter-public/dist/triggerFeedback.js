import { hub } from '@evomap/evolver-core';
export function createTriggerFeedbackCapability(call) {
    return {
        async commit(report) {
            const normalized = hub.normalizeTriggerFeedbackReport(report);
            const raw = await call('POST', '/a2a/trigger-feedback', { ...normalized });
            const receipt = hub.parseTriggerFeedbackReceipt(raw, normalized.run_id);
            if (!hub.triggerFeedbackReceiptMatches(receipt, normalized))
                throw new Error('trigger_feedback_receipt_unconfirmed');
            return receipt;
        },
        async get(runId) {
            if (!runId.trim() || Buffer.byteLength(runId) > 256)
                throw new Error('trigger_feedback_invalid_identity');
            const raw = await call('POST', '/a2a/trigger-feedback/get', { run_id: runId });
            return hub.parseTriggerFeedbackReceipt(raw, runId);
        },
    };
}