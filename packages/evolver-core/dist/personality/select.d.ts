import { type AppliedMutation } from './mutate.js';
import { type TriggerCycleEvent } from './drift.js';
import { type PersonalityAxis, type PersonalityModel, type PersonalityState } from './schema.js';
/**
 * 每轮人格选择 (v1 selectPersonalityForRun 端口): 自然选择微调 + 规则触发变异, 全在人格向量上小步演化.
 * 说明: v1 还消费 reflection.suggested_mutations, 那是独立子系统, 不在 evolver-core personality 范围内 —— 本端口不含.
 */
/** 单周期最多落地几条变异 (v1: 防漂移, 总量封顶 4). */
export declare const MAX_MUTATIONS_PER_CYCLE = 4;
/** 自然选择只对差异 ≥ 此阈值的轴动手 (v1). */
export declare const NATURAL_SELECTION_MIN_DIFF = 0.05;
/** 自然选择每条 nudge 的夹取幅度 (v1: ±0.1). */
export declare const NATURAL_SELECTION_CLIP = 0.1;
export interface ParamDelta {
    param: PersonalityAxis;
    delta: number;
}
/** 两状态间各轴差 (b-a), 按 |delta| 降序 (v1 getParamDeltas). */
export declare function getParamDeltas(from: PersonalityState, to: PersonalityState): ParamDelta[];
export interface SelectInput {
    driftEnabled?: boolean;
    signals?: readonly string[];
    recentEvents?: readonly TriggerCycleEvent[];
}
export interface SelectResult {
    model: PersonalityModel;
    state: PersonalityState;
    key: string;
    known: boolean;
    mutations: AppliedMutation[];
    meta: {
        bestKnownKey: string | null;
        bestKnownScore: number | null;
        triggered: {
            reason: string;
        } | null;
    };
}
/**
 * 纯函数: 给定 model + 上下文, 算出本轮人格 (含微调), 返回新 model + 选择结果.
 * 不落盘 —— store-backed 包装在 applySelectForRun (见 evolveOps.ts) 里持久化.
 * 顺序 (与 v1 一致):
 *  1. 自然选择: 朝 best-known 桶靠拢 (最多 2 轴, 差≥0.05, 每条夹 ±0.1)
 *  2. 触发式变异: shouldTrigger → proposeMutations → apply (总量与①合并封顶 4)
 */
export declare function selectPersonalityForRun(model: PersonalityModel, input?: SelectInput): SelectResult;