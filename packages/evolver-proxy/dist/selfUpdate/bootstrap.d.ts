import { spawn } from 'node:child_process';
import { util } from '@evomap/evolver-core';
import { type MigrationOptions } from './migration.js';
export declare const RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV = "EVOLVER_INTERNAL_RECOVERY_CONTROLLER_LIFECYCLE_OWNER";
type BootstrapProcessKill = (pid: number, signal: NodeJS.Signals | 0) => boolean;
type BootstrapSkipReason = 'already_supervised' | 'already_bootstrapped' | 'unsupported_install_shape' | 'policy_not_auto' | 'bootstrap_disabled' | 'ci_environment' | 'container_environment' | 'recent_failure' | 'migration_ambiguous' | 'bootstrap_attempt_invalid' | 'bootstrap_intent_pending' | 'bootstrap_attempt_pending';
export interface BootstrapDecision {
    proceed: boolean;
    reason?: BootstrapSkipReason;
}
export interface BootstrapOutcome {
    ok: boolean;
    /**
     * 'bootstrapped' / 'bootstrapped_lock_release_unconfirmed' / 'migrated' on success;
     * failure/skip reason otherwise. Migration failures record 'migration_failed' /
     * 'migration_timeout' (both cooldown-worthy).
     */
    reason: string;
    detail?: string;
    /** The child may own manager or IPC state, so the foreground proxy must exit. */
    requiresForegroundExit?: true;
}
export interface BootstrapRunOptions {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execPath?: string;
    argv1?: string;
    /** Parent force-timeout; it must exceed the child's transaction budget. */
    timeoutMs?: number;
    /** Absolute child deadline offset. Production uses the complete transaction budget. */
    transactionBudgetMs?: number;
    /** Bounded wait for OS confirmation after force-terminating the process tree. */
    terminationGraceMs?: number;
    now?: number;
    exists?: (path: string) => boolean;
    readFile?: (path: string) => string;
    writeFile?: (path: string, content: string) => void;
    spawnFn?: typeof spawn;
    treeKillSpawnFn?: typeof spawn;
    processKill?: BootstrapProcessKill;
    /** Test-only failure seam; production publication always uses the strict exclusive writer. */
    beforeIntentPublish?: () => void;
    /** Test-only crash seam for each durable initial-publication boundary. */
    afterIntentPublicationStep?: (step: 'create' | 'partial_write' | 'file_fsync' | 'link' | 'directory_fsync', path: string) => void;
    /** Test-only crash seams around the atomic terminal/clear state transitions. */
    beforeIntentTerminalFsync?: (path: string) => void;
    afterIntentTerminalPublish?: () => void;
    afterIntentClearRename?: () => void;
    /** Test-only trust seams. Production always uses native owner/DACL validation. */
    assertIntentDirectoryTrust?: (directory: string) => void;
    assertIntentFileTrust?: (path: string) => void;
    assertLegacyProofDirectoryTrust?: (directory: string) => void;
    assertLegacyProofFileTrust?: (path: string) => void;
    afterLegacyProofRead?: (path: string) => void;
    /** Test-only process identity seams; production uses fresh native core observations. */
    readRegistrationProcessStartIdentity?: (pid: number) => util.FileLockProcessStartIdentity | null;
    registrationOwnerProcessStatus?: (owner: Pick<util.FileLockOwnerRecord, 'pid' | 'processStartIdentity'>) => util.FileLockOwnerProcessStatus;
    registrationPublisherProcessStatus?: (publisher: Readonly<{
        pid: number;
        token: string;
        processIdentityDigest: string;
    }>) => util.FileLockOwnerProcessStatus;
    /**
     * Extra seams forwarded to the one-time npm/JS → standalone migration (migration.ts).
     * Bootstrap-level seams (exists/readFile/writeFile/spawnFn/now/execPath) win when both
     * are supplied, so the decision and the migration observe the same injected world.
     */
    migration?: MigrationOptions;
}
/** Lifecycle state dir mirror of evolver-cli lifecyclePaths (kept dependency-free across packages). */
export declare function resolveBootstrapStateDir(env: NodeJS.ProcessEnv): string;
export declare function withRecoveryControllerLifecycleOwnerCapability(env: NodeJS.ProcessEnv, owner: util.FileLockOwnerRecord): NodeJS.ProcessEnv;
export interface PreparedRecoveryControllerLifecycleOwnerCapability {
    env: NodeJS.ProcessEnv;
    startupAckToken: string;
}
export declare function prepareRecoveryControllerLifecycleOwnerCapability(env: NodeJS.ProcessEnv, owner: util.FileLockOwnerRecord): PreparedRecoveryControllerLifecycleOwnerCapability;
export declare function clearRecoveryControllerLifecycleOwnerCapability(env: NodeJS.ProcessEnv): void;
export declare function publishRecoveryControllerLifecycleStartupAttestation(env: NodeJS.ProcessEnv, descriptor?: number): boolean;
export declare function lifecycleBootstrapStatePresent(env: NodeJS.ProcessEnv, exists?: (path: string) => boolean): boolean;
export type BootstrapDurableStateOptions = Pick<BootstrapRunOptions, 'exists' | 'readFile' | 'assertIntentFileTrust' | 'assertLegacyProofDirectoryTrust' | 'assertLegacyProofFileTrust' | 'afterLegacyProofRead' | 'registrationOwnerProcessStatus' | 'now'> & {
    /** Exact owner currently holding the shared lifecycle mutation lock. */
    expectedRecoveryOwner?: util.FileLockOwnerRecord;
};
export interface LifecycleBootstrapOwnerLease {
    readonly path: string;
    readonly owner: util.FileLockOwnerRecord;
    assertOwned(): void;
    armProcess(pid: number): util.FileLockOwnerRecord;
    disarmProcess(): void;
    retainProcess(): void;
    transferToProcess(pid: number): util.FileLockOwnerRecord;
    release(): void;
}
export declare function assertSupervisedLifecycleBootstrapState(env: NodeJS.ProcessEnv, options?: BootstrapDurableStateOptions & {
    requireLifecycleState?: boolean;
    /** Test-only parent identity seam; production always binds to process.ppid. */
    recoveryControllerParentPid?: number;
}): void;
/**
 * Revalidate the narrow parent-owned activation window used by a newly launched recovery
 * controller. This deliberately rejects committed supervision: callers use it only as delegated
 * authority while the lifecycle parent still owns the mutation lock and is waiting for readiness.
 */
export declare function assertActiveSupervisedLifecycleBootstrapDelegation(env: NodeJS.ProcessEnv, options?: BootstrapDurableStateOptions): void;
/**
 * Revalidate a transaction-bound launcher before any self-update operation. Unlike the startup
 * assertion above, this never accepts the narrow activating window used to publish readiness.
 */
export declare function assertCommittedLifecycleBootstrapState(env: NodeJS.ProcessEnv, options?: BootstrapDurableStateOptions): void;
/**
 * Serialize self-update with every lifecycle bootstrap, recovery, and manual-transition writer.
 * Acquisition is deliberately fail-fast: a heartbeat must not block the daemon while another
 * lifecycle owner is active. Transaction-bound launchers revalidate the committed receipt under
 * the exact acquired generation; legacy launchers still hold and recheck the shared owner lock.
 */
export declare function acquireLifecycleBootstrapOwnerLease(env: NodeJS.ProcessEnv, lockOptions?: {
    maxTries?: number;
    waitMs?: number;
}): LifecycleBootstrapOwnerLease;
export declare function looksLikeContainer(exists: (path: string) => boolean, readFile: (path: string) => string): boolean;
/** True when a recent bootstrap/migration attempt failed within the cooldown window. */
export declare function recentBootstrapFailure(env: NodeJS.ProcessEnv, optionsOrReadFile: Pick<BootstrapRunOptions, 'exists' | 'readFile' | 'assertIntentFileTrust'> | ((path: string) => string), now: number): boolean;
/**
 * Decide whether an unsupervised (degraded) startup should attempt first-run bootstrap.
 * Pure — filesystem access is injectable for tests.
 */
export declare function shouldBootstrap(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, options?: Pick<BootstrapRunOptions, 'exists' | 'readFile' | 'now' | 'execPath' | 'assertIntentFileTrust'>): BootstrapDecision;
/**
 * Resolve the `lifecycle bootstrap` invocation for the current install shape: standalone binary,
 * CLI entry through node, or the npm-installed @evomap/evolver-cli sibling. Returns undefined when
 * no CLI can be located. The caller may continue only after confirming durable state is clean.
 */
export declare function resolveBootstrapCliInvocation(options?: Pick<BootstrapRunOptions, 'execPath' | 'argv1' | 'exists'>): {
    command: string;
    args: string[];
} | undefined;
/** Best-effort attempt marker; never throws — bootstrap bookkeeping must not break startup. */
export declare function recordBootstrapAttempt(env: NodeJS.ProcessEnv, outcome: BootstrapOutcome, options?: Pick<BootstrapRunOptions, 'writeFile' | 'now'>): void;
/** Spawn `evolver lifecycle bootstrap` and await its result within a bounded timeout. */
export declare function runBootstrap(options: BootstrapRunOptions): Promise<BootstrapOutcome>;
export type DegradedStartupBootstrapResult = {
    disposition: 'continue';
    handedOver: false;
    message: string;
} | {
    disposition: 'handoff';
    handedOver: true;
    exitCode: 0;
    message: string;
} | {
    disposition: 'fail_closed';
    handedOver: false;
    exitCode: 1;
    message: string;
};
/**
 * Orchestrate bootstrap for a degraded (default-auto, unsupervised) startup: decide, attempt,
 * record, and produce the operator message. Never throws.
 */
export declare function bootstrapDegradedSelfUpdateStartup(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, options?: Omit<BootstrapRunOptions, 'env' | 'platform'>): Promise<DegradedStartupBootstrapResult>;
export {};