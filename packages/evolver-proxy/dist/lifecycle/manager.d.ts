import { mailbox, hub as hubNs } from '@evomap/evolver-core';
import type { ForceUpdateDirective } from '../selfUpdate/executor.js';
import { type LastUpdateAck, type LastUpdatePayload } from '../selfUpdate/lastUpdate.js';
type MailboxStore = mailbox.MailboxStore;
type AuthProvider = hubNs.AuthProvider;
export type HelloLifecycleMode = 'legacy' | 'enterprise_token';
export declare const DEFAULT_HEARTBEAT_INTERVAL_MS = 360000;
export declare const MIN_HEARTBEAT_INTERVAL_MS = 30000;
export declare const HEARTBEAT_BACKOFF_CAP_MS: number;
export declare const MAX_REAUTH_ATTEMPTS = 2;
export declare const REAUTH_BACKOFF_BASE_MS: number;
export declare const REAUTH_BACKOFF_MAX_MS: number;
export declare const HUB_UNREACHABLE_BACKOFF_MS = 60000;
export declare const HUB_UNREACHABLE_BACKOFF_MAX_MS: number;
export declare const MIN_HUB_UNREACHABLE_RETRY_MS = 1000;
export declare const MAX_LAST_ERROR_LENGTH = 1000;
export interface HelloResult {
    ok: boolean;
    authError?: boolean;
    nodeId?: string;
    rateLimitUntilMs?: number;
    error?: string;
    details?: unknown;
    retryAfterMs?: number;
    status?: string;
    httpStatus?: number;
    secretDiverged?: boolean;
}
export interface HeartbeatOptions {
    evolverVersion?: string;
    lastUpdate?: LastUpdatePayload;
}
export interface HeartbeatResult {
    ok: boolean;
    authError?: boolean;
    error?: string;
    details?: unknown;
    retryAfterMs?: number;
    status?: string;
    httpStatus?: number;
    lastUpdateAck?: LastUpdateAck;
    forceUpdate?: ForceUpdateDirective;
}
export interface HeartbeatTickResult {
    ok: boolean;
    reauthed: boolean;
    error?: string;
}
export interface LifecycleDeps {
    store: MailboxStore;
    auth: AuthProvider;
    /**
     * 注入: 真实 /a2a/hello 调用(adapter 实现, M6-6); rotate=true 时请求轮换 secret.
     * evolverVersion 传入当前节点版本, adapter 在 hello/heartbeat wire 体里上报(hub 观测 fleet 版本分布, #108).
     */
    hello: (opts: {
        rotate: boolean;
        evolverVersion?: string;
    }) => Promise<HelloResult>;
    /** 注入: 真实 heartbeat 调用. evolverVersion=当前节点版本, 由 adapter 写进 heartbeat payload 供 hub 观测. */
    heartbeat: (opts?: HeartbeatOptions) => Promise<HeartbeatResult>;
    /** Optional heartbeat-discovered force_update hook; ProxyDaemon owns the actual self-update deps. */
    onForceUpdateDirective?: (directive: ForceUpdateDirective, source: 'heartbeat_200' | 'heartbeat_426') => Promise<void> | void;
    now: () => number;
    heartbeatIntervalMs?: number;
    /** 当前 evolver 版本(proxy getCurrentVersion 读 package.json); 随 hello/heartbeat 上报, hub 据此推 force_update. */
    evolverVersion?: string;
    /** enterprise-token private mode keeps hello as verify/register only and never asks for node_secret rotation. */
    helloMode?: HelloLifecycleMode;
}
/**
 * LifecycleManager(M6-3): hello/heartbeat/reauth 状态机, 移植 v1 lifecycle/manager.js.
 * node_secret 解析下沉到 HubCapability.auth(M6-5 LegacyAuthShim 双轨); 本层只管:
 * 注册(hello, 持久化 node_id)、心跳节奏、403/401→auth.rotate() 退避(30m→4h, MAX 2 次)、hello 限流尊重.
 * 纯逻辑注入 now/hello/heartbeat → 对 FakeHubCapability 确定性测.
 */
export declare class LifecycleManager {
    private readonly deps;
    private reauthInProgress;
    constructor(deps: LifecycleDeps);
    get nodeId(): string | undefined;
    /** 当前上报版本(供 force_update 决策 / hub fleet 观测). */
    get version(): string | undefined;
    /** 注册. 尊重 hub hello 限流窗口; 成功持久化 node_id + 清 reauth 退避. 随报当前版本(hub 观测 fleet). */
    doHello(rotate?: boolean): Promise<HelloResult>;
    /** 心跳. authError → 触发 reauth 状态机. 随心跳上报当前版本(hub 观测 fleet, #108). */
    doHeartbeat(): Promise<HeartbeatTickResult>;
    nextHeartbeatDelay(consecutiveFailures?: number): number;
    private heartbeatFailureBackoffDelay;
    private recordHeartbeatException;
    /**
     * 403/401 重认证. 指数退避 30m→4h, 超 MAX_REAUTH_ATTEMPTS 长退避;
     * auth.rotate() 成功后重 hello(rotate) 再注册. 退避状态持久化(进程重启不复位).
     */
    reauthenticate(): Promise<boolean>;
    private setBackoff;
    private hubUnreachableWaitMs;
    private recordHubUnreachable;
    private clearLegacyNodeSecretVersion;
    private verifyReauthHeartbeat;
    private heartbeatOptions;
    private callHello;
    private handleLastUpdateAck;
    private maybeTriggerForceUpdate;
}
export {};