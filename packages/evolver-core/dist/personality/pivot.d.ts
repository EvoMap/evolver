import { type AppliedMutation } from './mutate.js';
import { type PersonalityState, type PersonalityStateInput } from './schema.js';
/**
 * 平台期强制转向 (v1 forcePivot 端口): 检测到长期无改进时, 临时拉高创造性 + 风险容忍进入探索模式.
 * 纯函数 —— 返回新状态 + 实际落地的变异 (仍受 applyPersonalityMutations 的 ±0.2 夹取与最多 2 条约束);
 * 是否持久化 / 记事件由调用方 (orchestrator / cycleEngine 接线) 决定.
 */
export type PivotSeverity = 'suggested' | 'required';
export interface ForcePivotInput {
    base: PersonalityStateInput;
    severity?: PivotSeverity;
    evalsSinceImprovement?: number;
}
export interface ForcePivotResult {
    state: PersonalityState;
    mutations: AppliedMutation[];
    severity: PivotSeverity;
}
/**
 * required: creativity +0.2 / risk_tolerance +0.15 (更激进)
 * suggested: creativity +0.15 / risk_tolerance +0.1
 */
export declare function forcePivot(input: ForcePivotInput): ForcePivotResult;