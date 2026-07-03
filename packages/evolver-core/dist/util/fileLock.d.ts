export declare function syncSleep(ms: number): void;
export declare class LockTimeoutError extends Error {
    readonly code = "LOCK_TIMEOUT";
    constructor(lockPath: string);
}
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
 * is removed by hand. Acquisition stays atomic (O_EXCL), and stale reclaim moves the old lock aside
 * under a mutation guard before deletion so waiters cannot delete each other's newly-created locks.
 * A live owner's lock (including this process's own) is never stolen.
 *
 * NOTE: still synchronous (blocks the event loop while waiting) by design — it guards short
 * synchronous critical sections (append-only writes).
 */
export declare function acquireLock(lockPath: string, opts?: AcquireLockOptions): void;
export declare function releaseLock(lockPath: string): void;