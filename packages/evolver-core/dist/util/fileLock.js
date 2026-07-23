import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
export function syncSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const MALFORMED_LOCK_GRACE_NS = 1000000000n;
const ownedLocks = new Map();
const malformedLockObservations = new Map();
export class LockTimeoutError extends Error {
    code = 'LOCK_TIMEOUT';
    constructor(_lockPath) {
        super('获取文件锁超时');
        this.name = 'LockTimeoutError';
    }
}
export class UnsafeLockPathError extends Error {
    reason;
    code = 'UNSAFE_LOCK_PATH';
    constructor(reason) {
        super(`不安全的文件锁路径: ${reason}`);
        this.reason = reason;
        this.name = 'UnsafeLockPathError';
    }
}
export const MAX_LOCK_OWNER_BYTES = 4096;
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
function noFollowFlag() {
    return constants['O_NOFOLLOW'] ?? 0;
}
function assertRegularOwnerStat(stat) {
    if (stat.isSymbolicLink())
        throw new UnsafeLockPathError('symlink');
    if (!stat.isFile())
        throw new UnsafeLockPathError('not_regular_file');
    if (stat.size > BigInt(MAX_LOCK_OWNER_BYTES))
        throw new UnsafeLockPathError('owner_too_large');
}
function currentOwnerStat(path) {
    try {
        const stat = lstatSync(path, { bigint: true });
        assertRegularOwnerStat(stat);
        return stat;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
            throw new UnsafeLockPathError('permission_denied');
        }
        throw error;
    }
}
function readOwnerFileBounded(path) {
    const before = currentOwnerStat(path);
    if (before === null)
        return null;
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | noFollowFlag());
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        if (isErrno(error, 'ELOOP'))
            throw new UnsafeLockPathError('symlink');
        if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
            throw new UnsafeLockPathError('permission_denied');
        }
        throw error;
    }
    try {
        const opened = fstatSync(fd, { bigint: true });
        assertRegularOwnerStat(opened);
        const current = currentOwnerStat(path);
        if (current === null || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new UnsafeLockPathError('path_changed');
        }
        const buffer = Buffer.alloc(MAX_LOCK_OWNER_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
            const read = readSync(fd, buffer, total, buffer.length - total, total);
            if (read === 0)
                break;
            total += read;
        }
        if (total > MAX_LOCK_OWNER_BYTES)
            throw new UnsafeLockPathError('owner_too_large');
        const settled = fstatSync(fd, { bigint: true });
        assertRegularOwnerStat(settled);
        const settledPath = currentOwnerStat(path);
        if (settledPath === null
            || settledPath.dev !== settled.dev
            || settledPath.ino !== settled.ino
            || settledPath.size !== settled.size
            || settledPath.mtimeNs !== settled.mtimeNs) {
            throw new UnsafeLockPathError('path_changed');
        }
        return { raw: buffer.subarray(0, total).toString('utf8'), stat: settled };
    }
    finally {
        closeSync(fd);
    }
}
function readOwnerBounded(path) {
    return readOwnerFileBounded(path)?.raw ?? null;
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
/** Snapshot of the lock inode and its owner payload; null if the path disappeared. */
function lockSnapshot(lockPath) {
    try {
        const read = readOwnerFileBounded(lockPath);
        if (read === null)
            return null;
        return {
            owner: parseOwner(read.raw),
            dev: read.stat.dev,
            ino: read.stat.ino,
            size: read.stat.size,
            mtimeNs: read.stat.mtimeNs,
        };
    }
    catch (error) {
        // A valid owner can release and another waiter can acquire between lstat/open/fstat. Treat that snapshot as
        // transiently unavailable: callers remain conservative (no steal/delete) and the acquire loop retries.
        if (error instanceof UnsafeLockPathError && error.reason === 'path_changed')
            return null;
        throw error;
    }
}
function sameInode(left, right) {
    return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}
function sameSnapshot(left, right) {
    return sameInode(left, right)
        && left?.size === right?.size
        && left?.mtimeNs === right?.mtimeNs;
}
function forgetMalformedObservation(lockPath) {
    malformedLockObservations.delete(lockKey(lockPath));
}
function reclaimableSnapshot(lockPath, snapshot) {
    if (snapshot.owner !== null) {
        forgetMalformedObservation(lockPath);
        return snapshot.owner.pid !== process.pid && !pidAlive(snapshot.owner.pid);
    }
    const key = lockKey(lockPath);
    const now = process.hrtime.bigint();
    const observed = malformedLockObservations.get(key);
    if (observed === undefined || !sameSnapshot(observed.snapshot, snapshot)) {
        malformedLockObservations.set(key, { snapshot, firstSeenAtNs: now });
        return false;
    }
    return now - observed.firstSeenAtNs >= MALFORMED_LOCK_GRACE_NS;
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
function pathExists(path) {
    return existsSync(path);
}
function restoreMovedFile(lockPath, movedPath, moved) {
    try {
        linkSync(movedPath, lockPath);
        removeFileIfExists(movedPath);
        forgetMalformedObservation(lockPath);
        return;
    }
    catch (error) {
        if (!isErrno(error, 'EEXIST'))
            throw error;
    }
    const current = lockSnapshot(lockPath);
    if (sameInode(current, moved)) {
        removeFileIfExists(movedPath);
        forgetMalformedObservation(lockPath);
        return;
    }
    throw new Error(`文件锁在安全回收期间被替换，已保留候选文件: ${movedPath}`);
}
function removeUnchangedLock(lockPath, expected, kind) {
    const movedPath = sidecarPath(lockPath, kind);
    try {
        renameSync(lockPath, movedPath);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return false;
        throw error;
    }
    const moved = lockSnapshot(movedPath);
    if (!sameSnapshot(moved, expected)) {
        if (moved !== null)
            restoreMovedFile(lockPath, movedPath, moved);
        return false;
    }
    removeFileIfExists(movedPath);
    forgetMalformedObservation(lockPath);
    return true;
}
function removeFileIfOwned(lockPath, owner) {
    const snapshot = lockSnapshot(lockPath);
    if (snapshot === null || !sameOwner(snapshot.owner, owner))
        return false;
    return removeUnchangedLock(lockPath, snapshot, 'released');
}
function createLockFile(lockPath, owner, trackOwnership) {
    const guardPath = mutationGuardPath(lockPath);
    if (trackOwnership && pathExists(guardPath))
        return false;
    for (let permissionAttempt = 0; permissionAttempt < 2; permissionAttempt++) {
        try {
            writeFileSync(lockPath, serializeOwner(owner), { flag: 'wx', mode: 0o600 });
            if (trackOwnership && pathExists(guardPath)) {
                removeFileIfOwned(lockPath, owner);
                return false;
            }
            if (trackOwnership)
                ownedLocks.set(lockKey(lockPath), { owner, releasePending: false });
            forgetMalformedObservation(lockPath);
            return true;
        }
        catch (error) {
            if (isErrno(error, 'EEXIST'))
                return false;
            if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
                // Windows can report EPERM instead of EEXIST during contention. A regular owner is busy; if the owner
                // disappeared before lstat, retry create once to distinguish that release race from a persistent ACL
                // failure. Unsafe/inaccessible paths still throw from currentOwnerStat and remain fail closed.
                if (currentOwnerStat(lockPath) !== null)
                    return false;
                if (permissionAttempt === 0)
                    continue;
                throw new UnsafeLockPathError('permission_denied');
            }
            throw error;
        }
    }
    throw new UnsafeLockPathError('permission_denied');
}
function tryAcquireMutationGuard(lockPath) {
    const guardPath = mutationGuardPath(lockPath);
    const guard = newOwner();
    if (createLockFile(guardPath, guard, false))
        return guard;
    const snapshot = lockSnapshot(guardPath);
    if (snapshot === null || !reclaimableSnapshot(guardPath, snapshot))
        return null;
    if (!removeUnchangedLock(guardPath, snapshot, 'stale'))
        return null;
    return createLockFile(guardPath, guard, false) ? guard : null;
}
function releaseMutationGuard(lockPath, guard) {
    removeFileIfOwned(mutationGuardPath(lockPath), guard);
}
function reclaimStaleLock(lockPath) {
    const guard = tryAcquireMutationGuard(lockPath);
    if (guard === null)
        return false;
    try {
        const snapshot = lockSnapshot(lockPath);
        if (snapshot === null || !reclaimableSnapshot(lockPath, snapshot))
            return false;
        return removeUnchangedLock(lockPath, snapshot, 'stale');
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
 * is removed by hand. Empty or truncated locks are reclaimed only after the same inode and contents
 * remain malformed for a grace period, so a live creator can finish publishing its owner payload.
 * Acquisition stays atomic (O_EXCL), and stale reclaim moves the old lock aside under a mutation
 * guard, then verifies the inode snapshot before deletion. A live owner's lock (including this
 * process's own) is never stolen.
 *
 * NOTE: still synchronous (blocks the event loop while waiting) by design — it guards short
 * synchronous critical sections (append-only writes).
 */
export function acquireLock(lockPath, opts = {}) {
    const pending = ownedLocks.get(lockKey(lockPath));
    if (pending?.releasePending) {
        const released = releaseLock(lockPath);
        if (!released.released)
            throw new LockReleaseError(released.reason);
    }
    const maxTries = opts.maxTries ?? 300;
    const waitMs = opts.waitMs ?? 10;
    for (let i = 0; i < maxTries; i++) {
        const owner = newOwner();
        if (createLockFile(lockPath, owner, true)) {
            return;
        }
        const current = lockSnapshot(lockPath);
        if (current !== null && reclaimableSnapshot(lockPath, current)) {
            if (!reclaimStaleLock(lockPath))
                syncSleep(waitMs);
            continue;
        }
        if (current === null && pathExists(mutationGuardPath(lockPath))) {
            const guard = tryAcquireMutationGuard(lockPath);
            if (guard !== null)
                releaseMutationGuard(lockPath, guard);
        }
        syncSleep(waitMs);
    }
    throw new LockTimeoutError();
}
export function releaseLock(lockPath) {
    const key = lockKey(lockPath);
    const owned = ownedLocks.get(key);
    if (owned === undefined)
        return { released: true, reason: 'not_owned' };
    const failed = (reason) => {
        owned.releasePending = true;
        return { released: false, reason };
    };
    // Release must not use lockOwner(): that helper intentionally folds path_changed into a conservative null
    // for acquire retries. Here, an inconclusive read marks a pending release so the next acquire can retry or
    // surface LOCK_RELEASE_FAILED instead of silently timing out behind this process's own PID.
    let raw;
    try {
        raw = readOwnerBounded(lockPath);
    }
    catch (error) {
        return failed(error instanceof UnsafeLockPathError ? error.reason : 'release_failed');
    }
    if (raw === null) {
        ownedLocks.delete(key);
        return { released: true, reason: 'missing' };
    }
    const current = parseOwner(raw);
    if (current === null)
        return failed('invalid_owner');
    if (!sameOwner(current, owned.owner)) {
        ownedLocks.delete(key);
        return { released: true, reason: 'ownership_changed' };
    }
    const releasedPath = sidecarPath(lockPath, 'released');
    try {
        renameSync(lockPath, releasedPath);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT')) {
            ownedLocks.delete(key);
            return { released: true, reason: 'missing' };
        }
        return failed('release_failed');
    }
    ownedLocks.delete(key);
    try {
        removeFileIfExists(releasedPath);
    }
    catch {
        return { released: true, reason: 'released_with_cleanup_error' };
    }
    return { released: true, reason: 'released' };
}
export class LockReleaseError extends Error {
    reason;
    code = 'LOCK_RELEASE_FAILED';
    constructor(reason) {
        super(`文件锁释放未完成: ${reason}`);
        this.reason = reason;
        this.name = 'LockReleaseError';
    }
}