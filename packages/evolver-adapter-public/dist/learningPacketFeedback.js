import { assertHubUrlSecure, isHubUnreachableError } from './hubFetch.js';
import { learningOpsAuthHeaders } from './learningPacketSink.js';
/** Hub appendLearningFeedbackSchema closed enums (evomap-hub src/schemas/learningOps.js). */
export const LEARNING_FEEDBACK_TYPES = ['outcome', 'rating', 'correction', 'governance', 'note'];
export const LEARNING_FEEDBACK_DECISIONS = [
    'accepted', 'rejected', 'needs_redaction', 'not_training_eligible', 'training_candidate', 'note',
];
function pickString(record, key) {
    const value = record[key];
    if (value === null)
        return null;
    return typeof value === 'string' ? value : undefined;
}
async function failureReason(res) {
    const text = await res.text().catch(() => '');
    return `hub ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
}
/**
 * Feedback append + packet governance read-back against the hub Learning Ops API. Best-effort by the
 * same contract as HubLearningPacketSink: this is observability/ops tooling, so every failure —
 * network, auth, 4xx/5xx, unparseable body — returns { ok:false, reason } and never throws.
 */
export class HubLearningPacketFeedbackClient {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async submitFeedback(packetId, feedback) {
        try {
            const path = `/api/learning-packets/${encodeURIComponent(packetId)}/feedback`;
            const url = `${this.opts.baseUrl}${path}`;
            assertHubUrlSecure(url);
            const headers = await learningOpsAuthHeaders(this.opts.auth, 'POST', path);
            // Exactly the appendLearningFeedbackSchema fields (strict zod): optional keys are omitted, not nulled.
            const res = await this.opts.fetchFn(url, {
                method: 'POST',
                headers,
                redirect: 'manual',
                body: JSON.stringify({
                    decision: feedback.decision,
                    ...(feedback.feedbackType !== undefined ? { feedbackType: feedback.feedbackType } : {}),
                    ...(feedback.rating !== undefined ? { rating: feedback.rating } : {}),
                    ...(feedback.scores !== undefined ? { scores: feedback.scores } : {}),
                    ...(feedback.rationale !== undefined ? { rationale: feedback.rationale } : {}),
                    ...(feedback.verifier !== undefined ? { verifier: feedback.verifier } : {}),
                    ...(feedback.failureCategory !== undefined ? { failureCategory: feedback.failureCategory } : {}),
                    ...(feedback.traceEventId !== undefined ? { traceEventId: feedback.traceEventId } : {}),
                    ...(feedback.actorNodeId !== undefined ? { actorNodeId: feedback.actorNodeId } : {}),
                }),
            });
            if (res.status === 201) {
                const body = await res.json().catch(() => null);
                const row = body && typeof body === 'object' ? body.feedback : undefined;
                return { ok: true, ...(typeof row?.id === 'string' ? { feedbackId: row.id } : {}) };
            }
            return { ok: false, reason: await failureReason(res) };
        }
        catch (e) {
            if (isHubUnreachableError(e))
                return { ok: false, reason: 'hub_unreachable' };
            return { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
    async getPacket(packetId) {
        try {
            const path = `/api/learning-packets/${encodeURIComponent(packetId)}`;
            const url = `${this.opts.baseUrl}${path}`;
            assertHubUrlSecure(url);
            const headers = await learningOpsAuthHeaders(this.opts.auth, 'GET', path);
            const res = await this.opts.fetchFn(url, { method: 'GET', headers, redirect: 'manual' });
            if (res.status !== 200)
                return { ok: false, reason: await failureReason(res) };
            const body = await res.json().catch(() => null);
            const packet = body && typeof body === 'object' ? body.packet : undefined;
            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
                return { ok: false, reason: 'hub 200: response missing packet object' };
            }
            const record = packet;
            if (typeof record['id'] !== 'string' || record['id'].length === 0) {
                return { ok: false, reason: 'hub 200: packet missing id' };
            }
            return {
                ok: true,
                packet: {
                    id: record['id'],
                    ...(pickString(record, 'status') !== undefined && pickString(record, 'status') !== null ? { status: record['status'] } : {}),
                    ...(pickString(record, 'outcomeStatus') !== undefined ? { outcomeStatus: pickString(record, 'outcomeStatus') } : {}),
                    ...(pickString(record, 'verifier') !== undefined ? { verifier: pickString(record, 'verifier') } : {}),
                    ...(pickString(record, 'trainingEligibilityStatus') !== undefined ? { trainingEligibilityStatus: pickString(record, 'trainingEligibilityStatus') } : {}),
                    ...(pickString(record, 'governanceStatus') !== undefined ? { governanceStatus: pickString(record, 'governanceStatus') } : {}),
                    ...(typeof record['trainingEligible'] === 'boolean' ? { trainingEligible: record['trainingEligible'] } : {}),
                    ...(pickString(record, 'consentStatus') !== undefined ? { consentStatus: pickString(record, 'consentStatus') } : {}),
                    ...(pickString(record, 'redactionStatus') !== undefined ? { redactionStatus: pickString(record, 'redactionStatus') } : {}),
                    ...(pickString(record, 'retentionPolicy') !== undefined ? { retentionPolicy: pickString(record, 'retentionPolicy') } : {}),
                },
            };
        }
        catch (e) {
            if (isHubUnreachableError(e))
                return { ok: false, reason: 'hub_unreachable' };
            return { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
}