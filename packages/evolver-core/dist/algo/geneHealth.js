export const HEALTH_WEIGHTS_VERSION = 'gh-2';
export const DEFAULT_HEALTH_WEIGHTS = { successRate: 0.6, reuse: 0.1, antiPattern: 0.4 };
/** reuseCount 归一(对数压缩, 复用越多分越高但边际递减). */
function reuseScore(count) {
    return count <= 0 ? 0 : Math.min(1, Math.log10(count + 1) / 2); // 100 次≈封顶
}
/**
 * gene 健康分 = successRate·(w1 + w2·reuse归一) − w3·antiPattern密度.
 * 输入 = M3-6 聚合视图(不内联 learning_history) + anti_patterns 数 + 复用计数.
 */
export function geneHealthScore(view, opts = {}, w = DEFAULT_HEALTH_WEIGHTS) {
    const reuseCount = opts.reuseCount ?? view.total;
    const antiPatternPenalty = Math.min(1, (opts.antiPatternCount ?? 0) / 5); // 5+ anti-pattern 封顶惩罚
    const confidenceAdjustedSuccess = view.successRate * (w.successRate + w.reuse * reuseScore(reuseCount));
    const score = confidenceAdjustedSuccess - w.antiPattern * antiPatternPenalty;
    return { geneId: view.geneId, successRate: view.successRate, reuseCount, antiPatternPenalty, score };
}
/**
 * Whether a gene has any DECISIVE evidence behind its health score.
 *
 * `aggregateLearningHistory` divides successes by `success + failed`, excluding inert runs from both
 * sides, so a gene whose capsules are all inert — or which has never run — yields `successRate = 0` and
 * therefore `score = 0`. That zero means "nothing is known", not "known to be bad", and the two must not
 * render the same: showing 0% for an unproven gene is the same class of lie as showing a self-reported
 * 98%. A surface reporting a score must check this first and say "not assessed" when it is false.
 */
export function isGeneHealthAssessable(view) {
    return view.success + view.failed >= 1;
}
/**
 * The best score {@link geneHealthScore} can return under `w`: a gene with a perfect success rate, reuse
 * saturated, and no anti-patterns. Derived from the weights rather than hard-coded, so retuning them
 * cannot silently leave the display scale calibrated to the old ceiling.
 */
export function geneHealthScoreCeiling(w = DEFAULT_HEALTH_WEIGHTS) {
    return w.successRate + w.reuse;
}
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
export function normalizeGeneHealthScore(score, w = DEFAULT_HEALTH_WEIGHTS) {
    const ceiling = geneHealthScoreCeiling(w);
    if (!Number.isFinite(score) || ceiling <= 0)
        return 0;
    return Math.min(1, Math.max(0, score / ceiling));
}