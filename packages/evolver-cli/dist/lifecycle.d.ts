import { spawn } from 'node:child_process';
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
}
export interface LifecycleResult {
    status: string;
    pid?: number;
    pids?: number[];
    healthy?: boolean;
    reason?: string;
    logFile?: string;
    files?: string[];
    service?: string;
    autoexecHome?: string;
    actions?: string[];
}
type UnixRecoveryControllerModule = Pick<typeof import('@evomap/evolver-proxy'), 'provisionStableUnixRecoveryController' | 'stableUnixRecoveryControllerPathForTarget' | 'UNIX_RECOVERY_CONTROLLER_ARG'>;
type LoadUnixRecoveryController = () => Promise<UnixRecoveryControllerModule>;
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
    run?: (command: string, args: readonly string[]) => ServiceControlResult;
    uid?: number;
    install?: (target: ServiceTarget, flags: Record<string, string | true>, env: NodeJS.ProcessEnv, argv1: string | undefined, loadUnixRecoveryController?: LoadUnixRecoveryController) => Promise<LifecycleResult>;
}
interface ServiceControlResult {
    status: number | null;
    error?: unknown;
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
}): string;
export declare function renderAutoexecLaunchdPlist(opts: {
    envFile?: string;
    workingDirectory?: string;
    programArguments: readonly string[];
    logDir?: string;
}): string;
export declare function renderWindowsInstaller(defaults?: {
    evolverBin?: string;
    nodePath?: string;
    proxyBin?: string;
    envFile?: string;
    lifecycleStateDir?: string;
    selfUpdateStateDir?: string;
}): string;
export declare function renderWindowsAutoexecInstaller(defaults?: {
    evolverBin?: string;
    nodePath?: string;
    cliBin?: string;
    envFile?: string;
    autoexecHome?: string;
    workingDirectory?: string;
}): string;
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