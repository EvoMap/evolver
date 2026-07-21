import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm, writeFile, } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { ops } from '@evomap/evolver-core';
import { resolveSelfUpdateTarget } from './releaseBinary.js';
import { SELF_UPDATE_FAILURE_CODES, selfUpdateFailure } from './failureCodes.js';
import { bindWindowsManagedExecutable, prepareWindowsExecutableSwap, resolveWindowsUpdaterPaths, } from './windowsUpdater.js';
const execFileAsync = promisify(execFile);
const JOURNAL_SCHEMA_VERSION = 2;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_RECOVERY_ATTEMPTS = 2;
const STAGED_BINARY_PREFLIGHT_TIMEOUT_MS = 15_000;
const UNIX_CONTROLLER_DIRECTORY = 'unix-controller';
const UNIX_CONTROLLER_NAME = 'evolver-recovery-controller';
const WINDOWS_CONTROLLER_DIRECTORY = 'windows-controller';
const WINDOWS_CONTROLLER_NAME = 'evolver-recovery-controller.exe';
export async function inspectDurableSelfUpdate(options) {
    const paths = await resolveTransactionPaths(options, false);
    if (!paths)
        return { outcome: 'none' };
    const loadedJournal = await readJournal(paths.journal);
    if (!loadedJournal)
        return { outcome: 'none' };
    const journal = await bindJournalToTarget(paths, loadedJournal);
    const terminal = recoveryResultForTerminal(journal);
    if (terminal)
        return terminal;
    return recoveryResult(journal, 'pending_health');
}
export async function resolveStableUnixRecoveryControllerPath(options) {
    assertUnixControllerPlatform(options.platform ?? process.platform);
    const configuredTargetPath = resolveSelfUpdateTarget(options).path;
    const targetPath = await canonicalLogicalTargetPath(configuredTargetPath);
    const configuredStateDir = nonBlank(options.stateDir) ?? nonBlank(options.env?.['EVOLVER_SELF_UPDATE_STATE_DIR']);
    return stableUnixRecoveryControllerPathForTarget(targetPath, configuredStateDir);
}
export function stableUnixRecoveryControllerPathForTarget(targetPath, stateDir) {
    const root = resolve(nonBlank(stateDir) ?? join(dirname(resolve(targetPath)), '.evolver-update'));
    return join(root, UNIX_CONTROLLER_DIRECTORY, UNIX_CONTROLLER_NAME);
}
/**
 * Installs an executable copy outside the mutable target path. The transaction
 * lock and the existing no-follow file primitives keep service installation
 * from racing an update or copying through a symlink.
 */
export async function provisionStableUnixRecoveryController(options) {
    assertUnixControllerPlatform(options.platform ?? process.platform);
    const paths = await resolveTransactionPaths(options, true);
    const owner = await acquireLock(paths.lock, options.pid ?? process.pid);
    const controllerDirectory = join(paths.root, UNIX_CONTROLLER_DIRECTORY);
    const controllerPath = join(controllerDirectory, UNIX_CONTROLLER_NAME);
    const temporaryPath = join(controllerDirectory, `.${UNIX_CONTROLLER_NAME}.${randomBytes(8).toString('hex')}.tmp`);
    try {
        const loadedJournal = await readJournal(paths.journal);
        if (loadedJournal) {
            const journal = await bindJournalToTarget(paths, loadedJournal);
            if (!isTerminal(journal.stage) || journal.stage === 'rollback_failed') {
                throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `controller_install_pending_${journal.stage}`);
            }
        }
        await ensureSecureDirectory(paths.root);
        await ensureSecureDirectory(controllerDirectory);
        const targetIdentity = await assertRegularNonSymlink(paths.targetPath, 'target');
        const targetBytes = await readRegularFile(paths.targetPath);
        await writeExclusiveFile(temporaryPath, targetBytes, 0o700);
        await assertSameFileIdentity(paths.targetPath, targetIdentity);
        await rename(temporaryPath, controllerPath);
        await chmod(controllerPath, 0o700);
        return controllerPath;
    }
    finally {
        await rm(temporaryPath, { force: true }).catch(() => { });
        await releaseLock(paths.lock, owner).catch(() => { });
    }
}
export async function bindStableUnixRecoveryController(options, processExecPath) {
    assertUnixControllerPlatform(options.platform ?? process.platform);
    const paths = await resolveTransactionPaths(options, false);
    if (!paths) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'unix_controller_state_missing');
    }
    const controllerPath = join(paths.root, UNIX_CONTROLLER_DIRECTORY, UNIX_CONTROLLER_NAME);
    await assertRegularNonSymlink(controllerPath, 'unix_controller');
    await assertRegularNonSymlink(paths.targetPath, 'target');
    const [actualController, expectedController] = await Promise.all([
        realpath(processExecPath),
        realpath(controllerPath),
    ]);
    if (actualController !== expectedController) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unix_controller_exec_mismatch');
    }
    return { controllerPath: expectedController, targetPath: paths.targetPath };
}
export async function bindStableWindowsRecoveryController(options, processExecPath) {
    if ((options.platform ?? process.platform) !== 'win32') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'windows_controller_unsupported_platform');
    }
    const paths = await resolveTransactionPaths(options, false);
    if (!paths) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'windows_controller_state_missing');
    }
    await assertRegularNonSymlink(paths.targetPath, 'target');
    const boundController = await bindWindowsManagedExecutable({
        stateDir: paths.root,
        executablePath: processExecPath,
        relativePath: [WINDOWS_CONTROLLER_DIRECTORY, WINDOWS_CONTROLLER_NAME],
        label: 'windows_controller',
        platform: 'win32',
    });
    return {
        controllerPath: boundController.executablePath,
        stateDir: boundController.stateDir,
        targetPath: paths.targetPath,
    };
}
export function stableWindowsRecoveryControllerPathForStateDir(stateDir) {
    return join(resolve(stateDir), WINDOWS_CONTROLLER_DIRECTORY, WINDOWS_CONTROLLER_NAME);
}
/**
 * Provision or refresh the long-lived controller while it is not running.
 * Service installation stops the Scheduled Task before calling this command;
 * each self-update only replaces the separate windows-updater worker path.
 */
export async function provisionStableWindowsRecoveryController(options, processExecPath) {
    if ((options.platform ?? process.platform) !== 'win32') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'windows_controller_unsupported_platform');
    }
    const paths = await resolveTransactionPaths(options, true);
    const owner = await acquireLock(paths.lock, options.pid ?? process.pid);
    const controllerDirectory = join(paths.root, WINDOWS_CONTROLLER_DIRECTORY);
    const controllerPath = stableWindowsRecoveryControllerPathForStateDir(paths.root);
    const temporaryPath = join(controllerDirectory, `.${WINDOWS_CONTROLLER_NAME}.${randomBytes(8).toString('hex')}.tmp`);
    try {
        const loadedJournal = await readJournal(paths.journal);
        if (loadedJournal) {
            const journal = await bindJournalToTarget(paths, loadedJournal);
            if (!isTerminal(journal.stage) || journal.stage === 'rollback_failed') {
                throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `windows_controller_install_pending_${journal.stage}`);
            }
        }
        const [actualSource, expectedSource] = await Promise.all([
            realpath(processExecPath),
            realpath(paths.targetPath),
        ]);
        if (normalizeCanonicalSelfUpdateTargetPath(actualSource, 'win32')
            !== normalizeCanonicalSelfUpdateTargetPath(expectedSource, 'win32')) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'windows_controller_source_mismatch');
        }
        await ensureSecureDirectory(paths.root);
        await ensureSecureDirectory(controllerDirectory);
        const targetIdentity = await assertRegularNonSymlink(paths.targetPath, 'target');
        const targetBytes = await readRegularFile(paths.targetPath);
        await writeExclusiveFile(temporaryPath, targetBytes, 0o700);
        await assertSameFileIdentity(paths.targetPath, targetIdentity);
        try {
            await assertRegularNonSymlink(controllerPath, 'windows_controller');
            await rm(controllerPath);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
        }
        await rename(temporaryPath, controllerPath);
        await chmod(controllerPath, 0o700);
        return controllerPath;
    }
    finally {
        await rm(temporaryPath, { force: true }).catch(() => { });
        await releaseLock(paths.lock, owner).catch(() => { });
    }
}
export async function beginDurableSelfUpdate(targetVersion, options) {
    const paths = await resolveTransactionPaths(options, true);
    const owner = await acquireLock(paths.lock, options.pid ?? process.pid, options.beforeStaleLockReclaim);
    const now = options.now ?? (() => new Date());
    let journal;
    let released = false;
    try {
        const loadedExisting = await readJournal(paths.journal);
        const existing = loadedExisting ? await bindJournalToTarget(paths, loadedExisting) : undefined;
        if (existing?.stage === 'rollback_failed') {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED, 'pending_rollback_failed');
        }
        if (existing && !isTerminal(existing.stage)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `pending_${existing.stage}`);
        }
        await ensureSecureDirectory(paths.root);
        await ensureSecureDirectory(paths.staging);
        await ensureSecureDirectory(paths.backups);
        if (existing)
            await rm(paths.journal, { force: true });
        const transactionId = `${Date.now()}-${randomBytes(8).toString('hex')}`;
        const createdAt = now().toISOString();
        journal = {
            schema_version: JOURNAL_SCHEMA_VERSION,
            transaction_id: transactionId,
            stage: 'preparing',
            from_version: options.currentVersion,
            target_version: targetVersion,
            platform: options.platform ?? process.platform,
            arch: options.arch ?? process.arch,
            installing_pid: options.pid ?? process.pid,
            created_at: createdAt,
            updated_at: createdAt,
            recovery_attempts: 0,
            target_path: await canonicalLogicalTargetPath(paths.targetPath),
            configured_target_path: paths.configuredTargetPath,
        };
        await writeJournal(paths.journal, journal);
        const persist = async (stage, patch = {}) => {
            journal = { ...journal, ...patch, stage, updated_at: now().toISOString() };
            await writeJournal(paths.journal, journal);
            return journal;
        };
        const rollback = async (failureCode) => {
            if (!journal)
                return;
            const result = await rollbackJournal(paths, persist, failureCode, options);
            if (result.outcome === 'blocked') {
                throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED, failureCode);
            }
        };
        return {
            async adoptDownloaded(download) {
                const stagedName = `${journal.transaction_id}.staged`;
                const managedPath = join(paths.staging, stagedName);
                await moveRegularFile(download.stagedPath, managedPath, 0o700);
                await persist('downloaded', { staged_name: stagedName });
                return { ...download, stagedPath: managedPath };
            },
            async markVerified(artifacts) {
                if (!journal?.staged_name)
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'staging_missing');
                if (artifacts.length !== 1) {
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_artifact_count_invalid');
                }
                const artifact = artifacts[0];
                const verifiedSha256 = artifact.sha256?.toLowerCase()
                    ?? (artifact.bytes ? createHash('sha256').update(artifact.bytes).digest('hex') : undefined);
                if (!verifiedSha256 || !/^[0-9a-f]{64}$/.test(verifiedSha256)) {
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_artifact_digest_missing');
                }
                await persist('verified', { verified_sha256: verifiedSha256 });
            },
            async install() {
                if (!journal?.staged_name || !journal.verified_sha256 || journal.stage !== 'verified') {
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'install_before_verified');
                }
                const stagedPath = join(paths.staging, journal.staged_name);
                try {
                    await preflightManagedStagedBinary(stagedPath, journal.target_version, options.stagedBinaryProbe);
                }
                catch (error) {
                    await persist('rolled_back', { failure_code: SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION });
                    await cleanupTransactionFiles(paths, journal);
                    throw error;
                }
                const backupName = `${journal.transaction_id}.backup`;
                const backupPath = join(paths.backups, backupName);
                const targetStat = await assertRegularNonSymlink(paths.targetPath, 'target');
                const targetMode = Number(targetStat.mode) & 0o777;
                await copyRegularFile(paths.targetPath, backupPath, targetMode);
                await persist('backed_up', { backup_name: backupName });
                if ((options.platform ?? process.platform) === 'win32') {
                    try {
                        const stagedBytes = await readRegularFile(stagedPath);
                        const stagedSha256 = createHash('sha256').update(stagedBytes).digest('hex');
                        if (stagedSha256 !== journal.verified_sha256) {
                            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_artifact_changed_after_verification');
                        }
                        // Persist intent before publishing pending.json. A crash before
                        // publication restarts the untouched old target; a crash after
                        // publication lets the stable controller run the worker and complete the swap.
                        await persist('install_pending');
                        await prepareWindowsExecutableSwap({
                            operation: 'install',
                            targetPath: paths.targetPath,
                            stagedPath,
                            expectedStagedSha256: journal.verified_sha256,
                            backupPath,
                            stateDir: paths.root,
                            platform: 'win32',
                        });
                        return;
                    }
                    catch (error) {
                        await persist('rolled_back', { failure_code: SELF_UPDATE_FAILURE_CODES.COPY_FAILED });
                        await cleanupTransactionFiles(paths, journal);
                        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.COPY_FAILED, errorCode(error), { cause: error });
                    }
                }
                const installTmp = join(dirname(paths.targetPath), `.${journal.transaction_id}.evolver-install`);
                try {
                    const stagedBytes = await readRegularFile(stagedPath);
                    const stagedSha256 = createHash('sha256').update(stagedBytes).digest('hex');
                    if (stagedSha256 !== journal.verified_sha256) {
                        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_artifact_changed_after_verification');
                    }
                    await writeExclusiveFile(installTmp, stagedBytes, targetMode);
                    await assertSameFileIdentity(paths.targetPath, targetStat);
                    await rename(installTmp, paths.targetPath);
                    await persist('installed');
                }
                catch (error) {
                    await rm(installTmp, { force: true }).catch(() => { });
                    await rollback(SELF_UPDATE_FAILURE_CODES.COPY_FAILED);
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.COPY_FAILED, errorCode(error), { cause: error });
                }
            },
            async markRestartRequested() {
                if (journal?.stage !== 'installed' && journal?.stage !== 'install_pending') {
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'restart_before_install');
                }
                await persist('restarted');
            },
            async abort(failureCode) {
                if (!journal)
                    return;
                await persist('rolled_back', { failure_code: failureCode });
                await cleanupTransactionFiles(paths, journal);
            },
            rollback,
            async release() {
                if (released)
                    return;
                released = true;
                await releaseLock(paths.lock, owner);
            },
        };
    }
    catch (error) {
        await releaseLock(paths.lock, owner).catch(() => { });
        throw error;
    }
}
export async function recoverDurableSelfUpdate(options) {
    const paths = await resolveTransactionPaths(options, false);
    if (!paths)
        return { outcome: 'none' };
    const owner = await acquireLock(paths.lock, options.pid ?? process.pid, options.beforeStaleLockReclaim);
    const now = options.now ?? (() => new Date());
    try {
        const loadedJournal = await readJournal(paths.journal);
        if (!loadedJournal)
            return { outcome: 'none' };
        const boundJournal = await bindJournalToTarget(paths, loadedJournal);
        await options.beforeJournalMutation?.();
        let journal = boundJournal;
        const persist = async (stage, patch = {}) => {
            journal = { ...journal, ...patch, stage, updated_at: now().toISOString() };
            await writeJournal(paths.journal, journal);
            return journal;
        };
        const terminal = recoveryResultForTerminal(journal);
        if (terminal) {
            if (terminal.outcome !== 'blocked')
                await cleanupTransactionFiles(paths, journal);
            return terminal;
        }
        if (journal.stage === 'preparing' || journal.stage === 'downloaded' || journal.stage === 'verified') {
            await persist('rolled_back', { failure_code: 'interrupted_before_install' });
            await cleanupTransactionFiles(paths, journal);
            return recoveryResult(journal, 'rolled_back');
        }
        if (journal.stage === 'backed_up') {
            if (journal.platform === 'win32') {
                await persist('rolled_back', { failure_code: 'interrupted_before_install' });
                await cleanupTransactionFiles(paths, journal);
                return recoveryResult(journal, 'rolled_back');
            }
            return rollbackJournal(paths, persist, journal.failure_code ?? 'interrupted_before_install', options);
        }
        if (journal.stage === 'rolling_back' || journal.stage === 'rollback_pending') {
            return rollbackJournal(paths, persist, journal.failure_code ?? 'interrupted_before_install', options);
        }
        if (journal.stage === 'install_pending') {
            return {
                ...recoveryResult(journal, 'blocked'),
                failureCode: 'windows_install_not_applied',
            };
        }
        const attempts = journal.recovery_attempts + 1;
        await persist(journal.stage === 'health_check_pending' ? 'health_check_pending' : 'restarted', {
            recovery_attempts: attempts,
        });
        const readBack = options.readBackVersion ?? readInstalledVersion;
        let installedVersion;
        if (attempts <= MAX_RECOVERY_ATTEMPTS) {
            try {
                installedVersion = ops.normalizeConcreteVersion(await readBack(paths.targetPath));
            }
            catch {
                installedVersion = undefined;
            }
        }
        if (installedVersion === ops.normalizeConcreteVersion(journal.target_version)) {
            await persist('health_check_pending');
            return recoveryResult(journal, 'pending_health');
        }
        if (installedVersion === ops.normalizeConcreteVersion(journal.from_version)) {
            await persist('rolled_back', { failure_code: journal.failure_code ?? SELF_UPDATE_FAILURE_CODES.READ_BACK_FAILED });
            await cleanupTransactionFiles(paths, journal);
            return recoveryResult(journal, 'rolled_back');
        }
        return rollbackJournal(paths, persist, SELF_UPDATE_FAILURE_CODES.READ_BACK_FAILED, options);
    }
    finally {
        await releaseLock(paths.lock, owner).catch(() => { });
    }
}
export async function markWindowsInstallApplied(options) {
    return mutateRecoveredTransaction(options, async (paths, journal, persist) => {
        if (journal.platform !== 'win32' || journal.stage !== 'install_pending' || !journal.verified_sha256) {
            return {
                ...recoveryResult(journal, 'blocked'),
                failureCode: 'windows_install_not_applied',
            };
        }
        const targetSha256 = createHash('sha256').update(await readRegularFile(paths.targetPath)).digest('hex');
        if (targetSha256 !== journal.verified_sha256) {
            return {
                ...recoveryResult(journal, 'blocked'),
                failureCode: 'windows_install_not_applied',
            };
        }
        journal = await persist('restarted');
        return recoveryResult(journal, 'pending_health');
    });
}
export async function confirmDurableSelfUpdate(options) {
    return mutateRecoveredTransaction(options, async (paths, journal, persist) => {
        const terminal = recoveryResultForTerminal(journal);
        if (terminal)
            return terminal;
        if (journal.stage !== 'health_check_pending') {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `confirm_before_health_check:${journal.stage}`);
        }
        journal = await persist('confirmed');
        await cleanupTransactionFiles(paths, journal);
        return recoveryResult(journal, 'confirmed');
    });
}
export async function rollbackDurableSelfUpdate(options, failureCode) {
    return mutateRecoveredTransaction(options, async (paths, journal, persist) => {
        const terminal = recoveryResultForTerminal(journal);
        if (terminal)
            return terminal;
        return rollbackJournal(paths, persist, failureCode, options);
    });
}
async function mutateRecoveredTransaction(options, mutate) {
    const paths = await resolveTransactionPaths(options, false);
    if (!paths)
        return { outcome: 'none' };
    const owner = await acquireLock(paths.lock, options.pid ?? process.pid, options.beforeStaleLockReclaim);
    const now = options.now ?? (() => new Date());
    try {
        const loadedJournal = await readJournal(paths.journal);
        if (!loadedJournal)
            return { outcome: 'none' };
        const boundJournal = await bindJournalToTarget(paths, loadedJournal);
        await options.beforeJournalMutation?.();
        let journal = boundJournal;
        const persist = async (stage, patch = {}) => {
            journal = { ...journal, ...patch, stage, updated_at: now().toISOString() };
            await writeJournal(paths.journal, journal);
            return journal;
        };
        return await mutate(paths, journal, persist);
    }
    finally {
        await releaseLock(paths.lock, owner).catch(() => { });
    }
}
async function rollbackJournal(paths, persist, failureCode, options) {
    const current = await readJournal(paths.journal);
    if (!current)
        return { outcome: 'none' };
    const boundCurrent = await bindJournalToTarget(paths, current);
    if (boundCurrent.platform === 'win32') {
        return prepareWindowsRollback(paths, boundCurrent, persist, failureCode, options);
    }
    let journal = await persist('rolling_back', { failure_code: failureCode });
    let alreadyRestored = false;
    try {
        await restoreBackup(paths, journal, true);
    }
    catch (error) {
        alreadyRestored = isErrno(error, 'ENOENT')
            && await targetMatchesVersion(paths.targetPath, journal.from_version, options.readBackVersion);
        if (!alreadyRestored) {
            journal = await persist('rollback_failed', { failure_code: SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED });
            return recoveryResult(journal, 'blocked');
        }
    }
    journal = await persist('rolled_back', { failure_code: failureCode });
    await cleanupTransactionFiles(paths, journal);
    return recoveryResult(journal, 'rolled_back', !alreadyRestored);
}
async function prepareWindowsRollback(paths, current, persist, failureCode, options) {
    const pendingPath = resolveWindowsUpdaterPaths(paths.root).pendingPath;
    let pendingExists = await regularFileExists(pendingPath);
    if ((current.stage === 'install_pending' || current.stage === 'restarted') && pendingExists) {
        const targetStillMatchesBackup = await targetMatchesBackup(paths, current);
        await removeRegularWindowsPending(paths.root);
        pendingExists = false;
        if (targetStillMatchesBackup) {
            const cancelled = await persist('rolled_back', { failure_code: failureCode });
            await cleanupTransactionFiles(paths, cancelled);
            return recoveryResult(cancelled, 'rolled_back');
        }
    }
    let journal = current.stage === 'rollback_pending'
        ? current
        : await persist('rollback_pending', { failure_code: failureCode });
    if (await targetMatchesVersion(paths.targetPath, journal.from_version, options.readBackVersion)) {
        try {
            await removeRegularWindowsPending(paths.root);
        }
        catch {
            journal = await persist('rollback_failed', { failure_code: SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED });
            return recoveryResult(journal, 'blocked');
        }
        journal = await persist('rolled_back', { failure_code: failureCode });
        await cleanupTransactionFiles(paths, journal);
        return recoveryResult(journal, 'rolled_back');
    }
    if (!journal.backup_name) {
        journal = await persist('rollback_failed', { failure_code: SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED });
        return recoveryResult(journal, 'blocked');
    }
    if (!pendingExists) {
        try {
            await prepareWindowsExecutableSwap({
                operation: 'rollback',
                targetPath: paths.targetPath,
                backupPath: join(paths.backups, journal.backup_name),
                stateDir: paths.root,
                helperSourcePath: options.processExecPath ?? process.execPath,
                platform: 'win32',
            });
        }
        catch {
            journal = await persist('rollback_failed', { failure_code: SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED });
            return recoveryResult(journal, 'blocked');
        }
    }
    return recoveryResult(journal, 'rollback_pending', true);
}
async function removeRegularWindowsPending(stateDir) {
    const pendingPath = resolveWindowsUpdaterPaths(stateDir).pendingPath;
    try {
        const info = await lstat(pendingPath);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unsafe_windows_updater_pending');
        }
        await rm(pendingPath);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
async function regularFileExists(path) {
    try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unsafe_windows_updater_pending');
        }
        return true;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return false;
        throw error;
    }
}
async function targetMatchesVersion(targetPath, expectedVersion, readBackVersion) {
    try {
        const actual = ops.normalizeConcreteVersion(await (readBackVersion ?? readInstalledVersion)(targetPath));
        return actual === ops.normalizeConcreteVersion(expectedVersion);
    }
    catch {
        return false;
    }
}
async function targetMatchesBackup(paths, journal) {
    if (!journal.backup_name)
        return false;
    try {
        const [targetBytes, backupBytes] = await Promise.all([
            readRegularFile(paths.targetPath),
            readRegularFile(join(paths.backups, journal.backup_name)),
        ]);
        return targetBytes.equals(backupBytes);
    }
    catch {
        return false;
    }
}
function recoveryResultForTerminal(journal) {
    if (journal.stage === 'confirmed')
        return recoveryResult(journal, 'confirmed');
    if (journal.stage === 'rolled_back')
        return recoveryResult(journal, 'rolled_back');
    if (journal.stage === 'rollback_failed')
        return recoveryResult(journal, 'blocked');
    return undefined;
}
function recoveryResult(journal, outcome, restartRequired = false) {
    return {
        outcome,
        stage: journal.stage,
        targetVersion: journal.target_version,
        fromVersion: journal.from_version,
        ...(restartRequired ? { restartRequired: true } : {}),
        ...(journal.failure_code ? { failureCode: journal.failure_code } : {}),
    };
}
async function resolveTransactionPaths(options, create) {
    let configuredTargetPath;
    try {
        configuredTargetPath = resolveSelfUpdateTarget(options).path;
    }
    catch (error) {
        if (!create)
            return undefined;
        throw error;
    }
    const logicalTargetPath = resolve(configuredTargetPath);
    const normalizedConfiguredTargetPath = normalizeCanonicalSelfUpdateTargetPath(logicalTargetPath);
    const targetPath = create
        ? await canonicalLogicalTargetPath(logicalTargetPath)
        : logicalTargetPath;
    const configuredStateDir = nonBlank(options.stateDir) ?? nonBlank(options.env?.['EVOLVER_SELF_UPDATE_STATE_DIR']);
    // Keep the default state location tied to the configured spelling. The
    // journal itself binds mutations to the canonical target, while this path
    // preserves discovery of state created through a symlinked launcher path.
    const root = resolve(configuredStateDir ?? join(dirname(logicalTargetPath), '.evolver-update'));
    if (create) {
        await ensureStateRootForLock(root);
    }
    else {
        try {
            await assertDirectoryNonSymlink(root);
        }
        catch (error) {
            if (isErrno(error, 'ENOENT'))
                return undefined;
            throw error;
        }
    }
    return {
        configuredTargetPath: normalizedConfiguredTargetPath,
        targetPath,
        root,
        journal: join(root, 'journal.json'),
        lock: join(root, 'update.lock'),
        staging: join(root, 'staging'),
        backups: join(root, 'backups'),
    };
}
function nonBlank(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function assertUnixControllerPlatform(platform) {
    if (platform === 'win32') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unix_controller_unsupported_platform');
    }
}
async function ensureSecureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertDirectoryNonSymlink(path);
    await chmod(path, 0o700);
}
async function ensureStateRootForLock(path) {
    try {
        await assertDirectoryNonSymlink(path);
        return;
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertDirectoryNonSymlink(path);
    await chmod(path, 0o700);
}
async function bindJournalToTarget(paths, journal) {
    if (journal.schema_version !== JOURNAL_SCHEMA_VERSION || !journal.target_path) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'journal_target_missing');
    }
    const expected = normalizeCanonicalSelfUpdateTargetPath(journal.target_path);
    if (journal.target_path !== expected) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'journal_target_not_canonical');
    }
    const expectedConfigured = journal.configured_target_path === undefined
        ? expected
        : normalizeCanonicalSelfUpdateTargetPath(journal.configured_target_path);
    if (journal.configured_target_path !== undefined && journal.configured_target_path !== expectedConfigured) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'journal_configured_target_not_normalized');
    }
    let actual;
    try {
        actual = await canonicalLogicalTargetPath(paths.targetPath);
    }
    catch (error) {
        // An explicit durable state directory can outlive the install parent. In
        // that case symlinks cannot be resolved, so only the caller's matching
        // logical absolute path can preserve the journal binding.
        if (!hasErrnoCause(error, 'ENOENT'))
            throw error;
        if (paths.configuredTargetPath !== expectedConfigured) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'journal_target_mismatch');
        }
        paths.targetPath = expected;
        return journal;
    }
    if (actual !== expected) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'journal_target_mismatch');
    }
    paths.targetPath = expected;
    return journal;
}
async function canonicalLogicalTargetPath(targetPath) {
    const absoluteTarget = resolve(targetPath);
    let canonicalParent;
    try {
        canonicalParent = await realpath(dirname(absoluteTarget));
    }
    catch (error) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'target_parent_unresolvable', { cause: error });
    }
    return normalizeCanonicalSelfUpdateTargetPath(join(canonicalParent, basename(absoluteTarget)));
}
export function normalizeCanonicalSelfUpdateTargetPath(targetPath, platform = process.platform) {
    if (platform !== 'win32')
        return resolve(targetPath);
    const withoutNamespace = targetPath
        .replace(/^\\\\\?\\UNC\\/i, '\\\\')
        .replace(/^\\\\\?\\/i, '');
    return win32.normalize(withoutNamespace).toLowerCase();
}
async function assertDirectoryNonSymlink(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unsafe_state_directory');
    }
    await realpath(path);
}
async function assertRegularNonSymlink(path, kind) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, `${kind}_not_regular`);
    }
    return info;
}
async function moveRegularFile(source, destination, mode) {
    await assertRegularNonSymlink(source, 'staged');
    try {
        await rename(source, destination);
        await chmod(destination, mode);
    }
    catch (error) {
        if (!isErrno(error, 'EXDEV'))
            throw error;
        await copyRegularFile(source, destination, mode);
        await rm(source, { force: true });
    }
}
async function copyRegularFile(source, destination, mode) {
    await writeExclusiveFile(destination, await readRegularFile(source), mode);
}
async function readRegularFile(source) {
    const sourceHandle = await open(source, constants.O_RDONLY | noFollowFlag());
    try {
        const sourceStat = await sourceHandle.stat();
        if (!sourceStat.isFile())
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'source_not_regular');
        return await sourceHandle.readFile();
    }
    finally {
        await sourceHandle.close().catch(() => { });
    }
}
async function writeExclusiveFile(destination, bytes, mode) {
    const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        await destinationHandle.writeFile(bytes);
        await destinationHandle.sync();
        await destinationHandle.chmod(mode);
    }
    finally {
        await destinationHandle.close().catch(() => { });
    }
}
async function restoreBackup(paths, journal, force = false) {
    if (!journal.backup_name)
        return;
    const backupPath = join(paths.backups, journal.backup_name);
    try {
        await assertRegularNonSymlink(backupPath, 'backup');
    }
    catch (error) {
        if (!force && isErrno(error, 'ENOENT'))
            return;
        throw error;
    }
    const targetInfo = await lstat(paths.targetPath).catch((error) => {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    });
    if (targetInfo?.isSymbolicLink()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'target_became_symlink');
    }
    const restoreTmp = join(dirname(paths.targetPath), `.${journal.transaction_id}.evolver-rollback`);
    await rm(restoreTmp, { force: true });
    await copyRegularFile(backupPath, restoreTmp, Number(targetInfo?.mode ?? 0o755) & 0o777);
    await rename(restoreTmp, paths.targetPath);
}
async function cleanupTransactionFiles(paths, journal) {
    if (journal.staged_name)
        await rm(join(paths.staging, journal.staged_name), { force: true }).catch(() => { });
    if (journal.backup_name)
        await rm(join(paths.backups, journal.backup_name), { force: true }).catch(() => { });
}
async function writeJournal(path, journal) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
}
async function readJournal(path) {
    let journalHandle;
    try {
        const pathInfo = await lstat(path);
        if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unsafe_journal');
        }
        journalHandle = await open(path, constants.O_RDONLY | noFollowFlag());
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    try {
        const info = await journalHandle.stat();
        const currentPathInfo = await lstat(path);
        if (!info.isFile()
            || currentPathInfo.isSymbolicLink()
            || !currentPathInfo.isFile()
            || Number(currentPathInfo.dev) !== Number(info.dev)
            || Number(currentPathInfo.ino) !== Number(info.ino)
            || info.size > MAX_JOURNAL_BYTES) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'unsafe_journal');
        }
        const parsed = JSON.parse(await journalHandle.readFile('utf8'));
        if (!isJournal(parsed))
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'invalid_journal');
        return parsed;
    }
    finally {
        await journalHandle.close().catch(() => { });
    }
}
function isJournal(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const journal = value;
    const validBase = typeof journal.transaction_id === 'string'
        && isJournalStage(journal.stage)
        && typeof journal.from_version === 'string'
        && typeof journal.target_version === 'string'
        && typeof journal.installing_pid === 'number'
        && typeof journal.recovery_attempts === 'number'
        && (journal.staged_name === undefined || isSafeManagedName(journal.staged_name, '.staged'))
        && (journal.backup_name === undefined || isSafeManagedName(journal.backup_name, '.backup'))
        && (journal.verified_sha256 === undefined || /^[0-9a-f]{64}$/.test(journal.verified_sha256));
    if (!validBase)
        return false;
    if (journal.schema_version === 1) {
        return journal.target_path === undefined && journal.configured_target_path === undefined;
    }
    return journal.schema_version === JOURNAL_SCHEMA_VERSION
        && typeof journal.target_path === 'string'
        && journal.target_path.length > 0
        && journal.target_path.length <= 4_096
        && (process.platform === 'win32' ? win32.isAbsolute(journal.target_path) : isAbsolute(journal.target_path))
        && (journal.configured_target_path === undefined || (typeof journal.configured_target_path === 'string'
            && journal.configured_target_path.length > 0
            && journal.configured_target_path.length <= 4_096
            && (process.platform === 'win32'
                ? win32.isAbsolute(journal.configured_target_path)
                : isAbsolute(journal.configured_target_path))
            && journal.configured_target_path === normalizeCanonicalSelfUpdateTargetPath(journal.configured_target_path)));
}
function isSafeManagedName(value, suffix) {
    return typeof value === 'string'
        && value.length >= suffix.length + 1
        && value.length <= 160
        && value.endsWith(suffix)
        && /^[0-9A-Za-z.-]+$/.test(value)
        && !value.includes('..');
}
function isJournalStage(value) {
    return value === 'preparing' || value === 'downloaded' || value === 'verified' || value === 'backed_up' || value === 'installed'
        || value === 'install_pending' || value === 'restarted' || value === 'health_check_pending' || value === 'rolling_back'
        || value === 'rollback_pending'
        || value === 'confirmed' || value === 'rolled_back' || value === 'rollback_failed';
}
function isTerminal(stage) {
    return stage === 'confirmed' || stage === 'rolled_back';
}
async function acquireLock(path, pid, beforeStaleLockReclaim) {
    const owner = { pid, token: randomBytes(16).toString('hex') };
    const visited = new Set();
    let generationPath = path;
    while (true) {
        const existing = await readLockGeneration(generationPath);
        if (!existing) {
            if (await publishLockGeneration(path, generationPath, owner)) {
                return { ...owner, generationPath };
            }
            continue;
        }
        if (visited.has(generationPath)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'update_lock_invalid_chain');
        }
        visited.add(generationPath);
        const released = await lockGenerationReleased(path, existing.owner.token);
        if (!released && processAlive(existing.owner.pid)) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'update_lock_held');
        }
        await beforeStaleLockReclaim?.();
        generationPath = successorLockGenerationPath(path, existing.owner.token);
    }
}
async function releaseLock(path, lease) {
    const current = await readLockGeneration(lease.generationPath);
    if (current?.owner.pid !== lease.pid || current.owner.token !== lease.token)
        return;
    try {
        await mkdir(lockReleaseMarkerPath(path, lease.token), { mode: 0o700 });
    }
    catch (error) {
        if (!isErrno(error, 'EEXIST'))
            throw error;
        await lockGenerationReleased(path, lease.token);
    }
}
async function publishLockGeneration(rootPath, generationPath, owner) {
    const candidatePath = `${rootPath}.${owner.token}.candidate`;
    let candidateCreated = false;
    try {
        await mkdir(candidatePath, { mode: 0o700 });
        candidateCreated = true;
        await writeExclusiveFile(join(candidatePath, 'owner.json'), Buffer.from(`${JSON.stringify(owner)}\n`), 0o600);
        try {
            // A fully populated, non-empty directory is published atomically. Unlike
            // renaming the stale shared lock itself, a losing rename cannot replace a
            // winner's non-empty generation directory on POSIX or Windows.
            await rename(candidatePath, generationPath);
            return true;
        }
        catch (error) {
            if (!isLockPublishContention(error))
                throw error;
            // Only a valid, fully published generation proves that this rename lost
            // the ownership race. Do not turn unrelated I/O or permission failures
            // into an unbounded contention retry.
            const published = await readLockGeneration(generationPath);
            if (!published)
                throw error;
            return false;
        }
    }
    finally {
        if (candidateCreated) {
            await rm(candidatePath, { force: true, recursive: true }).catch(() => { });
        }
    }
}
async function readLockGeneration(path) {
    let info;
    try {
        info = await lstat(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    if (info.isSymbolicLink()) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'update_lock_unsafe');
    }
    const ownerPath = info.isDirectory()
        ? join(path, 'owner.json')
        : info.isFile()
            ? path
            : undefined;
    if (!ownerPath) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'update_lock_unsafe');
    }
    const owner = await readLockOwner(ownerPath);
    if (!owner) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'update_lock_invalid');
    }
    return { owner };
}
async function readLockOwner(path) {
    let handle;
    try {
        const before = await lstat(path);
        if (before.isSymbolicLink() || !before.isFile() || before.size > 4_096)
            return undefined;
        handle = await open(path, constants.O_RDONLY | noFollowFlag());
        const opened = await handle.stat();
        if (!opened.isFile()
            || opened.size > 4_096
            || Number(opened.dev) !== Number(before.dev)
            || Number(opened.ino) !== Number(before.ino))
            return undefined;
        const bytes = await handle.readFile();
        if (bytes.byteLength > 4_096)
            return undefined;
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object')
            return undefined;
        const owner = parsed;
        return Number.isSafeInteger(owner.pid)
            && typeof owner.pid === 'number'
            && owner.pid > 0
            && typeof owner.token === 'string'
            && /^[0-9a-f]{32}$/.test(owner.token)
            ? { pid: owner.pid, token: owner.token }
            : undefined;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || error instanceof SyntaxError)
            return undefined;
        throw error;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function lockGenerationReleased(rootPath, token) {
    try {
        const info = await lstat(lockReleaseMarkerPath(rootPath, token));
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'update_lock_release_unsafe');
        }
        return true;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return false;
        throw error;
    }
}
function successorLockGenerationPath(rootPath, token) {
    return `${rootPath}.${token}.next`;
}
function lockReleaseMarkerPath(rootPath, token) {
    return `${rootPath}.${token}.released`;
}
function isLockPublishContention(error) {
    return isErrno(error, 'EEXIST')
        || isErrno(error, 'ENOTEMPTY')
        || isErrno(error, 'ENOTDIR')
        || isErrno(error, 'EISDIR')
        || (process.platform === 'win32' && isErrno(error, 'EPERM'));
}
function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isErrno(error, 'EPERM');
    }
}
async function assertSameFileIdentity(path, expected) {
    const current = await assertRegularNonSymlink(path, 'target');
    if (Number(current.dev) !== Number(expected.dev) || Number(current.ino) !== Number(expected.ino)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'target_changed_during_update');
    }
}
export async function preflightManagedStagedBinary(targetPath, expectedVersion, probe = execStagedBinaryProbe) {
    await assertRegularNonSymlink(targetPath, 'staged');
    const probeOptions = {
        cwd: dirname(targetPath),
        timeout: STAGED_BINARY_PREFLIGHT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024,
        env: stagedBinaryPreflightEnvironment(),
    };
    let versionOutput;
    try {
        versionOutput = (await probe(targetPath, ['--version'], probeOptions)).stdout;
    }
    catch (error) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_preflight_version_failed', { cause: error });
    }
    const actualVersion = versionOutput.trim().split(/\r?\n/, 1)[0] ?? '';
    let versionMatches = false;
    try {
        versionMatches = ops.normalizeConcreteVersion(actualVersion)
            === ops.normalizeConcreteVersion(expectedVersion);
    }
    catch {
        versionMatches = false;
    }
    if (!versionMatches) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_preflight_version_mismatch');
    }
    try {
        await probe(targetPath, ['proxy', '--help'], probeOptions);
    }
    catch (error) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'staged_preflight_proxy_failed', { cause: error });
    }
}
async function execStagedBinaryProbe(targetPath, args, options) {
    const { stdout } = await execFileAsync(targetPath, [...args], options);
    return { stdout };
}
function stagedBinaryPreflightEnvironment() {
    const allowed = ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];
    return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
async function readInstalledVersion(targetPath) {
    const { stdout } = await execFileAsync(targetPath, ['--version'], {
        cwd: dirname(targetPath),
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 16 * 1024,
        env: readBackEnvironment(),
    });
    return stdout.trim().split(/\r?\n/, 1)[0] ?? '';
}
function readBackEnvironment() {
    const allowed = ['PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME'];
    return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
function noFollowFlag() {
    return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function hasErrnoCause(error, code) {
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
        if (isErrno(current, code))
            return true;
        current = current.cause;
    }
    return false;
}
function errorCode(error) {
    if (typeof error === 'object' && error !== null && typeof error.code === 'string') {
        return error.code;
    }
    return 'install_failed';
}