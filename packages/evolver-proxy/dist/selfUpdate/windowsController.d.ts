import { type ChildProcess } from 'node:child_process';
import { type SelfUpdateRecoveryOptions } from './transaction.js';
import { type WindowsUpdaterHelperTrust } from './windowsUpdater.js';
import { type RecoveryControllerAuthorityDependencies } from './controllerLifecycleAuthority.js';
export declare const WINDOWS_RECOVERY_CONTROLLER_ARG = "--evolver-windows-recovery-controller";
export declare const WINDOWS_RECOVERY_CONTROLLER_PROVISION_ARG = "--evolver-windows-recovery-controller-provision";
type RunUpdaterWorker = (workerPath: string, stateDir: string, env: NodeJS.ProcessEnv, startupGateToken: string) => Promise<number>;
type SpawnUpdaterWorker = (workerPath: string, env: NodeJS.ProcessEnv) => ChildProcess;
export interface WindowsRecoveryControllerOptions extends SelfUpdateRecoveryOptions {
    argv?: readonly string[];
    processExecPath?: string;
    platform?: NodeJS.Platform;
    confirmationTimeoutMs?: number;
    pollIntervalMs?: number;
    stopTimeoutMs?: number;
    workerTimeoutMs?: number;
    startupGateTimeoutMs?: number;
    startupAttestationTimeoutMs?: number;
    logger?: {
        write(chunk: string): unknown;
    };
    /** Test-only process adapter; production always uses the fixed target plus the fixed `proxy` argv. */
    spawnTarget?: (targetPath: string, env: NodeJS.ProcessEnv, startupAttestation: boolean) => ChildProcess;
    /** Test-only worker adapter; production executes the fixed updater path with the fixed worker argv. */
    runUpdaterWorker?: RunUpdaterWorker;
    /** Test-only native spawn seam; production still runs the fixed updater path and argv. */
    spawnUpdaterWorker?: SpawnUpdaterWorker;
    /** Test seam; production always evaluates the native Windows updater owner/writer policy. */
    assertUpdaterHelperTrust?: WindowsUpdaterHelperTrust;
    /** Test seam for exact lifecycle-owner and supervised-activation authority. */
    lifecycleAuthority?: RecoveryControllerAuthorityDependencies;
}
export declare function maybeRunWindowsRecoveryController(options?: WindowsRecoveryControllerOptions): Promise<number | undefined>;
export declare function runWindowsRecoveryController(options?: WindowsRecoveryControllerOptions): Promise<number>;
export {};