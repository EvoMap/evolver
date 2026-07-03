import { type PersonalityMutation, type PersonalityState } from './schema.js';
/** 单次变异的最大幅度 (v1 硬夹, 防人格被一步推飞). */
export declare const MAX_MUTATION_DELTA = 0.2;
/** 单次 apply 最多落地几条变异 (v1: 每周期最多 2 条, 防漂移). */
export declare const MAX_MUTATIONS_PER_APPLY = 2;
export interface AppliedMutation extends PersonalityMutation {
    type: 'PersonalityMutation';
}
export interface ApplyResult {
    state: PersonalityState;
    applied: AppliedMutation[];
}
/**
 * 把一组变异提案落到人格状态上 (v1 applyPersonalityMutations 端口).
 * - 只认合法轴, 非数 delta 跳过
 * - 每条 delta 夹到 ±MAX_MUTATION_DELTA
 * - 落地后每轴仍夹回 [0,1]
 * - 最多落 MAX_MUTATIONS_PER_APPLY 条 (超出忽略)
 * 纯函数: 不改入参, 返回新状态 + 实际落地的变异列表.
 */
export declare function applyPersonalityMutations(state: unknown, mutations: readonly PersonalityMutation[] | undefined): ApplyResult;