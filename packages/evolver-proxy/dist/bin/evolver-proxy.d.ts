#!/usr/bin/env node
import { mailbox } from '@evomap/evolver-core';
import { PrivateNodeCredentialStore } from '../private/nodeCredentialStore.js';
import { loadEnvFileFromEnv } from './envFile.js';
import { type SelfUpdatePolicy } from '../selfUpdate/policy.js';
import { type ReleaseBinaryOptions } from '../selfUpdate/releaseBinary.js';
import { rollbackDurableSelfUpdate, type SelfUpdateRecoveryOptions, type SelfUpdateRecoveryResult, type StagedBinaryProbe } from '../selfUpdate/transaction.js';
import { maybeRunWindowsUpdaterWorkerFromArgv } from '../selfUpdate/windowsUpdater.js';
import { maybeRunUnixRecoveryController } from '../selfUpdate/unixController.js';
import { maybeRunWindowsRecoveryController } from '../selfUpdate/windowsController.js';
import type { AtpProxyClient, ProxyDaemonDeps, ProxyTickReport } from '../daemon/proxyDaemon.js';
import type { HelloLifecycleMode, HelloResult, HeartbeatOptions, HeartbeatResult } from '../lifecycle/manager.js';
import type { InboundResult } from '../sync/engine.js';
/** evolver-proxy 系统级 daemon 入口(M6-7). EVOMAP_HUB_MODE/URL/NODE_SECRET 选址. */
export interface RunProxyMainOptions {
    environmentPrepared?: boolean;
    recoveryPrepared?: SelfUpdateRecoveryResult;
}
export declare function runProxyMain(options?: RunProxyMainOptions): Promise<void>;
export declare function recoverBoundDurableSelfUpdate(options: Omit<SelfUpdateRecoveryOptions, 'beforeJournalMutation'>): Promise<SelfUpdateRecoveryResult>;
export declare function loadProxyEnvFile(env: NodeJS.ProcessEnv): ReturnType<typeof loadEnvFileFromEnv>;
interface StartupClosableStore {
    close(): void;
}
interface StartupStoppableDaemon {
    stop(): Promise<void>;
}
interface RollbackPendingStartupOptions {
    storePath?: string;
    store?: StartupClosableStore;
    daemon?: StartupStoppableDaemon;
    startupError: unknown;
    env?: NodeJS.ProcessEnv;
    rollback?: typeof rollbackDurableSelfUpdate;
    openTelemetryStore?: (storePath: string) => StartupClosableStore;
    persistTelemetry?: (store: StartupClosableStore, recovery: SelfUpdateRecoveryResult) => void;
    logger?: {
        write(chunk: string): unknown;
    };
    processExecPath?: string;
}
export declare function rollbackPendingStartup(options: RollbackPendingStartupOptions): Promise<SelfUpdateRecoveryResult>;
export declare function startupRollbackExitCode(rollback: SelfUpdateRecoveryResult): 78;
export declare function proxyUsage(command?: string): string;
export interface RunProxyCliOptions {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    processExecPath?: string;
    runMain?: (options?: RunProxyMainOptions) => Promise<void>;
    recoverStartup?: typeof recoverBoundDurableSelfUpdate;
    runUnixRecoveryController?: typeof maybeRunUnixRecoveryController;
    runWindowsRecoveryController?: typeof maybeRunWindowsRecoveryController;
    runWindowsUpdaterWorker?: typeof maybeRunWindowsUpdaterWorkerFromArgv;
}
export interface ProxyCliPathOptions {
    home?: string;
    evomapHome?: string;
    store?: string;
    settings?: string;
    envFile?: string;
    help: boolean;
}
export declare function parseProxyCliPathOptions(argv: readonly string[]): ProxyCliPathOptions;
export declare function prepareProxyCliEnvironment(argv: readonly string[], env: NodeJS.ProcessEnv): {
    options: ProxyCliPathOptions;
    envFile: ReturnType<typeof loadEnvFileFromEnv>;
};
export declare function runProxyCli(options?: RunProxyCliOptions): Promise<number>;
type PrivateAdapterImporter = (specifier: string) => Promise<unknown>;
export interface RuntimeDeps {
    mode: 'public' | 'private';
    hubUrl: string;
    senderId: () => string | undefined;
    store: mailbox.MailboxStore;
    env?: Record<string, string | undefined>;
    now?: () => number;
    privateImporter?: PrivateAdapterImporter;
    privateNodeCredentialStore?: Pick<PrivateNodeCredentialStore, 'read' | 'write'>;
}
export type PublicNodeSecretSource = 'env' | 'store' | 'hub_rotate' | 'legacy_file';
export interface PublicNodeSecretSelection {
    nodeSecret: string | undefined;
    nodeId?: string;
    nodeSecretVersion?: number;
    source: PublicNodeSecretSource;
    storeSecret?: string;
}
export interface VerifiedPublicSender {
    senderId: () => string | undefined;
    adopt: (nodeId: string) => void;
}
export declare function createVerifiedPublicSender(initialNodeId?: string): VerifiedPublicSender;
export declare function adoptVerifiedPublicNodeId(store: mailbox.MailboxStore, selection: PublicNodeSecretSelection, sender: VerifiedPublicSender, nodeId: string): void;
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
    setExpectedNextTick?: (delayMs: number | undefined) => void;
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
export declare function runManagedProxyLoop(options: {
    daemon: ProxyLoopDaemon & StartupStoppableDaemon;
    store: StartupClosableStore;
    notifier: {
        readyOrThrow(): Promise<void>;
        stop(): void;
    };
    runLoop?: (daemon: ProxyLoopDaemon, options?: ProxyLoopOptions) => Promise<void>;
    logger?: ProxyLoopLogger;
}): Promise<void>;
interface CreateProxyDaemonDepsOptions {
    runtime: HubRuntime;
    store: mailbox.MailboxStore;
    hubMode?: 'public' | 'private';
    ipcToken: string;
    ipcPort?: number;
    evolverVersion: string;
    selfUpdatePolicy: SelfUpdatePolicy;
    env?: NodeJS.ProcessEnv;
    selfUpdateOverrides?: SelfUpdateRuntimeOverrides;
}
interface SelfUpdateRuntimeOverrides extends ReleaseBinaryOptions {
    restart?: () => void;
    stagedBinaryProbe?: StagedBinaryProbe;
    /** Test-only attestation seam. Production callers must use the real process executable. */
    supervisorAttested?: {
        processExecPath: string;
    };
}
export declare function createProxyDaemonDeps(options: CreateProxyDaemonDepsOptions): ProxyDaemonDeps;
export declare function createSelfUpdateDeps(policy: SelfUpdatePolicy, currentVersion: string, env?: NodeJS.ProcessEnv, overrides?: SelfUpdateRuntimeOverrides): ProxyDaemonDeps['selfUpdate'];
export declare function assertSelfUpdateProcessTargetBound(options: ReleaseBinaryOptions, allowUnresolvedTarget?: boolean): void;
export declare function resolvePublicNodeSecret(deps: RuntimeDeps): PublicNodeSecretSelection;
/**
 * Hub rejected the cached node_secret as diverged (v1 a2aProtocol.js L1983-2017). Clear every
 * durable copy — store keys + on-disk legacy files — so the next start re-acquires cleanly via an
 * unauthenticated hello. The in-memory secret is already dropped by LegacyAuthShim before this runs.
 */
export declare function clearDivergedPublicNodeSecret(store: mailbox.MailboxStore, env?: NodeJS.ProcessEnv): void;
export declare function persistSelectedPublicNodeSecret(store: mailbox.MailboxStore, selection: PublicNodeSecretSelection): void;
export declare function persistRotatedPublicNodeCredentials(store: mailbox.MailboxStore, selection: PublicNodeSecretSelection, secret: string, version: number | undefined): void;
export declare function persistPublicNodeSecretVersion(store: mailbox.MailboxStore, selection: PublicNodeSecretSelection, version: number | undefined): void;
export declare function connectHubRuntime(deps: RuntimeDeps): Promise<HubRuntime>;
export declare function resolveLegacyNodeSecret(envNodeSecret: string | undefined, storedNodeSecret: string | undefined, storedSource: string | undefined): string | undefined;
export {};