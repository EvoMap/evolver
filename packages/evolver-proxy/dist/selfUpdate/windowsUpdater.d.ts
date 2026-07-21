import { rename } from 'node:fs/promises';
export declare const WINDOWS_UPDATER_WORKER_ARG = "--evolver-windows-updater-worker";
export type WindowsUpdaterOperation = 'install' | 'rollback';
export interface WindowsUpdaterPaths {
    directory: string;
    helperPath: string;
    pendingPath: string;
    resultPath: string;
}
export interface PrepareWindowsUpdaterOptions {
    operation: WindowsUpdaterOperation;
    targetPath: string;
    backupPath: string;
    stateDir: string;
    /** Required for install and bound to the signed-manifest digest. */
    stagedPath?: string;
    expectedStagedSha256?: string;
    /** Rollback copies the currently running helper-capable binary by default. */
    helperSourcePath?: string;
    processExecPath?: string;
    platform?: NodeJS.Platform;
}
export interface WindowsUpdaterDescriptor {
    operation: WindowsUpdaterOperation;
    operationId: string;
    helperPath: string;
    pendingPath: string;
    resultPath: string;
}
export interface WindowsUpdaterResult {
    schema_version: 1;
    operation: WindowsUpdaterOperation;
    status: 'completed' | 'failed';
    failure_code?: string;
}
export interface ApplyWindowsUpdaterOptions {
    stateDir?: string;
    workerExecPath?: string;
    platform?: NodeJS.Platform;
    renameFn?: typeof rename;
}
export interface BindWindowsManagedExecutableOptions {
    stateDir: string;
    executablePath: string;
    relativePath: readonly string[];
    label: string;
    mismatchLabel?: string;
    platform?: NodeJS.Platform;
}
export interface BoundWindowsManagedExecutable {
    stateDir: string;
    executablePath: string;
}
/** Paths are fixed so the stable controller never consumes descriptor-supplied executable paths. */
export declare function resolveWindowsUpdaterPaths(stateDirInput: string): WindowsUpdaterPaths;
/** Bind a fixed executable below the private state root without following directory links. */
export declare function bindWindowsManagedExecutable(options: BindWindowsManagedExecutableOptions): Promise<BoundWindowsManagedExecutable>;
/**
 * Prepare a launcher-consumed update descriptor. This function never mutates
 * the live executable and never spawns a competing relaunch process.
 *
 * The stable lifecycle controller runs updater.exe before it starts target.
 * The worker applies pending.json while no target process exists, then removes
 * pending.json only after an idempotently durable success result is written.
 */
export declare function prepareWindowsExecutableSwap(options: PrepareWindowsUpdaterOptions): Promise<WindowsUpdaterDescriptor>;
/**
 * Apply the pending operation before the stable controller starts target.
 * A successful swap is idempotent across crashes after rename: if target
 * already has source's content, the helper only finalizes result/pending state.
 */
export declare function applyPendingWindowsExecutableSwap(options?: ApplyWindowsUpdaterOptions): Promise<WindowsUpdaterResult>;
/** Return undefined for normal execution, otherwise the launcher helper exit code. */
export declare function maybeRunWindowsUpdaterWorkerFromArgv(options?: {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    processExecPath?: string;
}): Promise<number | undefined>;