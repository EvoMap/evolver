import { type RootEvent, type RawEvent } from './eventSchema.js';
/** 单行字节上限, 保 O_APPEND+write 在 ext4 的原子性 (军杰 §3.2). */
export declare const MAX_LINE_BYTES = 4096;
export declare class LineTooLargeError extends Error {
    readonly bytes: number;
    constructor(bytes: number);
}
export interface EventStoreOptions {
    path: string;
    /** Injectable clock for the event `ts` (ms epoch). Defaults to the real clock; inject for deterministic tests. */
    now?: () => number;
}
/** 唯一权威事件流 (AE). single-writer / append-only / seq 递增 / fsync. */
export declare class EventStore {
    readonly path: string;
    private readonly lockPath;
    private readonly now;
    private chain;
    constructor(opts: EventStoreOptions);
    /** 唯一写路径: 生成 seq/eventId/ts, 校验, 原子 append + fsync. */
    append(raw: RawEvent): Promise<RootEvent>;
    private appendLocked;
    /** 读全部事件 (跳过尾部半行/损坏行). */
    readAll(): RootEvent[];
    iterate(fromSeq?: number): Generator<RootEvent>;
    tail(n?: number): RootEvent[];
    /** 截断尾部半行 (崩溃恢复). */
    recover(): {
        truncated: boolean;
    };
    private lastSeqFromFile;
}