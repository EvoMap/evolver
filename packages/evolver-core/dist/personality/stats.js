import { clamp01, normalizePersonalityState, personalityKey, } from './schema.js';
/**
 * 人格适应度 + 统计回写 (v1 personalityScore / chooseBestKnownPersonality / updatePersonalityStats 端口).
 * 自然选择的"适者"由这里的分数决定; 每轮结果回写到对应人格桶, 供下一轮选择.
 */
/** 一个桶要参与"最佳已知"竞争的最小样本数 (v1: total<3 不计). */
export const MIN_SAMPLES_FOR_BEST = 3;
/** 样本权重饱和点 (v1: min(1, total/8)). */
export const SAMPLE_WEIGHT_FULL_AT = 8;
/**
 * 桶适应度分数 (v1 personalityScore):
 *  - Laplace 平滑成功率 p = (succ+1)/(total+2)  → 主导 (权重 0.75)
 *  - 质量代理 q = avgScore, 但乘 sampleWeight 惩罚小样本过度自信 (权重 0.25)
 */
export function personalityScore(entry) {
    const succ = Number(entry?.success) || 0;
    const fail = Number(entry?.fail) || 0;
    const total = succ + fail;
    const p = (succ + 1) / (total + 2);
    const sampleWeight = Math.min(1, total / SAMPLE_WEIGHT_FULL_AT);
    const avg = entry?.avgScore;
    const q = Number.isFinite(Number(avg)) ? clamp01(Number(avg)) : 0.5;
    return p * 0.75 + q * 0.25 * sampleWeight;
}
/**
 * 选出"最佳已知"人格桶 (v1 chooseBestKnownPersonality): 只在样本≥MIN_SAMPLES_FOR_BEST 的桶里比 personalityScore.
 * 没有够样本的桶 ⇒ null (选择阶段就不做自然选择微调).
 */
export function chooseBestKnownPersonality(stats) {
    let best = null;
    for (const [key, entry] of Object.entries(stats ?? {})) {
        const total = (Number(entry?.success) || 0) + (Number(entry?.fail) || 0);
        if (total < MIN_SAMPLES_FOR_BEST)
            continue;
        const score = personalityScore(entry);
        if (!best || score > best.score)
            best = { key, score, entry };
    }
    return best;
}
/**
 * 把一轮结果回写到对应人格桶 (v1 updatePersonalityStats 的纯函数版):
 *  - success/fail 计数 +1
 *  - avgScore 增量更新 (仅当给了 score): avg += (s-avg)/n
 *  - history 追加一条 (含 outcome/score/notes)
 * 返回新 model (不落盘 —— 调用方用 store.save 持久化, 或 applyStatsUpdate 一步到位).
 */
export function updatePersonalityStats(model, input, at) {
    const st = normalizePersonalityState(input.personality ?? model.current);
    const key = personalityKey(st);
    const prev = model.stats[key];
    const entry = prev
        ? { ...prev }
        : { success: 0, fail: 0, avgScore: 0.5, n: 0, updatedAt: null };
    const outcome = String(input.outcome ?? '').toLowerCase();
    if (outcome === 'success')
        entry.success += 1;
    else if (outcome === 'failed')
        entry.fail += 1;
    const sc = input.score == null ? null : (Number.isFinite(Number(input.score)) ? clamp01(Number(input.score)) : null);
    if (sc != null) {
        const n = entry.n + 1;
        entry.avgScore = entry.avgScore + (sc - entry.avgScore) / n;
        entry.n = n;
    }
    entry.updatedAt = at;
    const nextStats = { ...model.stats, [key]: entry };
    const historyEntry = {
        at,
        key,
        outcome: outcome === 'success' || outcome === 'failed' ? outcome : 'unknown',
        score: sc,
        notes: input.notes ? String(input.notes).slice(0, 220) : null,
    };
    // v1 parity: 回写只动 stats + history, 不改 model.current —— current 由 select/pivot 决定, 记账不该挪它.
    const nextModel = {
        ...model,
        stats: nextStats,
        history: [...model.history, historyEntry],
    };
    return { model: nextModel, key, entry };
}