import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class SharedFileConflictError extends Error {
    recoveryPath;
    constructor(path, recoveryPath, options) {
        super(recoveryPath
            ? `Shared config changed during commit: ${path}; conflicting bytes preserved at ${recoveryPath}`
            : `Shared config changed during commit: ${path}`, options?.cause === undefined ? undefined : { cause: options.cause });
        this.recoveryPath = recoveryPath;
        this.name = 'SharedFileConflictError';
    }
}
function tempPath(path, label) {
    return join(dirname(path), `.${basename(path)}.evolver-${label}-${process.pid}-${randomUUID()}`);
}
function writePrepared(path, raw, mode) {
    const fd = openSync(path, 'wx', mode);
    try {
        writeFileSync(fd, raw, 'utf8');
    }
    finally {
        closeSync(fd);
    }
    chmodSync(path, mode);
}
function removeIfPresent(path) {
    if (!path)
        return;
    try {
        unlinkSync(path);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
}
function publishNoClobber(source, target, linkFile = linkSync) {
    try {
        linkFile(source, target);
    }
    catch (error) {
        const code = error.code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') {
            throw error;
        }
        copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
    }
}
function snapshotNoClobber(source, snapshot, linkFile = linkSync) {
    try {
        linkFile(source, snapshot);
    }
    catch (error) {
        const code = error.code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') {
            throw error;
        }
        copyFileSync(source, snapshot, fsConstants.COPYFILE_EXCL);
    }
}
function restoreNoClobber(displaced, target, linkFile = linkSync) {
    try {
        publishNoClobber(displaced, target, linkFile);
        unlinkSync(displaced);
        return undefined;
    }
    catch (err) {
        const code = err.code;
        if (code === 'EEXIST')
            return displaced;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
            try {
                copyFileSync(displaced, target, fsConstants.COPYFILE_EXCL);
                unlinkSync(displaced);
                return undefined;
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
    const stat = statSync(path, { bigint: true });
    return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
    };
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
    const mode = options.mode ?? 0o600;
    const prepared = options.nextRaw === undefined ? undefined : tempPath(options.path, 'next');
    const displaced = options.expectedRaw === undefined ? undefined : tempPath(options.path, 'previous');
    const movedLive = options.expectedRaw === undefined ? undefined : tempPath(options.path, 'live');
    let preserveDisplaced = false;
    let preserveMovedLive = false;
    let liveWasMoved = false;
    let published = false;
    try {
        if (prepared)
            writePrepared(prepared, options.nextRaw, mode);
        options.beforeCommitForTest?.();
        if (options.expectedRaw === undefined) {
            if (!prepared)
                return;
            try {
                publishNoClobber(prepared, options.path, options.linkForTest);
            }
            catch (err) {
                if (err.code === 'EEXIST') {
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
            actualRaw = readFileSync(options.path, 'utf8');
            validatedVersion = fileVersion(options.path);
        }
        catch (err) {
            if (err.code === 'ENOENT') {
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
        snapshotNoClobber(options.path, displaced, options.linkForTest);
        try {
            const liveAfterSnapshot = fileVersion(options.path);
            if (readFileSync(options.path, 'utf8') !== options.expectedRaw
                || liveAfterSnapshot.dev !== validatedVersion.dev
                || liveAfterSnapshot.ino !== validatedVersion.ino
                || liveAfterSnapshot.size !== validatedVersion.size
                || liveAfterSnapshot.mtimeNs !== validatedVersion.mtimeNs) {
                throw new SharedFileConflictError(options.path);
            }
            options.afterDisplaceForTest?.(displaced);
            const liveBeforePublish = fileVersion(options.path);
            if (!sameFileVersion(liveAfterSnapshot, liveBeforePublish)
                || readFileSync(options.path, 'utf8') !== options.expectedRaw
                || readFileSync(displaced, 'utf8') !== options.expectedRaw) {
                throw new SharedFileConflictError(options.path);
            }
            options.beforePublishForTest?.();
            renameSync(options.path, movedLive);
            liveWasMoved = true;
            if (readFileSync(movedLive, 'utf8') !== options.expectedRaw) {
                const recoveryPath = restoreNoClobber(movedLive, options.path, options.linkForTest);
                liveWasMoved = recoveryPath !== undefined;
                preserveMovedLive = recoveryPath !== undefined;
                throw new SharedFileConflictError(options.path, recoveryPath);
            }
            if (prepared) {
                publishNoClobber(prepared, options.path);
                removeIfPresent(prepared);
            }
            else {
                unlinkSync(movedLive);
                liveWasMoved = false;
            }
            if (prepared) {
                unlinkSync(movedLive);
                liveWasMoved = false;
            }
            published = true;
            removeIfPresent(displaced);
        }
        catch (error) {
            if (!published) {
                if (liveWasMoved && movedLive !== undefined) {
                    const recoveryPath = restoreNoClobber(movedLive, options.path, options.linkForTest);
                    liveWasMoved = recoveryPath !== undefined;
                    preserveMovedLive = recoveryPath !== undefined;
                    if (recoveryPath !== undefined) {
                        removeIfPresent(displaced);
                        throw new SharedFileConflictError(options.path, recoveryPath, { cause: error });
                    }
                }
                removeIfPresent(displaced);
                if (error instanceof SharedFileConflictError)
                    throw error;
                throw new SharedFileConflictError(options.path, undefined, { cause: error });
            }
            let recoveryPath;
            try {
                if (prepared && existsSync(options.path)) {
                    try {
                        if (readFileSync(options.path, 'utf8') === options.nextRaw)
                            removeIfPresent(options.path);
                    }
                    catch {
                        // Preserve a concurrent replacement and expose the snapshot as recoveryPath.
                    }
                }
                recoveryPath = restoreNoClobber(displaced, options.path, options.linkForTest);
                preserveDisplaced = recoveryPath !== undefined;
            }
            catch (restoreError) {
                preserveDisplaced = true;
                throw new Error(`Shared config commit failed for ${options.path}; original bytes preserved at ${displaced}`, { cause: new AggregateError([error, restoreError]) });
            }
            throw new SharedFileConflictError(options.path, recoveryPath, { cause: error });
        }
    }
    finally {
        if (!preserveDisplaced && displaced && existsSync(displaced)) {
            if (!existsSync(options.path)) {
                const recoveryPath = restoreNoClobber(displaced, options.path, options.linkForTest);
                preserveDisplaced = recoveryPath !== undefined;
            }
            else {
                // Keep a displaced file only when it is the sole recovery copy of concurrent bytes.
                try {
                    const displacedRaw = readFileSync(displaced, 'utf8');
                    if (displacedRaw === options.expectedRaw)
                        removeIfPresent(displaced);
                }
                catch {
                    // Preserve an unreadable displaced file instead of masking the primary result.
                }
            }
        }
        removeIfPresent(prepared);
        if (!preserveMovedLive && movedLive && existsSync(movedLive)) {
            removeIfPresent(movedLive);
        }
    }
}