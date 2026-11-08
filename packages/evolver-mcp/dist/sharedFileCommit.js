import { closeSync, constants as fsConstants, fsyncSync, fstatSync, fchmodSync, lstatSync, linkSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pinSharedDirectory, SharedDirectoryPostconditionError } from './sharedDirectory.js';
import { util } from '@evomap/evolver-core';
import { assertInstallerSyncCallback, assertInstallerSyncScopeActive, runInstallerSyncCallback } from './installerSync.js';
const pinnedDirectories = new Map();
function closePreservingFailure(close, primary, field) {
    try {
        close();
    }
    catch (error) {
        if (primary instanceof Error)
            Object.assign(primary, { [field]: error });
        else
            throw error;
    }
}
function withSharedDirectory(path, run) {
    const parent = resolve(dirname(path));
    if (pinnedDirectories.has(parent))
        return run();
    const directory = pinSharedDirectory(parent);
    pinnedDirectories.set(parent, directory);
    let primary;
    try {
        return run();
    }
    catch (error) {
        primary = error;
        throw error;
    }
    finally {
        pinnedDirectories.delete(parent);
        closePreservingFailure(() => directory.close(), primary, 'directoryCloseError');
    }
}
function pinned(path) { return pinnedDirectories.get(resolve(dirname(path))); }
function safeOpen(path, flags, mode) {
    const directory = pinned(path);
    return directory ? directory.open(path, flags, mode) : openSync(path, flags, mode);
}
function safeLink(from, to) {
    const directory = pinned(to);
    if (directory && process.platform !== 'win32')
        directory.link(from, to);
    else {
        directory?.assertCurrent();
        linkSync(from, to);
    }
}
function safeRename(from, to) {
    const directory = pinned(to);
    if (directory && process.platform !== 'win32')
        directory.rename(from, to);
    else {
        directory?.assertCurrent();
        renameSync(from, to);
    }
}
function safeUnlink(path) {
    const directory = pinned(path);
    if (directory && process.platform !== 'win32')
        directory.unlink(path);
    else {
        directory?.assertCurrent();
        unlinkSync(path);
    }
}
function safeRaw(path) {
    const fd = safeOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
        return snapshotForDescriptor(fd, path).raw;
    }
    finally {
        closeSync(fd);
    }
}
function safeExists(path) {
    try {
        safeRaw(path);
        return true;
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return false;
        throw error;
    }
}
function safeCopy(source, target, expectedSource) {
    withSharedDirectory(source, () => {
        const sourceFd = safeOpen(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
        let primary;
        try {
            const { bytes, snapshot } = contentsForDescriptor(sourceFd, source);
            if (expectedSource && !sameSharedFileIdentity(snapshot.identity, expectedSource.identity))
                throw new SharedFileConflictError(target, source);
            writeExclusiveCopy(target, bytes, snapshot.identity?.mode ?? 0o600);
        }
        catch (error) {
            primary = error;
            throw error;
        }
        finally {
            closePreservingFailure(() => closeSync(sourceFd), primary, 'sourceCloseError');
        }
    });
}
/** Never traverse a redirected parent, including parents above an adapter's safe root. */
export function assertSharedPathSafe(path) {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    let current = root;
    for (const segment of absolute.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//)) {
        current = join(current, segment);
        try {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink())
                throw new Error('Shared config path is a symbolic link');
            if (current !== absolute && !stat.isDirectory())
                throw new Error('Shared config parent is not a directory');
            if (current === absolute && !stat.isFile() && !stat.isDirectory())
                throw new Error('Shared config path is not a regular file');
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                continue;
            throw error;
        }
    }
}
export function readSharedFileSnapshot(path) {
    return withSharedDirectory(path, () => readSharedFileSnapshotOnce(path));
}
function readSharedFileSnapshotOnce(path) {
    assertSharedPathSafe(path);
    if (pinned(path)?.missing)
        return { raw: null, identity: null };
    let fd;
    try {
        fd = safeOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { raw: null, identity: null };
        throw error;
    }
    try {
        return snapshotForDescriptor(fd, path);
    }
    finally {
        closeSync(fd);
    }
}
function snapshotForDescriptor(fd, path) {
    return contentsForDescriptor(fd, path).snapshot;
}
function contentsForDescriptor(fd, path) {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile())
        throw new Error('Shared config is not a regular file');
    const beforeIdentity = process.platform === 'win32' && before.dev === 0n ? util.readWindowsDescriptorIdentity(fd) : before;
    if (beforeIdentity.ino !== before.ino)
        throw new SharedFileConflictError(path);
    pinned(path)?.assertCurrent();
    if (process.platform === 'win32') {
        const named = lstatSync(path, { bigint: true });
        // Only the actual held FD may fill its missing volume. Known pathname volumes remain mandatory evidence.
        if (beforeIdentity.dev <= 0n || beforeIdentity.ino <= 0n || named.isSymbolicLink() || !named.isFile()
            || named.ino !== beforeIdentity.ino || named.dev !== 0n && named.dev !== beforeIdentity.dev)
            throw new SharedFileConflictError(path);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!read)
            throw new SharedFileConflictError(path);
        offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    pinned(path)?.assertCurrent();
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new SharedFileConflictError(path);
    }
    const native = process.platform === 'win32' && after.dev === 0n ? util.readWindowsDescriptorIdentity(fd) : after;
    if (native.ino !== after.ino || native.ino !== beforeIdentity.ino || native.dev !== beforeIdentity.dev)
        throw new SharedFileConflictError(path);
    return {
        bytes,
        snapshot: {
            raw: bytes.toString('utf8'),
            identity: {
                dev: native.dev.toString(), ino: native.ino.toString(), mtimeNs: after.mtimeNs.toString(),
                size: after.size.toString(), mode: Number(after.mode) & 0o777,
                uid: after.uid.toString(), gid: after.gid.toString(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
        },
    };
}
export function sameSharedFileIdentity(left, right) {
    if (left === null || right === null)
        return left === right;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}
export function syncSharedDirectory(path) {
    const existing = pinnedDirectories.get(resolve(path));
    if (existing) {
        existing.sync();
        return;
    }
    const directory = pinSharedDirectory(path);
    try {
        directory.sync();
    }
    finally {
        directory.close();
    }
}
function callReceipt(receipt, method, snapshot) {
    if (!receipt)
        return;
    const callback = receipt[method];
    assertInstallerSyncCallback(callback);
    runInstallerSyncCallback(() => callback.call(receipt, snapshot));
}
let commitObserver;
let compensationActive = false;
export function withSharedFileCompensation(run) {
    assertInstallerSyncScopeActive();
    assertInstallerSyncCallback(run);
    const previous = compensationActive;
    compensationActive = true;
    try {
        return runInstallerSyncCallback(run);
    }
    finally {
        compensationActive = previous;
    }
}
export function sharedFileCompensationActive() { return compensationActive; }
export function sharedFilePublicationAttempted(path) {
    assertInstallerSyncScopeActive();
    const observer = commitObserver, callback = observer?.publicationAttempted;
    if (!callback)
        return undefined;
    assertInstallerSyncCallback(callback);
    return runInstallerSyncCallback(() => callback.call(observer, path));
}
let phaseHookForTest;
export function _setSharedFileCommitPhaseHookForTest(hook) { phaseHookForTest = hook; }
/** Installers are synchronous. Nested observers are refused instead of silently losing a transaction. */
export function withSharedFileCommitObserver(observer, run) {
    assertInstallerSyncScopeActive();
    assertInstallerSyncCallback(run);
    assertInstallerSyncCallback(observer);
    if (commitObserver)
        throw new Error('Nested shared config transaction');
    commitObserver = observer;
    try {
        return runInstallerSyncCallback(run);
    }
    finally {
        commitObserver = undefined;
    }
}
export function sharedFileTransactionActive() { return commitObserver !== undefined; }
export class SharedFileConflictError extends Error {
    recoveryPath;
    get completedOperation() { return completedDirectoryOperation(this); }
    get retryable() { return this.completedOperation === undefined; }
    constructor(path, recoveryPath, options) {
        super(recoveryPath
            ? `Shared config changed during commit: ${path}; conflicting bytes preserved at ${recoveryPath}`
            : `Shared config changed during commit: ${path}`, options?.cause === undefined ? undefined : { cause: options.cause });
        this.recoveryPath = recoveryPath;
        this.name = 'SharedFileConflictError';
    }
}
function completedDirectoryOperation(error) {
    const pending = [error], seen = new Set();
    while (pending.length) {
        const current = pending.pop();
        if (current instanceof SharedDirectoryPostconditionError)
            return current.operation;
        if (!(current instanceof Error) || seen.has(current))
            continue;
        seen.add(current);
        // Inspect only stored error values, never callback-defined getters.
        for (const field of ['cause', 'cleanupError', 'rollbackError', 'receiptError', 'directoryCloseError', 'sourceCloseError']) {
            pending.push(Object.getOwnPropertyDescriptor(current, field)?.value);
        }
        const aggregate = Object.getOwnPropertyDescriptor(current, 'errors')?.value;
        if (current instanceof AggregateError && Array.isArray(aggregate)) {
            for (const item of aggregate)
                pending.push(item);
        }
    }
    return undefined;
}
function tempPath(path, label) {
    return join(dirname(path), `.${basename(path)}.evolver-${label}-${process.pid}-${randomUUID()}`);
}
function writePrepared(path, raw, mode, captured) {
    const fd = safeOpen(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    try {
        captured(snapshotForDescriptor(fd, path));
        writeFileSync(fd, raw, 'utf8');
        fchmodSync(fd, mode);
        captured(snapshotForDescriptor(fd, path));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
/** Move only the observed partial inode out of the live name before deleting its private name. */
function discardCopiedFile(path, expected, state) {
    const current = readSharedFileSnapshot(path);
    if (current.raw === null)
        return;
    if (!sameSharedFileIdentity(current.identity, expected.identity) || lstatSync(path).nlink !== 1)
        return;
    const displaced = tempPath(path, 'partial');
    try {
        safeRename(path, displaced);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    const moved = readSharedFileSnapshot(displaced);
    if (!sameSharedFileIdentity(moved.identity, expected.identity)) {
        if (state)
            state.recoveryPath = displaced;
        const recovery = restoreNoClobber(displaced, path, linkSync, false, moved);
        if (state)
            state.recoveryPath = recovery;
        throw new SharedFileConflictError(path, recovery);
    }
    if (state)
        state.removed = true;
    try {
        if (!sameSharedFileIdentity(readSharedFileSnapshot(displaced).identity, expected.identity) || lstatSync(displaced).nlink !== 1) {
            throw new SharedFileConflictError(path, displaced);
        }
        safeUnlink(displaced);
    }
    catch (error) {
        if (state)
            state.recoveryPath = displaced;
        throw new SharedFileConflictError(path, displaced, { cause: error });
    }
}
function isOwnedCopyPrefix(before, captured, bytes, mode) {
    if (!before?.identity || !captured?.snapshot.identity)
        return false;
    const actual = captured.snapshot.identity, original = before.identity;
    return actual.dev === original.dev && actual.ino === original.ino && actual.uid === original.uid && actual.gid === original.gid
        && (actual.mode === original.mode || actual.mode === mode) && captured.bytes.equals(bytes.subarray(0, captured.bytes.length));
}
function writeExclusiveCopy(path, bytes, mode, state) {
    const fd = safeOpen(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    if (state)
        state.created = true;
    let before, captured;
    let failed = false, primary;
    try {
        before = snapshotForDescriptor(fd, path);
        writeFileSync(fd, bytes);
        fchmodSync(fd, mode);
        fsyncSync(fd);
        captured = contentsForDescriptor(fd, path);
    }
    catch (error) {
        failed = true;
        primary = error;
        try {
            captured = contentsForDescriptor(fd, path);
        }
        catch { /* Unknown bytes/identity are retained, not adopted for cleanup. */ }
    }
    try {
        closeSync(fd);
    }
    catch (error) {
        if (!failed) {
            failed = true;
            primary = error;
        }
        else if (primary instanceof Error)
            primary.closeError = error;
    }
    if (!failed)
        return captured.snapshot;
    if (isOwnedCopyPrefix(before, captured, bytes, mode)) {
        try {
            discardCopiedFile(path, captured.snapshot, state);
        }
        catch (cleanupError) {
            if (primary instanceof Error)
                primary.cleanupError = cleanupError;
        }
    }
    throw primary;
}
function publishNoClobber(source, target, linkFile = linkSync, expectedSource, copyState) {
    const sourceFd = safeOpen(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    let primary;
    try {
        const { snapshot, bytes } = contentsForDescriptor(sourceFd, source);
        if (expectedSource && !sameSharedFileIdentity(snapshot.identity, expectedSource.identity))
            throw new SharedFileConflictError(source);
        let copied = false;
        try {
            if (linkFile === linkSync)
                safeLink(source, target);
            else
                linkFile(source, target);
        }
        catch (error) {
            const code = error?.code;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV')
                throw error;
            copied = true;
        }
        if (!copied) {
            const published = readSharedFileSnapshot(target);
            if (!sameSharedFileIdentity(published.identity, snapshot.identity))
                throw new SharedFileConflictError(target, source);
            return published;
        }
        const published = writeExclusiveCopy(target, bytes, snapshot.identity?.mode ?? 0o600, copyState);
        try {
            if (!sameSharedFileIdentity(readSharedFileSnapshot(target).identity, published.identity))
                throw new SharedFileConflictError(target, source);
            return published;
        }
        catch (error) {
            try {
                discardCopiedFile(target, published, copyState);
            }
            catch (cleanupError) {
                if (error instanceof Error)
                    error.cleanupError = cleanupError;
            }
            throw error;
        }
    }
    catch (error) {
        primary = error;
        throw error;
    }
    finally {
        closePreservingFailure(() => closeSync(sourceFd), primary, 'sourceCloseError');
    }
}
function snapshotNoClobber(source, snapshot, linkFile = linkSync) {
    return publishNoClobber(source, snapshot, linkFile);
}
function restoreNoClobber(displaced, target, linkFile = linkSync, keepSource = false, expectedSource) {
    const source = expectedSource ?? readSharedFileSnapshot(displaced);
    const finish = () => {
        if (keepSource)
            return undefined;
        const current = readSharedFileSnapshot(displaced);
        if (current.raw === null)
            return undefined;
        if (!sameSharedFileIdentity(current.identity, source.identity))
            return displaced;
        safeUnlink(displaced);
        return undefined;
    };
    try {
        publishNoClobber(displaced, target, linkFile, source);
        return finish();
    }
    catch (err) {
        const code = err?.code;
        if (code === 'EEXIST')
            return displaced;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
            try {
                safeCopy(displaced, target, source);
                return finish();
            }
            catch (copyError) {
                if (copyError.code === 'EEXIST')
                    return displaced;
                throw new AggregateError([err, copyError], `Unable to restore shared config at ${target}`);
            }
        }
        throw err;
    }
}
function fileVersion(path) {
    const fd = safeOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
        const stat = fstatSync(fd, { bigint: true });
        const native = process.platform === 'win32' && stat.dev === 0n ? util.readWindowsDescriptorIdentity(fd) : stat;
        if (!stat.isFile() || native.ino !== stat.ino)
            throw new SharedFileConflictError(path);
        return {
            dev: native.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeNs: stat.mtimeNs,
            ctimeNs: stat.ctimeNs,
        };
    }
    finally {
        closeSync(fd);
    }
}
function sameFileVersion(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
/** Commits only if the target bytes still match the caller's snapshot. */
export function commitSharedFile(options) {
    assertInstallerSyncScopeActive();
    return runInstallerSyncCallback(() => withSharedDirectory(options.path, () => commitSharedFileInDirectory(options)));
}
function commitSharedFileInDirectory(options) {
    const paths = {
        ...(options.nextRaw === undefined ? {} : { prepared: tempPath(options.path, 'next') }),
        ...(options.expectedRaw === undefined ? {} : {
            displaced: tempPath(options.path, 'previous'), movedLive: tempPath(options.path, 'live'),
        }),
    };
    const observer = commitObserver;
    const receipt = observer ? runInstallerSyncCallback(() => observer(options, paths)) : undefined;
    phaseHookForTest?.('intent', options.path);
    let failed = false, primary;
    try {
        commitSharedFileOnce(options, paths, receipt);
    }
    catch (error) {
        failed = true;
        primary = error;
    }
    try {
        callReceipt(receipt, 'finished');
    }
    catch (receiptError) {
        if (!failed)
            throw receiptError;
        if (primary instanceof Error)
            primary.receiptError = receiptError;
    }
    if (failed)
        throw primary;
    phaseHookForTest?.('finished', options.path);
    return options.retainOriginal && paths.movedLive ? { retainedOriginal: paths.movedLive } : {};
}
function commitSharedFileOnce(options, paths, receipt) {
    const mode = options.mode ?? 0o600;
    const { prepared, displaced, movedLive } = paths;
    let preserveDisplaced = false;
    let preserveMovedLive = false;
    let liveWasMoved = false;
    let published = false;
    let publicationSnapshot;
    let preparedSnapshot;
    const copiedPublication = { created: false, removed: false };
    let displacedSnapshot;
    let movedSnapshot;
    let movedOrigin;
    let failed = false;
    let primary;
    const removeKnown = (path, expected) => {
        if (!path)
            return;
        const actual = readSharedFileSnapshot(path);
        if (actual.raw === null)
            return;
        if (!expected || !sameSharedFileIdentity(actual.identity, expected.identity)) {
            // An in-place writer updates both hardlinks. Drop only our known extra name when the live path still holds that inode.
            const live = path === displaced && expected?.identity && actual.identity
                && actual.identity.dev === expected.identity.dev && actual.identity.ino === expected.identity.ino
                ? readSharedFileSnapshot(options.path) : undefined;
            if (!live?.identity || live.identity.dev !== actual.identity?.dev || live.identity.ino !== actual.identity?.ino) {
                throw new SharedFileConflictError(path, path);
            }
        }
        safeUnlink(path);
    };
    const knownMovedSnapshot = () => {
        try {
            const current = readSharedFileSnapshot(movedLive);
            if (!movedOrigin || !current.identity || current.identity.dev !== movedOrigin.dev.toString()
                || current.identity.ino !== movedOrigin.ino.toString())
                throw new SharedFileConflictError(options.path, movedLive);
            movedSnapshot = current;
            return current;
        }
        catch (error) {
            preserveDisplaced = true;
            preserveMovedLive = true;
            throw new SharedFileConflictError(options.path, movedLive, { cause: error });
        }
    };
    const restoreMovedLive = () => {
        const source = knownMovedSnapshot();
        try {
            return restoreNoClobber(movedLive, options.path, options.linkForTest, options.retainOriginal, source);
        }
        catch (error) {
            preserveDisplaced = true;
            preserveMovedLive = true;
            throw new SharedFileConflictError(options.path, movedLive, { cause: error });
        }
    };
    const perform = () => {
        if (prepared)
            writePrepared(prepared, options.nextRaw, mode, snapshot => { preparedSnapshot = snapshot; });
        if (receipt)
            syncSharedDirectory(dirname(options.path));
        callReceipt(receipt, 'prepared');
        phaseHookForTest?.('prepared', options.path);
        options.beforeCommitForTest?.();
        if (options.expectedIdentity !== undefined && !sameSharedFileIdentity(readSharedFileSnapshot(options.path).identity, options.expectedIdentity)) {
            throw new SharedFileConflictError(options.path);
        }
        if (options.expectedRaw === undefined) {
            if (!prepared)
                return;
            try {
                callReceipt(receipt, 'publishing');
                publicationSnapshot = publishNoClobber(prepared, options.path, options.linkForTest, preparedSnapshot, copiedPublication);
                if (receipt)
                    syncSharedDirectory(dirname(options.path));
                phaseHookForTest?.('published', options.path);
                callReceipt(receipt, 'published', publicationSnapshot);
                phaseHookForTest?.('receipt', options.path);
            }
            catch (err) {
                if (completedDirectoryOperation(err))
                    throw new SharedFileConflictError(options.path, undefined, { cause: err });
                if (publicationSnapshot) {
                    try {
                        const current = readSharedFileSnapshot(options.path);
                        if (sameSharedFileIdentity(current.identity, publicationSnapshot.identity)) {
                            withSharedFileCompensation(() => commitSharedFile({ path: options.path, expectedRaw: current.raw ?? undefined, nextRaw: undefined, expectedIdentity: current.identity }));
                        }
                    }
                    catch (rollbackError) {
                        if (err instanceof Error)
                            err.rollbackError = rollbackError;
                    }
                }
                if (err?.code === 'EEXIST') {
                    throw new SharedFileConflictError(options.path);
                }
                throw err;
            }
            return;
        }
        // Validate while the live path is still present. The no-clobber publish below then limits the unavoidable
        // crash-only missing-path interval to the two adjacent metadata operations.
        let versionBeforeRead;
        let actualRaw;
        let validatedVersion;
        try {
            versionBeforeRead = fileVersion(options.path);
            actualRaw = safeRaw(options.path);
            validatedVersion = fileVersion(options.path);
        }
        catch (err) {
            if (err?.code === 'ENOENT') {
                throw new SharedFileConflictError(options.path);
            }
            throw err;
        }
        if (actualRaw !== options.expectedRaw) {
            throw new SharedFileConflictError(options.path);
        }
        if (!sameFileVersion(versionBeforeRead, validatedVersion)) {
            throw new SharedFileConflictError(options.path);
        }
        options.afterValidateForTest?.();
        displacedSnapshot = snapshotNoClobber(options.path, displaced, options.linkForTest);
        if (receipt)
            syncSharedDirectory(dirname(options.path));
        callReceipt(receipt, 'displaced', displacedSnapshot);
        try {
            const liveAfterSnapshot = fileVersion(options.path);
            if (safeRaw(options.path) !== options.expectedRaw
                || liveAfterSnapshot.dev !== validatedVersion.dev
                || liveAfterSnapshot.ino !== validatedVersion.ino
                || liveAfterSnapshot.size !== validatedVersion.size
                || liveAfterSnapshot.mtimeNs !== validatedVersion.mtimeNs) {
                throw new SharedFileConflictError(options.path);
            }
            options.afterDisplaceForTest?.(displaced);
            const liveBeforePublish = fileVersion(options.path);
            if (!sameFileVersion(liveAfterSnapshot, liveBeforePublish)
                || safeRaw(options.path) !== options.expectedRaw
                || safeRaw(displaced) !== options.expectedRaw) {
                throw new SharedFileConflictError(options.path);
            }
            options.beforePublishForTest?.();
            callReceipt(receipt, 'publishing');
            phaseHookForTest?.('publishing', options.path);
            movedOrigin = liveBeforePublish;
            safeRename(options.path, movedLive);
            liveWasMoved = true;
            if (receipt)
                syncSharedDirectory(dirname(options.path));
            phaseHookForTest?.('moved', options.path);
            const moved = knownMovedSnapshot();
            if (moved.raw !== options.expectedRaw
                || options.expectedIdentity !== undefined && !sameSharedFileIdentity(moved.identity, options.expectedIdentity)) {
                const recoveryPath = restoreMovedLive();
                liveWasMoved = recoveryPath !== undefined;
                preserveMovedLive = options.retainOriginal === true || recoveryPath !== undefined;
                throw new SharedFileConflictError(options.path, recoveryPath ?? (options.retainOriginal ? movedLive : undefined));
            }
            const publication = prepared ? publishNoClobber(prepared, options.path, options.linkForTest, preparedSnapshot, copiedPublication) : { raw: null, identity: null };
            publicationSnapshot = publication;
            published = true;
            if (receipt)
                syncSharedDirectory(dirname(options.path));
            phaseHookForTest?.('published', options.path);
            callReceipt(receipt, 'published', publication);
            phaseHookForTest?.('receipt', options.path);
            removeKnown(prepared, preparedSnapshot);
            if (options.retainOriginal) {
                knownMovedSnapshot();
                preserveMovedLive = true;
            }
            else {
                try {
                    removeKnown(movedLive, movedSnapshot);
                }
                catch (error) {
                    preserveMovedLive = true;
                    throw error;
                }
            }
            liveWasMoved = false;
            removeKnown(displaced, displacedSnapshot);
        }
        catch (error) {
            if (completedDirectoryOperation(error)) {
                throw new SharedFileConflictError(options.path, undefined, { cause: error });
            }
            if (!published) {
                if (copiedPublication.created && !copiedPublication.removed && readSharedFileSnapshot(options.path).raw === null) {
                    preserveDisplaced = true;
                    preserveMovedLive = liveWasMoved;
                    throw new SharedFileConflictError(options.path, copiedPublication.recoveryPath ?? movedLive, { cause: error });
                }
                if (liveWasMoved && movedLive !== undefined) {
                    const recoveryPath = restoreMovedLive();
                    liveWasMoved = recoveryPath !== undefined;
                    preserveMovedLive = options.retainOriginal === true || recoveryPath !== undefined;
                    if (recoveryPath !== undefined) {
                        removeKnown(displaced, displacedSnapshot);
                        throw new SharedFileConflictError(options.path, recoveryPath, { cause: error });
                    }
                }
                removeKnown(displaced, displacedSnapshot);
                if (error instanceof SharedFileConflictError)
                    throw error;
                throw new SharedFileConflictError(options.path, undefined, { cause: error });
            }
            if (options.retainOriginal && liveWasMoved)
                preserveMovedLive = true;
            // Once a new inode was published, an absent live path may be the user's concurrent deletion.
            // Do not reinterpret that absence as permission to put an older configuration back.
            if (prepared && readSharedFileSnapshot(options.path).raw === null
                || options.retainOriginal && liveWasMoved && options.expectedIdentity !== undefined
                    && !sameSharedFileIdentity(readSharedFileSnapshot(movedLive).identity, options.expectedIdentity)) {
                preserveDisplaced = true;
                preserveMovedLive = liveWasMoved;
                throw new SharedFileConflictError(options.path, options.retainOriginal ? movedLive : displaced, { cause: error });
            }
            let recoveryPath;
            try {
                if (prepared && safeExists(options.path)) {
                    try {
                        if (publicationSnapshot && sameSharedFileIdentity(readSharedFileSnapshot(options.path).identity, publicationSnapshot.identity)) {
                            const identity = publicationSnapshot.identity;
                            withSharedFileCompensation(() => commitSharedFile({ path: options.path, expectedRaw: options.nextRaw, nextRaw: undefined, expectedIdentity: identity }));
                        }
                    }
                    catch {
                        // Preserve a concurrent replacement and expose the snapshot as recoveryPath.
                    }
                }
                recoveryPath = restoreNoClobber(displaced, options.path, options.linkForTest, false, displacedSnapshot);
                preserveDisplaced = recoveryPath !== undefined;
            }
            catch (restoreError) {
                preserveDisplaced = true;
                throw new Error(`Shared config commit failed for ${options.path}; original bytes preserved at ${displaced}`, { cause: new AggregateError([error, restoreError]) });
            }
            throw new SharedFileConflictError(options.path, recoveryPath, { cause: error });
        }
    };
    try {
        perform();
    }
    catch (error) {
        failed = true;
        primary = error;
    }
    // A completed namespace operation under an unverified parent is not an uncommitted retry.
    // Keep every pre/post-image for scope recovery; no cleanup or compensation uses a replacement parent.
    if (completedDirectoryOperation(primary)) {
        throw new SharedFileConflictError(options.path, undefined, { cause: primary });
    }
    try {
        if (!preserveDisplaced && displaced && safeExists(displaced)) {
            if (!safeExists(options.path)) {
                if (liveWasMoved) {
                    const recoveryPath = restoreNoClobber(displaced, options.path, options.linkForTest, false, displacedSnapshot);
                    preserveDisplaced = recoveryPath !== undefined;
                }
                else
                    preserveDisplaced = true; // A deletion before our rename is the user's state, not our missing-path window.
            }
            else {
                // Keep a displaced file only when it is the sole recovery copy of concurrent bytes.
                try {
                    const displacedRaw = safeRaw(displaced);
                    if (displacedRaw === options.expectedRaw)
                        removeKnown(displaced, displacedSnapshot);
                }
                catch {
                    // Preserve an unreadable displaced file instead of masking the primary result.
                }
            }
        }
        removeKnown(prepared, preparedSnapshot);
        if (!preserveMovedLive && movedLive && safeExists(movedLive)) {
            removeKnown(movedLive, movedSnapshot);
        }
    }
    catch (cleanupError) {
        if (!failed)
            throw cleanupError;
        if (primary instanceof Error)
            primary.cleanupError = cleanupError;
    }
    if (failed)
        throw primary;
}