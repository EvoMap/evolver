import { hub } from '@evomap/evolver-core';
import { HubClientError, AuthError } from '@evomap/evolver-adapter-public';
export async function deliverTriggerFeedback(snapshot, remote) {
    const report = hub.triggerFeedbackReport(snapshot);
    try {
        const receipt = await remote.commit(report);
        if (!hub.triggerFeedbackReceiptMatches(receipt, report))
            throw new Error('trigger_feedback_receipt_unconfirmed');
        return { status: 'confirmed', receipt };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'trigger_feedback_egress_blocked')
            return { status: 'rejected', reason: error.message };
        if (error instanceof HubClientError && (error.status === 404 || error.status === 405))
            return { status: 'unsupported', reason: 'trigger_feedback_hub_unsupported' };
        if (error instanceof AuthError || (error instanceof HubClientError && error.status >= 400 && error.status < 500)) {
            return { status: 'rejected', reason: 'trigger_feedback_hub_rejected' };
        }
        try {
            const receipt = await remote.get(snapshot.runId);
            if (hub.triggerFeedbackReceiptMatches(receipt, report))
                return { status: 'confirmed', receipt };
        }
        catch {
            // An unavailable read is not evidence that the mutation did not commit.
        }
        return { status: 'unverified', reason: 'trigger_feedback_hub_unverified' };
    }
}