import { clamp01, normalizePersonalityState, } from './schema.js';
/** 单次变异的最大幅度 (v1 硬夹, 防人格被一步推飞). */
export const MAX_MUTATION_DELTA = 0.2;
/** 单次 apply 最多落地几条变异 (v1: 每周期最多 2 条, 防漂移). */
export const MAX_MUTATIONS_PER_APPLY = 2;
/**
 * 把一组变异提案落到人格状态上 (v1 applyPersonalityMutations 端口).
 * - 只认合法轴, 非数 delta 跳过
 * - 每条 delta 夹到 ±MAX_MUTATION_DELTA
 * - 落地后每轴仍夹回 [0,1]
 * - 最多落 MAX_MUTATIONS_PER_APPLY 条 (超出忽略)
 * 纯函数: 不改入参, 返回新状态 + 实际落地的变异列表.
 */
export function applyPersonalityMutations(state, mutations) {
    const cur = normalizePersonalityState(state);
    const applied = [];
    for (const m of mutations ?? []) {
        if (applied.length >= MAX_MUTATIONS_PER_APPLY)
            break;
        if (!m || typeof m !== 'object')
            continue;
        const param = m.param;
        // param 是五轴枚举 (schema z.enum(PERSONALITY_AXES)) — 天然排除 'type'; in 检查兜底手改数据.
        if (!(param in cur))
            continue;
        const delta = Number(m.delta);
        if (!Number.isFinite(delta))
            continue;
        const clipped = Math.max(-MAX_MUTATION_DELTA, Math.min(MAX_MUTATION_DELTA, delta));
        cur[param] = clamp01(cur[param] + clipped);
        applied.push({
            type: 'PersonalityMutation',
            param,
            delta: clipped,
            reason: String(m.reason ?? '').slice(0, 140),
        });
    }
    return { state: cur, applied };
}