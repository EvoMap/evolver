import { normalizePersonalityState } from './schema.js';
/**
 * 何时/如何小步变异人格 (v1 proposeMutations / shouldTriggerPersonalityMutation + mutation.js 的信号判定端口).
 * 这是"自调参"的规则引擎: 根据信号/失败连击提出对人格向量的小 nudge, 由 applyPersonalityMutations 落地.
 */
/** 机会信号: 表示"有创新余地"而非只是修 bug (v1 OPPORTUNITY_SIGNALS). */
export const OPPORTUNITY_SIGNALS = [
    'user_feature_request',
    'user_improvement_suggestion',
    'perf_bottleneck',
    'capability_gap',
    'stable_success_plateau',
    'external_opportunity',
    'recurring_error',
    'unsupported_input_type',
    'evolution_stagnation_detected',
    'repair_loop_detected',
    'force_innovation_after_repair_loop',
    'tool_bypass',
    'curriculum_target',
    'issue_already_resolved',
    'openclaw_self_healed',
    'empty_cycle_loop_detected',
];
const ERROR_INDICATORS = ['log_error', 'error', 'exception', 'failed', 'unstable'];
function asStrings(signals) {
    return Array.isArray(signals) ? signals.map((s) => String(s ?? '')) : [];
}
/** signals 里是否有机会信号 (精确名或 `name:` 前缀). */
export function hasOpportunitySignal(signals) {
    const list = asStrings(signals);
    return OPPORTUNITY_SIGNALS.some((name) => list.includes(name) || list.some((s) => s.startsWith(`${name}:`)));
}
/** signals 里是否有错误类信号 (但 issue_already_resolved / openclaw_self_healed 例外为 false). */
export function hasErrorishSignal(signals) {
    const list = asStrings(signals);
    if (list.includes('issue_already_resolved') || list.includes('openclaw_self_healed'))
        return false;
    return list.some((sig) => {
        const s = sig.toLowerCase();
        return ERROR_INDICATORS.includes(s) || s.startsWith('errsig:') || s.startsWith('errsig_norm:');
    });
}
/**
 * 依上下文提出一组人格变异 (v1 proposeMutations). 分支优先级:
 *  drift → 提创造性(风险回夹) / protocol_drift → 提服从&严谨 / 错误 → 提严谨降风险 /
 *  机会 → 提创造性&风险 / 否则(平台期) → 微提创造性降啰嗦.
 * 若 obedience 已饱和(≥0.95), 把服从类变异换成创造性.
 */
export function proposeMutations(input) {
    const s = normalizePersonalityState(input.baseState);
    const sig = asStrings(input.signals);
    const r = String(input.reason ?? '');
    const mk = (param, delta, reason) => ({ type: 'PersonalityMutation', param, delta, reason });
    const muts = [];
    if (input.driftEnabled) {
        muts.push(mk('creativity', +0.1, r || 'drift enabled'));
        muts.push(mk('risk_tolerance', -0.05, 'drift safety clamp'));
    }
    else if (sig.includes('protocol_drift')) {
        muts.push(mk('obedience', +0.1, r || 'protocol drift'));
        muts.push(mk('rigor', +0.05, 'tighten protocol compliance'));
    }
    else if (sig.includes('log_error') || sig.some((x) => x.startsWith('errsig:') || x.startsWith('errsig_norm:'))) {
        muts.push(mk('rigor', +0.1, r || 'repair instability'));
        muts.push(mk('risk_tolerance', -0.1, 'reduce risky changes under errors'));
    }
    else if (hasOpportunitySignal(sig)) {
        muts.push(mk('creativity', +0.1, r || 'opportunity signal detected'));
        muts.push(mk('risk_tolerance', +0.05, 'allow exploration for innovation'));
    }
    else {
        muts.push(mk('creativity', +0.05, r || 'plateau creativity nudge'));
        muts.push(mk('verbosity', -0.05, 'reduce noise'));
    }
    if (s.obedience >= 0.95) {
        const idx = muts.findIndex((m) => m.param === 'obedience');
        if (idx >= 0)
            muts[idx] = mk('creativity', +0.05, 'obedience saturated');
    }
    return muts;
}
/**
 * 是否该触发一次人格变异 (v1 shouldTriggerPersonalityMutation):
 *  - driftEnabled ⇒ 总触发
 *  - 最近 6 事件里, 后 4 个有 ≥3 个 failed ⇒ 长失败连击
 *  - 带 mutation_id 的最近 3 个事件全 failed ⇒ 变异连续失败
 */
export function shouldTriggerPersonalityMutation(args) {
    if (args.driftEnabled)
        return { ok: true, reason: 'drift enabled' };
    const tail = (Array.isArray(args.recentEvents) ? args.recentEvents : []).slice(-6);
    const outcomes = tail.map((e) => (e?.outcome?.status ? String(e.outcome.status) : null)).filter((x) => x != null);
    if (outcomes.length >= 4) {
        const recentFailed = outcomes.slice(-4).filter((x) => x === 'failed').length;
        if (recentFailed >= 3)
            return { ok: true, reason: 'long failure streak' };
    }
    const withMut = tail.filter((e) => typeof e?.mutationId === 'string' && e.mutationId);
    if (withMut.length >= 3) {
        const fail3 = withMut.slice(-3).filter((e) => e?.outcome?.status === 'failed').length;
        if (fail3 >= 3)
            return { ok: true, reason: 'mutation consecutive failures' };
    }
    return { ok: false, reason: '' };
}