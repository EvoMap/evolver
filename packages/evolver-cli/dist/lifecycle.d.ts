import { spawn } from 'node:child_process';
import { bootstrap as coreBootstrap, util as coreUtil } from '@evomap/evolver-core';
import { type BootstrapTransactionJournal, type BootstrapArtifactIdentity, type LegacyBootstrapMarkerRead } from './lifecycleBootstrapTransaction.js';
export declare function selectExistingPosixCommand(candidates: readonly string[], exists?: (path: string) => boolean): string;
export type ServiceTarget = 'launchd' | 'systemd' | 'windows';
export interface DaemonCommand {
    command: string;
    args: string[];
    display: string;
}
interface ProcessIdentity {
    executable?: string;
    parentPid?: number;
    startedAt?: number;
}
export interface LifecyclePaths {
    home: string;
    stateDir: string;
    logDir: string;
    pidFile: string;
    logFile: string;
    settingsFile: string;
}
export interface LifecycleStatus {
    running: boolean;
    pid?: number;
    healthy?: boolean;
    reason?: string;
    logFile?: string;
    startedAt?: string;
    url?: string;
}
export interface LifecycleResult {
    status: string;
    /** Durable transaction identity for bootstrap success results. */
    transactionId?: string;
    pid?: number;
    pids?: number[];
    healthy?: boolean;
    reason?: string;
    logFile?: string;
    files?: string[];
    /** Verified legacy companion files intentionally preserved and never removed. */
    preservedFiles?: string[];
    service?: string;
    autoexecHome?: string;
    actions?: string[];
    /** Files whose absent pre-state is owned by a first-run bootstrap transaction. */
    bootstrapArtifacts?: string[];
    /** Expected bytes recorded before a first-run bootstrap mutates the filesystem. */
    bootstrapArtifactIdentities?: Record<string, BootstrapArtifactIdentity>;
}
type UnixRecoveryControllerModule = Pick<typeof import('@evomap/evolver-proxy'), 'provisionStableUnixRecoveryController' | 'stableUnixRecoveryControllerPathForTarget' | 'UNIX_RECOVERY_CONTROLLER_ARG'> & Partial<Pick<typeof import('@evomap/evolver-proxy'), 'provisionStableWindowsRecoveryController'>>;
type LoadUnixRecoveryController = () => Promise<UnixRecoveryControllerModule>;
type InspectDurableSelfUpdate = typeof import('@evomap/evolver-proxy')['inspectDurableSelfUpdate'];
interface RunLifecycleDeps {
    argv1?: string;
    env?: NodeJS.ProcessEnv;
    loadUnixRecoveryController?: LoadUnixRecoveryController;
    removeAutoexecService?: (target: ServiceTarget, dryRun: boolean) => LifecycleResult;
    bootstrap?: BootstrapServiceDeps;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
export interface BootstrapServiceDeps {
    platform?: NodeJS.Platform;
    run?: (command: string, args: readonly string[], timeoutMs?: number) => ServiceControlResult;
    uid?: number;
    now?: () => number;
    lock?: {
        maxTries?: number;
        waitMs?: number;
    };
    health?: (paths: LifecyclePaths, env: NodeJS.ProcessEnv) => Promise<LifecycleStatus>;
    readiness?: (stateDir: string) => coreBootstrap.LifecycleBootstrapReadiness | undefined;
    readinessOwnerProcessStatus?: (owner: Pick<coreUtil.FileLockOwnerRecord, 'pid' | 'processStartIdentity'>) => coreUtil.FileLockOwnerProcessStatus;
    healthTimeoutMs?: number;
    install?: (target: ServiceTarget, flags: Record<string, string | true>, env: NodeJS.ProcessEnv, argv1: string | undefined, loadUnixRecoveryController?: LoadUnixRecoveryController, options?: InstallServiceOptions) => Promise<LifecycleResult>;
    writeMarker?: (path: string, marker: coreBootstrap.LifecycleBootstrapMarker) => void;
    inspectSelfUpdate?: InspectDurableSelfUpdate;
}
interface ServiceControlResult {
    status: number | null;
    error?: unknown;
    stdout?: string;
}
interface InstallServiceOptions {
    exclusive?: boolean;
    transactionId?: string;
    onArtifactPublished?: (path: string, claimPath: string) => void;
    assertOwner?: () => void;
}
export interface RemoveAutoexecServiceDeps {
    paths?: Partial<Record<ServiceTarget, string>>;
    run?: (command: string, args: readonly string[]) => ServiceControlResult;
    exists?: (path: string) => boolean;
    remove?: (path: string) => void;
    write?: (path: string, content: string, mode: number) => void;
    uid?: number;
}
export type SessionStartSpawn = (command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => ReturnType<typeof spawn>;
interface SessionStartAutostartDeps {
    stderr?: (text: string) => void;
    spawnDetached?: SessionStartSpawn;
    platform?: NodeJS.Platform;
}
export interface StopLifecycleDeps {
    processCommandLine?: (pid: number) => string | undefined;
    processIdentity?: (pid: number) => ProcessIdentity | undefined;
    platform?: NodeJS.Platform;
}
export declare function runLifecycleCommand(argv: readonly string[], deps?: RunLifecycleDeps): Promise<number>;
export declare function maybeAutoRestartProxyForSessionStart(env?: NodeJS.ProcessEnv, argv1?: string | undefined, deps?: SessionStartAutostartDeps): Promise<void>;
export declare function startLifecycle(paths: LifecyclePaths, env?: NodeJS.ProcessEnv): Promise<LifecycleResult>;
export declare function stopLifecycle(paths: LifecyclePaths, deps?: StopLifecycleDeps): LifecycleResult;
export declare function lifecycleStatus(paths: LifecyclePaths, env?: NodeJS.ProcessEnv, options?: {
    timeoutMs?: number;
    quietSettingsReadError?: boolean;
    stderr?: (text: string) => void;
}): Promise<LifecycleStatus>;
/** Extended connection status for `evolver daily`: includes hub_auth_status and last_sync_at from proxy. */
export interface DailyConnectionStatus extends LifecycleStatus {
    hubAuthStatus?: string;
    lastSyncAt?: string;
}
/** Fetch enriched connection status for the daily summary. Builds on lifecycleStatus, adding hub details. */
export declare function dailyConnectionStatus(paths: LifecyclePaths, env?: NodeJS.ProcessEnv, options?: {
    timeoutMs?: number;
    stderr?: (text: string) => void;
}): Promise<DailyConnectionStatus>;
export declare function lifecyclePaths(env?: NodeJS.ProcessEnv): LifecyclePaths;
export declare function renderSystemdUnit(opts?: {
    envFile?: string;
    workingDirectory?: string;
    execStart?: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
    selfUpdateTarget?: string;
    bootstrapTransactionId?: string;
}): string;
export declare function renderAutoexecSystemdUnit(opts: {
    envFile?: string;
    workingDirectory?: string;
    execStart: string;
}): string;
export declare function renderLaunchdPlist(opts?: {
    envFile?: string;
    workingDirectory?: string;
    nodePath?: string;
    proxyBin?: string;
    programArguments?: readonly string[];
    logDir?: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
    selfUpdateTarget?: string;
    label?: string;
    logName?: string;
    selfUpdateSupervisor?: boolean;
    bootstrapTransactionId?: string;
}): string;
export declare function renderAutoexecLaunchdPlist(opts: {
    envFile?: string;
    workingDirectory?: string;
    programArguments: readonly string[];
    logDir?: string;
}): string;
interface WindowsInstallerDefaults {
    evolverBin?: string;
    nodePath?: string;
    proxyBin?: string;
    envFile?: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
    bootstrapTransactionId?: string;
    wscriptPath?: string;
}
interface LegacyWindowsInstallerProof {
    family: 'v907' | 'v918';
    defaults: WindowsInstallerDefaults;
}
declare function parseLegacyWindowsInstallerDefaults(source: string): LegacyWindowsInstallerProof;
export declare const _parseLegacyWindowsInstallerDefaultsForTest: typeof parseLegacyWindowsInstallerDefaults;
declare function renderWindowsProxyLauncherBytes(defaults: WindowsInstallerDefaults): Buffer;
declare function renderLegacyWindowsProxyLauncherBytes(proof: LegacyWindowsInstallerProof): Buffer;
export declare const _renderWindowsProxyLauncherBytesForTest: typeof renderWindowsProxyLauncherBytes;
export declare function renderWindowsInstaller(defaults?: WindowsInstallerDefaults): string;
export declare function renderWindowsAutoexecInstaller(defaults?: {
    evolverBin?: string;
    nodePath?: string;
    cliBin?: string;
    envFile?: string;
    autoexecHome?: string;
    workingDirectory?: string;
    wscriptPath?: string;
}): string;
export declare const _renderLegacyWindowsProxyLauncherBytesForTest: typeof renderLegacyWindowsProxyLauncherBytes;
declare function renderFrozenLegacySystemdUnit(opts: {
    envFile?: string;
    workingDirectory?: string;
    execStart: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
    selfUpdateTarget?: string;
}): string;
declare function renderFrozenLegacyLaunchdPlist(opts: {
    envFile?: string;
    workingDirectory: string;
    programArguments: readonly string[];
    logDir: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
    selfUpdateTarget?: string;
}): string;
export declare const _renderFrozenLegacySystemdUnitForTest: typeof renderFrozenLegacySystemdUnit;
export declare const _renderFrozenLegacyLaunchdPlistForTest: typeof renderFrozenLegacyLaunchdPlist;
declare function legacyBootstrapArtifactPlan(legacy: LegacyBootstrapMarkerRead, planned: LifecycleResult, target: ServiceTarget, env: NodeJS.ProcessEnv, stateDir: string, legacyWindowsLauncherPath?: string, allowAbsentWindowsManager?: boolean, requireStateRootProof?: boolean, uid?: number): {
    paths: string[];
    expected: Record<string, BootstrapArtifactIdentity>;
    preserved: coreBootstrap.LifecycleBootstrapMarker['artifacts'];
    legacyStateRootProof?: coreBootstrap.LifecycleBootstrapLegacyStateRootProof;
};
export declare const _planLegacyBootstrapArtifactsForTest: typeof legacyBootstrapArtifactPlan;
declare function windowsTaskProbeCommand(): string;
export declare const _windowsTaskProbeCommandForTest: typeof windowsTaskProbeCommand;
declare function probeLegacyWindowsLauncherPath(run: (command: string, args: readonly string[], timeoutMs?: number) => ServiceControlResult, timeoutMs: number, expectedEnabled?: boolean): string;
export declare const _probeLegacyWindowsLauncherPathForTest: typeof probeLegacyWindowsLauncherPath;
export declare function validateSystemdBootstrapManagerBinding(journal: Pick<BootstrapTransactionJournal, 'transactionId' | 'managerBinding'>, unit: string, stdout: string, requireRunning?: boolean): number | undefined;
export declare function validateLaunchdBootstrapManagerBinding(journal: Pick<BootstrapTransactionJournal, 'transactionId' | 'managerBinding'>, plist: string, stdout: string, requireRunning?: boolean): number | undefined;
interface WindowsBootstrapLauncherBinding {
    mode: 'controller' | 'direct';
    proxyExecutable: string;
    proxyScript?: string;
    controllerExecutable?: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
}
export declare function parseWindowsBootstrapLauncherBinding(journal: Pick<BootstrapTransactionJournal, 'transactionId' | 'managerBinding' | 'artifacts'>, bytes: Buffer): WindowsBootstrapLauncherBinding;
export declare function bootstrapReadinessMatchesManager(journal: Pick<BootstrapTransactionJournal, 'target' | 'managerBinding' | 'artifacts'>, readiness: coreBootstrap.LifecycleBootstrapReadiness, managerPid: number | undefined): boolean;
export declare function removeAutoexecService(target: ServiceTarget, dryRun: boolean, deps?: RemoveAutoexecServiceDeps): LifecycleResult;
export declare function resolveDaemonCommand(env: NodeJS.ProcessEnv, execPath?: string, argv1?: string | undefined): DaemonCommand;
export declare function resolveSelfUpdatingExecutable(execPath: string, argv1: string | undefined): DaemonCommand | undefined;
export declare function resolveAutoexecDaemonCommand(env: NodeJS.ProcessEnv, execPath?: string, argv1?: string | undefined, autoexecHome?: string): DaemonCommand | undefined;
export declare function resolveProxyBinPath(): string | undefined;
export declare function resolveStableNodePath(): string;
export declare function sessionStartHookVerboseEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function proxyExpected(env?: NodeJS.ProcessEnv): boolean;
declare function writeWindowsHelper(preferredPath: string, content: string): string;
export declare const _writeWindowsHelperForTest: typeof writeWindowsHelper;
export {};