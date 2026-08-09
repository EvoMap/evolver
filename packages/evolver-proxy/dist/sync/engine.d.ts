import { mailbox, hub as hubNs } from '@evomap/evolver-core';
type MailboxStore = mailbox.MailboxStore;
type Envelope = mailbox.Envelope;
type HubCapability = hubNs.HubCapability;
/** 双线程轮询节奏(沿用 v1 常量). */
export declare const SYNC_INTERVALS: {
    readonly outboundIdle: 5000;
    readonly outboundPending: 1000;
    readonly inboundActive: 10000;
    readonly inboundIdle: 60000;
};
export declare const MAX_BATCH = 50;
export declare const IDLE_THRESHOLD_MS: number;
export interface SyncEngineDeps {
    store: MailboxStore;
    hub: HubCapability;
    /** = makeHubBindings(hub).asProxyHandler(); outbound 推送复用 Dispatcher 同一 handler. */
    proxyHandler: (e: Envelope) => Promise<unknown>;
    now: () => number;
    runtimeNamespace?: string;
    leaseMs?: number;
    /** Finalize durable facade state after the Hub accepted one outbound envelope. */
    onOutboundSucceeded?: (envelope: Envelope, result: unknown) => void | Promise<void>;
    /** Cache a durable facade terminal result after SyncEngine moved the envelope to DLQ. */
    onOutboundTerminal?: (envelope: Envelope, error: unknown) => void | Promise<void>;
    /** Return the durable marker that proves a racing facade request already reached external acceptance. */
    acceptedOutcomeKey?: (envelope: Envelope) => string | undefined;
    /** Return a replayable terminal result that must be committed atomically with the mailbox DLQ transition. */
    terminalOutcome?: (envelope: Envelope, error: unknown) => {
        key: string;
        result: unknown;
    } | undefined;
    /** Canonicalize an inbound envelope before durable insertion. */
    normalizeInboundEnvelope?: (envelope: Envelope) => Envelope;
    onOutboundFlushed?: (result: OutboundResult) => void | Promise<void>;
    env?: NodeJS.ProcessEnv;
}
export interface OutboundResult {
    sent: number;
    failed: number;
    terminal: number;
    deferred: number;
    authFailed?: boolean;
    authErrorMessage?: string;
}
export interface InboundResult {
    received: number;
    enqueued: number;
    nextPollAfterMs?: number;
    hasMore: boolean;
}
export declare class SyncEngine {
    private readonly deps;
    private readonly acceptedTaskOutboundMemory;
    private lastActivityAt;
    constructor(deps: SyncEngineDeps);
    /** 出站: claim proxy 消息 → 经 proxyHandler 推 hub → complete; 终态(publish reject)直进 DLQ 不重试(money-safety). */
    syncOutbound(limit?: number): Promise<OutboundResult>;
    /** 入站: poll hub → 去重 enqueue 到 MailboxStore → ack; 游标存 kv. 遵守 #1195 nextPollAfterMs. */
    syncInbound(): Promise<InboundResult>;
    /** #1195 背压: hub 给 nextPollAfterMs 优先(有 backlog→drain 立即, 否则遵守); 缺省回退 idle/active. */
    nextInboundDelay(last: InboundResult): number;
    nextOutboundDelay(): number;
    private isIdle;
    private markOk;
    private markError;
    private notifyOutboundFlushed;
    private normalizeOutbound;
    private outboundDedupKey;
    private acceptedTaskOutbound;
    private durableAcceptedTaskOutbound;
    private completeAcceptedOutcome;
    private rememberAcceptedTaskOutbound;
    private safeAck;
    /** AgentEvent → core Envelope; 未知类型(不在目录)跳过. */
    private toEnvelope;
}
export {};