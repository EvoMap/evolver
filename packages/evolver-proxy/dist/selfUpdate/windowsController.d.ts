import { type ChildProcess } from 'node:child_process';
import { type SelfUpdateRecoveryOptions } from './transaction.js';
export declare const WINDOWS_RECOVERY_CONTROLLER_ARG = "--evolver-windows-recovery-controller";
export declare const WINDOWS_RECOVERY_CONTROLLER_PROVISION_ARG = "--evolver-windows-recovery-controller-provision";
type RunUpdaterWorker = (workerPath: string, stateDir: string, env: NodeJS.ProcessEnv) => Promise<number>;
export interface WindowsRecoveryControllerOptions extends SelfUpdateRecoveryOptions {
    argv?: readonly string[];
    processExecPath?: string;
    platform?: NodeJS.Platform;
    confirmationTimeoutMs?: number;
    pollIntervalMs?: number;
    stopTimeoutMs?: number;
    logger?: {
        write(chunk: string): unknown;
    };
    /** Test-only process adapter; production always uses the fixed target plus the fixed `proxy` argv. */
    spawnTarget?: (targetPath: string, env: NodeJS.ProcessEnv) => ChildProcess;
    /** Test-only worker adapter; production executes the fixed updater path with the fixed worker argv. */
    runUpdaterWorker?: RunUpdaterWorker;
}
export declare function maybeRunWindowsRecoveryController(options?: WindowsRecoveryControllerOptions): Promise<number | undefined>;
export declare function runWindowsRecoveryController(options?: WindowsRecoveryControllerOptions): Promise<number>;
export {};