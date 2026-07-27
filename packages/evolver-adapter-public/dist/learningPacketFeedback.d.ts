import type { hub } from '@evomap/evolver-core';
import { type FetchLike } from './hubFetch.js';
/** Hub appendLearningFeedbackSchema closed enums (evomap-hub src/schemas/learningOps.js). */
export declare const LEARNING_FEEDBACK_TYPES: readonly ["outcome", "rating", "correction", "governance", "note"];
export type LearningFeedbackType = (typeof LEARNING_FEEDBACK_TYPES)[number];
export declare const LEARNING_FEEDBACK_DECISIONS: readonly ["accepted", "rejected", "needs_redaction", "not_training_eligible", "training_candidate", "note"];
export type LearningFeedbackDecision = (typeof LEARNING_FEEDBACK_DECISIONS)[number];
export interface LearningPacketFeedbackInput {
    /** Default hub-side: 'outcome'. */
    feedbackType?: LearningFeedbackType;
    decision: LearningFeedbackDecision;
    /** 0..1 (hub-validated). */
    rating?: number;
    scores?: Record<string, unknown>;
    rationale?: string;
    /** Hub VERIFIERS enum member (e.g. 'automated_test', 'human'). */
    verifier?: string;
    /** Hub FAILURE_CATEGORIES enum member. */
    failureCategory?: string;
    /** Anchor the feedback to one trace event instead of the whole packet. */
    traceEventId?: string;
    actorNodeId?: string;
}
export type LearningFeedbackResult = {
    ok: true;
    feedbackId?: string;
} | {
    ok: false;
    reason: string;
};
/** Server-managed governance/eligibility state read back from GET /api/learning-packets/:id. */
export interface LearningPacketStatus {
    id: string;
    status?: string;
    outcomeStatus?: string | null;
    verifier?: string | null;
    /** LearningOpsTrainingEligibility mirror: pending/eligible/ineligible/revoked/expired. */
    trainingEligibilityStatus?: string | null;
    /** pending/approved/blocked/purge_requested. */
    governanceStatus?: string | null;
    trainingEligible?: boolean;
    consentStatus?: string | null;
    redactionStatus?: string | null;
    retentionPolicy?: string | null;
}
export type LearningPacketReadResult = {
    ok: true;
    packet: LearningPacketStatus;
} | {
    ok: false;
    reason: string;
};
export interface HubLearningPacketFeedbackClientOptions {
    baseUrl: string;
    auth: hub.AuthProvider;
    fetchFn: FetchLike;
}
/**
 * Feedback append + packet governance read-back against the hub Learning Ops API. Best-effort by the
 * same contract as HubLearningPacketSink: this is observability/ops tooling, so every failure —
 * network, auth, 4xx/5xx, unparseable body — returns { ok:false, reason } and never throws.
 */
export declare class HubLearningPacketFeedbackClient {
    private readonly opts;
    constructor(opts: HubLearningPacketFeedbackClientOptions);
    submitFeedback(packetId: string, feedback: LearningPacketFeedbackInput): Promise<LearningFeedbackResult>;
    getPacket(packetId: string): Promise<LearningPacketReadResult>;
}