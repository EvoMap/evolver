import { normalizePersonalityState } from './schema.js';
/**
 * 变异风险闸 (v1 src/gep/mutation.js 的 isHighRiskPersonality / isHighRiskMutationAllowed 端口).
 * PersonalityState 用途②: 决定敢不敢放行高危/创新变异.
 */
/** rigor 低于此值即视为"高危人格". */
export const HIGH_RISK_RIGOR_FLOOR = 0.5;
/** risk_tolerance 高于此值即视为"高危人格". */
export const HIGH_RISK_TOLERANCE_CEIL = 0.6;
/** 放行 high-risk 变异要求的 rigor 下限. */
export const ALLOW_HIGH_RISK_RIGOR_MIN = 0.6;
/** 放行 high-risk 变异要求的 risk_tolerance 上限. */
export const ALLOW_HIGH_RISK_TOLERANCE_MAX = 0.5;
/**
 * 保守定义: rigor 过低 或 risk_tolerance 过高 → 高危人格.
 * 缺省(无人格)返回 false — 无信息不主动扣帽子, 交由下游默认策略.
 */
export function isHighRiskPersonality(p) {
    if (!p)
        return false;
    const s = normalizePersonalityState(p);
    if (s.rigor < HIGH_RISK_RIGOR_FLOOR)
        return true;
    if (s.risk_tolerance > HIGH_RISK_TOLERANCE_CEIL)
        return true;
    return false;
}
/**
 * high-risk 变异只在 rigor≥0.6 且 risk_tolerance≤0.5 放行 (任务用途②的硬阈值).
 * 缺省(无人格)时按最保守假设处理: rigor=0, risk_tolerance=1 → 不放行.
 */
export function isHighRiskMutationAllowed(p) {
    const s = p ? normalizePersonalityState(p) : { rigor: 0, risk_tolerance: 1 };
    return s.rigor >= ALLOW_HIGH_RISK_RIGOR_MIN && s.risk_tolerance <= ALLOW_HIGH_RISK_TOLERANCE_MAX;
}
/** 安全信号: 追加到 Mutation.trigger_signals, 使降级在事件流里可审计. */
export const SAFETY_SIGNAL_AVOID_INNOVATE = 'safety:avoid_innovate_with_high_risk_personality';
export const SAFETY_SIGNAL_DOWNGRADE_HIGH_RISK = 'safety:downgrade_high_risk';
function uniq(arr) {
    return [...new Set(arr)];
}
/**
 * 对一条待执行的变异施加人格风险闸 (v1 buildMutation 内两条硬安全约束的端口):
 *  1. innovate + 高危人格 → 降级为 optimize/low (禁"高危人格 + 创新"组合)
 *  2. high-risk 且人格不满足放行阈值 → 降一档到 medium
 * 纯函数, 返回新 Mutation. cycleEngine 在 buildMutation 后调用它, 再 ingest mutation.built.
 */
export function gatePersonalityRisk(mutation, personality) {
    const signals = [];
    let category = mutation.category;
    let risk = mutation.risk_level;
    let expected = mutation.expected_effect;
    // 约束①: 高危人格下禁止 innovate — 降级为 optimize/low.
    if (category === 'innovate' && isHighRiskPersonality(personality)) {
        category = 'optimize';
        risk = 'low';
        expected = 'safety downgrade: optimize under high-risk personality (avoid innovate+high-risk combo)';
        signals.push(SAFETY_SIGNAL_AVOID_INNOVATE);
    }
    // 约束②: high-risk 变异要满足放行阈值, 否则降到 medium.
    if (risk === 'high' && !isHighRiskMutationAllowed(personality)) {
        risk = 'medium';
        signals.push(SAFETY_SIGNAL_DOWNGRADE_HIGH_RISK);
    }
    const downgraded = signals.length > 0;
    if (!downgraded) {
        return { mutation, downgraded: false, appliedSignals: [] };
    }
    return {
        mutation: {
            ...mutation,
            category,
            risk_level: risk,
            expected_effect: expected,
            trigger_signals: uniq([...mutation.trigger_signals, ...signals]),
        },
        downgraded: true,
        appliedSignals: signals,
    };
}