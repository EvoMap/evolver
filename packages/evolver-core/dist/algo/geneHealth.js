export const HEALTH_WEIGHTS_VERSION = 'gh-1';
export const DEFAULT_HEALTH_WEIGHTS = { successRate: 0.6, reuse: 0.3, antiPattern: 0.4 };
/** reuseCount 归一(对数压缩, 复用越多分越高但边际递减). */
function reuseScore(count) {
    return count <= 0 ? 0 : Math.min(1, Math.log10(count + 1) / 2); // 100 次≈封顶
}
/**
 * gene 健康分 = w1·successRate + w2·reuse归一 − w3·antiPattern密度.
 * 输入 = M3-6 聚合视图(不内联 learning_history) + anti_patterns 数 + 复用计数.
 */
export function geneHealthScore(view, opts = {}, w = DEFAULT_HEALTH_WEIGHTS) {
    const reuseCount = opts.reuseCount ?? view.total;
    const antiPatternPenalty = Math.min(1, (opts.antiPatternCount ?? 0) / 5); // 5+ anti-pattern 封顶惩罚
    const score = w.successRate * view.successRate + w.reuse * reuseScore(reuseCount) - w.antiPattern * antiPatternPenalty;
    return { geneId: view.geneId, successRate: view.successRate, reuseCount, antiPatternPenalty, score };
}