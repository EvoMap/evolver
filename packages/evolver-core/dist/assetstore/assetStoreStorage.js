import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, } from 'node:fs';
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
export const EXPERIENCE_BUNDLE_SCHEMA = 'evolver.assetstore-experience.v3';
export class ExperienceRecoveryRequiredError extends Error {
    code = 'EXPERIENCE_RECOVERY_REQUIRED';
    constructor() { super('experience transaction requires recovery'); }
}
/** Every supported shared-lock writer must refuse an unfinished experience transaction. */
export function assertNoExperienceTransaction(baseDir) {
    if (assertOptionalRegularFile(join(baseDir, '.assetstore-bundle.json'), 'temp_file') !== null)
        throw new ExperienceRecoveryRequiredError();
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
        if (!deps.experienceRecovery && basename(lockPath) === '.assetstore.lock')
            assertNoExperienceTransaction(dirname(lockPath));
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
function nativePathIdentity(path, role, witnessAccess = constants.O_RDONLY, strictSnapshot = false) {
    const current = lstatSync(path, { bigint: true });
    if (current.isSymbolicLink())
        throw new UnsafeAssetStorePathError(role, 'symlink');
    if (!current.isFile())
        throw new UnsafeAssetStorePathError(role, 'not_regular_file');
    if (process.platform !== 'win32' || current.dev !== 0n)
        return current;
    // Windows lstat can omit the volume identity even though fstat supplies it.
    // Acquire a fresh ordinary-file witness; never treat missing dev as equality.
    // Match the caller's access without creating, truncating or requiring extra data-read rights.
    const witness = openNoFollow(path, witnessAccess);
    let result;
    try {
        const identity = fstatSync(witness, { bigint: true });
        const after = lstatSync(path, { bigint: true });
        const sameVersion = (named) => named.isFile() && !named.isSymbolicLink()
            && (named.dev === 0n ? identity.dev !== 0n : named.dev === identity.dev)
            && named.ino === identity.ino && named.birthtimeNs === identity.birthtimeNs
            && named.size === identity.size && named.mode === identity.mode && named.nlink === identity.nlink
            && named.uid === identity.uid && named.gid === identity.gid
            && named.mtimeNs === identity.mtimeNs && named.ctimeNs === identity.ctimeNs;
        if (!identity.isFile() || after.isSymbolicLink() || !after.isFile()
            || identity.ino !== current.ino || identity.ino !== after.ino
            || identity.birthtimeNs !== current.birthtimeNs || identity.birthtimeNs !== after.birthtimeNs
            || strictSnapshot && (!sameVersion(current) || !sameVersion(after))) {
            throw new UnsafeAssetStorePathError(role, 'path_changed');
        }
        result = { ok: true, identity };
    }
    catch (error) {
        result = { ok: false, error };
    }
    try {
        closeSync(witness);
    }
    catch (closeError) {
        if (!result.ok) {
            throw new AggregateError([result.error, closeError], 'asset store witness validation and close failed', { cause: result.error });
        }
        throw closeError;
    }
    if (!result.ok)
        throw result.error;
    return result.identity;
}
function assertOpenedPathMatches(fd, path, role, witnessAccess = constants.O_RDONLY) {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile())
        throw new UnsafeAssetStorePathError(role, 'not_regular_file');
    let current;
    try {
        current = nativePathIdentity(path, role, witnessAccess);
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
export function captureAssetStoreDirectoryIdentity(path) {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink())
        throw new UnsafeAssetStorePathError('base_directory', 'symlink');
    if (!before.isDirectory())
        throw new UnsafeAssetStorePathError('base_directory', 'not_directory');
    const fd = openNoFollow(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    let result;
    try {
        const opened = fstatSync(fd, { bigint: true }), after = lstatSync(path, { bigint: true });
        if (!opened.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
            || opened.ino !== before.ino || opened.birthtimeNs !== before.birthtimeNs
            || opened.ino !== after.ino || opened.birthtimeNs !== after.birthtimeNs
            || (process.platform !== 'win32' || before.dev !== 0n) && opened.dev !== before.dev
            || (process.platform !== 'win32' || after.dev !== 0n) && opened.dev !== after.dev) {
            throw new UnsafeAssetStorePathError('base_directory', 'path_changed');
        }
        result = { ok: true, identity: Object.freeze({ dev: opened.dev, ino: opened.ino, birthtimeNs: opened.birthtimeNs }) };
    }
    catch (error) {
        result = { ok: false, error };
    }
    try {
        closeSync(fd);
    }
    catch (closeError) {
        if (!result.ok)
            throw new AggregateError([result.error, closeError], 'asset store directory validation and close failed', { cause: result.error });
        throw closeError;
    }
    if (!result.ok)
        throw result.error;
    return result.identity;
}
export function assertAssetStoreDirectoryIdentity(path, expected) {
    let actual;
    try {
        actual = captureAssetStoreDirectoryIdentity(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            throw new UnsafeAssetStorePathError('base_directory', 'path_changed');
        throw error;
    }
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs) {
        throw new UnsafeAssetStorePathError('base_directory', 'path_changed');
    }
}
/** Preserve pathname type/content guards, filling only a regular file's missing Windows volume from a native witness. */
export function lstatWithAssetFileIdentity(path, witnessAccess = 'read') {
    const named = lstatSync(path, { bigint: true });
    if (process.platform !== 'win32' || named.dev !== 0n || named.isSymbolicLink() || !named.isFile())
        return named;
    const identity = captureRegularAssetFileIdentity(path, witnessAccess);
    if (named.ino !== identity.ino || named.birthtimeNs !== identity.birthtimeNs) {
        throw new UnsafeAssetStorePathError('asset_file', 'path_changed');
    }
    return Object.assign(named, { dev: identity.dev });
}
export function captureRegularAssetFileIdentity(path, witnessAccess = 'read') {
    const identity = nativePathIdentity(path, 'asset_file', witnessAccess === 'write' ? constants.O_WRONLY : constants.O_RDONLY);
    return Object.freeze({ dev: identity.dev, ino: identity.ino, birthtimeNs: identity.birthtimeNs });
}
/** A path version from a real kernel witness, not a held FD or a missing-volume wildcard. */
export function captureRegularAssetFileSnapshot(path, witnessAccess = constants.O_RDONLY) {
    return nativePathIdentity(path, 'asset_file', witnessAccess, true);
}
export function assertOpenedRegularAssetFile(fd, path, expected, witnessAccess = 'read') {
    assertOpenedPathMatches(fd, path, 'asset_file', witnessAccess === 'write' ? constants.O_WRONLY : constants.O_RDONLY);
    if (expected) {
        const actual = fstatSync(fd, { bigint: true });
        if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs) {
            throw new UnsafeAssetStorePathError('asset_file', 'path_changed');
        }
    }
}
function openNoFollow(path, flags, mode) {
    return mode === undefined
        ? openSync(path, flags | noFollowFlag())
        : openSync(path, flags | noFollowFlag(), mode);
}
export function readRegularBuffer(path, maxBytes = Number.MAX_SAFE_INTEGER, check = () => undefined) {
    check();
    if (assertOptionalRegularFile(path) === null) {
        check();
        return null;
    }
    const fd = openNoFollow(path, constants.O_RDONLY);
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        if (fstatSync(fd).size > maxBytes)
            throw new AssetStoreReadLimitError();
        const chunks = [];
        let total = 0;
        while (total <= maxBytes) {
            check();
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
            const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
            if (bytesRead === 0)
                break;
            total += bytesRead;
            if (total > maxBytes)
                throw new AssetStoreReadLimitError();
            chunks.push(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
        }
        check();
        assertOpenedPathMatches(fd, path, 'asset_file');
        return Buffer.concat(chunks, total);
    }
    finally {
        closeSync(fd);
    }
}
export function readUtf8Regular(path, maxBytes = Number.MAX_SAFE_INTEGER) {
    return readRegularBuffer(path, maxBytes)?.toString('utf8') ?? null;
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
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile())
            throw new UnsafeAssetStorePathError('asset_file', 'not_regular_file');
        openedIdentity = { dev: opened.dev, ino: opened.ino };
        assertOpenedPathMatches(fd, path, 'asset_file', constants.O_WRONLY);
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
            operationError = operationError === undefined ? error
                : new AggregateError([operationError, error], 'asset store exclusive write and close failed', { cause: operationError });
        }
    }
    if (operationError !== undefined) {
        try {
            const current = statOrNull(path) === null ? null : nativePathIdentity(path, 'temp_file', constants.O_WRONLY);
            if (openedIdentity
                && current !== null
                && !current.isSymbolicLink()
                && current.isFile()
                && current.dev === openedIdentity.dev
                && current.ino === openedIdentity.ino) {
                unlinkSync(path);
            }
        }
        catch (cleanupError) {
            throw new AggregateError([operationError, cleanupError], 'asset store exclusive write and cleanup failed', { cause: operationError });
        }
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
    const fd = openNoFollow(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        const stat = fstatSync(fd);
        let needsLineSeparator = false;
        if (stat.size > 0 && value.length > 0) {
            const tail = Buffer.allocUnsafe(1);
            const bytesRead = readSync(fd, tail, 0, 1, stat.size - 1);
            if (bytesRead !== 1)
                throw new Error('asset store tail read made no progress');
            needsLineSeparator = tail[0] !== 0x0a;
        }
        writeAll(fd, needsLineSeparator ? `\n${value}` : value);
        (opts.syncFile ?? fsyncSync)(fd);
    }
    finally {
        closeSync(fd);
    }
    if (!existed)
        (opts.syncDirectory ?? fsyncDirectoryBestEffort)(parent);
}
function removeTemp(path, identity, directory) {
    try {
        if (directory)
            assertAssetStoreDirectoryIdentity(dirname(path), directory);
        const current = nativePathIdentity(path, 'temp_file', constants.O_WRONLY);
        if (current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) {
            throw new UnsafeAssetStorePathError('temp_file', 'path_changed');
        }
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
    if (opts.expectedDirectory)
        assertAssetStoreDirectoryIdentity(parent, opts.expectedDirectory);
    assertOptionalRegularFile(path);
    const tempPath = join(parent, `.${basename(path)}.compact.${process.pid}.${randomUUID()}.tmp`);
    opts.onTempPath?.(tempPath);
    let renamed = false;
    let temporaryIdentity;
    let failure;
    try {
        if (opts.expectedDirectory)
            assertAssetStoreDirectoryIdentity(parent, opts.expectedDirectory);
        const fd = openNoFollow(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            const opened = fstatSync(fd, { bigint: true });
            temporaryIdentity = { dev: opened.dev, ino: opened.ino, birthtimeNs: opened.birthtimeNs };
            assertOpenedPathMatches(fd, tempPath, 'temp_file', constants.O_WRONLY);
            if (opts.expectedDirectory)
                assertAssetStoreDirectoryIdentity(parent, opts.expectedDirectory);
            writeAll(fd, value);
            (opts.syncFile ?? fsyncSync)(fd);
        }
        finally {
            closeSync(fd);
        }
        if (opts.expectedDirectory)
            assertAssetStoreDirectoryIdentity(parent, opts.expectedDirectory);
        assertOptionalRegularFile(path);
        if (opts.expectedFingerprint !== undefined && regularFileFingerprint(path) !== opts.expectedFingerprint) {
            throw new UnsafeAssetStorePathError('asset_file', 'path_changed');
        }
        renameSync(tempPath, path);
        renamed = true;
        if (opts.expectedDirectory)
            assertAssetStoreDirectoryIdentity(parent, opts.expectedDirectory);
        (opts.syncDirectory ?? fsyncDirectoryBestEffort)(parent);
        if (opts.expectedDirectory)
            assertAssetStoreDirectoryIdentity(parent, opts.expectedDirectory);
    }
    catch (error) {
        failure = { error };
    }
    if (!renamed && temporaryIdentity) {
        try {
            removeTemp(tempPath, temporaryIdentity, opts.expectedDirectory);
        }
        catch (cleanupError) {
            if (failure)
                throw new AggregateError([failure.error, cleanupError], 'asset store replacement and cleanup failed', { cause: failure.error });
            throw cleanupError;
        }
    }
    if (failure)
        throw failure.error;
}
/** Confirm the exact named projection on one descriptor before deleting its recovery intent. */
export function syncUtf8Regular(path, expected, opts = {}) {
    const check = () => {
        if (opts.expectedDirectory)
            assertAssetStoreDirectoryIdentity(dirname(path), opts.expectedDirectory);
        if (opts.expectedFingerprint !== undefined && regularFileFingerprint(path) !== opts.expectedFingerprint) {
            throw new UnsafeAssetStorePathError('asset_file', 'path_changed');
        }
    };
    check();
    const bytes = Buffer.from(expected);
    const fd = openNoFollow(path, constants.O_RDWR);
    try {
        assertOpenedPathMatches(fd, path, 'asset_file');
        if (fstatSync(fd).size !== bytes.length)
            throw new UnsafeAssetStorePathError('asset_file', 'path_changed');
        const actual = Buffer.alloc(Math.min(64 * 1024, bytes.length));
        for (let offset = 0; offset < bytes.length;) {
            const count = Math.min(actual.length, bytes.length - offset);
            const read = readSync(fd, actual, 0, count, offset);
            if (read !== count || !actual.subarray(0, count).equals(bytes.subarray(offset, offset + count))) {
                throw new UnsafeAssetStorePathError('asset_file', 'path_changed');
            }
            offset += count;
        }
        (opts.syncFile ?? fsyncSync)(fd);
        assertOpenedPathMatches(fd, path, 'asset_file');
    }
    finally {
        closeSync(fd);
    }
    check();
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