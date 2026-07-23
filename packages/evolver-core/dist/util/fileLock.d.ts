export declare function syncSleep(ms: number): void;
export declare class LockTimeoutError extends Error {
    readonly code = "LOCK_TIMEOUT";
    constructor(_lockPath?: string);
}
export type UnsafeLockPathReason = 'symlink' | 'not_regular_file' | 'owner_too_large' | 'path_changed' | 'permission_denied' | 'invalid_owner';
export declare class UnsafeLockPathError extends Error {
    readonly reason: UnsafeLockPathReason;
    readonly code = "UNSAFE_LOCK_PATH";
    constructor(reason: UnsafeLockPathReason);
}
export declare const MAX_LOCK_OWNER_BYTES = 4096;
export interface AcquireLockOptions {
    maxTries?: number;
    waitMs?: number;
}
/**
 * Cross-process O_EXCL file lock with crashed-owner recovery.
 *
 * The lock file records the owner pid and token. If a waiter finds the lock held by a pid that is no longer
 * alive (the owner crashed without releaseLock), it reclaims the stale lock instead of spinning
 * until timeout — otherwise one crashed process would deadlock every future writer until the file
 * is removed by hand. Empty or truncated locks are reclaimed only after the same inode and contents
 * remain malformed for a grace period, so a live creator can finish publishing its owner payload.
 * Acquisition stays atomic (O_EXCL), and stale reclaim moves the old lock aside under a mutation
 * guard, then verifies the inode snapshot before deletion. A live owner's lock (including this
 * process's own) is never stolen.
 *
 * NOTE: still synchronous (blocks the event loop while waiting) by design — it guards short
 * synchronous critical sections (append-only writes).
 */
export declare function acquireLock(lockPath: string, opts?: AcquireLockOptions): void;
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