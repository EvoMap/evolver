/** 闸1: cycle-local 状态每轮 reset (D15/军杰附录A). 新 cycle = 新 context, 结束销毁. */
export declare class CycleContext {
    readonly cycleId: string;
    private readonly local;
    private disposed;
    constructor(cycleId: string);
    set<T>(k: string, v: T): void;
    get<T>(k: string): T | undefined;
    has(k: string): boolean;
    dispose(): void;
    private assertLive;
}