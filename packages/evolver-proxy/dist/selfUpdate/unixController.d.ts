import { type SelfUpdateRecoveryOptions } from './transaction.js';
export declare const UNIX_RECOVERY_CONTROLLER_ARG = "--evolver-unix-recovery-controller";
export interface UnixRecoveryControllerOptions extends SelfUpdateRecoveryOptions {
    argv?: readonly string[];
    processExecPath?: string;
    platform?: NodeJS.Platform;
    confirmationTimeoutMs?: number;
    pollIntervalMs?: number;
    stopTimeoutMs?: number;
    logger?: {
        write(chunk: string): unknown;
    };
}
export declare function maybeRunUnixRecoveryController(options?: UnixRecoveryControllerOptions): Promise<number | undefined>;
export declare function runUnixRecoveryController(options?: UnixRecoveryControllerOptions): Promise<number>;