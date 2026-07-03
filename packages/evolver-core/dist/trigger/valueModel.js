/** value = severity × reach × strategicFit × (1+novelty)/(1+costEst). 命名因子, 禁黑盒 (军杰§5.3). */
export function computeValue(f) {
    const score = (f.severity * f.reach * f.strategicFit * (1 + f.novelty)) / (1 + f.costEst);
    return { score, factors: { ...f } };
}
/** occurrences that earn full reach — a FIXED scale, deliberately NOT normalized to the biggest bucket. */
export const REACH_FULL_AT = 30;
const UNCLASSIFIED_FIT = 0.35;
const CLASSIFIED_FIT = 0.9;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
/**
 * Derive value factors from a problem's observation stats — the tuning learned from observing real agent logs
 * (evolver-v2-observation): a vague high-volume catch-all should not out-trigger specific, actionable problems.
 * So `reach` is on a FIXED occurrence scale (not normalized to the largest bucket, which crushes everything
 * specific), and `strategicFit` is reduced for unclassified problems. Feed the result to {@link computeValue}.
 */
export function deriveValueFactors(stats) {
    return {
        severity: clamp01(stats.severity ?? 0.5),
        reach: clamp01(Math.max(0, stats.occurrences) / REACH_FULL_AT),
        strategicFit: stats.classified === false ? UNCLASSIFIED_FIT : CLASSIFIED_FIT,
        novelty: stats.novelty ?? 0,
        costEst: stats.costEst ?? 0.2,
    };
}