export declare const TRIGGER_SHIFT_METHOD_VERSION = "trigger-shift-v1";
/** @experimental Shift dimension for a semantically paired replay task. */
export type TriggerShiftAxis = 'wrapper_trigger' | 'temporal_context' | 'instruction_phrasing';
/** @experimental One replay prompt variant in a trigger-shift pair. */
export interface TriggerShiftTask {
    id: string;
    prompt: string;
    wrapperTrigger?: string;
    temporalContext?: string;
    instructionPhrasing?: string;
}
/** @experimental Same objective, paired across one trigger/context shift axis. */
export interface TriggerShiftPair {
    id: string;
    objectiveId: string;
    axis: TriggerShiftAxis;
    expectedDecision: string;
    train: TriggerShiftTask;
    shifted: TriggerShiftTask;
}
/** @experimental Policy output normalized for replay scoring. */
export interface TriggerShiftDecision {
    label: string;
    confidence?: number;
}
/** @experimental Replay-only policy seam; callers own any model/tool execution. */
export interface TriggerShiftPolicy {
    id: string;
    predict(task: TriggerShiftTask): TriggerShiftDecision;
}
/** @experimental One paired replay result with train/shifted rewards and gap. */
export interface TriggerShiftPairResult {
    pairId: string;
    objectiveId: string;
    axis: TriggerShiftAxis;
    trainTaskId: string;
    shiftedTaskId: string;
    expectedDecision: string;
    trainDecision: string;
    shiftedDecision: string;
    trainReward: number;
    shiftedReward: number;
    gap: number;
}
/** @experimental Aggregate replay report; diagnostic only, not a selector input. */
export interface TriggerShiftReport {
    methodVersion: string;
    policyId: string;
    pairs: number;
    meanTrainReward: number;
    meanShiftedReward: number;
    meanGap: number;
    maxGap: number;
    rows: TriggerShiftPairResult[];
}
/**
 * @experimental Offline trigger-shift replay evaluator. It returns inert report
 * rows only: no trigger fires, no store writes, and no live selection updates.
 */
export declare function evaluateTriggerShift(policy: TriggerShiftPolicy, pairs: readonly TriggerShiftPair[]): TriggerShiftReport;
/** @experimental Tiny public calibration/demo suite; not a live threshold. */
export declare function smallTriggerShiftSuite(): TriggerShiftPair[];