import type { Strategy } from '../strategy/strategyPoint.js';
import { computeFitness, type FitnessSample, type FitnessScore, type FitnessWeights } from '../strategy/experiment.js';
export interface BenchmarkCase<I> {
    id: string;
    input: I;
}
export interface BenchmarkSuite<I, O> {
    name: string;
    cases: ReadonlyArray<BenchmarkCase<I>>;
    /** 评分: 给定 case 输入与策略输出, 产 fitness 样本(resolved/reuse/cost). */
    score: (input: I, output: O, caseId: string) => FitnessSample;
}
export interface BenchmarkRunResult {
    strategy: string;
    version: string;
    fitness: FitnessScore;
}
export interface BenchmarkReport {
    suite: string;
    results: BenchmarkRunResult[];
    winner: string;
}
/**
 * Benchmark 框架(M4-BM, D9). 对比进化算法各策略在同一题集上的 fitness, 排名选优.
 * EverOS/SkillOpt 作**对照基线**(原创为主, 非复刻); 算法自进化时拿它当锚.
 */
export declare function runBenchmark<I, O>(suite: BenchmarkSuite<I, O>, strategies: ReadonlyArray<Strategy<I, O>>, weights?: FitnessWeights): Promise<BenchmarkReport>;
/** EverOS 风格对照: 倾向复用既有 skill(reuse-first). 仅作比较锚, 非复刻. */
export declare function everosControl<I, O>(run: (input: I) => O): Strategy<I, O>;
/** SkillOpt 风格对照: 倾向优化单一最优 skill. 仅作比较锚, 非复刻. */
export declare function skillOptControl<I, O>(run: (input: I) => O): Strategy<I, O>;
export { computeFitness };