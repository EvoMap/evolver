export declare function syncSleep(ms: number): void;
export type FileLockProcessStartIdentity = {
    readonly source: 'linux-proc';
    readonly bootId: string;
    readonly startTicks: string;
} | {
    readonly source: 'windows-powershell';
    readonly startTimeTicks: string;
} | {
    readonly source: 'darwin-ps';
    readonly startTime: string;
};
export interface FileLockOwnerRecord {
    readonly pid: number;
    readonly token: string;
    readonly processStartIdentity: FileLockProcessStartIdentity;
}
export type TransferLockOwnershipReason = 'transferred' | 'not_owned' | 'ownership_changed' | 'mutation_busy' | 'guardian_exists' | 'guardian_missing' | 'target_process_dead' | 'target_process_pid_reused' | 'target_process_unverifiable' | 'path_changed';
export type TransferLockOwnershipResult = {
    transferred: true;
    reason: 'transferred';
    guardian: FileLockOwnerRecord;
} | {
    transferred: false;
    reason: Exclude<TransferLockOwnershipReason, 'transferred'>;
};
export type AttachLockGuardianResult = {
    attached: true;
    reason: 'attached';
    guardian: FileLockOwnerRecord;
} | {
    attached: false;
    reason: Exclude<TransferLockOwnershipReason, 'transferred'>;
};
export type RetainLockGuardianResult = {
    retained: true;
    reason: 'retained';
} | {
    retained: false;
    reason: 'not_owned' | 'ownership_changed' | 'mutation_busy' | 'guardian_missing' | 'path_changed';
};
export type ClearLockGuardianResult = {
    cleared: true;
    reason: 'cleared' | 'missing';
} | {
    cleared: false;
    reason: 'not_owned' | 'ownership_changed' | 'mutation_busy' | 'path_changed';
};
export type FileLockOwnerProcessStatus = 'current' | 'dead' | 'pid_reused' | 'unverifiable';
export declare class LockTimeoutError extends Error {
    readonly code = "LOCK_TIMEOUT";
    constructor(_lockPath?: string);
}
export type UnsafeLockPathReason = 'symlink' | 'not_regular_file' | 'owner_too_large' | 'path_changed' | 'permission_denied' | 'process_identity_unavailable' | 'invalid_owner';
export declare class UnsafeLockPathError extends Error {
    readonly reason: UnsafeLockPathReason;
    readonly code = "UNSAFE_LOCK_PATH";
    constructor(reason: UnsafeLockPathReason);
}
export declare const MAX_LOCK_OWNER_BYTES = 4096;
/** Fresh native process-start observation. Unlike lock acquisition, this does not use caches. */
export declare function readFileLockProcessStartIdentity(pid: number): FileLockProcessStartIdentity | null;
export declare function sameFileLockProcessStartIdentity(left: FileLockProcessStartIdentity, right: FileLockProcessStartIdentity): boolean;
export declare function parseFileLockProcessStartIdentity(value: unknown): FileLockProcessStartIdentity | undefined;
/**
 * Conservative owner classification for crash recovery. PID reuse and unavailable identity
 * remain distinct from a proven-dead PID so callers cannot reclaim ambiguous ownership.
 */
export declare function inspectFileLockOwnerProcess(owner: Pick<FileLockOwnerRecord, 'pid' | 'processStartIdentity'>): FileLockOwnerProcessStatus;
export declare function _setFileLockTestHooksForTest(hooks?: {
    processStartIdentity?: (pid: number) => FileLockProcessStartIdentity | null;
    pidAlive?: (pid: number) => boolean;
    beforeOwnerPublish?: (temporaryPath: string, lockPath: string) => void;
    beforeGuardianPublish?: (temporaryPath: string, guardianPath: string) => void;
    afterGuardianPublish?: (guardianPath: string, lockPath: string) => void;
    beforeGuardianReclaim?: (guardianPath: string, lockPath: string) => void;
    beforeMutationGuardRelease?: (mutationGuardPath: string, lockPath: string) => void;
}): void;
/**
 * Pre-arm an acquired lock with the exact child PID generation while retaining local ownership.
 * A controller can therefore keep mutating its journal, while a hard controller crash cannot make
 * the primary owner reclaimable until the child exits.
 */
export declare function attachLockGuardianToProcess(lockPath: string, expectedOwner: FileLockOwnerRecord, targetPid: number): AttachLockGuardianResult;
/**
 * Drop local ownership only after an already-published guardian has been revalidated exactly.
 * No file mutation is needed: the durable guardian receipt is the crash-safe owner binding.
 */
export declare function retainLockGuardianForProcess(lockPath: string, expectedOwner: FileLockOwnerRecord, expectedGuardian: FileLockOwnerRecord): RetainLockGuardianResult;
/**
 * Remove an exact attached guardian after the child has definitely exited, retaining the primary
 * owner so rollback or another launch can continue under the same lifecycle lease.
 */
export declare function clearLockGuardianForProcess(lockPath: string, expectedOwner: FileLockOwnerRecord, expectedGuardian: FileLockOwnerRecord): ClearLockGuardianResult;
/**
 * Atomically bind an acquired lock to a still-running child and relinquish local ownership.
 */
export declare function transferLockOwnershipToProcess(lockPath: string, expectedOwner: FileLockOwnerRecord, targetPid: number): TransferLockOwnershipResult;
export interface AcquireLockOptions {
    maxTries?: number;
    waitMs?: number;
}
/**
 * Cross-process file lock with crashed-owner recovery.
 *
 * The lock file records the owner pid and token. If a waiter finds the lock held by a pid that is no longer
 * alive (the owner crashed without releaseLock), it reclaims the stale lock instead of spinning
 * until timeout — otherwise one crashed process would deadlock every future writer until the file
 * is removed by hand. Empty or truncated locks are reclaimed only after the same inode and contents
 * remain malformed for a grace period, so a live creator can finish publishing its owner payload.
 * Acquisition publishes a fully synced temporary owner with an atomic no-replace hardlink, and stale
 * reclaim moves the old lock aside under a mutation guard, then verifies the inode snapshot before
 * deletion. A live owner's lock (including this
 * process's own) is never stolen.
 *
 * NOTE: still synchronous (blocks the event loop while waiting) by design — it guards short
 * synchronous critical sections (append-only writes).
 */
export declare function acquireLock(lockPath: string, opts?: AcquireLockOptions): FileLockOwnerRecord;
export type ReleaseLockReason = 'released' | 'missing' | 'ownership_changed' | 'not_owned' | 'released_with_cleanup_error' | UnsafeLockPathReason | 'release_failed';
export interface ReleaseLockResult {
    released: boolean;
    reason: ReleaseLockReason;
}
export declare function releaseLock(lockPath: string): ReleaseLockResult;
export declare class LockReleaseError extends Error {
    readonly reason: ReleaseLockReason;
    readonly code = "LOCK_RELEASE_FAILED";
    constructor(reason: ReleaseLockReason);
}