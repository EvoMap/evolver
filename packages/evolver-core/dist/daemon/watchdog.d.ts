/** 闸3: 外部 watchdog, 按 root_events 最后写入时间判挂死 (硬化 A8). 不依赖主进程自报活. */
export interface WatchdogOptions {
    lastWriteAt: () => number;
    stallThresholdMs: number;
    onStall: (idleMs: number) => void;
}
export declare class Watchdog {
    private readonly opts;
    constructor(opts: WatchdogOptions);
    check(now: number): boolean;
}