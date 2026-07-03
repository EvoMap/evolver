import { type PersonalityMutation, type PersonalityStateInput } from './schema.js';
/**
 * 何时/如何小步变异人格 (v1 proposeMutations / shouldTriggerPersonalityMutation + mutation.js 的信号判定端口).
 * 这是"自调参"的规则引擎: 根据信号/失败连击提出对人格向量的小 nudge, 由 applyPersonalityMutations 落地.
 */
/** 机会信号: 表示"有创新余地"而非只是修 bug (v1 OPPORTUNITY_SIGNALS). */
export declare const OPPORTUNITY_SIGNALS: readonly string[];
/** signals 里是否有机会信号 (精确名或 `name:` 前缀). */
export declare function hasOpportunitySignal(signals: readonly unknown[] | undefined): boolean;
/** signals 里是否有错误类信号 (但 issue_already_resolved / openclaw_self_healed 例外为 false). */
export declare function hasErrorishSignal(signals: readonly unknown[] | undefined): boolean;
export interface ProposeMutationsInput {
    baseState: PersonalityStateInput;
    reason?: string;
    driftEnabled?: boolean;
    signals?: readonly string[];
}
/**
 * 依上下文提出一组人格变异 (v1 proposeMutations). 分支优先级:
 *  drift → 提创造性(风险回夹) / protocol_drift → 提服从&严谨 / 错误 → 提严谨降风险 /
 *  机会 → 提创造性&风险 / 否则(平台期) → 微提创造性降啰嗦.
 * 若 obedience 已饱和(≥0.95), 把服从类变异换成创造性.
 */
export declare function proposeMutations(input: ProposeMutationsInput): PersonalityMutation[];
/** 一条 cycle 事件在触发判定里的最小形状. */
export interface TriggerCycleEvent {
    outcome?: {
        status?: string;
    } | null;
    mutationId?: string;
}
export interface TriggerDecision {
    ok: boolean;
    reason: string;
}
/**
 * 是否该触发一次人格变异 (v1 shouldTriggerPersonalityMutation):
 *  - driftEnabled ⇒ 总触发
 *  - 最近 6 事件里, 后 4 个有 ≥3 个 failed ⇒ 长失败连击
 *  - 带 mutation_id 的最近 3 个事件全 failed ⇒ 变异连续失败
 */
export declare function shouldTriggerPersonalityMutation(args: {
    driftEnabled?: boolean;
    recentEvents?: readonly TriggerCycleEvent[];
}): TriggerDecision;