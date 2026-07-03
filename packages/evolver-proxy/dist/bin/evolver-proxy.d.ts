#!/usr/bin/env node
import { mailbox } from '@evomap/evolver-core';
import { type SelfUpdatePolicy } from '../selfUpdate/policy.js';
import { type ReleaseBinaryOptions } from '../selfUpdate/releaseBinary.js';
import type { AtpProxyClient, ProxyDaemonDeps, ProxyTickReport } from '../daemon/proxyDaemon.js';
import type { HelloLifecycleMode, HelloResult, HeartbeatOptions, HeartbeatResult } from '../lifecycle/manager.js';
import type { InboundResult } from '../sync/engine.js';
export declare function proxyUsage(): string;
export declare function runProxyCli(): void;
type PrivateAdapterImporter = (specifier: string) => Promise<unknown>;
export interface RuntimeDeps {
    mode: 'public' | 'private';
    hubUrl: string;
    senderId: () => string | undefined;
    store: mailbox.MailboxStore;
    env?: Record<string, string | undefined>;
    now?: () => number;
    privateImporter?: PrivateAdapterImporter;
}
export type PublicNodeSecretSource = 'env' | 'store' | 'hub_rotate' | 'legacy_file';
export interface PublicNodeSecretSelection {
    nodeSecret: string | undefined;
    nodeSecretVersion?: number;
    source: PublicNodeSecretSource;
    storeSecret?: string;
}
export interface HubRuntime {
    hub: ProxyDaemonDeps['hub'];
    hello: (opts: {
        rotate: boolean;
        evolverVersion?: string;
    }) => Promise<HelloResult>;
    heartbeat: (opts?: HeartbeatOptions) => Promise<HeartbeatResult>;
    helloMode?: HelloLifecycleMode;
    atp?: AtpProxyClient;
}
interface ProxyLoopDaemon {
    tick: () => Promise<ProxyTickReport>;
    nextDelay: (last: InboundResult) => number;
    sleep?: (delayMs: number) => Promise<void>;
    setWakeHandler?: (wake: (() => void) | undefined) => void;
}
interface ProxyLoopLogger {
    write: (chunk: string) => unknown;
}
export interface ProxyLoopOptions {
    minDelayMs?: number;
    errorDelayMs?: number;
    maxIterations?: number;
    sleep?: (delayMs: number) => Promise<void>;
    logger?: ProxyLoopLogger;
    /** 连续 tick throw 或 resolved fatal-candidate 达该值则抛错退出交 supervisor 重启; 默认 10; 瞬态成功会清零。 */
    maxConsecutiveTickFailures?: number;
}
export declare function runProxyLoop(daemon: ProxyLoopDaemon, options?: ProxyLoopOptions): Promise<void>;
interface CreateProxyDaemonDepsOptions {
    runtime: HubRuntime;
    store: mailbox.MailboxStore;
    ipcToken: string;
    ipcPort?: number;
    evolverVersion: string;
    selfUpdatePolicy: SelfUpdatePolicy;
    env?: NodeJS.ProcessEnv;
    selfUpdateOverrides?: ReleaseBinaryOptions & {
        restart?: () => void;
    };
}
export declare function createProxyDaemonDeps(options: CreateProxyDaemonDepsOptions): ProxyDaemonDeps;
export declare function createSelfUpdateDeps(policy: SelfUpdatePolicy, currentVersion: string, env?: NodeJS.ProcessEnv, overrides?: ReleaseBinaryOptions & {
    restart?: () => void;
}): ProxyDaemonDeps['selfUpdate'];
export declare function resolvePublicNodeSecret(deps: RuntimeDeps): PublicNodeSecretSelection;
/**
 * Hub rejected the cached node_secret as diverged (v1 a2aProtocol.js L1983-2017). Clear every
 * durable copy — store keys + on-disk legacy files — so the next start re-acquires cleanly via an
 * unauthenticated hello. The in-memory secret is already dropped by LegacyAuthShim before this runs.
 */
export declare function clearDivergedPublicNodeSecret(store: mailbox.MailboxStore, env?: NodeJS.ProcessEnv): void;
export declare function persistSelectedPublicNodeSecret(store: mailbox.MailboxStore, selection: PublicNodeSecretSelection): void;
export declare function persistPublicNodeSecretVersion(store: mailbox.MailboxStore, selection: PublicNodeSecretSelection, version: number | undefined): void;
export declare function connectHubRuntime(deps: RuntimeDeps): Promise<HubRuntime>;
export declare function resolveLegacyNodeSecret(envNodeSecret: string | undefined, storedNodeSecret: string | undefined, storedSource: string | undefined): string | undefined;
export {};