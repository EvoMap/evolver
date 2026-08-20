import type { GeneLearningView } from '../assetstore/learningHistory.js';
/** 统一 gene 健康分(算法草案§7 自然选择反馈). 并 learning_history/epigenetic/anti_patterns. */
export interface GeneHealth {
    geneId: string;
    successRate: number;
    reuseCount: number;
    antiPatternPenalty: number;
    score: number;
}
export interface GeneHealthWeights {
    successRate: number;
    reuse: number;
    antiPattern: number;
}
export declare const HEALTH_WEIGHTS_VERSION = "gh-2";
export declare const DEFAULT_HEALTH_WEIGHTS: GeneHealthWeights;
/**
 * gene 健康分 = successRate·(w1 + w2·reuse归一) − w3·antiPattern密度.
 * 输入 = M3-6 聚合视图(不内联 learning_history) + anti_patterns 数 + 复用计数.
 */
export declare function geneHealthScore(view: GeneLearningView, opts?: {
    reuseCount?: number;
    antiPatternCount?: number;
}, w?: GeneHealthWeights): GeneHealth;
/**
 * Whether a gene has any DECISIVE evidence behind its health score.
 *
 * `aggregateLearningHistory` divides successes by `success + failed`, excluding inert runs from both
 * sides, so a gene whose capsules are all inert — or which has never run — yields `successRate = 0` and
 * therefore `score = 0`. That zero means "nothing is known", not "known to be bad", and the two must not
 * render the same: showing 0% for an unproven gene is the same class of lie as showing a self-reported
 * 98%. A surface reporting a score must check this first and say "not assessed" when it is false.
 */
export declare function isGeneHealthAssessable(view: Pick<GeneLearningView, 'success' | 'failed'>): boolean;
/**
 * The best score {@link geneHealthScore} can return under `w`: a gene with a perfect success rate, reuse
 * saturated, and no anti-patterns. Derived from the weights rather than hard-coded, so retuning them
 * cannot silently leave the display scale calibrated to the old ceiling.
 */
export declare function geneHealthScoreCeiling(w?: GeneHealthWeights): number;
/**
 * Map a raw health score onto [0, 1] for DISPLAY only.
 *
 * `geneHealthScore` is not a 0–1 quantity: under the default weights it tops out at 0.7 and floors at
 * -0.4 (the anti-pattern penalty). Rendering the raw number as a percentage would report a flawless gene
 * as 70%, so any surface showing a percentage has to rescale — and doing that at each surface is how two
 * surfaces end up disagreeing.
 *
 * Negative scores clamp to 0 rather than mapping the full [-ceiling_penalty, ceiling] range onto [0, 1]:
 * a linear map would place "no evidence at all" (raw 0) near the middle of the bar, which reads as a
 * passing grade for a gene that has proven nothing. The penalty is not lost, it is just not separately
 * legible below zero — callers that need it read `GeneHealth.score` / `antiPatternPenalty` directly.
 *
 * Never feed this back into selection: ranking consumes the raw score, and clamping there would make
 * every penalized gene tie at 0.
 */
export declare function normalizeGeneHealthScore(score: number, w?: GeneHealthWeights): number;