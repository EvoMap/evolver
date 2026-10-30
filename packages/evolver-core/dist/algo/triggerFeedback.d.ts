export type TriggerRating = 'good' | 'bad' | null;
export type TriggerOverrideSource = 'human' | 'judge_code' | 'goal_loop' | 'unknown';
export interface TriggerRatingCommit {
    runId: string;
    triggerId: string;
    revision: number;
    operationId: string;
    rating: TriggerRating;
}
export interface TriggerMachineOutcome {
    status: string;
    score: number | null;
    override: number | null;
    overrideSource: TriggerOverrideSource;
}
export interface TriggerFeedbackSnapshot {
    schemaVersion: 1;
    runId: string;
    triggerId: string;
    commit: TriggerRatingCommit | null;
    machine: TriggerMachineOutcome | null;
    baselineEventId: string | null;
    evaluatedAt: string | null;
    genes: readonly string[];
    signals: readonly string[];
    workspace: string | null;
    learningEligible?: boolean;
}
export interface TriggerFeedbackState {
    version: 1;
    snapshot: TriggerFeedbackSnapshot;
    operations: readonly TriggerRatingCommit[];
}
export declare class TriggerFeedbackConflictError extends Error {
    readonly code: 'stale_revision' | 'idempotency_conflict' | 'baseline_conflict' | 'operation_capacity';
    constructor(code: 'stale_revision' | 'idempotency_conflict' | 'baseline_conflict' | 'operation_capacity');
}
export declare function triggerEffectiveScore(snapshot: TriggerFeedbackSnapshot): number | null;
export declare function updateTriggerFeedbackState(prior: TriggerFeedbackState | undefined, incoming: TriggerFeedbackSnapshot): TriggerFeedbackState;
export declare function parseKernelTriggerFeedback(raw: unknown, runId: string): TriggerFeedbackSnapshot;