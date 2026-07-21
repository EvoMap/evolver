import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm, } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { SELF_UPDATE_FAILURE_CODES, SelfUpdateFailureError, selfUpdateFailure, } from './failureCodes.js';
export const WINDOWS_UPDATER_WORKER_ARG = '--evolver-windows-updater-worker';
const WORK_ITEM_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;
const MAX_WORK_ITEM_BYTES = 64 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const OPERATION_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Paths are fixed so the stable controller never consumes descriptor-supplied executable paths. */
export function resolveWindowsUpdaterPaths(stateDirInput) {
    const stateDir = assertAbsoluteCleanPath(stateDirInput, 'state_dir');
    const directory = join(stateDir, 'windows-updater');
    return {
        directory,
        helperPath: join(directory, 'updater.exe'),
        pendingPath: join(directory, 'pending.json'),
        resultPath: join(directory, 'result.json'),
    };
}
/** Bind a fixed executable below the private state root without following directory links. */
export async function bindWindowsManagedExecutable(options) {
    assertWindowsPlatform(options.platform ?? process.platform);
    if (options.relativePath.length === 0
        || options.relativePath.some((segment) => !segment || segment === '.' || segment === '..' || basename(segment) !== segment)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${options.label}_path_invalid`);
    }
    const stateDir = await assertPrivateDirectory(options.stateDir, 'state_dir', false);
    const expectedPath = join(stateDir, ...options.relativePath);
    await assertPrivateDirectory(dirname(expectedPath), `${options.label}_dir`, false);
    const executablePath = await assertManagedRegularPath(options.executablePath, stateDir, options.label);
    const canonicalExpectedPath = await assertManagedRegularPath(expectedPath, stateDir, `${options.label}_expected`);
    if (!samePath(executablePath, canonicalExpectedPath)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${options.mismatchLabel ?? options.label}_exec_mismatch`);
    }
    return { stateDir, executablePath };
}
/**
 * Prepare a launcher-consumed update descriptor. This function never mutates
 * the live executable and never spawns a competing relaunch process.
 *
 * The stable lifecycle controller runs updater.exe before it starts target.
 * The worker applies pending.json while no target process exists, then removes
 * pending.json only after an idempotently durable success result is written.
 */
export async function prepareWindowsExecutableSwap(options) {
    assertWindowsPlatform(options.platform ?? process.platform);
    const stateDir = await assertPrivateDirectory(options.stateDir, 'state_dir', true);
    const paths = resolveWindowsUpdaterPaths(stateDir);
    await assertPrivateDirectory(paths.directory, 'updater_dir', true);
    await assertPathAbsent(paths.pendingPath, 'pending');
    const targetPath = await assertExternalRegularPath(options.targetPath, stateDir, 'target');
    const backupPath = await assertManagedRegularPath(options.backupPath, stateDir, 'backup');
    const targetIdentity = await snapshotRegularFile(targetPath, 'target');
    const backupIdentity = await snapshotRegularFile(backupPath, 'backup');
    let stagedPath;
    let stagedIdentity;
    let sourcePath;
    let sourceIdentity;
    let helperSourcePath;
    if (options.operation === 'install') {
        if (!options.stagedPath || !options.expectedStagedSha256) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_staged_required');
        }
        stagedPath = await assertManagedRegularPath(options.stagedPath, stateDir, 'staged');
        stagedIdentity = await snapshotRegularFile(stagedPath, 'staged');
        assertSha256(options.expectedStagedSha256, 'expected_staged_sha256');
        if (!safeDigestEqual(stagedIdentity.sha256, options.expectedStagedSha256)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'windows_updater_staged_digest_mismatch');
        }
        sourcePath = stagedPath;
        sourceIdentity = stagedIdentity;
        // The new staged binary contains the worker, so this also bootstraps the
        // first helper-capable release from an older executable.
        helperSourcePath = stagedPath;
    }
    else {
        if (options.stagedPath || options.expectedStagedSha256) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_rollback_staged_forbidden');
        }
        sourcePath = backupPath;
        sourceIdentity = backupIdentity;
        helperSourcePath = assertAbsoluteCleanPath(options.helperSourcePath ?? options.processExecPath ?? process.execPath, 'helper_source');
        await assertNoSymlinkedParent(helperSourcePath, 'helper_source');
    }
    const helperSourceIdentity = await snapshotRegularFile(helperSourcePath, 'helper_source');
    const operationId = randomBytes(16).toString('hex');
    const helperTempPath = join(paths.directory, `.updater-${operationId}.tmp`);
    try {
        await copyRegularFileExclusive(helperSourcePath, helperTempPath, helperSourceIdentity, 0o700);
        await commitPreparedHelper(helperTempPath, paths.helperPath, helperSourceIdentity);
    }
    catch (error) {
        await removeBestEffort(helperTempPath);
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.COPY_FAILED, 'windows_updater_helper_prepare_failed', {
            cause: error,
        });
    }
    const helperIdentity = await snapshotRegularFile(paths.helperPath, 'helper');
    if (!safeDigestEqual(helperIdentity.sha256, helperSourceIdentity.sha256)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.COPY_FAILED, 'windows_updater_helper_digest_mismatch');
    }
    const workItem = {
        schema_version: WORK_ITEM_SCHEMA_VERSION,
        operation_id: operationId,
        operation: options.operation,
        target_path: targetPath,
        ...(stagedPath ? { staged_path: stagedPath } : {}),
        backup_path: backupPath,
        source_path: sourcePath,
        target_identity: targetIdentity,
        ...(stagedIdentity ? { staged_identity: stagedIdentity } : {}),
        backup_identity: backupIdentity,
        source_identity: sourceIdentity,
        helper_identity: helperIdentity,
    };
    // Publish pending.json last. link() makes the descriptor visible atomically
    // and refuses to replace an existing pending operation.
    await removeBestEffort(paths.resultPath);
    await writeJsonNoReplaceAtomic(paths.pendingPath, workItem, 0o600);
    return {
        operation: options.operation,
        operationId,
        helperPath: paths.helperPath,
        pendingPath: paths.pendingPath,
        resultPath: paths.resultPath,
    };
}
/**
 * Apply the pending operation before the stable controller starts target.
 * A successful swap is idempotent across crashes after rename: if target
 * already has source's content, the helper only finalizes result/pending state.
 */
export async function applyPendingWindowsExecutableSwap(options = {}) {
    assertWindowsPlatform(options.platform ?? process.platform);
    const workerExecPathInput = assertAbsoluteCleanPath(options.workerExecPath ?? process.execPath, 'worker_exec');
    const inferredStateDir = dirname(dirname(workerExecPathInput));
    const boundWorker = await bindWindowsManagedExecutable({
        stateDir: options.stateDir ?? inferredStateDir,
        executablePath: workerExecPathInput,
        relativePath: ['windows-updater', 'updater.exe'],
        label: 'worker_exec',
        mismatchLabel: 'helper',
        platform: options.platform,
    });
    const stateDir = boundWorker.stateDir;
    const paths = resolveWindowsUpdaterPaths(stateDir);
    let workItem;
    try {
        workItem = await readWorkItem(paths.pendingPath);
        await validateWorkItem(workItem, paths, stateDir);
    }
    catch (error) {
        const result = {
            schema_version: RESULT_SCHEMA_VERSION,
            operation: workItem?.operation ?? 'install',
            status: 'failed',
            failure_code: updaterFailureCode(error),
        };
        await writeJsonAtomic(paths.resultPath, result, 0o600);
        return result;
    }
    if (!workItem) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_pending_missing');
    }
    let result;
    try {
        await assertSnapshot(workItem.source_path, workItem.source_identity, 'source');
        await assertSnapshot(workItem.backup_path, workItem.backup_identity, 'backup');
        if (workItem.staged_path && workItem.staged_identity) {
            await assertSnapshot(workItem.staged_path, workItem.staged_identity, 'staged');
        }
        const target = await snapshotRegularFile(workItem.target_path, 'target');
        if (!sameContent(target, workItem.source_identity)) {
            if (!sameIdentity(target, workItem.target_identity)) {
                throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_target_changed');
            }
            const replacementPath = join(dirname(workItem.target_path), `.${workItem.operation_id}.evolver-replacement`);
            await removeKnownReplacementTemp(replacementPath);
            try {
                await copyRegularFileExclusive(workItem.source_path, replacementPath, workItem.source_identity, 0o700);
                await assertSnapshot(workItem.target_path, workItem.target_identity, 'target');
                // Exactly one target mutation. The old fixed entry remains present until
                // the verified sibling replacement is atomically installed.
                await (options.renameFn ?? rename)(replacementPath, workItem.target_path);
            }
            catch (error) {
                await removeBestEffort(replacementPath);
                throw error;
            }
        }
        result = {
            schema_version: RESULT_SCHEMA_VERSION,
            operation: workItem.operation,
            status: 'completed',
        };
        await writeJsonAtomic(paths.resultPath, result, 0o600);
        await rm(paths.pendingPath);
    }
    catch (error) {
        result = {
            schema_version: RESULT_SCHEMA_VERSION,
            operation: workItem.operation,
            status: 'failed',
            failure_code: updaterFailureCode(error),
        };
        await writeJsonAtomic(paths.resultPath, result, 0o600);
    }
    return result;
}
/** Return undefined for normal execution, otherwise the launcher helper exit code. */
export async function maybeRunWindowsUpdaterWorkerFromArgv(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    if (!argv.includes(WINDOWS_UPDATER_WORKER_ARG))
        return undefined;
    if ((options.platform ?? process.platform) !== 'win32')
        return 64;
    if (argv.length !== 2 || argv[0] !== 'proxy' || argv[1] !== WINDOWS_UPDATER_WORKER_ARG)
        return 64;
    try {
        const result = await applyPendingWindowsExecutableSwap({
            stateDir: options.env?.['EVOLVER_SELF_UPDATE_STATE_DIR']?.trim() || undefined,
            platform: options.platform,
            workerExecPath: options.processExecPath,
        });
        return result.status === 'completed' ? 0 : 1;
    }
    catch {
        return 1;
    }
}
async function commitPreparedHelper(helperTempPath, helperPath, sourceIdentity) {
    try {
        const info = await lstat(helperPath);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_helper_unsafe');
        }
        const existing = await snapshotRegularFile(helperPath, 'helper');
        if (sameContent(existing, sourceIdentity)) {
            await rm(helperTempPath);
            return;
        }
        await rm(helperPath);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
    await rename(helperTempPath, helperPath);
}
async function validateWorkItem(workItem, paths, stateDir) {
    if (!OPERATION_ID_PATTERN.test(workItem.operation_id)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_operation_id_invalid');
    }
    const targetPath = await assertExternalRegularPath(workItem.target_path, stateDir, 'target');
    const backupPath = await assertManagedRegularPath(workItem.backup_path, stateDir, 'backup');
    const sourcePath = await assertManagedRegularPath(workItem.source_path, stateDir, 'source');
    if (samePath(targetPath, sourcePath) || samePath(targetPath, backupPath)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_target_alias');
    }
    if (workItem.operation === 'install') {
        if (!workItem.staged_path || !workItem.staged_identity) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_staged_missing');
        }
        const stagedPath = await assertManagedRegularPath(workItem.staged_path, stateDir, 'staged');
        if (!samePath(stagedPath, sourcePath)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_install_source_mismatch');
        }
        workItem.staged_path = stagedPath;
    }
    else if (workItem.staged_path || workItem.staged_identity || !samePath(sourcePath, backupPath)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_rollback_source_mismatch');
    }
    workItem.target_path = targetPath;
    workItem.backup_path = backupPath;
    workItem.source_path = sourcePath;
    await assertSnapshot(paths.helperPath, workItem.helper_identity, 'helper');
    await assertSnapshot(backupPath, workItem.backup_identity, 'backup');
    await assertSnapshot(sourcePath, workItem.source_identity, 'source');
}
async function readWorkItem(workItemPath) {
    const snapshot = await snapshotRegularFile(workItemPath, 'pending', MAX_WORK_ITEM_BYTES);
    if (BigInt(snapshot.size) > BigInt(MAX_WORK_ITEM_BYTES)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_pending_too_large');
    }
    const handle = await openNoFollow(workItemPath, constants.O_RDONLY);
    try {
        const opened = await handle.stat({ bigint: true });
        if (!sameStatIdentity(opened, snapshot)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_pending_changed');
        }
        const raw = await handle.readFile({ encoding: 'utf8' });
        const after = await handle.stat({ bigint: true });
        if (!sameStatIdentity(after, snapshot)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_pending_changed');
        }
        return parseWorkItem(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof SelfUpdateFailureError)
            throw error;
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_pending_invalid', {
            cause: error,
        });
    }
    finally {
        await handle.close();
    }
}
function parseWorkItem(value) {
    if (!isRecord(value) || value['schema_version'] !== WORK_ITEM_SCHEMA_VERSION)
        throw new Error('schema_version');
    const operation = value['operation'];
    if (operation !== 'install' && operation !== 'rollback')
        throw new Error('operation');
    const parsed = {
        schema_version: 1,
        operation_id: requireString(value, 'operation_id'),
        operation,
        target_path: requireString(value, 'target_path'),
        backup_path: requireString(value, 'backup_path'),
        source_path: requireString(value, 'source_path'),
        target_identity: parseIdentity(value['target_identity']),
        backup_identity: parseIdentity(value['backup_identity']),
        source_identity: parseIdentity(value['source_identity']),
        helper_identity: parseIdentity(value['helper_identity']),
    };
    if (value['staged_path'] !== undefined)
        parsed.staged_path = requireString(value, 'staged_path');
    if (value['staged_identity'] !== undefined)
        parsed.staged_identity = parseIdentity(value['staged_identity']);
    return parsed;
}
function parseIdentity(value) {
    if (!isRecord(value))
        throw new Error('identity');
    const identity = {
        dev: requireString(value, 'dev'),
        ino: requireString(value, 'ino'),
        size: requireString(value, 'size'),
        mtime_ns: requireString(value, 'mtime_ns'),
        ctime_ns: requireString(value, 'ctime_ns'),
        sha256: requireString(value, 'sha256'),
    };
    assertSha256(identity.sha256, 'identity_sha256');
    return identity;
}
async function snapshotRegularFile(path, label, maxBytes) {
    const cleanPath = assertAbsoluteCleanPath(path, label);
    const before = await lstat(cleanPath, { bigint: true }).catch((error) => {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_unreadable`, {
            cause: error,
        });
    });
    if (!before.isFile() || before.isSymbolicLink()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_not_regular`);
    }
    if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_too_large`);
    }
    const handle = await openNoFollow(cleanPath, constants.O_RDONLY);
    try {
        const opened = await handle.stat({ bigint: true });
        assertStatIdentity(before, opened, `${label}_opened`);
        const digest = await hashHandle(handle, maxBytes);
        const after = await handle.stat({ bigint: true });
        assertStatIdentity(opened, after, `${label}_changed`);
        return identityFromStat(after, digest);
    }
    finally {
        await handle.close();
    }
}
async function assertSnapshot(path, expected, label) {
    const actual = await snapshotRegularFile(path, label);
    if (!sameIdentity(actual, expected)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_changed`);
    }
}
async function copyRegularFileExclusive(sourcePath, destinationPath, expectedSource, mode) {
    const source = await openNoFollow(sourcePath, constants.O_RDONLY);
    let destination;
    let operationError;
    try {
        const openedSource = await source.stat({ bigint: true });
        if (!sameStatIdentity(openedSource, expectedSource)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_source_changed');
        }
        destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        let position = 0;
        while (true) {
            const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
            if (bytesRead === 0)
                break;
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await writeFully(destination, chunk, position);
            position += bytesRead;
        }
        if (!safeDigestEqual(hash.digest('hex'), expectedSource.sha256)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_source_digest_changed');
        }
        const afterSource = await source.stat({ bigint: true });
        if (!sameStatIdentity(afterSource, expectedSource)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_source_changed');
        }
        await destination.sync();
    }
    catch (error) {
        operationError = error;
    }
    finally {
        try {
            if (destination)
                await destination.close();
        }
        finally {
            await source.close();
        }
    }
    if (operationError !== undefined) {
        await removeBestEffort(destinationPath);
        throw operationError;
    }
}
async function writeFully(handle, bytes, startPosition) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, startPosition + offset);
        if (bytesWritten <= 0) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.COPY_FAILED, 'windows_updater_short_write');
        }
        offset += bytesWritten;
    }
}
async function hashHandle(handle, maxBytes) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0)
            break;
        position += bytesRead;
        if (maxBytes !== undefined && position > maxBytes) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_file_too_large');
        }
        hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
}
async function openNoFollow(path, flags) {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    try {
        return await open(path, flags | noFollow);
    }
    catch (error) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_open_failed', {
            cause: error,
        });
    }
}
async function assertPrivateDirectory(path, label, create) {
    const cleanPath = assertAbsoluteCleanPath(path, label);
    if (create)
        await mkdir(cleanPath, { recursive: true, mode: 0o700 });
    await assertNoSymlinkedParent(cleanPath, label);
    const before = await lstat(cleanPath, { bigint: true }).catch((error) => {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_unreadable`, {
            cause: error,
        });
    });
    if (!before.isDirectory() || before.isSymbolicLink()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_not_directory`);
    }
    const canonicalPath = await canonicalPathFor(cleanPath, label);
    await assertNoSymlinkedParent(cleanPath, label);
    await assertNoSymlinkedParent(canonicalPath, label);
    const canonical = await lstat(canonicalPath, { bigint: true }).catch((error) => {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_unreadable`, {
            cause: error,
        });
    });
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_not_directory`);
    }
    assertDirectoryIdentity(before, canonical, `${label}_canonical_changed`);
    return canonicalPath;
}
async function assertManagedRegularPath(path, stateDir, label) {
    const canonicalPath = await assertCanonicalRegularPath(path, label);
    const rel = relative(stateDir, canonicalPath);
    if (!rel || rel === '..' || rel.startsWith(`..${separator()}`) || isAbsolute(rel)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_outside_state_dir`);
    }
    return canonicalPath;
}
async function assertExternalRegularPath(path, stateDir, label) {
    const canonicalPath = await assertCanonicalRegularPath(path, label);
    const rel = relative(stateDir, canonicalPath);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${separator()}`) && !isAbsolute(rel))) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_inside_state_dir`);
    }
    return canonicalPath;
}
async function assertCanonicalRegularPath(path, label) {
    const cleanPath = assertAbsoluteCleanPath(path, label);
    await assertNoSymlinkedParent(cleanPath, label);
    const identity = await snapshotRegularFile(cleanPath, label);
    const canonicalPath = await canonicalPathFor(cleanPath, label);
    await assertNoSymlinkedParent(cleanPath, label);
    await assertNoSymlinkedParent(canonicalPath, label);
    await assertSnapshot(canonicalPath, identity, `${label}_canonical`);
    return canonicalPath;
}
async function canonicalPathFor(path, label) {
    return realpath(path).catch((error) => {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_unreadable`, {
            cause: error,
        });
    });
}
async function assertNoSymlinkedParent(path, label) {
    const parent = dirname(path);
    const root = symlinkTraversalRoot(parent);
    const directories = [];
    for (let current = parent; !samePath(current, root); current = dirname(current)) {
        directories.push(current);
    }
    for (const directory of directories.reverse()) {
        const info = await lstat(directory).catch((error) => {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_parent_unreadable`, { cause: error });
        });
        if (info.isSymbolicLink()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_parent_symlinked`);
        }
    }
}
function symlinkTraversalRoot(path) {
    const parsedRoot = parse(path).root;
    if (process.platform !== 'win32')
        return parsedRoot;
    // node:path treats only `\\?\UNC\` as the root of an extended UNC path.
    // Stop at the actual share root so we never probe non-filesystem server segments.
    const extendedUncRoot = /^(\\\\\?\\UNC\\[^\\]+\\[^\\]+\\?)/i.exec(path)?.[1];
    return extendedUncRoot ?? parsedRoot;
}
function assertAbsoluteCleanPath(path, label) {
    if (!path || path.includes('\0') || !isAbsolute(path)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_path_invalid`);
    }
    const cleanPath = resolve(path);
    if (!samePath(cleanPath, path)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_path_not_normalized`);
    }
    return cleanPath;
}
function assertStatIdentity(left, right, label) {
    if (left.dev !== right.dev
        || left.ino !== right.ino
        || left.size !== right.size
        || left.mtimeNs !== right.mtimeNs
        || left.ctimeNs !== right.ctimeNs) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}`);
    }
}
function assertDirectoryIdentity(left, right, label) {
    // Directory size and timestamps legitimately change when updater files are
    // created or scanned. Device + inode identify the directory without turning
    // those content changes into false path-swap failures.
    if (left.dev !== right.dev || left.ino !== right.ino) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}`);
    }
}
function sameStatIdentity(stat, identity) {
    return stat.dev.toString() === identity.dev
        && stat.ino.toString() === identity.ino
        && stat.size.toString() === identity.size
        && stat.mtimeNs.toString() === identity.mtime_ns
        && stat.ctimeNs.toString() === identity.ctime_ns;
}
function identityFromStat(stat, digest) {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtime_ns: stat.mtimeNs.toString(),
        ctime_ns: stat.ctimeNs.toString(),
        sha256: digest,
    };
}
function sameIdentity(left, right) {
    return sameContent(left, right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.mtime_ns === right.mtime_ns
        && left.ctime_ns === right.ctime_ns;
}
function sameContent(left, right) {
    return left.size === right.size && safeDigestEqual(left.sha256, right.sha256);
}
function safeDigestEqual(left, right) {
    if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right))
        return false;
    return timingSafeEqual(Buffer.from(left.toLowerCase(), 'hex'), Buffer.from(right.toLowerCase(), 'hex'));
}
function assertSha256(value, label) {
    if (!/^[0-9a-f]{64}$/i.test(value)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, `windows_updater_${label}_invalid`);
    }
}
async function writeJsonNoReplaceAtomic(path, value, mode) {
    const tempPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeJsonExclusive(tempPath, value, mode);
        await link(tempPath, path);
    }
    catch (error) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_pending_publish_failed', {
            cause: error,
        });
    }
    finally {
        await removeBestEffort(tempPath);
    }
}
async function writeJsonExclusive(path, value, mode) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function writeJsonAtomic(path, value, mode) {
    const tempPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeJsonExclusive(tempPath, value, mode);
        await rename(tempPath, path);
    }
    catch (error) {
        await removeBestEffort(tempPath);
        throw error;
    }
}
async function assertPathAbsent(path, label) {
    try {
        await lstat(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return;
        throw error;
    }
    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `windows_updater_${label}_exists`);
}
async function removeKnownReplacementTemp(path) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_replacement_temp_unsafe');
        }
        await rm(path);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
function updaterFailureCode(error) {
    if (error instanceof SelfUpdateFailureError)
        return error.failureCode;
    return SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED;
}
function samePath(left, right) {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
function separator() {
    return process.platform === 'win32' ? '\\' : '/';
}
function assertWindowsPlatform(platform) {
    if (platform !== 'win32') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'windows_updater_platform_required');
    }
}
async function removeBestEffort(path) {
    try {
        await rm(path, { force: true });
    }
    catch {
        // Cleanup failure must not replace the primary updater error.
    }
}
function requireString(value, key) {
    const field = value[key];
    if (typeof field !== 'string' || !field)
        throw new Error(key);
    return field;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}