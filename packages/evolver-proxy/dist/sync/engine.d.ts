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
/**
 * SyncEngine(M6-2): proxy↔hub 双向同步. 移植 v1 sync/{engine,outbound,inbound} 到 TS,
 * hub I/O 全走 HubCapability.mailbox(非裸 hubFetch). tick 方法纯逻辑(注入 now), 可对 FakeHubCapability 确定性测;
 * 定时器循环(start/stop)是薄包装, 由 M6-4 daemon 装配驱动.
 */
export declare class SyncEngine {
    private readonly deps;
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
    private safeAck;
    /** AgentEvent → core Envelope; 未知类型(不在目录)跳过. */
    private toEnvelope;
}
export {};