import { canonicalEventPath } from './canonicalEventPath.js';
import { basename, dirname, join } from 'node:path';
export const asyncFileLockOwners = new Map();
/** A live Windows lock deliberately denies leaf opens. Resolve only its parent;
 * supported lock names are fixed, and the actual acquisition still checks the
 * named leaf with no-follow rather than laundering a lock-file symlink. */
export function asyncFileLockKey(path) {
    return join(canonicalEventPath(dirname(path)), basename(path));
}
export function asyncFileLockOwned(path) {
    if (!asyncFileLockOwners.size)
        return false;
    try {
        const key = asyncFileLockKey(path), owner = asyncFileLockOwners.get(key);
        // Another retained capability may have rejoined this cleanup. Retire only
        // that exact confirmed owner, never a live or still-unconfirmed acquisition.
        try {
            if (owner?.failure?.cleanupComplete === true && asyncFileLockOwners.get(key) === owner)
                asyncFileLockOwners.delete(key);
        }
        catch { /* Unavailable owner confirmation must retain its root reservation. */ }
        return asyncFileLockOwners.has(key);
    }
    catch {
        return false;
    } // The actual lock participant retains its own unsafe-path error.
}