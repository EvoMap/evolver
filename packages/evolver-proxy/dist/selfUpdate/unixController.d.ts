import { type ChildProcess } from 'node:child_process';
import { type SelfUpdateRecoveryOptions } from './transaction.js';
import { type RecoveryControllerAuthorityDependencies } from './controllerLifecycleAuthority.js';
export declare const UNIX_RECOVERY_CONTROLLER_ARG = "--evolver-unix-recovery-controller";
export interface UnixRecoveryControllerOptions extends SelfUpdateRecoveryOptions {
    argv?: readonly string[];
    processExecPath?: string;
    platform?: NodeJS.Platform;
    confirmationTimeoutMs?: number;
    pollIntervalMs?: number;
    stopTimeoutMs?: number;
    startupGateTimeoutMs?: number;
    startupAttestationTimeoutMs?: number;
    logger?: {
        write(chunk: string): unknown;
    };
    /** Test-only process adapter; production always executes the bound target with the fixed argv. */
    spawnTarget?: (targetPath: string, env: NodeJS.ProcessEnv, startupAttestation: boolean) => ChildProcess;
    /** Test seam for exact lifecycle-owner and supervised-activation authority. */
    lifecycleAuthority?: RecoveryControllerAuthorityDependencies;
}
export declare function maybeRunUnixRecoveryController(options?: UnixRecoveryControllerOptions): Promise<number | undefined>;
export declare function runUnixRecoveryController(options?: UnixRecoveryControllerOptions): Promise<number>;