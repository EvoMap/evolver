import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { bindStableWindowsRecoveryController, inspectDurableSelfUpdate, markWindowsInstallApplied, provisionStableWindowsRecoveryController, recoverDurableSelfUpdate, rollbackDurableSelfUpdate, } from './transaction.js';
import { SELF_UPDATE_FAILURE_CODES } from './failureCodes.js';
import { bindWindowsManagedExecutable, resolveWindowsUpdaterPaths, WINDOWS_UPDATER_WORKER_ARG, } from './windowsUpdater.js';
export const WINDOWS_RECOVERY_CONTROLLER_ARG = '--evolver-windows-recovery-controller';
export const WINDOWS_RECOVERY_CONTROLLER_PROVISION_ARG = '--evolver-windows-recovery-controller-provision';
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const PENDING_CONTROLLER_STAGES = new Set(['installed', 'restarted', 'health_check_pending']);
const RECOVER_BEFORE_START_STAGES = new Set([
    'preparing',
    'downloaded',
    'verified',
    'backed_up',
    'install_pending',
    'rolling_back',
    'rollback_pending',
]);
const PENDING_SWAP_JOURNAL_STAGES = new Set([
    'install_pending',
    'restarted',
    'rolling_back',
    'rollback_pending',
]);
export async function maybeRunWindowsRecoveryController(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const command = argv.length === 2 && argv[0] === 'proxy' ? argv[1] : undefined;
    if (command !== WINDOWS_RECOVERY_CONTROLLER_ARG && command !== WINDOWS_RECOVERY_CONTROLLER_PROVISION_ARG) {
        return undefined;
    }
    if ((options.platform ?? process.platform) !== 'win32')
        return 64;
    try {
        if (command === WINDOWS_RECOVERY_CONTROLLER_PROVISION_ARG) {
            await provisionStableWindowsRecoveryController(options, options.processExecPath ?? process.execPath);
            return 0;
        }
        return await runWindowsRecoveryController(options);
    }
    catch {
        return 1;
    }
}
export async function runWindowsRecoveryController(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const processExecPath = options.processExecPath ?? process.execPath;
    const logger = options.logger ?? process.stderr;
    const confirmationTimeoutMs = positiveDuration(options.confirmationTimeoutMs, DEFAULT_CONFIRMATION_TIMEOUT_MS);
    const pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const stopTimeoutMs = positiveDuration(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    const spawnBoundTarget = options.spawnTarget ?? spawnTarget;
    const runBoundUpdaterWorker = options.runUpdaterWorker ?? runUpdaterWorker;
    const bound = await bindStableWindowsRecoveryController({ ...options, env, platform }, processExecPath);
    const transactionOptions = {
        ...options,
        env,
        platform,
        processExecPath,
        stateDir: bound.stateDir,
        targetPath: bound.targetPath,
        beforeJournalMutation: async () => {
            await bindStableWindowsRecoveryController({ ...options, env, platform }, processExecPath);
        },
    };
    let initial = await inspectDurableSelfUpdate(transactionOptions);
    if (initial.outcome === 'blocked') {
        logger.write('[evolver-windows-controller] recovery_blocked_before_start\n');
        return 1;
    }
    if (await pendingSwapExists(bound.stateDir)) {
        if (initial.stage === undefined || !PENDING_SWAP_JOURNAL_STAGES.has(initial.stage)) {
            logger.write('[evolver-windows-controller] pending_swap_blocked\n');
            return 1;
        }
        const workerExitCode = await executeBoundUpdaterWorker(runBoundUpdaterWorker, bound.stateDir, env);
        if (workerExitCode !== 0) {
            let rollback;
            try {
                rollback = await rollbackDurableSelfUpdate(transactionOptions, SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED);
                rollback = await completePreparedRollback(rollback, transactionOptions, bound.stateDir, env, runBoundUpdaterWorker);
            }
            catch {
                logger.write('[evolver-windows-controller] pending_swap_blocked\n');
                return 1;
            }
            if (rollback.outcome !== 'rolled_back') {
                logger.write('[evolver-windows-controller] pending_swap_blocked\n');
                return 1;
            }
            return launchRestoredTarget(bound.targetPath, env, spawnBoundTarget);
        }
        initial = await inspectDurableSelfUpdate(transactionOptions);
    }
    if (initial.stage === 'install_pending') {
        initial = await markWindowsInstallApplied(transactionOptions);
        if (initial.outcome === 'blocked') {
            logger.write('[evolver-windows-controller] install_not_applied\n');
            return 1;
        }
    }
    if (initial.outcome === 'blocked') {
        logger.write('[evolver-windows-controller] recovery_blocked_before_start\n');
        return 1;
    }
    if (initial.stage !== undefined && RECOVER_BEFORE_START_STAGES.has(initial.stage)) {
        initial = await recoverAndApplyRollback(transactionOptions, bound.stateDir, env, runBoundUpdaterWorker);
        if (initial.outcome === 'blocked' || initial.outcome === 'rollback_pending') {
            logger.write('[evolver-windows-controller] recovery_blocked_before_start\n');
            return 1;
        }
    }
    const pendingAtLaunch = isControllerPending(initial);
    const launched = spawnBoundTarget(bound.targetPath, env);
    const childExit = waitForNativeExit(launched);
    if (!pendingAtLaunch)
        return exitCode(await childExit);
    const deadline = Date.now() + confirmationTimeoutMs;
    for (;;) {
        const event = await Promise.race([
            childExit.then((exit) => ({ type: 'exit', exit })),
            delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
                .then(() => ({ type: 'poll' })),
        ]);
        let state;
        try {
            state = await inspectDurableSelfUpdate(transactionOptions);
        }
        catch {
            if (event.type === 'exit' || Date.now() >= deadline) {
                logger.write('[evolver-windows-controller] recovery_state_unavailable\n');
            }
            else {
                continue;
            }
        }
        if (state?.outcome === 'confirmed')
            return exitCode(await childExit);
        if (state?.outcome === 'blocked') {
            await stopNativeChild(launched, childExit, stopTimeoutMs);
            return 1;
        }
        if (state?.outcome === 'rolled_back') {
            await stopNativeChild(launched, childExit, stopTimeoutMs);
            return launchRestoredTarget(bound.targetPath, env, spawnBoundTarget);
        }
        if (event.type === 'exit' || Date.now() >= deadline) {
            await stopNativeChild(launched, childExit, stopTimeoutMs);
            let rollback;
            try {
                rollback = await rollbackDurableSelfUpdate(transactionOptions, event.type === 'exit'
                    ? SELF_UPDATE_FAILURE_CODES.RESTART_FAILED
                    : 'health_confirmation_timeout');
                rollback = await completePreparedRollback(rollback, transactionOptions, bound.stateDir, env, runBoundUpdaterWorker);
            }
            catch {
                logger.write('[evolver-windows-controller] rollback_blocked\n');
                return 1;
            }
            if (rollback.outcome === 'confirmed')
                return exitCode(await childExit);
            if (rollback.outcome !== 'rolled_back') {
                logger.write('[evolver-windows-controller] rollback_blocked\n');
                return 1;
            }
            return launchRestoredTarget(bound.targetPath, env, spawnBoundTarget);
        }
    }
}
async function recoverAndApplyRollback(options, stateDir, env, runBoundUpdaterWorker) {
    const recovery = await recoverDurableSelfUpdate(options);
    return completePreparedRollback(recovery, options, stateDir, env, runBoundUpdaterWorker);
}
async function completePreparedRollback(recovery, options, stateDir, env, runBoundUpdaterWorker) {
    if (recovery.outcome !== 'rollback_pending')
        return recovery;
    const workerExitCode = await executeBoundUpdaterWorker(runBoundUpdaterWorker, stateDir, env);
    if (workerExitCode !== 0) {
        return { ...recovery, outcome: 'blocked', failureCode: 'rollback_apply_failed' };
    }
    return recoverDurableSelfUpdate(options);
}
async function pendingSwapExists(stateDir) {
    const pendingPath = resolveWindowsUpdaterPaths(stateDir).pendingPath;
    try {
        const info = await lstat(pendingPath);
        if (info.isSymbolicLink() || !info.isFile())
            throw new Error('windows_controller_pending_unsafe');
        return true;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return false;
        throw error;
    }
}
function isControllerPending(state) {
    return state.stage !== undefined && PENDING_CONTROLLER_STAGES.has(state.stage);
}
function spawnTarget(targetPath, env) {
    return spawn(targetPath, ['proxy'], {
        env,
        stdio: 'inherit',
        windowsHide: true,
    });
}
async function runUpdaterWorker(workerPath, _stateDir, env) {
    return exitCode(await waitForNativeExit(spawn(workerPath, ['proxy', WINDOWS_UPDATER_WORKER_ARG], {
        env,
        stdio: 'inherit',
        windowsHide: true,
    })));
}
async function executeBoundUpdaterWorker(runner, stateDir, env) {
    const paths = resolveWindowsUpdaterPaths(stateDir);
    const bound = await bindWindowsManagedExecutable({
        stateDir,
        executablePath: paths.helperPath,
        relativePath: ['windows-updater', 'updater.exe'],
        label: 'controller_worker',
        platform: 'win32',
    });
    const workerEnv = { ...env, EVOLVER_SELF_UPDATE_STATE_DIR: bound.stateDir };
    return runner(bound.executablePath, bound.stateDir, workerEnv);
}
async function launchRestoredTarget(targetPath, env, spawnBoundTarget) {
    return exitCode(await waitForNativeExit(spawnBoundTarget(targetPath, env)));
}
function waitForNativeExit(child) {
    return new Promise((resolve) => {
        child.once('error', (error) => { resolve({ code: null, signal: null, error }); });
        child.once('exit', (code, signal) => { resolve({ code, signal }); });
    });
}
async function stopNativeChild(child, exit, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    child.kill('SIGTERM');
    const stopped = await Promise.race([
        exit.then(() => true),
        delay(timeoutMs).then(() => false),
    ]);
    if (!stopped) {
        child.kill('SIGKILL');
        await exit;
    }
}
function exitCode(exit) {
    if (exit.error)
        return 1;
    if (exit.code !== null)
        return exit.code;
    return exit.signal === null ? 1 : 128 + signalNumber(exit.signal);
}
function signalNumber(signal) {
    if (signal === 'SIGINT')
        return 2;
    if (signal === 'SIGTERM')
        return 15;
    if (signal === 'SIGKILL')
        return 9;
    return 1;
}
function positiveDuration(value, fallback) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}