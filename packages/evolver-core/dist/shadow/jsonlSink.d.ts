import { BaseShadowSink, type ShadowRecord } from './sink.js';
/** append-only jsonl shadow 账本(WAL-safe append). 默认不存 payload 全文(只 payloadSize, M8-5). */
export declare class JsonlShadowSink extends BaseShadowSink {
    private readonly path;
    constructor(path: string, nowFn?: () => number);
    write(r: ShadowRecord): void;
    readAll(): ShadowRecord[];
}
/** 完全不落账本(EVOLVER_SHADOW_TELEMETRY=off). seen/markSeen 仍维护(去重不依赖落盘). */
export declare class NullShadowSink extends BaseShadowSink {
    write(): void;
}
/** 内存账本(测试). */
export declare class InMemoryShadowSink extends BaseShadowSink {
    readonly records: ShadowRecord[];
    write(r: ShadowRecord): void;
}