import { spawn } from 'node:child_process';
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
interface LifecyclePaths {
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
}
interface RunLifecycleDeps {
    argv1?: string;
    env?: NodeJS.ProcessEnv;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
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
export declare function lifecyclePaths(env?: NodeJS.ProcessEnv): LifecyclePaths;
export declare function renderSystemdUnit(opts?: {
    envFile?: string;
    workingDirectory?: string;
    execStart?: string;
    selfUpdateStateDir?: string;
    selfUpdateTarget?: string;
}): string;
export declare function renderLaunchdPlist(opts?: {
    envFile?: string;
    workingDirectory?: string;
    nodePath?: string;
    proxyBin?: string;
    programArguments?: readonly string[];
    logDir?: string;
    selfUpdateStateDir?: string;
    selfUpdateTarget?: string;
}): string;
export declare function renderWindowsInstaller(defaults?: {
    evolverBin?: string;
    nodePath?: string;
    proxyBin?: string;
    envFile?: string;
    selfUpdateStateDir?: string;
}): string;
export declare function resolveDaemonCommand(env: NodeJS.ProcessEnv, execPath?: string, argv1?: string | undefined): DaemonCommand;
export declare function resolveSelfUpdatingExecutable(execPath: string, argv1: string | undefined): DaemonCommand | undefined;
export declare function resolveProxyBinPath(): string | undefined;
export declare function resolveStableNodePath(): string;
export declare function sessionStartHookVerboseEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function proxyExpected(env?: NodeJS.ProcessEnv): boolean;
export {};