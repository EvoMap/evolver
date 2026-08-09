/**
 * Progressive curriculum signals, adapted from V1's curriculum producer.
 *
 * V2 keeps the policy pure and derives its history from the append-only root event log. This avoids V1's
 * separate mutable curriculum_state.json sidecar while preserving the behavior that matters to selection:
 * classify recent outcomes and add at most one capability-gap target plus one frontier target.
 */
export interface CurriculumOutcome {
    key: string;
    status: 'success' | 'failed';
}
export interface CurriculumBucket {
    key: string;
    success: number;
    failed: number;
    total: number;
    rate: number;
}
export interface CurriculumClassification {
    mastered: CurriculumBucket[];
    failing: CurriculumBucket[];
    frontier: CurriculumBucket[];
}
export interface CurriculumEventLike {
    type: string;
    payload?: unknown;
}
export interface GenerateCurriculumSignalsInput {
    outcomes: readonly CurriculumOutcome[];
    capabilityGaps?: readonly string[];
}
export declare const MAX_CAPABILITY_GAPS = 16;
export declare const CAPABILITY_GAPS_STATE_KEY = "curriculum:capability_gaps";
/** Normalize untrusted capability names before they cross adapter, persistence, or selection boundaries. */
export declare function normalizeCapabilityGaps(value: unknown): string[];
/** Versioned, bounded snapshot stored atomically in the lifecycle mailbox KV table. */
export declare function serializeCapabilityGapsState(capabilityGaps: unknown, observedAt: number): string;
/** Parse only the current bounded snapshot format. Unknown versions fail open without influencing selection. */
export declare function capabilityGapsFromState(value: unknown): string[];
/** Stable V2 equivalent of V1 computeSignalKey, excluding previously generated curriculum targets. */
export declare function curriculumSignalKey(signals: readonly string[]): string;
/** Classify signal-key outcomes using V1's thresholds. */
export declare function classifyCurriculumOutcomes(outcomes: readonly CurriculumOutcome[]): CurriculumClassification;
/** Generate no more than the two target families V1 produced: gap first, then closest frontier. */
export declare function generateCurriculumSignals(input: GenerateCurriculumSignalsInput): string[];
/**
 * Map V2's capability signal conventions to concrete curriculum gaps. A bare cap:* tag is not sufficient by
 * itself: it becomes a curriculum gap only when the same signal set explicitly declares capability_gap.
 */
export declare function capabilityGapsFromSignals(signals: readonly string[]): string[];
/**
 * Join cycle.signals_collected to terminal cycle events and retain the latest outcome window. `baseSignals`
 * wins over `signals`, so history-derived meta-signals do not become a self-reinforcing curriculum key.
 */
export declare function curriculumOutcomesFromEvents(events: readonly CurriculumEventLike[], maxOutcomes?: number): CurriculumOutcome[];