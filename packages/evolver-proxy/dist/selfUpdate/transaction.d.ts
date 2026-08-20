import type { DownloadResult } from './executor.js';
import { type ReleaseBinaryOptions } from './releaseBinary.js';
export type SelfUpdateJournalStage = 'preparing' | 'downloaded' | 'verified' | 'backed_up' | 'install_pending' | 'installed' | 'restarted' | 'health_check_pending' | 'rolling_back' | 'rollback_pending' | 'confirmed' | 'rolled_back' | 'rollback_failed';
export interface SelfUpdateJournal {
    schema_version: 2;
    transaction_id: string;
    stage: SelfUpdateJournalStage;
    from_version: string;
    target_version: string;
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    installing_pid: number;
    created_at: string;
    updated_at: string;
    recovery_attempts: number;
    /** Canonical logical install path: real parent directory plus the target leaf name. */
    target_path: string;
    /** Normalized operator-configured spelling used only when its parent can no longer be resolved. */
    configured_target_path?: string;
    staged_name?: string;
    backup_name?: string;
    failure_code?: string;
    verified_sha256?: string;
}
export interface DurableSelfUpdateSession {
    adoptDownloaded(download: DownloadResult): Promise<DownloadResult>;
    markVerified(artifacts: readonly {
        bytes?: Uint8Array;
        sha256?: string;
    }[]): Promise<void>;
    install(): Promise<void>;
    markRestartRequested(): Promise<void>;
    abort(failureCode: string): Promise<void>;
    rollback(failureCode: string): Promise<void>;
    release(): Promise<void>;
}
export interface SelfUpdateRecoveryResult {
    outcome: 'none' | 'pending_health' | 'rollback_pending' | 'confirmed' | 'rolled_back' | 'blocked';
    stage?: SelfUpdateJournalStage;
    targetVersion?: string;
    fromVersion?: string;
    restartRequired?: boolean;
    failureCode?: string;
}
export interface StagedBinaryProbeOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
}
export type StagedBinaryProbe = (targetPath: string, args: readonly string[], options: StagedBinaryProbeOptions) => Promise<{
    stdout: string;
}>;
export interface DurableSelfUpdateOptions extends ReleaseBinaryOptions {
    stateDir?: string;
    currentVersion: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    pid?: number;
    now?: () => Date;
    readBackVersion?: (targetPath: string) => Promise<string>;
    stagedBinaryProbe?: StagedBinaryProbe;
    /** Test hook invoked after a stale lock generation is observed and before its successor is published. */
    beforeStaleLockReclaim?: () => void | Promise<void>;
}
export type SelfUpdateRecoveryOptions = Omit<DurableSelfUpdateOptions, 'currentVersion'> & {
    currentVersion?: string;
    /** Runs after a durable journal is loaded and before recovery changes the journal, target, or managed artifacts. */
    beforeJournalMutation?: () => void | Promise<void>;
};
export interface StableUnixRecoveryControllerOptions extends SelfUpdateRecoveryOptions {
    platform?: NodeJS.Platform;
    /** Bootstrap uses create-only ownership; explicit install-service keeps replacement semantics. */
    replaceExisting?: boolean;
    artifactClaimPath?: string;
    onArtifactPublished?: (path: string, claimPath: string) => void | Promise<void>;
}
export interface StableWindowsRecoveryControllerOptions extends SelfUpdateRecoveryOptions {
    platform?: NodeJS.Platform;
    /** Bootstrap uses create-only ownership; explicit install-service keeps replacement semantics. */
    replaceExisting?: boolean;
    artifactClaimPath?: string;
    onArtifactPublished?: (path: string, claimPath: string) => void | Promise<void>;
}
export declare function inspectDurableSelfUpdate(options: SelfUpdateRecoveryOptions): Promise<SelfUpdateRecoveryResult>;
export declare function resolveStableUnixRecoveryControllerPath(options: StableUnixRecoveryControllerOptions): Promise<string>;
export declare function stableUnixRecoveryControllerPathForTarget(targetPath: string, stateDir?: string): string;
/**
 * Installs an executable copy outside the mutable target path. The transaction
 * lock and the existing no-follow file primitives keep service installation
 * from racing an update or copying through a symlink.
 */
export declare function provisionStableUnixRecoveryController(options: StableUnixRecoveryControllerOptions): Promise<string>;
export declare function bindStableUnixRecoveryController(options: StableUnixRecoveryControllerOptions, processExecPath: string): Promise<{
    controllerPath: string;
    targetPath: string;
}>;
export declare function bindStableWindowsRecoveryController(options: StableWindowsRecoveryControllerOptions, processExecPath: string): Promise<{
    controllerPath: string;
    stateDir: string;
    targetPath: string;
}>;
export declare function stableWindowsRecoveryControllerPathForStateDir(stateDir: string): string;
/**
 * Provision or refresh the long-lived controller while it is not running.
 * Service installation stops the Scheduled Task before calling this command;
 * each self-update only replaces the separate windows-updater worker path.
 */
export declare function provisionStableWindowsRecoveryController(options: StableWindowsRecoveryControllerOptions, processExecPath: string): Promise<string>;
export declare function beginDurableSelfUpdate(targetVersion: string, options: DurableSelfUpdateOptions): Promise<DurableSelfUpdateSession>;
export declare function recoverDurableSelfUpdate(options: SelfUpdateRecoveryOptions): Promise<SelfUpdateRecoveryResult>;
export declare function markWindowsInstallApplied(options: SelfUpdateRecoveryOptions): Promise<SelfUpdateRecoveryResult>;
export declare function confirmDurableSelfUpdate(options: SelfUpdateRecoveryOptions): Promise<SelfUpdateRecoveryResult>;
export declare function rollbackDurableSelfUpdate(options: SelfUpdateRecoveryOptions, failureCode: string): Promise<SelfUpdateRecoveryResult>;
export declare function normalizeCanonicalSelfUpdateTargetPath(targetPath: string, platform?: NodeJS.Platform): string;
export declare function preflightManagedStagedBinary(targetPath: string, expectedVersion: string, probe?: StagedBinaryProbe): Promise<void>;