import type { RootEvent } from '../events/eventSchema.js';
import type { EventSink } from '../events/sink.js';
export interface ObserverMeta {
    name: string;
    eventTypes?: readonly string[];
    idempotent: boolean;
    timeoutMs: number;
}
export interface Observer {
    readonly meta: ObserverMeta;
    handle(event: Readonly<RootEvent>): void | Promise<void>;
}
export interface DlqEntry {
    observer: string;
    event: Readonly<RootEvent>;
    error: string;
    at: string;
    reason: 'throw' | 'timeout';
}
export declare class InvalidObserverMetaError extends Error {
    constructor(msg: string);
}
/** 进程内 observer bus (军杰§8): meta 强制 + quarantine + DLQ; 旁路, 故障绝不影响主写路径. */
export declare class ObserverBus implements EventSink {
    private readonly observers;
    private readonly quarantined;
    private readonly dlq;
    private readonly failCounts;
    private inflight;
    private readonly poisonThreshold;
    constructor(opts?: {
        poisonThreshold?: number;
    });
    register(observer: Observer): void;
    /** fan-out: 非阻塞, observer 故障隔离, 绝不向调用方抛. */
    dispatch(event: RootEvent): void;
    private run;
    private withTimeout;
    /** 等所有 inflight 完成 (优雅关闭/测试). */
    drain(): Promise<void>;
    isQuarantined(name: string): boolean;
    reset(name: string): void;
    deadLetters(): readonly DlqEntry[];
}