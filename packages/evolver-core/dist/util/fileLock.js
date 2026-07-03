import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
export function syncSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const ownedLocks = new Map();
export class LockTimeoutError extends Error {
    code = 'LOCK_TIMEOUT';
    constructor(lockPath) {
        super(`获取文件锁超时: ${lockPath}`);
        this.name = 'LockTimeoutError';
    }
}
function lockKey(lockPath) {
    return resolve(lockPath);
}
function newOwner() {
    return { pid: process.pid, token: randomUUID() };
}
function serializeOwner(owner) {
    return `${JSON.stringify({ v: 1, pid: owner.pid, token: owner.token })}\n`;
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
/** True if pid is a live process (cross-platform via signal 0; EPERM = exists but owned by another user). */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
function parseJsonOwner(raw) {
    try {
        const value = JSON.parse(raw);
        if (typeof value !== 'object' || value === null)
            return null;
        const record = value;
        if (typeof record.pid !== 'number'
            || !Number.isInteger(record.pid)
            || record.pid <= 0
            || typeof record.token !== 'string'
            || record.token.length === 0) {
            return null;
        }
        return { pid: record.pid, token: record.token };
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return null;
        throw error;
    }
}
function parseLegacyOwner(raw) {
    const first = raw.trim().split(/\s+/, 1)[0];
    if (first === undefined)
        return null;
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? { pid, token: null } : null;
}
function parseOwner(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return null;
    return parseJsonOwner(trimmed) ?? parseLegacyOwner(trimmed);
}
/** Owner recorded in the lock file; null if missing/unparseable. */
function lockOwner(lockPath) {
    try {
        return parseOwner(readFileSync(lockPath, 'utf8'));
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw error;
    }
}
function sameOwner(parsed, owner) {
    return parsed?.pid === owner.pid && parsed.token === owner.token;
}
function sidecarPath(lockPath, kind) {
    return join(dirname(lockPath), `.${basename(lockPath)}.${kind}.${process.pid}.${randomUUID()}`);
}
function mutationGuardPath(lockPath) {
    return join(dirname(lockPath), `.${basename(lockPath)}.mutation`);
}
function removeFileIfExists(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
function createLockFile(lockPath, owner, trackOwnership) {
    try {
        writeFileSync(lockPath, serializeOwner(owner), { flag: 'wx', mode: 0o600 });
        if (trackOwnership)
            ownedLocks.set(lockKey(lockPath), owner);
        return true;
    }
    catch (error) {
        if (isErrno(error, 'EEXIST'))
            return false;
        throw error;
    }
}
function tryAcquireMutationGuard(lockPath) {
    const guardPath = mutationGuardPath(lockPath);
    const guard = newOwner();
    if (createLockFile(guardPath, guard, false))
        return guard;
    const owner = lockOwner(guardPath);
    if (owner === null || owner.pid === process.pid || pidAlive(owner.pid))
        return null;
    const stalePath = sidecarPath(guardPath, 'stale');
    try {
        renameSync(guardPath, stalePath);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw error;
    }
    removeFileIfExists(stalePath);
    return createLockFile(guardPath, guard, false) ? guard : null;
}
function releaseMutationGuard(lockPath, guard) {
    const guardPath = mutationGuardPath(lockPath);
    if (!sameOwner(lockOwner(guardPath), guard))
        return;
    const releasedPath = sidecarPath(guardPath, 'released');
    try {
        renameSync(guardPath, releasedPath);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return;
        throw error;
    }
    removeFileIfExists(releasedPath);
}
function reclaimStaleLock(lockPath) {
    const guard = tryAcquireMutationGuard(lockPath);
    if (guard === null)
        return false;
    try {
        const owner = lockOwner(lockPath);
        if (owner === null || owner.pid === process.pid || pidAlive(owner.pid))
            return false;
        const stalePath = sidecarPath(lockPath, 'stale');
        try {
            renameSync(lockPath, stalePath);
        }
        catch (error) {
            if (isErrno(error, 'ENOENT'))
                return false;
            throw error;
        }
        removeFileIfExists(stalePath);
        return true;
    }
    finally {
        releaseMutationGuard(lockPath, guard);
    }
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
export function acquireLock(lockPath, opts = {}) {
    const maxTries = opts.maxTries ?? 300;
    const waitMs = opts.waitMs ?? 10;
    for (let i = 0; i < maxTries; i++) {
        const owner = newOwner();
        if (createLockFile(lockPath, owner, true)) {
            return;
        }
        const current = lockOwner(lockPath);
        if (current !== null && current.pid !== process.pid && !pidAlive(current.pid)) {
            if (!reclaimStaleLock(lockPath))
                syncSleep(waitMs);
            continue;
        }
        syncSleep(waitMs);
    }
    throw new LockTimeoutError(lockPath);
}
export function releaseLock(lockPath) {
    const key = lockKey(lockPath);
    const owner = ownedLocks.get(key);
    if (owner === undefined)
        return;
    try {
        if (!sameOwner(lockOwner(lockPath), owner))
            return;
        const releasedPath = sidecarPath(lockPath, 'released');
        try {
            renameSync(lockPath, releasedPath);
        }
        catch (error) {
            if (isErrno(error, 'ENOENT'))
                return;
            throw error;
        }
        removeFileIfExists(releasedPath);
    }
    finally {
        ownedLocks.delete(key);
    }
}