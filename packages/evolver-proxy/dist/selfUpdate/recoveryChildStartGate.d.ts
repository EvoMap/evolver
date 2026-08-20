import type { ChildProcess } from 'node:child_process';
import { util } from '@evomap/evolver-core';
export declare const RECOVERY_CHILD_START_GATE_ENV = "EVOLVER_INTERNAL_RECOVERY_CHILD_START_GATE";
export declare const DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS = 120000;
export type RecoveryChildStartGateRole = 'proxy-target' | 'windows-updater';
export interface PreparedRecoveryChildStartGate {
    env: NodeJS.ProcessEnv;
    startupGateToken: string;
}
export interface ConsumeRecoveryChildStartGateOptions {
    descriptor?: number;
    timeoutMs?: number;
    parentPid?: number;
    inspectParentProcess?: (parent: Pick<util.FileLockOwnerRecord, 'pid' | 'processStartIdentity'>) => util.FileLockOwnerProcessStatus;
}
/**
 * Bind a one-shot child start gate to this exact parent PID generation.
 * The token travels in both the environment capability and a private fd4 pipe;
 * neither input is sufficient on its own.
 */
export declare function prepareRecoveryChildStartGate(env: NodeJS.ProcessEnv, role: RecoveryChildStartGateRole, expectedParent?: Pick<util.FileLockOwnerRecord, 'pid' | 'processStartIdentity'>): PreparedRecoveryChildStartGate;
/**
 * Consume the gate before controller/worker dispatch or durable recovery.
 * Invalid capability, wrong role/parent generation, EOF, malformed input and
 * timeout all fail closed. The inherited capability is scrubbed on every path.
 */
export declare function consumeRecoveryChildStartGate(env: NodeJS.ProcessEnv, expectedRole: RecoveryChildStartGateRole | undefined, options?: ConsumeRecoveryChildStartGateOptions): Promise<boolean>;
/** Deliver fd4 only after the caller establishes its owned guardian or delegated authority. */
export declare function deliverRecoveryChildStartGate(child: ChildProcess, token: string, timeoutMs?: number): Promise<boolean>;