import { mailbox, hub as hubNs, shadow as shadow_, assetstore } from '@evomap/evolver-core';
import { SyncEngine, type OutboundResult, type InboundResult } from '../sync/engine.js';
import { LifecycleManager, type HelloLifecycleMode, type HelloResult, type HeartbeatOptions, type HeartbeatResult, type HeartbeatTickResult } from '../lifecycle/manager.js';
import { type SelfUpdateDeps } from '../selfUpdate/executor.js';
import type { AtpOrderConsentGate } from './atpConsent.js';
type HubCapability = hubNs.HubCapability;
type AssetStoreProvider = assetstore.AssetStoreProvider;
export declare const DEFAULT_IPC_PORT = 19820;
export interface ProxyDaemonDeps {
    hub: HubCapability;
    /** 二选一: 传 storePath 让 ProxyDaemon 建 store, 或传已建 store(供 hub senderId 共享同一 node_id). */
    storePath?: string;
    store?: mailbox.MailboxStore;
    ipcToken: string;
    ipcPort?: number;
    ipcHost?: string;
    runtimeNamespace?: string;
    now?: () => number;
    /** Random source for heartbeat force_update staggering. Defaults to Math.random; tests inject a deterministic value. */
    random?: () => number;
    /** 注入 adapter 的 /a2a/hello + heartbeat wire 调用(M6-6 提供; M6-4 测试用 fake). evolverVersion 随报供 hub 观测. */
    hello: (opts: {
        rotate: boolean;
        evolverVersion?: string;
    }) => Promise<HelloResult>;
    heartbeat: (opts?: HeartbeatOptions) => Promise<HeartbeatResult>;
    helloMode?: HelloLifecycleMode;
    lockPath?: string;
    /** M8 shadow: 'shadow'=publish/settle/push/complete/fail 只记录不执行(默认 enforce 正常). */
    shadowMode?: shadow_.ShadowMode;
    shadowSink?: shadow_.ShadowSink;
    /** 本地资产库: 支撑 /asset/* 与 /conversation/distill 的 Proxy MCP 兼容端点. */
    assetStore?: AssetStoreProvider;
    /** 未显式传 assetStore 时, 用该目录创建 LocalJsonlProvider; 缺省跟随 storePath 同目录. */
    assetStoreDir?: string;
    /** 可选 ATP 兼容路由实现. ProxyDaemon 只依赖窄接口; public/private adapter 在 bin 层装配. */
    atp?: AtpProxyClient;
    /** Consent gate for local /atp/order spend attempts. Missing gate fails closed. */
    atpOrderConsent?: AtpOrderConsentGate;
    /**
     * #108 自更新执行配置. 缺省 = 不接(force_update 入站只标完成, 不下载/不重启 — 半成品通道默认 OFF 的风险闸).
     * 提供时, force_update 入站经 core handler → executeForceUpdate(decide→verify→replace→restart).
     * download/atomicReplace/restart 是注入 I/O seam(bin 接真实, 测试用 fake); policy=off 时永不落地.
     */
    selfUpdate?: Omit<SelfUpdateDeps, 'currentVersion'> & {
        currentVersion?: string;
    };
    /** 当前 evolver 版本(getCurrentVersion); 随 hello/heartbeat 上报 hub(fleet 观测) + 喂 decideUpdate 的 current. */
    evolverVersion?: string;
    /** Best-effort hook for repairing local discovery state after a failed IPC auth attempt. */
    onIpcAuthFailure?: () => void;
    /** Best-effort hook after IPC is listening but before initial hello can block on Hub I/O. */
    onIpcListen?: (port: number) => void;
    /** Optional LLM trace backfill source. The daemon uses the shared mailbox store to continue bounded drains after outbound capacity frees. */
    traceBackfill?: {
        dir: string;
        env?: NodeJS.ProcessEnv;
    };
}
export interface ProxyTickReport {
    outbound: OutboundResult;
    inbound: InboundResult;
    heartbeat?: HeartbeatTickResult;
    errors?: ProxyTickError[];
    failedPhases?: ProxyTickPhase[];
    fatalCandidate?: boolean;
}
export type ProxyTickPhase = 'core' | 'outbound' | 'inbound' | 'heartbeat';
export interface ProxyTickError {
    phase: ProxyTickPhase;
    message: string;
}
export interface ProxyHealth {
    running: boolean;
    ipcListening: boolean;
    nodeId?: string;
    lastWriteAt: number;
}
export interface AtpProxyClient {
    placeOrder(opts: {
        capabilities: readonly string[];
        budget?: number;
        routingMode?: string;
        verifyMode?: string;
        question?: string;
        signals?: readonly string[];
        minReputation?: number;
    }): Promise<unknown>;
    submitDelivery(orderId: string, proofPayload?: unknown): Promise<unknown>;
    verifyDelivery(orderId: string, action?: string): Promise<unknown>;
    settleOrder(orderId: string): Promise<unknown>;
    disputeOrder(orderId: string, reason: string): Promise<unknown>;
    getMerchantTier(nodeId?: string): Promise<unknown>;
    getOrderStatus(orderId: string): Promise<unknown>;
    listProofs(opts?: {
        nodeId?: string;
        role?: string;
        status?: string;
        limit?: number;
    }): Promise<unknown>;
    getAtpPolicy(): Promise<unknown>;
}
/**
 * ProxyDaemon(M6-4) 装配层: 把 core(MailboxStore/Dispatcher/MailboxDaemon/IpcServer) +
 * HubBindings(M6-1) + SyncEngine(M6-2) + LifecycleManager(M6-3) 拼成系统级 proxy.
 * 职责分工(避免双 claim): MailboxDaemon 只 pump 'core'(本地确定性); proxy 出站归 SyncEngine.syncOutbound;
 * inbound 由 SyncEngine.syncInbound 从 hub 拉; agent 消息留给 runtime 经 IPC claim.
 */
export declare class ProxyDaemon {
    private readonly deps;
    readonly store: mailbox.MailboxStore;
    readonly dispatcher: mailbox.Dispatcher;
    readonly daemon: mailbox.MailboxDaemon;
    readonly sync: SyncEngine;
    readonly lifecycle: LifecycleManager;
    private readonly assetStore;
    private readonly remoteAssetById;
    private readonly reuseResultReporter;
    private readonly validator;
    private readonly atp;
    private ipc;
    private readonly now;
    private readonly random;
    private nextHeartbeatAt;
    private heartbeatFailures;
    private heartbeatGeneration;
    /** Resolver for an in-flight runner sleep(); set while sleeping, called to wake early on poke. */
    private wakeRunnerResolve;
    /** A poke that arrived between ticks (no sleep in flight) parks the wake here so it is not lost. */
    private wakeRunnerPending;
    private started;
    private storeClosed;
    private forceUpdateTriggerInFlight;
    private forceUpdateLastTriggeredAt;
    private forceUpdateLastTriggeredKey;
    private pendingForceUpdateDirective;
    private forceUpdateTimer;
    private scheduledForceUpdateKey;
    private traceBackfillDraining;
    private loopWakeHandler;
    constructor(deps: ProxyDaemonDeps);
    /**
     * core handler(确定性, 不经 agent): 目前只接 force_update(#108). 其他 core 类型(asset_publish_result/
     * feature_flag_update)仍由 Material/上层处理, 这里 no-op 标完成. force_update 仅当装配了 selfUpdate 才执行;
     * 否则只标完成(不下载/不重启 — 默认 OFF 风险闸). 永不抛: 失败转结构化 telemetry, daemon 续跑旧版本.
     */
    private handleCore;
    private recordTickError;
    /** 启动: 锁 + IPC 监听 + 初次 hello. 返回 IPC 端口. */
    start(): Promise<number>;
    /** 单轮: core pump/TTL/wake + proxy 出站 + hub 入站 + 到点心跳. */
    tick(): Promise<ProxyTickReport>;
    /** 下一轮建议延时: inbound 背压/idle 与 outbound pending cadence 取更快者. */
    nextDelay(last: InboundResult): number;
    setWakeHandler(wake: (() => void) | undefined): void;
    notifyNewOutbound(): void;
    /**
     * Expedite the next heartbeat: clear the failure backoff, mark the heartbeat due now, and wake an
     * in-flight runner sleep() so the next tick runs immediately. Wake-on-event for the pull-based
     * loop — the interruptible sleep() lets this preempt a long backoff wait the way V1's timer-driven
     * loop did (which armed a 0ms timer). The generation bump prevents a tick that was already in
     * flight from overwriting this reschedule. No-op until the daemon is started.
     */
    pokeHeartbeatLoop(): void;
    /**
     * Interruptible delay for the resident runner loop (bin/evolver-proxy.ts): resolves after `ms`, OR
     * immediately when pokeHeartbeatLoop() fires while sleeping. A poke that lands between ticks (before
     * the next sleep starts) sets wakeRunnerPending so the wake is not lost. The timer is unref'd so it
     * never keeps the process alive on its own.
     */
    sleep(ms: number): Promise<void>;
    private wakeRunner;
    health(): ProxyHealth;
    stop(): Promise<void>;
    private closeIpc;
    private closeIpcBestEffort;
    private closeStoreOnce;
    private drainProxyTraceBackfill;
    private recordHeartbeatResult;
    private recordHeartbeatTickException;
    private executeAndReportForceUpdate;
    private triggerForceUpdateFromHeartbeat;
    private startForceUpdateExecution;
    private reportPendingForceUpdate;
    private stateNumber;
    private handleProxyRoute;
    private searchAssets;
    private handleAtpRoute;
    private writeAtpJson;
}
export {};