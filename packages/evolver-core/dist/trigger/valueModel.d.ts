import type { ValueFactors } from '../schema/problem.js';
export interface ValueResult {
    score: number;
    factors: ValueFactors;
}
/** value = severity × reach × strategicFit × (1+novelty)/(1+costEst). 命名因子, 禁黑盒 (军杰§5.3). */
export declare function computeValue(f: ValueFactors): ValueResult;
/** Observation stats for one problem pattern, used to derive its value factors. */
export interface ProblemValueStats {
    occurrences: number;
    /** false for vague catch-all buckets (e.g. 'general'/'unknown') — they should NOT out-rank specific problems by sheer volume. */
    classified?: boolean;
    /** 0..1 hint from the failure-mode severity (caller maps its taxonomy → a number); default 0.5. */
    severity?: number;
    novelty?: number;
    costEst?: number;
}
/** occurrences that earn full reach — a FIXED scale, deliberately NOT normalized to the biggest bucket. */
export declare const REACH_FULL_AT = 30;
/**
 * Derive value factors from a problem's observation stats — the tuning learned from observing real agent logs
 * (evolver-v2-observation): a vague high-volume catch-all should not out-trigger specific, actionable problems.
 * So `reach` is on a FIXED occurrence scale (not normalized to the largest bucket, which crushes everything
 * specific), and `strategicFit` is reduced for unclassified problems. Feed the result to {@link computeValue}.
 */
export declare function deriveValueFactors(stats: ProblemValueStats): ValueFactors;