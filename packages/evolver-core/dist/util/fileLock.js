import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
export function syncSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const MALFORMED_LOCK_GRACE_NS = 1000000000n;
const OBSERVED_PROCESS_IDENTITY_CACHE_NS = 5000000000n;
const PROCESS_IDENTITY_TIMEOUT_MS = 15_000;
const HOST_WINDOWS_SYSTEM_ROOT = process.env['SystemRoot']?.trim() || 'C:\\Windows';
const ownedLocks = new Map();
const malformedLockObservations = new Map();
const observedProcessIdentities = new Map();
let currentProcessIdentity;
let fileLockTestHooks = {};
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
    const processStart = processStartIdentity(process.pid);
    if (processStart === null)
        throw new UnsafeLockPathError('process_identity_unavailable');
    return { pid: process.pid, token: randomUUID(), processStart };
}
function serializeOwner(owner) {
    return `${JSON.stringify({
        v: 2,
        pid: owner.pid,
        token: owner.token,
        processStart: owner.processStart,
    })}\n`;
}
function publicOwnerRecord(owner) {
    return {
        pid: owner.pid,
        token: owner.token,
        processStartIdentity: { ...owner.processStart },
    };
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function validPositiveIntegerText(value) {
    return /^[1-9]\d*$/.test(value);
}
function validIdentityText(value, maxLength) {
    if (value.length === 0 || value.length > maxLength)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f)
            return false;
    }
    return true;
}
let cachedLinuxBootId;
function linuxBootId() {
    if (cachedLinuxBootId !== undefined)
        return cachedLinuxBootId;
    try {
        const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase();
        cachedLinuxBootId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
            ? value
            : null;
    }
    catch {
        cachedLinuxBootId = null;
    }
    return cachedLinuxBootId;
}
function linuxProcessStartTicks(pid) {
    try {
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = raw.lastIndexOf(')');
        if (commandEnd < 0)
            return null;
        const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
        const startTicks = fields[19];
        return startTicks !== undefined && validPositiveIntegerText(startTicks) ? startTicks : null;
    }
    catch {
        return null;
    }
}
function linuxProcessStartIdentity(pid) {
    const first = linuxProcessStartTicks(pid);
    const bootId = linuxBootId();
    const second = linuxProcessStartTicks(pid);
    return first !== null && first === second && bootId !== null
        ? { source: 'linux-proc', bootId, startTicks: first }
        : null;
}
function trustedWindowsPowerShell() {
    if (!win32.isAbsolute(HOST_WINDOWS_SYSTEM_ROOT)
        || !validIdentityText(HOST_WINDOWS_SYSTEM_ROOT, 1024))
        return null;
    const executable = win32.join(HOST_WINDOWS_SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return existsSync(executable) ? executable : null;
}
function windowsProcessStartIdentity(pid) {
    const powershell = trustedWindowsPowerShell();
    if (powershell === null)
        return null;
    const script = [
        `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
        '$ticks = $process.StartTime.ToUniversalTime().Ticks',
        '[Console]::Out.Write($ticks.ToString([Globalization.CultureInfo]::InvariantCulture))',
    ].join('; ');
    try {
        const startTimeTicks = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: PROCESS_IDENTITY_TIMEOUT_MS,
            windowsHide: true,
        }).trim();
        return validPositiveIntegerText(startTimeTicks)
            ? { source: 'windows-powershell', startTimeTicks }
            : null;
    }
    catch {
        return null;
    }
}
function darwinProcessStartIdentity(pid) {
    try {
        const startTime = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: PROCESS_IDENTITY_TIMEOUT_MS,
        }).trim().replace(/\s+/g, ' ');
        return validIdentityText(startTime, 128)
            ? { source: 'darwin-ps', startTime }
            : null;
    }
    catch {
        return null;
    }
}
function nativeProcessStartIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    if (process.platform === 'linux')
        return linuxProcessStartIdentity(pid);
    if (process.platform === 'win32')
        return windowsProcessStartIdentity(pid);
    if (process.platform === 'darwin')
        return darwinProcessStartIdentity(pid);
    return null;
}
function processStartIdentity(pid, claimedIdentity) {
    if (pid === process.pid) {
        if (currentProcessIdentity === undefined) {
            const resolved = (fileLockTestHooks.processStartIdentity ?? nativeProcessStartIdentity)(pid);
            if (resolved !== null)
                currentProcessIdentity = resolved;
            return resolved;
        }
        return currentProcessIdentity;
    }
    const now = process.hrtime.bigint();
    const cached = observedProcessIdentities.get(pid);
    if (cached !== undefined
        && claimedIdentity !== undefined
        && sameProcessStartIdentity(cached.claimedIdentity, claimedIdentity)
        && now < cached.expiresAtNs) {
        return cached.identity;
    }
    const identity = (fileLockTestHooks.processStartIdentity ?? nativeProcessStartIdentity)(pid);
    if (claimedIdentity !== undefined) {
        observedProcessIdentities.set(pid, {
            claimedIdentity,
            identity,
            expiresAtNs: now + OBSERVED_PROCESS_IDENTITY_CACHE_NS,
        });
    }
    return identity;
}
function sameProcessStartIdentity(left, right) {
    if (left.source !== right.source)
        return false;
    if (left.source === 'linux-proc' && right.source === 'linux-proc') {
        return left.bootId === right.bootId && left.startTicks === right.startTicks;
    }
    if (left.source === 'windows-powershell' && right.source === 'windows-powershell') {
        return left.startTimeTicks === right.startTimeTicks;
    }
    return left.source === 'darwin-ps'
        && right.source === 'darwin-ps'
        && left.startTime === right.startTime;
}
/** Fresh native process-start observation. Unlike lock acquisition, this does not use caches. */
export function readFileLockProcessStartIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    const identity = (fileLockTestHooks.processStartIdentity ?? nativeProcessStartIdentity)(pid);
    return identity === null ? null : { ...identity };
}
export function sameFileLockProcessStartIdentity(left, right) {
    return sameProcessStartIdentity(left, right);
}
export function parseFileLockProcessStartIdentity(value) {
    return parseProcessStartIdentity(value) ?? undefined;
}
/**
 * Conservative owner classification for crash recovery. PID reuse and unavailable identity
 * remain distinct from a proven-dead PID so callers cannot reclaim ambiguous ownership.
 */
export function inspectFileLockOwnerProcess(owner) {
    if (!pidAlive(owner.pid))
        return 'dead';
    const current = readFileLockProcessStartIdentity(owner.pid);
    if (current === null)
        return 'unverifiable';
    return sameProcessStartIdentity(owner.processStartIdentity, current) ? 'current' : 'pid_reused';
}
export function _setFileLockTestHooksForTest(hooks = {}) {
    fileLockTestHooks = hooks;
    currentProcessIdentity = undefined;
    observedProcessIdentities.clear();
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
/** True if pid is a live process (cross-platform via signal 0; EPERM = exists but owned by another user). */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (fileLockTestHooks.pidAlive)
        return fileLockTestHooks.pidAlive(pid);
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
function parseProcessStartIdentity(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    if (record['source'] === 'linux-proc') {
        const bootId = record['bootId'];
        const startTicks = record['startTicks'];
        return typeof bootId === 'string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)
            && typeof startTicks === 'string'
            && validPositiveIntegerText(startTicks)
            ? { source: 'linux-proc', bootId, startTicks }
            : null;
    }
    if (record['source'] === 'windows-powershell') {
        const startTimeTicks = record['startTimeTicks'];
        return typeof startTimeTicks === 'string' && validPositiveIntegerText(startTimeTicks)
            ? { source: 'windows-powershell', startTimeTicks }
            : null;
    }
    if (record['source'] === 'darwin-ps') {
        const startTime = record['startTime'];
        return typeof startTime === 'string' && validIdentityText(startTime, 128)
            ? { source: 'darwin-ps', startTime }
            : null;
    }
    return null;
}
function parseJsonOwner(raw) {
    try {
        const value = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return null;
        const record = value;
        if (typeof record['pid'] !== 'number'
            || !Number.isInteger(record['pid'])
            || record['pid'] <= 0
            || typeof record['token'] !== 'string'
            || record['token'].length === 0) {
            return null;
        }
        if (record['v'] === 2) {
            const processStart = parseProcessStartIdentity(record['processStart']);
            return processStart === null
                ? null
                : { pid: record['pid'], token: record['token'], processStart };
        }
        if (record['v'] === 1 || record['v'] === undefined) {
            return { pid: record['pid'], token: record['token'], processStart: null };
        }
        return null;
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
    return Number.isInteger(pid) && pid > 0 ? { pid, token: null, processStart: null } : null;
}
function parseOwner(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return null;
    return parseJsonOwner(trimmed) ?? parseLegacyOwner(trimmed);
}
function readLockSnapshot(lockPath) {
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
/** Snapshot of the lock inode and its owner payload; null if the path disappeared or changed during inspection. */
function lockSnapshot(lockPath) {
    try {
        return readLockSnapshot(lockPath);
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
        if (!pidAlive(snapshot.owner.pid)) {
            observedProcessIdentities.delete(snapshot.owner.pid);
            return true;
        }
        if (snapshot.owner.processStart === null)
            return false;
        const liveProcessStart = processStartIdentity(snapshot.owner.pid, snapshot.owner.processStart);
        return liveProcessStart !== null
            && !sameProcessStartIdentity(snapshot.owner.processStart, liveProcessStart);
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
    return parsed?.pid === owner.pid
        && parsed.token === owner.token
        && parsed.processStart !== null
        && sameProcessStartIdentity(parsed.processStart, owner.processStart);
}
function guardianPath(lockPath) {
    return join(dirname(lockPath), `.${basename(lockPath)}.guardian`);
}
function serializedOwnerRecord(owner) {
    return {
        pid: owner.pid,
        token: owner.token,
        processStart: owner.processStart,
    };
}
function parseGuardianOwner(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const record = value;
    const keys = Object.keys(record).sort();
    if (keys.length !== 3
        || keys[0] !== 'pid'
        || keys[1] !== 'processStart'
        || keys[2] !== 'token'
        || !Number.isSafeInteger(record['pid'])
        || record['pid'] <= 0
        || typeof record['token'] !== 'string'
        || record['token'].length === 0
        || record['token'].length > 128)
        return null;
    const processStart = parseProcessStartIdentity(record['processStart']);
    return processStart === null
        ? null
        : { pid: record['pid'], token: record['token'], processStart };
}
function parseLockGuardian(raw) {
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return null;
        const record = value;
        const keys = Object.keys(record).sort();
        if (keys.length !== 3 || keys[0] !== 'from' || keys[1] !== 'guardian'
            || keys[2] !== 'v' || record['v'] !== 1)
            return null;
        const from = parseGuardianOwner(record['from']);
        const guardian = parseGuardianOwner(record['guardian']);
        return from && guardian ? { from, guardian } : null;
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return null;
        throw error;
    }
}
function serializeLockGuardian(record) {
    return `${JSON.stringify({
        v: 1,
        from: serializedOwnerRecord(record.from),
        guardian: serializedOwnerRecord(record.guardian),
    })}\n`;
}
function readLockGuardianSnapshot(lockPath) {
    const read = readOwnerFileBounded(guardianPath(lockPath));
    if (read === null)
        return null;
    return {
        record: parseLockGuardian(read.raw),
        snapshot: {
            owner: null,
            dev: read.stat.dev,
            ino: read.stat.ino,
            size: read.stat.size,
            mtimeNs: read.stat.mtimeNs,
        },
    };
}
function guardianReclaimable(record) {
    if (!pidAlive(record.guardian.pid)) {
        observedProcessIdentities.delete(record.guardian.pid);
        return true;
    }
    const current = processStartIdentity(record.guardian.pid, record.guardian.processStart);
    return current !== null && !sameProcessStartIdentity(record.guardian.processStart, current);
}
function sameGuardianRecord(left, right) {
    return sameOwner({
        pid: left.from.pid,
        token: left.from.token,
        processStart: left.from.processStart,
    }, right.from) && sameOwner({
        pid: left.guardian.pid,
        token: left.guardian.token,
        processStart: left.guardian.processStart,
    }, right.guardian);
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
function removeUnchangedLock(lockPath, expected, kind, onCleanupError) {
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
    try {
        removeFileIfExists(movedPath);
    }
    catch (error) {
        if (onCleanupError === undefined)
            throw error;
        onCleanupError(error);
    }
    forgetMalformedObservation(lockPath);
    return true;
}
function removeFileIfOwned(lockPath, owner, onCleanupError) {
    const snapshot = lockSnapshot(lockPath);
    if (snapshot === null || !sameOwner(snapshot.owner, owner))
        return false;
    return removeUnchangedLock(lockPath, snapshot, 'released', onCleanupError);
}
function publishOwnerFile(lockPath, owner) {
    const temporaryPath = sidecarPath(lockPath, 'publishing');
    let descriptor;
    let published = false;
    let publicationResult = false;
    let failure;
    try {
        descriptor = openSync(temporaryPath, 'wx', 0o600);
        writeFileSync(descriptor, serializeOwner(owner), { encoding: 'utf8' });
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        fileLockTestHooks.beforeOwnerPublish?.(temporaryPath, lockPath);
        try {
            linkSync(temporaryPath, lockPath);
            published = true;
            publicationResult = true;
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                failure = error;
        }
    }
    catch (error) {
        failure = error;
    }
    finally {
        if (descriptor !== undefined) {
            try {
                closeSync(descriptor);
            }
            catch (error) {
                failure ??= error;
            }
        }
        try {
            unlinkSync(temporaryPath);
        }
        catch (error) {
            // Once linked, the final owner is valid and must be tracked even if the temporary name cannot be removed.
            if (!published && !isErrno(error, 'ENOENT'))
                failure ??= error;
        }
    }
    if (failure !== undefined)
        throw failure;
    return publicationResult;
}
function publishGuardianFile(lockPath, record) {
    const finalPath = guardianPath(lockPath);
    const temporaryPath = sidecarPath(finalPath, 'publishing');
    let descriptor;
    let published = false;
    let publicationResult = false;
    let failure;
    try {
        descriptor = openSync(temporaryPath, 'wx', 0o600);
        writeFileSync(descriptor, serializeLockGuardian(record), { encoding: 'utf8' });
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        fileLockTestHooks.beforeGuardianPublish?.(temporaryPath, finalPath);
        try {
            linkSync(temporaryPath, finalPath);
            published = true;
            publicationResult = true;
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                failure = error;
        }
    }
    catch (error) {
        failure = error;
    }
    finally {
        if (descriptor !== undefined) {
            try {
                closeSync(descriptor);
            }
            catch (error) {
                failure ??= error;
            }
        }
        try {
            unlinkSync(temporaryPath);
        }
        catch (error) {
            if (!published && !isErrno(error, 'ENOENT'))
                failure ??= error;
        }
    }
    if (failure !== undefined)
        throw failure;
    return publicationResult;
}
function createLockFile(lockPath, owner, trackOwnership) {
    const guardPath = mutationGuardPath(lockPath);
    if (trackOwnership && pathExists(guardPath))
        return false;
    if (trackOwnership && pathExists(guardianPath(lockPath)))
        return false;
    if (pathExists(lockPath))
        return false;
    for (let permissionAttempt = 0; permissionAttempt < 2; permissionAttempt++) {
        try {
            if (!publishOwnerFile(lockPath, owner))
                return false;
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
function releaseMutationGuard(lockPath, guard, onCleanupError) {
    fileLockTestHooks.beforeMutationGuardRelease?.(mutationGuardPath(lockPath), lockPath);
    return removeFileIfOwned(mutationGuardPath(lockPath), guard, onCleanupError);
}
function withMutationGuardRelease(lockPath, guard, operation, onCleanupError) {
    let operationCompleted = false;
    let operationResult;
    let operationError;
    try {
        operationResult = operation();
        operationCompleted = true;
    }
    catch (error) {
        operationError = error;
    }
    let releaseError;
    try {
        if (!releaseMutationGuard(lockPath, guard, onCleanupError)) {
            releaseError = new UnsafeLockPathError('path_changed');
        }
    }
    catch (error) {
        releaseError = error;
    }
    if (!operationCompleted) {
        if (releaseError !== undefined) {
            throw new AggregateError([operationError, releaseError], 'file lock mutation failed and mutation-guard release is unconfirmed');
        }
        throw operationError;
    }
    if (releaseError !== undefined)
        throw releaseError;
    return operationResult;
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
function reclaimStaleGuardian(lockPath) {
    const guard = tryAcquireMutationGuard(lockPath);
    if (guard === null)
        return false;
    try {
        const observed = readLockGuardianSnapshot(lockPath);
        if (observed === null)
            return false;
        const receiptPath = guardianPath(lockPath);
        if (observed.record === null) {
            if (!reclaimableSnapshot(receiptPath, observed.snapshot))
                return false;
            fileLockTestHooks.beforeGuardianReclaim?.(receiptPath, lockPath);
            return removeUnchangedLock(receiptPath, observed.snapshot, 'guardian-malformed');
        }
        if (!guardianReclaimable(observed.record))
            return false;
        fileLockTestHooks.beforeGuardianReclaim?.(guardianPath(lockPath), lockPath);
        const current = lockSnapshot(lockPath);
        const locallyRetained = observed.record.from.pid === process.pid
            && ownedLocks.get(lockKey(lockPath)) === undefined;
        if (current !== null
            && sameOwner(current.owner, observed.record.from)
            && (locallyRetained || reclaimableSnapshot(lockPath, current))) {
            removeUnchangedLock(lockPath, current, 'guardian-owner-stale');
        }
        return removeUnchangedLock(receiptPath, observed.snapshot, 'guardian-stale');
    }
    finally {
        releaseMutationGuard(lockPath, guard);
    }
}
function samePublicOwner(left, right) {
    return left.pid === right.pid
        && left.token === right.token
        && sameProcessStartIdentity(left.processStartIdentity, right.processStart);
}
function observeTransferTarget(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !pidAlive(pid)) {
        return { reason: 'target_process_dead' };
    }
    const first = readFileLockProcessStartIdentity(pid);
    if (first === null)
        return { reason: 'target_process_unverifiable' };
    if (!pidAlive(pid))
        return { reason: 'target_process_dead' };
    const second = readFileLockProcessStartIdentity(pid);
    if (second === null)
        return { reason: 'target_process_unverifiable' };
    if (!sameProcessStartIdentity(first, second)) {
        return { reason: 'target_process_pid_reused' };
    }
    if (!pidAlive(pid))
        return { reason: 'target_process_dead' };
    return { owner: { pid, token: randomUUID(), processStart: second } };
}
/**
 * Pre-arm an acquired lock with the exact child PID generation while retaining local ownership.
 * A controller can therefore keep mutating its journal, while a hard controller crash cannot make
 * the primary owner reclaimable until the child exits.
 */
export function attachLockGuardianToProcess(lockPath, expectedOwner, targetPid) {
    const key = lockKey(lockPath);
    const owned = ownedLocks.get(key);
    if (owned === undefined)
        return { attached: false, reason: 'not_owned' };
    if (owned.releasePending || !samePublicOwner(expectedOwner, owned.owner)) {
        return { attached: false, reason: 'ownership_changed' };
    }
    const guard = tryAcquireMutationGuard(lockPath);
    if (guard === null)
        return { attached: false, reason: 'mutation_busy' };
    const guarded = withMutationGuardRelease(lockPath, guard, () => {
        const current = readLockSnapshot(lockPath);
        if (current === null || !sameOwner(current.owner, owned.owner)) {
            return { result: { attached: false, reason: 'ownership_changed' } };
        }
        if (owned.guardian !== undefined || readLockGuardianSnapshot(lockPath) !== null) {
            return { result: { attached: false, reason: 'guardian_exists' } };
        }
        const target = observeTransferTarget(targetPid);
        if ('reason' in target) {
            return { result: { attached: false, reason: target.reason } };
        }
        const record = {
            from: owned.owner,
            guardian: target.owner,
        };
        if (!publishGuardianFile(lockPath, record)) {
            return { result: { attached: false, reason: 'guardian_exists' } };
        }
        const publishedGuardian = readLockGuardianSnapshot(lockPath);
        if (publishedGuardian?.record === null || publishedGuardian === null
            || !sameGuardianRecord(publishedGuardian.record, record)) {
            return { result: { attached: false, reason: 'path_changed' } };
        }
        fileLockTestHooks.afterGuardianPublish?.(guardianPath(lockPath), lockPath);
        const settledGuardian = readLockGuardianSnapshot(lockPath);
        const settled = lockSnapshot(lockPath);
        const guardianUnchanged = settledGuardian !== null
            && sameSnapshot(publishedGuardian.snapshot, settledGuardian.snapshot)
            && settledGuardian.record !== null
            && sameGuardianRecord(settledGuardian.record, record);
        const ownerUnchanged = settled !== null
            && sameSnapshot(current, settled)
            && sameOwner(settled.owner, owned.owner);
        if (!guardianUnchanged || !ownerUnchanged) {
            if (guardianUnchanged) {
                removeUnchangedLock(guardianPath(lockPath), settledGuardian.snapshot, 'guardian-transfer-aborted');
            }
            if (!ownerUnchanged)
                ownedLocks.delete(key);
            return { result: { attached: false, reason: 'path_changed' } };
        }
        forgetMalformedObservation(lockPath);
        return {
            result: {
                attached: true,
                reason: 'attached',
                guardian: publicOwnerRecord(target.owner),
            },
            guardian: record,
        };
    });
    if (guarded.guardian !== undefined) {
        owned.guardian = guarded.guardian;
    }
    return guarded.result;
}
/**
 * Drop local ownership only after an already-published guardian has been revalidated exactly.
 * No file mutation is needed: the durable guardian receipt is the crash-safe owner binding.
 */
export function retainLockGuardianForProcess(lockPath, expectedOwner, expectedGuardian) {
    const key = lockKey(lockPath);
    const owned = ownedLocks.get(key);
    if (owned === undefined)
        return { retained: false, reason: 'not_owned' };
    if (owned.releasePending || !samePublicOwner(expectedOwner, owned.owner)) {
        return { retained: false, reason: 'ownership_changed' };
    }
    if (owned.guardian === undefined)
        return { retained: false, reason: 'guardian_missing' };
    if (!samePublicOwner(expectedGuardian, owned.guardian.guardian)) {
        return { retained: false, reason: 'ownership_changed' };
    }
    const guardian = owned.guardian;
    const guard = tryAcquireMutationGuard(lockPath);
    if (guard === null)
        return { retained: false, reason: 'mutation_busy' };
    const result = withMutationGuardRelease(lockPath, guard, () => {
        const current = readLockSnapshot(lockPath);
        const receipt = readLockGuardianSnapshot(lockPath);
        if (current === null || !sameOwner(current.owner, owned.owner)) {
            return { retained: false, reason: 'ownership_changed' };
        }
        if (receipt?.record === null || receipt === null
            || !sameGuardianRecord(receipt.record, guardian)) {
            return { retained: false, reason: 'path_changed' };
        }
        return { retained: true, reason: 'retained' };
    });
    if (result.retained) {
        ownedLocks.delete(key);
    }
    return result;
}
/**
 * Remove an exact attached guardian after the child has definitely exited, retaining the primary
 * owner so rollback or another launch can continue under the same lifecycle lease.
 */
export function clearLockGuardianForProcess(lockPath, expectedOwner, expectedGuardian) {
    const key = lockKey(lockPath);
    const owned = ownedLocks.get(key);
    if (owned === undefined)
        return { cleared: false, reason: 'not_owned' };
    if (owned.releasePending || !samePublicOwner(expectedOwner, owned.owner)) {
        return { cleared: false, reason: 'ownership_changed' };
    }
    if (owned.guardian === undefined
        || !samePublicOwner(expectedGuardian, owned.guardian.guardian)) {
        return { cleared: false, reason: 'ownership_changed' };
    }
    const guardian = owned.guardian;
    const guard = tryAcquireMutationGuard(lockPath);
    if (guard === null)
        return { cleared: false, reason: 'mutation_busy' };
    const result = withMutationGuardRelease(lockPath, guard, () => {
        const current = readLockSnapshot(lockPath);
        if (current === null || !sameOwner(current.owner, owned.owner)) {
            return { cleared: false, reason: 'ownership_changed' };
        }
        const receipt = readLockGuardianSnapshot(lockPath);
        if (receipt === null) {
            return { cleared: true, reason: 'missing' };
        }
        if (receipt.record === null || !sameGuardianRecord(receipt.record, guardian)) {
            return { cleared: false, reason: 'path_changed' };
        }
        if (!removeUnchangedLock(guardianPath(lockPath), receipt.snapshot, 'guardian-cleared')) {
            return { cleared: false, reason: 'path_changed' };
        }
        return { cleared: true, reason: 'cleared' };
    });
    if (result.cleared) {
        delete owned.guardian;
    }
    return result;
}
/**
 * Atomically bind an acquired lock to a still-running child and relinquish local ownership.
 */
export function transferLockOwnershipToProcess(lockPath, expectedOwner, targetPid) {
    const attached = attachLockGuardianToProcess(lockPath, expectedOwner, targetPid);
    if (!attached.attached)
        return { transferred: false, reason: attached.reason };
    const retained = retainLockGuardianForProcess(lockPath, expectedOwner, attached.guardian);
    if (!retained.retained)
        return { transferred: false, reason: retained.reason };
    return {
        transferred: true,
        reason: 'transferred',
        guardian: attached.guardian,
    };
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
        const guardian = readLockGuardianSnapshot(lockPath);
        if (guardian !== null) {
            const reclaimable = guardian.record === null
                ? reclaimableSnapshot(guardianPath(lockPath), guardian.snapshot)
                : guardianReclaimable(guardian.record);
            if (!reclaimable) {
                syncSleep(waitMs);
                continue;
            }
            if (!reclaimStaleGuardian(lockPath)) {
                syncSleep(waitMs);
                continue;
            }
        }
        const owner = newOwner();
        if (createLockFile(lockPath, owner, true)) {
            return publicOwnerRecord(owner);
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
    let guard;
    try {
        guard = tryAcquireMutationGuard(lockPath);
    }
    catch (error) {
        return failed(error instanceof UnsafeLockPathError ? error.reason : 'release_failed');
    }
    if (guard === null)
        return failed('release_failed');
    let cleanupFailed = false;
    let forgetOwnership = false;
    let result;
    try {
        result = withMutationGuardRelease(lockPath, guard, () => {
            // Release must use exact snapshots. Inconclusive reads leave a pending release instead of
            // silently unlocking a live guarded child.
            const current = readLockSnapshot(lockPath);
            if (current === null) {
                if (owned.guardian !== undefined)
                    return failed('ownership_changed');
                forgetOwnership = true;
                return { released: true, reason: 'missing' };
            }
            if (current.owner === null)
                return failed('invalid_owner');
            if (!sameOwner(current.owner, owned.owner)) {
                forgetOwnership = true;
                return { released: true, reason: 'ownership_changed' };
            }
            const receipt = readLockGuardianSnapshot(lockPath);
            if (owned.guardian !== undefined) {
                if (receipt !== null) {
                    if (receipt.record === null || !sameGuardianRecord(receipt.record, owned.guardian)) {
                        return failed('path_changed');
                    }
                    if (!removeUnchangedLock(guardianPath(lockPath), receipt.snapshot, 'guardian-released', () => { cleanupFailed = true; })) {
                        return failed('path_changed');
                    }
                }
            }
            else if (receipt !== null) {
                return failed('path_changed');
            }
            if (!removeUnchangedLock(lockPath, current, 'released', () => { cleanupFailed = true; })) {
                return failed('path_changed');
            }
            forgetOwnership = true;
            return { released: true, reason: 'released' };
        }, () => { cleanupFailed = true; });
    }
    catch (error) {
        return failed(error instanceof UnsafeLockPathError ? error.reason : 'release_failed');
    }
    if (result.released && forgetOwnership)
        ownedLocks.delete(key);
    return result.released && cleanupFailed
        ? { released: true, reason: 'released_with_cleanup_error' }
        : result;
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