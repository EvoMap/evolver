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
export declare const HEALTH_WEIGHTS_VERSION = "gh-1";
export declare const DEFAULT_HEALTH_WEIGHTS: GeneHealthWeights;
/**
 * gene 健康分 = w1·successRate + w2·reuse归一 − w3·antiPattern密度.
 * 输入 = M3-6 聚合视图(不内联 learning_history) + anti_patterns 数 + 复用计数.
 */
export declare function geneHealthScore(view: GeneLearningView, opts?: {
    reuseCount?: number;
    antiPatternCount?: number;
}, w?: GeneHealthWeights): GeneHealth;