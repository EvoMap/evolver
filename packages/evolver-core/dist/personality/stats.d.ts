import { type PersonalityModel, type PersonalityStateInput, type PersonalityStats } from './schema.js';
/**
 * 人格适应度 + 统计回写 (v1 personalityScore / chooseBestKnownPersonality / updatePersonalityStats 端口).
 * 自然选择的"适者"由这里的分数决定; 每轮结果回写到对应人格桶, 供下一轮选择.
 */
/** 一个桶要参与"最佳已知"竞争的最小样本数 (v1: total<3 不计). */
export declare const MIN_SAMPLES_FOR_BEST = 3;
/** 样本权重饱和点 (v1: min(1, total/8)). */
export declare const SAMPLE_WEIGHT_FULL_AT = 8;
/**
 * 桶适应度分数 (v1 personalityScore):
 *  - Laplace 平滑成功率 p = (succ+1)/(total+2)  → 主导 (权重 0.75)
 *  - 质量代理 q = avgScore, 但乘 sampleWeight 惩罚小样本过度自信 (权重 0.25)
 */
export declare function personalityScore(entry: Partial<PersonalityStats> | undefined): number;
export interface BestKnown {
    key: string;
    score: number;
    entry: PersonalityStats;
}
/**
 * 选出"最佳已知"人格桶 (v1 chooseBestKnownPersonality): 只在样本≥MIN_SAMPLES_FOR_BEST 的桶里比 personalityScore.
 * 没有够样本的桶 ⇒ null (选择阶段就不做自然选择微调).
 */
export declare function chooseBestKnownPersonality(stats: Record<string, PersonalityStats> | undefined): BestKnown | null;
export interface UpdateStatsInput {
    /** 本轮所用人格 (缺省用 model.current). */
    personality?: PersonalityStateInput;
    outcome: 'success' | 'failed' | string;
    /** 0..1 质量分 (可选). */
    score?: number | null;
    notes?: string | null;
}
export interface UpdateStatsResult {
    model: PersonalityModel;
    key: string;
    entry: PersonalityStats;
}
/**
 * 把一轮结果回写到对应人格桶 (v1 updatePersonalityStats 的纯函数版):
 *  - success/fail 计数 +1
 *  - avgScore 增量更新 (仅当给了 score): avg += (s-avg)/n
 *  - history 追加一条 (含 outcome/score/notes)
 * 返回新 model (不落盘 —— 调用方用 store.save 持久化, 或 applyStatsUpdate 一步到位).
 */
export declare function updatePersonalityStats(model: PersonalityModel, input: UpdateStatsInput, at: string): UpdateStatsResult;