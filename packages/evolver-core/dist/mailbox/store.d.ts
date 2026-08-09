import { type Envelope, type Status, type CreateEnvelopeInput } from './envelope.js';
export declare const MAX_ATTEMPTS = 5;
export declare const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES: number;
export declare const DEFAULT_IMPORT_JSONL_MAX_BYTES: number;
export declare const DEFAULT_IMPORT_JSONL_MAX_RECORDS = 100000;
export declare const MAILBOX_CLAIM_OWNER: unique symbol;
export type ClaimedEnvelope = Envelope & {
    readonly [MAILBOX_CLAIM_OWNER]: string;
};
export type MailboxImportRecord = Readonly<{
    kind: 'message';
    envelope: Readonly<Envelope>;
}> | Readonly<{
    kind: 'update';
    id: string;
    fields: Readonly<Record<string, unknown>>;
}>;
export type PreparedMailboxImport = Readonly<{
    records: readonly MailboxImportRecord[];
    sourceRecords: number;
    messageCandidates: number;
    uniqueMessageCandidates: number;
    updateCandidates: number;
}>;
export type MailboxImportPreview = Readonly<{
    sourceRecords: number;
    messageCandidates: number;
    uniqueMessageCandidates: number;
    updateCandidates: number;
    insertedMessages: number;
    updatedMessages: number;
    managedMessages: number;
    protectedMessages: number;
}>;
export type MailboxJsonlImportErrorCode = 'line_too_large' | 'journal_too_large' | 'too_many_records' | 'invalid_utf8' | 'invalid_json' | 'invalid_record' | 'invalid_update' | 'unsupported_operation' | 'invalid_message';
export declare class MailboxJsonlImportError extends Error {
    readonly code: MailboxJsonlImportErrorCode;
    readonly line: number;
    constructor(code: MailboxJsonlImportErrorCode, line: number, message: string);
}
export declare function mailboxClaimOwner(envelope: Envelope): string | undefined;
export declare function expBackoffMs(attempt: number): number;
/** Read one mailbox state value without creating, migrating, or taking write ownership of the database. */
export declare function readMailboxState(path: string, key: string): string | undefined;
/**
 * Parse and normalize a V1 mailbox journal without opening or mutating a V2 mailbox.
 * The returned batch is sealed so dry-run and apply can consume the exact same records.
 */
export declare function prepareMailboxJsonlImport(source: string | number, options?: {
    maxLineBytes?: number;
    maxBytes?: number;
    maxRecords?: number;
    now?: number;
}): PreparedMailboxImport;
/** Preview a prepared import against an optional existing mailbox without creating or migrating it. */
export declare function previewPreparedMailboxImport(batch: PreparedMailboxImport, mailboxPath?: string): MailboxImportPreview;
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
    claim(handler: string, limit: number, leaseMs: number, now: number, runtimeNamespace?: string): ClaimedEnvelope[];
    complete(id: string, now: number): void;
    /** 失败: attempts<N→退避回 pending; ≥N→DLQ(不自动丢). */
    fail(id: string, err: string, now: number, maxAttempts?: number): void;
    /** 暂缓: transient upstream outage 不消耗 attempts, 仅设置下次可 claim 时间. */
    defer(id: string, err: string, now: number, retryAfterMs: number): void;
    deferUnlessProcessed(id: string, processedKey: string, err: string, now: number, retryAfterMs: number): boolean;
    failUnlessProcessed(id: string, processedKey: string, err: string, now: number, maxAttempts?: number): boolean;
    completeClaimed(id: string, now: number, claimOwner: string): boolean;
    /** Atomically complete the current worker's lease and persist its idempotency result. */
    completeClaimedAndMarkProcessed(id: string, processedKey: string, result: unknown, now: number, claimOwner: string): boolean;
    renewClaim(id: string, now: number, leaseMs: number, claimOwner: string): boolean;
    setClaimedCheckpoint(id: string, checkpoint: unknown, now: number, claimOwner: string): boolean;
    getClaimedCheckpoint(id: string): unknown | undefined;
    deferClaimed(id: string, err: string, now: number, retryAfterMs: number, claimOwner: string): boolean;
    failClaimed(id: string, err: string, now: number, claimOwner: string, maxAttempts?: number): boolean;
    /** Transition only the row held by the current worker, unless a concurrent success marker already exists. */
    deferClaimedUnlessProcessed(id: string, processedKey: string, err: string, now: number, retryAfterMs: number, claimOwner: string): boolean;
    /** Transition only the row held by the current worker, unless a concurrent success marker already exists. */
    failClaimedUnlessProcessed(id: string, processedKey: string, err: string, now: number, claimOwner: string, maxAttempts?: number): boolean;
    /** Atomically fail a non-leased intent and persist the replayable terminal result. */
    failAndMarkProcessedUnlessProcessed(id: string, blockingProcessedKeys: readonly string[], resultKey: string, result: unknown, err: string, now: number, maxAttempts?: number): boolean;
    /** Atomically fail the current worker's leased intent and persist the replayable terminal result. */
    failClaimedAndMarkProcessedUnlessProcessed(id: string, blockingProcessedKeys: readonly string[], resultKey: string, result: unknown, err: string, now: number, claimOwner: string, maxAttempts?: number): boolean;
    private transitionUnlessProcessed;
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
        priority: Envelope['priority'];
        attempts: number;
        nextRetryAt: number | null;
        ttlAt: number | null;
        dlq: boolean;
        lastError: string | null;
    } | undefined;
    /** 幂等(A13): 副作用 handler 用 idempotencyKey 去重; 命中返缓存不重跑. */
    isProcessed(key: string): boolean;
    getProcessed(key: string): unknown;
    markProcessed(key: string, result: unknown, now: number): void;
    replaceProcessed(key: string, result: unknown, now: number): void;
    /** Persist a monotonic outcome and its lightweight concurrency marker in one SQLite transaction. */
    replaceProcessedWithMarker(key: string, result: unknown, markerKey: string, markerResult: unknown, now: number): void;
    /** Backfill a concurrency marker only when the durable source result still satisfies the caller's predicate. */
    markProcessedIf(sourceKey: string, markerKey: string, markerResult: unknown, now: number, matches: (sourceResult: unknown) => boolean): boolean;
    deleteProcessed(keys: readonly string[]): void;
    private messageClaimOwner;
    /** Build the target-aware plan shared by preview and apply. */
    private buildPreparedImportPlan;
    /** Preview the exact import result against the current mailbox snapshot without writing to it. */
    previewPreparedImport(batch: PreparedMailboxImport): MailboxImportPreview;
    private writeImportedEnvelopeFields;
    /** Apply a parsed batch; planning and writes share one transaction and one normalized journal. */
    importPrepared(batch: PreparedMailboxImport): number;
    importJsonl(source: string | number): number;
    close(): void;
}