/**
 * StrategyPoint 框架(M4A-1a). 算法设计内核: 固定 cycle 骨架, 处处可插拔策略点.
 * 每个 StrategyPoint = 一处可换算法(分类/触发/选 gene/变异/...); 多实现注册, 一个 active, 其余可 shadow/A-B.
 * 经验主义: 不先验判优劣, 靠实验台(experiment.ts)按 fitness 选优.
 */
export interface StrategyContext {
    now: number;
    cycleId: string;
    /** Injected randomness for stochastic strategies (e.g. exploration drift). Defaults to Math.random; inject a seeded rng for deterministic tests. */
    rng?: () => number;
}
export interface Strategy<I, O> {
    readonly name: string;
    readonly version: string;
    run(input: I, ctx: StrategyContext): Promise<O> | O;
}
export declare class StrategyPoint<I, O> {
    readonly id: string;
    private readonly impls;
    private activeName;
    constructor(id: string, primary: Strategy<I, O>);
    register(s: Strategy<I, O>): this;
    setActive(name: string): this;
    active(): Strategy<I, O>;
    get(name: string): Strategy<I, O> | undefined;
    list(): Strategy<I, O>[];
    names(): string[];
    /** 跑 active, 透传 ctx. */
    run(input: I, ctx: StrategyContext): Promise<O> | O;
}