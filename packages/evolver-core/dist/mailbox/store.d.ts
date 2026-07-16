import { type Envelope, type Status, type CreateEnvelopeInput } from './envelope.js';
export declare const MAX_ATTEMPTS = 5;
export declare const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES: number;
export declare function expBackoffMs(attempt: number): number;
/** mailbox sqlite 引擎 (WAL + busy_timeout). 状态机 pending→in_flight→done/failed/expired + 租约 + 重试/DLQ. */
export declare class MailboxStore {
    private readonly db;
    constructor(opts: {
        path: string;
        busyTimeoutMs?: number;
    });
    /** 通用 KV 状态(M6: sync 游标 inbound_cursor / lifecycle reauth 退避 / node_id 等). */
    getState(key: string): string | undefined;
    setState(key: string, value: string): void;
    /** 投递; 同 id 幂等(OR IGNORE). 返回 receiptId. */
    send(e: Envelope): {
        receiptId: string;
        stored: boolean;
    };
    getById(id: string): Envelope | undefined;
    list(opts?: {
        status?: Status;
        handler?: string;
        runtimeNamespace?: string;
        type?: string;
        direction?: Envelope['direction'];
        typeDirections?: readonly {
            type: string;
            direction: Envelope['direction'];
        }[];
        newestFirst?: boolean;
        offset?: number;
        limit?: number;
    }): Envelope[];
    countMessages(opts?: {
        status?: Status;
        runtimeNamespace?: string;
        type?: string;
        direction?: Envelope['direction'];
    }): number;
    countByStatus(status: Status): number;
    /** pending 计数(可按 handler/runtimeNamespace 分区), 用于 agent wake 去抖. */
    countPending(handler?: string, runtimeNamespace?: string): number;
    /** 只统计「现在就能 claim」的出站, 供 cadence 判定, 避免 deferred 拉低 idle 退避.
     *  谓词须与 claim() 对齐: 到点 pending + 租约过期的 in_flight 孤儿; 否则孤儿出站(claim 能回收却不被计)会被误判 idle, 恢复最多慢一个 idle 周期. */
    countClaimable(handler: string, now: number, runtimeNamespace?: string): number;
    hasMessageWithIdempotencyKey(idempotencyKey: string): boolean;
    hasMessageWithPayload(type: string, payload: unknown): boolean;
    /** 原子 claim: pending(或租约过期的 in_flight) → in_flight + 租约. 可按 runtimeNamespace 分区. */
    claim(handler: string, limit: number, leaseMs: number, now: number, runtimeNamespace?: string): Envelope[];
    complete(id: string, now: number): void;
    /** 失败: attempts<N→退避回 pending; ≥N→DLQ(不自动丢). */
    fail(id: string, err: string, now: number, maxAttempts?: number): void;
    /** 暂缓: transient upstream outage 不消耗 attempts, 仅设置下次可 claim 时间. */
    defer(id: string, err: string, now: number, retryAfterMs: number): void;
    /** DLQ 重放(人工/agent 显式, 不自动丢). */
    replayDlq(id: string, now: number): void;
    dlq(): Envelope[];
    /** TTL 扫描: ttlAt 过期且未 done/dlq → expired. */
    expireOld(now: number): number;
    /** M2-5 关联线程: 同 correlationId 全部消息(请求+应答), 按 createdAt 排序. */
    findByCorrelation(correlationId: string): Envelope[];
    /** 关联线程中除 requestId 外最新一条 = 应答(durable, 跨重启/进程). */
    getReply(correlationId: string, requestId: string): Envelope | undefined;
    /** 构造并投递一条对 `to` 的应答(继承 correlationId, 收发方对调, replyTo 清空). */
    reply(to: Envelope, replyType: string, payload: unknown, now: number, over?: Partial<CreateEnvelopeInput>): {
        envelope: Envelope;
        receiptId: string;
        stored: boolean;
    };
    /** M2-5 轻量状态视图(运维/IPC 查询用). */
    getStatus(id: string): {
        id: string;
        type: string;
        status: Status;
        attempts: number;
        nextRetryAt: number | null;
        ttlAt: number | null;
        dlq: boolean;
    } | undefined;
    /** 幂等(A13): 副作用 handler 用 idempotencyKey 去重; 命中返缓存不重跑. */
    isProcessed(key: string): boolean;
    getProcessed(key: string): unknown;
    markProcessed(key: string, result: unknown, now: number): void;
    /** v1 messages.jsonl → sqlite 迁移(幂等可重入). */
    importJsonl(path: string): number;
    close(): void;
}