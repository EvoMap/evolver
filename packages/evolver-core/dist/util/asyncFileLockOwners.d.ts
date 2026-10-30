import type { AuditCleanupError } from '../events/auditCleanup.js';
/** Actual async owners remain registered through settlement and uncertain
 * cleanup. Synchronous lock participants cannot wait on their own event loop. */
export interface AsyncFileLockOwner {
    failure?: AuditCleanupError;
}
export declare const asyncFileLockOwners: Map<string, AsyncFileLockOwner>;
/** A live Windows lock deliberately denies leaf opens. Resolve only its parent;
 * supported lock names are fixed, and the actual acquisition still checks the
 * named leaf with no-follow rather than laundering a lock-file symlink. */
export declare function asyncFileLockKey(path: string): string;
export declare function asyncFileLockOwned(path: string): boolean;