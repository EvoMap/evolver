import type { Strategy, StrategyContext, StrategyPoint } from './strategyPoint.js';
/** 策略多指标适应度(算法草案§7). 权重可调, 初值 0.5/0.3/0.2(待实验校准). */
export interface FitnessWeights {
    resolved: number;
    reuse: number;
    cost: number;
}
export declare const DEFAULT_WEIGHTS: FitnessWeights;
export interface FitnessSample {
    resolvedByEvidence: boolean;
    reused: boolean;
    cost: number;
}
export interface FitnessScore {
    n: number;
    resolvedRate: number;
    reuseRate: number;
    avgCost: number;
    score: number;
}
/** fitness = w1·resolved_by_evidence率 + w2·capsule复用率 − w3·归一成本. */
export declare function computeFitness(samples: readonly FitnessSample[], w?: FitnessWeights): FitnessScore;
export interface ShadowResult<O> {
    active: O;
    activeName: string;
    shadows: Array<{
        name: string;
        output?: O;
        error?: string;
    }>;
}
/**
 * Shadow 评估: active 权威返回; 其余实现旁路跑同输入, 记录产出/异常供离线对比, 不影响主流程.
 * 实验台打底(算法草案§7): 所有候选先 shadow, 关键的才 A/B.
 */
export declare function runShadow<I, O>(sp: StrategyPoint<I, O>, input: I, ctx: StrategyContext): Promise<ShadowResult<O>>;
/** 确定性 A/B 分桶: 同 key 永远同变体(可复现, 不依赖随机). */
export declare function assignVariant(key: string, variants: readonly string[]): string;
/** A/B 路由: 按 ctx.cycleId 确定性选变体并跑. */
export declare function runAB<I, O>(sp: StrategyPoint<I, O>, variants: readonly string[], input: I, ctx: StrategyContext): Promise<{
    variant: string;
    output: O;
}>;
/**
 * 离线回放: 用历史输入集跑某策略, 由打分器产出 fitness 样本, 算总分.
 * 用途: 新策略上线前先离线对比 active(算法草案§7 offline replay).
 */
export declare function offlineReplay<I, O>(impl: Strategy<I, O>, inputs: readonly I[], score: (input: I, output: O) => FitnessSample, ctxOf: (i: number) => StrategyContext, w?: FitnessWeights): Promise<FitnessScore>;