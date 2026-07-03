/** 闸4: cycle_id 幂等键. 同 cycleId+opKey 的副作用只执行一次(daemon 重启 replay/重试不重复). */
export declare class IdempotencyGuard {
    private readonly path?;
    private readonly done;
    constructor(path?: string | undefined);
    private k;
    has(cycleId: string, opKey: string): boolean;
    once<T>(cycleId: string, opKey: string, fn: () => Promise<T> | T): Promise<T>;
    private persist;
    private load;
}