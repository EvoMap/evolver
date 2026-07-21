import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acquireLock, LockReleaseError, releaseLock, } from '../util/fileLock.js';
export class UnsafeAssetStorePathError extends Error {
    role;
    reason;
    code = 'UNSAFE_ASSET_STORE_PATH';
    constructor(role, reason) {
        super(`unsafe asset store ${role}: ${reason}`);
        this.role = role;
        this.reason = reason;
        this.name = 'UnsafeAssetStorePathError';
    }
}
export class AssetStoreReadLimitError extends Error {
    code = 'ASSET_STORE_READ_LIMIT';
    constructor() {
        super('asset store file exceeds the configured read limit');
        this.name = 'AssetStoreReadLimitError';
    }
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function noFollowFlag() {
    return constants['O_NOFOLLOW'] ?? 0;
}
function statOrNull(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw error;
    }
}
function assertRegularStat(stat, role) {
    if (stat.isSymbolicLink())
        throw new UnsafeAssetStorePathError(role, 'symlink');
    if (!stat.isFile())
        throw new UnsafeAssetStorePathError(role, 'not_regular_file');
    return stat;
}
export function ensureAssetStoreDirectory(path) {
    let stat = statOrNull(path);
    if (stat === null) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        stat = statOrNull(path);
    }
    assertAssetStoreDirectoryStat(stat);
}
function assertAssetStoreDirectoryStat(stat) {
    if (stat === null)
        throw new UnsafeAssetStorePathError('base_directory', 'not_directory');
    if (stat.isSymbolicLink())
        throw new UnsafeAssetStorePathError('base_directory', 'symlink');
    if (!stat.isDirectory())
        throw new UnsafeAssetStorePathError('base_directory', 'not_directory');
}
/** Validate an existing store root without recreating a deleted or unmounted path. */
export function assertAssetStoreDirectory(path) {
    assertAssetStoreDirectoryStat(statOrNull(path));
}
export function isReliableAssetStoreLockRelease(result) {
    return result.released
        && (result.reason === 'released' || result.reason === 'released_with_cleanup_error');
}
/**
 * Run one synchronous asset-store critical section without hiding its primary failure.
 * A release failure is surfaced only after a successful operation; when both fail, the operation error wins.
 */
export function withAssetStoreLock(lockPath, operation, deps = {}) {
    assertOptionalRegularFile(lockPath, 'lock_file');
    (deps.acquireLock ?? acquireLock)(lockPath);
    let value;
    let operationError;
    let operationFailed = false;
    try {
        value = operation();
    }
    catch (error) {
        operationFailed = true;
        operationError = error;
    }
    let releaseError;
    try {
        const released = (deps.releaseLock ?? releaseLock)(lockPath);
        if (!isReliableAssetStoreLockRelease(released))
            releaseError = new LockReleaseError(released.reason);
    }
    catch (error) {
        releaseError = error;
    }
    if (operationFailed)
        throw operationError;
    if (releaseError !== undefined)
        throw releaseError;
    return value;
}
export function assertOptionalRegularFile(path, role = 'asset_file') {
    const stat = statOrNull(path);
    return stat === null ? null : assertRegularStat(stat, role);
}
export function regularFileFingerprint(path) {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink())
            throw new UnsafeAssetStorePathError('asset_file', 'symlink');
        if (!stat.isFile())
            throw new UnsafeAssetStorePathError('asset_file', 'not_regular_file');
        return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return 'missing';
        throw error;
    }
}
function assertOpenedPathMatches(fd, path, role) {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile())
        throw new UnsafeAssetStorePathError(role, 'not_regular_file');
    let current;
    try {
        current = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            throw new UnsafeAssetStorePathError(role, 'path_changed');
        throw error;
    }
    if (current.isSymbolicLink())
        throw new UnsafeAssetStorePathError(role, 'symlink');
    if (!current.isFile())
        throw new UnsafeAssetStorePathError(role, 'not_regular_file');
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new UnsafeAssetStorePathError(role, 'path_changed');
    }
}
function openNoFollow(path, flags, mode) {
    return mode === undefined
        ? openSync(path, flags | noFollowFlag())
        : openSync(path, flags | noFollowFlag(), mode);
}
export function readRegularBuffer(path, maxBytes = Number.MAX_SAFE_INTEGER) {
    if (assertOptionalRegularFile(path) === null)
        return null;
    const fd = openNoFollow(path, constants.O_RDONLY);
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        if (fstatSync(fd).size > maxBytes)
            throw new AssetStoreReadLimitError();
        const value = readFileSync(fd);
        if (value.byteLength > maxBytes)
            throw new AssetStoreReadLimitError();
        return value;
    }
    finally {
        closeSync(fd);
    }
}
export function readUtf8Regular(path) {
    return readRegularBuffer(path)?.toString('utf8') ?? null;
}
function writeAll(fd, value) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    let offset = 0;
    while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0)
            throw new Error('asset store write made no progress');
        offset += written;
    }
}
export function createBufferDurableExclusive(path, value, opts = {}) {
    const parent = dirname(path);
    assertAssetStoreDirectory(parent);
    const fd = openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let operationError;
    let openedIdentity;
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        const opened = fstatSync(fd, { bigint: true });
        openedIdentity = { dev: opened.dev, ino: opened.ino };
        writeAll(fd, value);
        (opts.syncFile ?? fsyncSync)(fd);
    }
    catch (error) {
        operationError = error;
    }
    finally {
        try {
            closeSync(fd);
        }
        catch (error) {
            if (operationError === undefined)
                operationError = error;
        }
    }
    if (operationError !== undefined) {
        try {
            const current = lstatSync(path, { bigint: true });
            if (openedIdentity
                && !current.isSymbolicLink()
                && current.isFile()
                && current.dev === openedIdentity.dev
                && current.ino === openedIdentity.ino) {
                unlinkSync(path);
            }
        }
        catch { /* preserve the primary write/fsync failure */ }
        throw operationError;
    }
    (opts.syncDirectory ?? fsyncDirectoryBestEffort)(parent);
}
export function fsyncDirectoryBestEffort(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY);
        fsyncSync(fd);
    }
    catch {
        // Windows and some filesystems do not support syncing directory handles.
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* best-effort directory sync must stay best-effort */ }
        }
    }
}
export function appendUtf8Durable(path, value, opts = {}) {
    const parent = dirname(path);
    assertAssetStoreDirectory(parent);
    const existed = assertOptionalRegularFile(path) !== null;
    const fd = openNoFollow(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        writeAll(fd, value);
        (opts.syncFile ?? fsyncSync)(fd);
    }
    finally {
        closeSync(fd);
    }
    if (!existed)
        (opts.syncDirectory ?? fsyncDirectoryBestEffort)(parent);
}
function removeTemp(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
export function replaceUtf8Durable(path, value, opts = {}) {
    const parent = dirname(path);
    assertAssetStoreDirectory(parent);
    assertOptionalRegularFile(path);
    const tempPath = join(parent, `.${basename(path)}.compact.${process.pid}.${randomUUID()}.tmp`);
    opts.onTempPath?.(tempPath);
    let renamed = false;
    try {
        const fd = openNoFollow(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            assertOpenedPathMatches(fd, tempPath, 'temp_file');
            writeAll(fd, value);
            (opts.syncFile ?? fsyncSync)(fd);
        }
        finally {
            closeSync(fd);
        }
        assertOptionalRegularFile(path);
        renameSync(tempPath, path);
        renamed = true;
        (opts.syncDirectory ?? fsyncDirectoryBestEffort)(parent);
    }
    finally {
        if (!renamed)
            removeTemp(tempPath);
    }
}
/** Remove one exact UTF-8 suffix and fsync the new file length; false means the suffix was not current. */
export function truncateUtf8SuffixDurable(path, suffix, opts = {}) {
    if (assertOptionalRegularFile(path) === null)
        return false;
    const expected = Buffer.from(suffix, 'utf8');
    if (expected.length === 0)
        return false;
    const fd = openNoFollow(path, constants.O_RDWR);
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        const stat = fstatSync(fd);
        if (stat.size < expected.length)
            return false;
        const actual = Buffer.alloc(expected.length);
        let offset = 0;
        while (offset < actual.length) {
            const read = readSync(fd, actual, offset, actual.length - offset, stat.size - actual.length + offset);
            if (read === 0)
                return false;
            offset += read;
        }
        if (!actual.equals(expected))
            return false;
        ftruncateSync(fd, stat.size - expected.length);
        (opts.syncFile ?? fsyncSync)(fd);
        return true;
    }
    finally {
        closeSync(fd);
    }
}