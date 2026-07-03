import type { AssetKind, PublishReceipt } from '../hub/capability.js';
/** shadow 模式. 默认 'enforce'(=正常执行, decorator 退化 pass-through, 零开销秒级回滚). 'shadow'=只记录. */
export type ShadowMode = 'shadow' | 'enforce';
export type ShadowAction = 'WOULD_PUBLISH' | 'WOULD_SETTLE' | 'WOULD_PUSH' | 'WOULD_STORE_PUT' | 'WOULD_MAILBOX_COMPLETE' | 'WOULD_MAILBOX_FAIL' | 'WOULD_INGEST';
/** WOULD-* 意图日志: shadow 下一切对线上有副作用的动作记录. payload 默认只存字节数(脱敏 M8-5). */
export interface ShadowRecord {
    seq: number;
    at: number;
    action: ShadowAction;
    assetId?: string;
    assetKind?: AssetKind;
    envelopeType?: string;
    claimId?: string;
    payloadSize?: number;
    /** v1 actual 对照槽(由对账器填, 非 sink 写). */
    shadowReceipt?: Pick<PublishReceipt, 'status' | 'reason' | 'terminal'>;
}
/** shadow sink 抽象. 实现: JsonlShadowSink / NullShadowSink / InMemoryShadowSink. */
export interface ShadowSink {
    now(): number;
    record(r: Omit<ShadowRecord, 'seq' | 'at'>): ShadowRecord;
    /** 去重镜像(补偿 store.put 不真写导致内存索引缺失, gotcha #2). */
    seen(assetId: string): boolean;
    markSeen(assetId: string): void;
}
/** 内存镜像 + 序号基类(各 sink 复用). */
export declare abstract class BaseShadowSink implements ShadowSink {
    protected readonly nowFn: () => number;
    protected seq: number;
    private readonly mirror;
    constructor(nowFn?: () => number);
    now(): number;
    abstract write(r: ShadowRecord): void;
    record(r: Omit<ShadowRecord, 'seq' | 'at'>): ShadowRecord;
    seen(assetId: string): boolean;
    markSeen(assetId: string): void;
}