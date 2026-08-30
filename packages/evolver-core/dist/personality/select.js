import { applyPersonalityMutations } from './mutate.js';
import { chooseBestKnownPersonality } from './stats.js';
import { proposeMutations, shouldTriggerPersonalityMutation } from './drift.js';
import { normalizePersonalityState, parseKeyToState, personalityKey, PERSONALITY_AXES, } from './schema.js';
/**
 * 每轮人格选择 (v1 selectPersonalityForRun 端口): 自然选择微调 + 规则触发变异, 全在人格向量上小步演化.
 * 说明: v1 还消费 reflection.suggested_mutations, 那是独立子系统, 不在 evolver-core personality 范围内 —— 本端口不含.
 */
/** 单周期最多落地几条变异 (v1: 防漂移, 总量封顶 4). */
export const MAX_MUTATIONS_PER_CYCLE = 4;
/** 自然选择只对差异 ≥ 此阈值的轴动手 (v1). */
export const NATURAL_SELECTION_MIN_DIFF = 0.05;
/** 自然选择每条 nudge 的夹取幅度 (v1: ±0.1). */
export const NATURAL_SELECTION_CLIP = 0.1;
/** 两状态间各轴差 (b-a), 按 |delta| 降序 (v1 getParamDeltas). */
export function getParamDeltas(from, to) {
    const a = normalizePersonalityState(from);
    const b = normalizePersonalityState(to);
    return PERSONALITY_AXES
        .map((param) => ({ param, delta: b[param] - a[param] }))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
/**
 * 纯函数: 给定 model + 上下文, 算出本轮人格 (含微调), 返回新 model + 选择结果.
 * 不落盘 —— store-backed 包装在 applySelectForRun (见 evolveOps.ts) 里持久化.
 * 顺序 (与 v1 一致):
 *  1. 自然选择: 朝 best-known 桶靠拢 (最多 2 轴, 差≥0.05, 每条夹 ±0.1)
 *  2. 触发式变异: shouldTrigger → proposeMutations → apply (总量与①合并封顶 4)
 */
export function selectPersonalityForRun(model, input = {}) {
    let current = normalizePersonalityState(model.current);
    const applied = [];
    // ① 自然选择
    const best = chooseBestKnownPersonality(model.stats);
    if (best) {
        const bestState = parseKeyToState(best.key);
        const diffs = getParamDeltas(current, bestState).filter((d) => Math.abs(d.delta) >= NATURAL_SELECTION_MIN_DIFF);
        const muts = diffs.slice(0, 2).map((d) => ({
            type: 'PersonalityMutation',
            param: d.param,
            delta: Math.max(-NATURAL_SELECTION_CLIP, Math.min(NATURAL_SELECTION_CLIP, d.delta)),
            reason: 'natural_selection',
        }));
        const res = applyPersonalityMutations(current, muts);
        current = res.state;
        applied.push(...res.applied);
    }
    // ② 触发式变异 (受剩余额度约束)
    const trig = shouldTriggerPersonalityMutation({ driftEnabled: !!input.driftEnabled, recentEvents: input.recentEvents });
    if (trig.ok && applied.length < MAX_MUTATIONS_PER_CYCLE) {
        const proposals = proposeMutations({ baseState: current, reason: trig.reason, driftEnabled: !!input.driftEnabled, signals: input.signals });
        const res = applyPersonalityMutations(current, proposals);
        current = res.state;
        applied.push(...res.applied);
    }
    const key = personalityKey(current);
    const known = Boolean(model.stats[key]);
    const nextModel = { ...model, current };
    return {
        model: nextModel,
        state: current,
        key,
        known,
        mutations: applied,
        meta: {
            bestKnownKey: best?.key ?? null,
            bestKnownScore: best ? best.score : null,
            triggered: trig.ok ? { reason: trig.reason } : null,
        },
    };
}