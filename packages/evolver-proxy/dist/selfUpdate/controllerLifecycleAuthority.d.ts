import type { util } from '@evomap/evolver-core';
import { type PreparedRecoveryChildStartGate, type RecoveryChildStartGateRole } from './recoveryChildStartGate.js';
interface RecoveryControllerLifecycleLease {
    readonly owner: util.FileLockOwnerRecord;
    assertOwned(): void;
    armProcess(pid: number): util.FileLockOwnerRecord;
    disarmProcess(): void;
    retainProcess(): void;
    transferToProcess(pid: number): util.FileLockOwnerRecord;
    release(): void;
}
type RecoveryControllerLifecycleLeaseAcquirer = (env: NodeJS.ProcessEnv, options: {
    maxTries: number;
    waitMs: number;
}) => RecoveryControllerLifecycleLease;
type SupervisedActivationDelegationAssertion = (env: NodeJS.ProcessEnv) => void;
interface RecoveryControllerPreparedOwnerCapability {
    env: NodeJS.ProcessEnv;
    startupAckToken: string;
}
interface RecoveryControllerPreparedChild {
    env: NodeJS.ProcessEnv;
    startupAckToken?: string;
    startupGateToken: string;
}
type RecoveryControllerChildCapabilityFactory = (env: NodeJS.ProcessEnv, owner: util.FileLockOwnerRecord) => RecoveryControllerPreparedOwnerCapability;
type RecoveryControllerStartGateFactory = (env: NodeJS.ProcessEnv, role: RecoveryChildStartGateRole, expectedParent?: Pick<util.FileLockOwnerRecord, 'pid' | 'processStartIdentity'>) => PreparedRecoveryChildStartGate;
export interface RecoveryControllerAuthorityDependencies {
    acquireOwnerLease?: RecoveryControllerLifecycleLeaseAcquirer;
    assertActivationDelegation?: SupervisedActivationDelegationAssertion;
    prepareOwnerCapability?: RecoveryControllerChildCapabilityFactory;
    prepareStartGate?: RecoveryControllerStartGateFactory;
}
export interface RecoveryControllerAuthority {
    readonly kind: 'owned' | 'delegated';
    assertAuthorized(): void;
    prepareTarget(env: NodeJS.ProcessEnv): RecoveryControllerPreparedChild;
    prepareWorker(env: NodeJS.ProcessEnv): PreparedRecoveryChildStartGate;
    armProcess(pid: number): void;
    disarmProcess(): void;
    retainProcess(): void;
    release(): void;
}
export declare function resolveRecoveryControllerAuthority(env: NodeJS.ProcessEnv, dependencies?: RecoveryControllerAuthorityDependencies): Promise<RecoveryControllerAuthority>;
export {};