import { z } from 'zod';
import { extensions } from '../schema/common.js';
/**
 * PersonalityState = 可进化人格 (v1 src/gep/personality.js 的 v2 端口).
 *
 * 五维行为向量, 各 0..1, 决定进化"风格"而非"内容":
 *  - rigor          严谨度: 越高越保守/协议优先, 是高危变异的准入前提
 *  - creativity     创造性: 越高越倾向 innovate/explore, 跳出局部最优
 *  - verbosity      啰嗦度: 影响产物叙述密度 (纯 prompt 提示, 不改逻辑)
 *  - risk_tolerance 风险容忍: 越高越敢冒险, 但会被风险闸压制
 *  - obedience      服从度: 越高越贴合协议/用户指令
 *
 * 三条用途 (v2 必须保留语义, 见 riskGate.ts / prompt.ts / (PR-2) selection):
 *  1. 注入每轮 GEP prompt, 决定进化风格 (prompt.ts)
 *  2. 变异风险闸: high-risk/innovate 变异只在 rigor≥0.6 且 risk_tolerance≤0.5 放行 (riskGate.ts)
 *  3. 自然选择 + 小步变异自调参, 成功强化/失败淘汰, 全程进事件流可审计 (PR-2)
 */
/** 五维行为轴 (顺序固定 — personalityKey / 遍历依赖它). */
export const PERSONALITY_AXES = ['rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience'];
/** 保守默认: 协议优先、安全、低风险 (v1 defaultPersonalityState 原值). */
export const DEFAULT_PERSONALITY = Object.freeze({
    rigor: 0.7,
    creativity: 0.35,
    verbosity: 0.25,
    risk_tolerance: 0.4,
    obedience: 0.85,
});
const axis01 = z.number().min(0).max(1);
/** 五维人格状态. type 判别标签保留 (v1/事件流互认). */
export const personalityState = z.object({
    type: z.literal('PersonalityState').default('PersonalityState'),
    rigor: axis01.default(DEFAULT_PERSONALITY.rigor),
    creativity: axis01.default(DEFAULT_PERSONALITY.creativity),
    verbosity: axis01.default(DEFAULT_PERSONALITY.verbosity),
    risk_tolerance: axis01.default(DEFAULT_PERSONALITY.risk_tolerance),
    obedience: axis01.default(DEFAULT_PERSONALITY.obedience),
});
/** 一个人格键的运行统计 (自然选择的适应度原料; PR-2 回写). */
export const personalityStats = z.object({
    success: z.number().int().nonnegative().default(0),
    fail: z.number().int().nonnegative().default(0),
    /** 增量均值; n 为纳入均值的样本数. */
    avgScore: z.number().min(0).max(1).default(0.5),
    n: z.number().int().nonnegative().default(0),
    updatedAt: z.string().datetime().nullable().default(null),
});
/** 单条人格变更历史 (可审计; 也镜像进事件流). */
export const personalityHistoryEntry = z.object({
    at: z.string().datetime(),
    key: z.string(),
    outcome: z.string(),
    score: z.number().min(0).max(1).nullable().default(null),
    notes: z.string().nullable().default(null),
});
/** 持久化模型: 当前人格 + 各键统计 + 变更历史 (v1 loadPersonalityModel 的 v2 形状). */
export const personalityModel = z.object({
    version: z.literal(1).default(1),
    current: personalityState.default(() => personalityState.parse({})),
    stats: z.record(z.string(), personalityStats).default({}),
    history: z.array(personalityHistoryEntry).default([]),
    updatedAt: z.string().datetime().nullable().default(null),
    extensions,
});
/** 单个变异提案 (作用于一个轴, delta 会被 applyMutations 夹取). */
export const personalityMutation = z.object({
    type: z.literal('PersonalityMutation').default('PersonalityMutation'),
    param: z.enum(PERSONALITY_AXES),
    delta: z.number(),
    reason: z.string().default(''),
});
const clamp01 = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(1, n));
};
/**
 * 把任意输入夹成合法 PersonalityState (缺失/越界/非数 → 夹到 [0,1]).
 * 注意: 与 v1 一致, 非有限值夹为 0 而非默认值 — 显式坏输入不静默"复活"成保守默认.
 */
export function normalizePersonalityState(state) {
    const s = (state && typeof state === 'object' ? state : {});
    return {
        type: 'PersonalityState',
        rigor: clamp01(s['rigor']),
        creativity: clamp01(s['creativity']),
        verbosity: clamp01(s['verbosity']),
        risk_tolerance: clamp01(s['risk_tolerance']),
        obedience: clamp01(s['obedience']),
    };
}
/** 严格校验: type 标签对且五轴都是 [0,1] 有限数 (不做夹取, 用于信任边界). */
export function isValidPersonalityState(obj) {
    return personalityState.safeParse(obj).success && obj.type === 'PersonalityState';
}
function roundToStep(x, step) {
    if (!Number.isFinite(step) || step <= 0)
        return x;
    return Math.round(x / step) * step;
}
/**
 * 稳定桶键: 五轴各按 0.1 步长量化后拼串. 相近人格落同一桶, 统计才能积累 (v1 personalityKey).
 * 例: "rigor=0.7|creativity=0.4|verbosity=0.2|risk_tolerance=0.4|obedience=0.9"
 */
export function personalityKey(state) {
    const s = normalizePersonalityState(state);
    return PERSONALITY_AXES.map((k) => `${k}=${roundToStep(s[k], 0.1).toFixed(1)}`).join('|');
}
/** 由 personalityKey 反解回 PersonalityState (未识别轴回落默认; 自然选择需要). */
export function parseKeyToState(key) {
    const out = { ...DEFAULT_PERSONALITY };
    for (const part of String(key ?? '').split('|')) {
        const [k, v] = part.split('=').map((x) => x.trim());
        if (k && PERSONALITY_AXES.includes(k))
            out[k] = clamp01(v);
    }
    return normalizePersonalityState(out);
}
export { clamp01 };