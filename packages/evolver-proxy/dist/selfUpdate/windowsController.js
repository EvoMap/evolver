import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { bindStableWindowsRecoveryController, inspectDurableSelfUpdate, markWindowsInstallApplied, provisionStableWindowsRecoveryController, recoverDurableSelfUpdate, rollbackDurableSelfUpdate, } from './transaction.js';
import { SELF_UPDATE_FAILURE_CODES } from './failureCodes.js';
import { revalidatePendingWindowsUpdaterHelper, resolveWindowsUpdaterPaths, WINDOWS_UPDATER_WORKER_ARG, } from './windowsUpdater.js';
import { resolveRecoveryControllerAuthority, } from './controllerLifecycleAuthority.js';
import { DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS, deliverRecoveryChildStartGate, RECOVERY_CHILD_START_GATE_ENV, } from './recoveryChildStartGate.js';
export const WINDOWS_RECOVERY_CONTROLLER_ARG = '--evolver-windows-recovery-controller';
export const WINDOWS_RECOVERY_CONTROLLER_PROVISION_ARG = '--evolver-windows-recovery-controller-provision';
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_WORKER_TIMEOUT_MS = 120_000;
// The child performs up to three native owner-identity probes before acknowledging. Each
// PowerShell-backed Windows probe has its own 15s budget, so keep enough headroom for CI hosts.
const DEFAULT_STARTUP_ATTESTATION_TIMEOUT_MS = 120_000;
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
class NativeChildTerminationUnconfirmedError extends Error {
    child;
    exit;
    constructor(child, exit) {
        super('windows_updater_worker_termination_unconfirmed');
        this.child = child;
        this.exit = exit;
    }
}
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
            await provisionStableWindowsRecoveryController({
                ...options,
                replaceExisting: options.env?.['EVOLVER_INTERNAL_BOOTSTRAP_EXCLUSIVE'] !== '1',
            }, options.processExecPath ?? process.execPath);
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
    const workerTimeoutMs = positiveDuration(options.workerTimeoutMs, DEFAULT_WORKER_TIMEOUT_MS);
    const startupGateTimeoutMs = positiveDuration(options.startupGateTimeoutMs, DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS);
    const startupAttestationTimeoutMs = positiveDuration(options.startupAttestationTimeoutMs, DEFAULT_STARTUP_ATTESTATION_TIMEOUT_MS);
    const spawnBoundTarget = options.spawnTarget ?? spawnTarget;
    let authority;
    const bindingOptions = { ...options, env, platform };
    const bound = await bindStableWindowsRecoveryController(bindingOptions, processExecPath);
    const transactionOptions = {
        ...options,
        env,
        platform,
        processExecPath,
        stateDir: bound.stateDir,
        targetPath: bound.targetPath,
        beforeJournalMutation: async () => {
            assertOwnedRecoveryAuthority(authority);
            await options.beforeJournalMutation?.();
            await revalidateBoundWindowsController(bindingOptions, processExecPath, bound, authority);
            assertOwnedRecoveryAuthority(authority);
        },
    };
    const observed = await inspectDurableSelfUpdate(transactionOptions);
    if (observed.outcome === 'blocked') {
        logger.write('[evolver-windows-controller] recovery_blocked_before_start\n');
        return 1;
    }
    let child;
    let childExit;
    let releaseAttempted = false;
    const guardUnconfirmedChild = async (_target, exit) => {
        logger.write('[evolver-windows-controller] child_termination_unconfirmed\n');
        if (authority?.kind === 'owned') {
            try {
                authority.retainProcess();
                logger.write('[evolver-windows-controller] child_guardian_active\n');
                return;
            }
            catch {
                logger.write('[evolver-windows-controller] child_guardian_retain_failed\n');
            }
        }
        // Without a verifiable PID generation there is no safe lock handoff. Keep this live owner
        // until exact exit instead of returning a dead-owner lock that another process could reclaim.
        await exit;
    };
    const armBoundChild = (target) => {
        if (authority?.kind !== 'owned')
            return;
        if (target.pid === undefined) {
            throw new Error('self_update_recovery_controller_child_pid_unavailable');
        }
        authority.armProcess(target.pid);
    };
    const disarmBoundChild = () => {
        if (authority?.kind === 'owned')
            authority.disarmProcess();
    };
    const stopBoundChild = async (target, exit) => {
        const stopped = await stopNativeChild(target, exit, stopTimeoutMs);
        if (!stopped) {
            await guardUnconfirmedChild(target, exit);
        }
        else {
            disarmBoundChild();
        }
        return stopped;
    };
    const runBoundUpdaterWorker = options.runUpdaterWorker
        ?? ((workerPath, stateDir, workerEnv, startupGateToken) => runUpdaterWorker(workerPath, stateDir, workerEnv, startupGateToken, workerTimeoutMs, stopTimeoutMs, startupGateTimeoutMs, armBoundChild, disarmBoundChild, () => { assertOwnedRecoveryAuthority(authority); }, options.spawnUpdaterWorker ?? spawnUpdaterWorker));
    const releaseAuthority = async () => {
        if (!authority || releaseAttempted)
            return true;
        releaseAttempted = true;
        try {
            authority.release();
            return true;
        }
        catch {
            logger.write('[evolver-windows-controller] lifecycle_authority_release_failed\n');
            if (child && childExit)
                await stopBoundChild(child, childExit);
            return false;
        }
    };
    const launchTerminalTarget = async () => {
        await revalidateBoundWindowsController(bindingOptions, processExecPath, bound, authority);
        authority.assertAuthorized();
        const prepared = authority.prepareTarget(env);
        const launched = spawnBoundTarget(bound.targetPath, prepared.env, prepared.startupAckToken !== undefined);
        child = launched;
        const launchedExit = waitForNativeExit(launched);
        childExit = launchedExit;
        const spawned = waitForNativeSpawn(launched);
        try {
            // Node publishes the native PID synchronously when spawn succeeds. Arm the guardian before
            // the first await so a hard controller crash cannot expose a stale parent-owner lock.
            armBoundChild(launched);
        }
        catch {
            logger.write('[evolver-windows-controller] child_guardian_arm_failed\n');
            if (await spawned)
                await stopBoundChild(launched, launchedExit);
            await releaseAuthority();
            return 1;
        }
        if (!await spawned) {
            disarmBoundChild();
            await releaseAuthority();
            return 1;
        }
        authority.assertAuthorized();
        if (!await deliverRecoveryChildStartGate(launched, prepared.startupGateToken, startupGateTimeoutMs)) {
            logger.write('[evolver-windows-controller] startup_gate_failed\n');
            await stopBoundChild(launched, launchedExit);
            await releaseAuthority();
            return 1;
        }
        if (prepared.startupAckToken
            && !await waitForStartupAttestation(launched, prepared.startupAckToken, startupAttestationTimeoutMs)) {
            logger.write('[evolver-windows-controller] startup_attestation_failed\n');
            await stopBoundChild(launched, launchedExit);
            await releaseAuthority();
            return 1;
        }
        if (!await releaseAuthority())
            return 1;
        return exitCode(await launchedExit);
    };
    try {
        authority = await resolveRecoveryControllerAuthority(env, options.lifecycleAuthority);
        await revalidateBoundWindowsController(bindingOptions, processExecPath, bound, authority);
        let initial = await inspectDurableSelfUpdate(transactionOptions);
        if (initial.outcome === 'blocked') {
            logger.write('[evolver-windows-controller] recovery_blocked_before_start\n');
            return 1;
        }
        if (authority.kind === 'delegated' && !stateAllowsDelegatedSpawn(initial)) {
            logger.write('[evolver-windows-controller] lifecycle_authority_blocked\n');
            return 1;
        }
        if (await pendingSwapExists(bound.stateDir)) {
            if (initial.stage === undefined || !PENDING_SWAP_JOURNAL_STAGES.has(initial.stage)) {
                logger.write('[evolver-windows-controller] pending_swap_blocked\n');
                return 1;
            }
            assertOwnedRecoveryAuthority(authority);
            const workerExitCode = await executeBoundUpdaterWorker(runBoundUpdaterWorker, bound.stateDir, env, authority, options.assertUpdaterHelperTrust);
            assertOwnedRecoveryAuthority(authority);
            if (workerExitCode !== 0) {
                let rollback;
                try {
                    rollback = await rollbackDurableSelfUpdate(transactionOptions, SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED);
                    rollback = await completePreparedRollback(rollback, transactionOptions, bound.stateDir, env, runBoundUpdaterWorker, authority, options.assertUpdaterHelperTrust);
                }
                catch {
                    logger.write('[evolver-windows-controller] pending_swap_blocked\n');
                    return 1;
                }
                if (rollback.outcome !== 'rolled_back') {
                    logger.write('[evolver-windows-controller] pending_swap_blocked\n');
                    return 1;
                }
                return await launchTerminalTarget();
            }
            initial = await inspectDurableSelfUpdate(transactionOptions);
        }
        if (initial.stage === 'install_pending') {
            assertOwnedRecoveryAuthority(authority);
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
            assertOwnedRecoveryAuthority(authority);
            initial = await recoverAndApplyRollback(transactionOptions, bound.stateDir, env, runBoundUpdaterWorker, authority, options.assertUpdaterHelperTrust);
            if (initial.outcome === 'blocked' || initial.outcome === 'rollback_pending') {
                logger.write('[evolver-windows-controller] recovery_blocked_before_start\n');
                return 1;
            }
        }
        const pendingAtLaunch = isControllerPending(initial);
        if (!pendingAtLaunch)
            return await launchTerminalTarget();
        await revalidateBoundWindowsController(bindingOptions, processExecPath, bound, authority);
        assertOwnedRecoveryAuthority(authority);
        const prepared = authority.prepareTarget(env);
        const launched = spawnBoundTarget(bound.targetPath, prepared.env, prepared.startupAckToken !== undefined);
        child = launched;
        const launchedExit = waitForNativeExit(launched);
        childExit = launchedExit;
        const spawned = waitForNativeSpawn(launched);
        try {
            // Arm before yielding for the same hard-crash boundary as terminal launches.
            armBoundChild(launched);
        }
        catch {
            logger.write('[evolver-windows-controller] child_guardian_arm_failed\n');
            if (await spawned)
                await stopBoundChild(launched, launchedExit);
            await releaseAuthority();
            return 1;
        }
        if (!await spawned) {
            disarmBoundChild();
            await releaseAuthority();
            return 1;
        }
        authority.assertAuthorized();
        const startupGateAccepted = await deliverRecoveryChildStartGate(launched, prepared.startupGateToken, startupGateTimeoutMs);
        if (!startupGateAccepted) {
            logger.write('[evolver-windows-controller] startup_gate_failed\n');
        }
        if (!startupGateAccepted || (prepared.startupAckToken
            && !await waitForStartupAttestation(launched, prepared.startupAckToken, startupAttestationTimeoutMs))) {
            if (!await stopBoundChild(launched, launchedExit))
                return 1;
            let rollback = await rollbackDurableSelfUpdate(transactionOptions, SELF_UPDATE_FAILURE_CODES.RESTART_FAILED);
            rollback = await completePreparedRollback(rollback, transactionOptions, bound.stateDir, env, runBoundUpdaterWorker, authority, options.assertUpdaterHelperTrust);
            if (rollback.outcome === 'confirmed') {
                if (!await releaseAuthority())
                    return 1;
                return exitCode(await launchedExit);
            }
            if (rollback.outcome !== 'rolled_back') {
                logger.write('[evolver-windows-controller] startup_attestation_failed\n');
                return 1;
            }
            child = undefined;
            childExit = undefined;
            return await launchTerminalTarget();
        }
        const deadline = Date.now() + confirmationTimeoutMs;
        for (;;) {
            const event = await Promise.race([
                launchedExit.then((exit) => ({ type: 'exit', exit })),
                delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
                    .then(() => ({ type: 'poll' })),
            ]);
            assertOwnedRecoveryAuthority(authority);
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
            if (state?.outcome === 'confirmed') {
                if (!await releaseAuthority())
                    return 1;
                return exitCode(await launchedExit);
            }
            if (state?.outcome === 'blocked') {
                await stopBoundChild(launched, launchedExit);
                return 1;
            }
            if (state?.outcome === 'rolled_back') {
                if (!await stopBoundChild(launched, launchedExit))
                    return 1;
                child = undefined;
                childExit = undefined;
                return await launchTerminalTarget();
            }
            if (event.type === 'exit' || Date.now() >= deadline) {
                if (!await stopBoundChild(launched, launchedExit))
                    return 1;
                let rollback;
                try {
                    rollback = await rollbackDurableSelfUpdate(transactionOptions, event.type === 'exit'
                        ? SELF_UPDATE_FAILURE_CODES.RESTART_FAILED
                        : 'health_confirmation_timeout');
                    rollback = await completePreparedRollback(rollback, transactionOptions, bound.stateDir, env, runBoundUpdaterWorker, authority, options.assertUpdaterHelperTrust);
                }
                catch {
                    logger.write('[evolver-windows-controller] rollback_blocked\n');
                    return 1;
                }
                if (rollback.outcome === 'confirmed') {
                    if (!await releaseAuthority())
                        return 1;
                    return exitCode(await launchedExit);
                }
                if (rollback.outcome !== 'rolled_back') {
                    logger.write('[evolver-windows-controller] rollback_blocked\n');
                    return 1;
                }
                child = undefined;
                childExit = undefined;
                return await launchTerminalTarget();
            }
        }
    }
    catch (error) {
        if (error instanceof NativeChildTerminationUnconfirmedError) {
            await guardUnconfirmedChild(error.child, error.exit);
        }
        logger.write('[evolver-windows-controller] lifecycle_authority_blocked\n');
        if (child && childExit)
            await stopBoundChild(child, childExit);
        await releaseAuthority();
        return 1;
    }
    finally {
        if (!releaseAttempted)
            await releaseAuthority();
    }
}
async function recoverAndApplyRollback(options, stateDir, env, runBoundUpdaterWorker, authority, assertUpdaterHelperTrust) {
    assertOwnedRecoveryAuthority(authority);
    const recovery = await recoverDurableSelfUpdate(options);
    return completePreparedRollback(recovery, options, stateDir, env, runBoundUpdaterWorker, authority, assertUpdaterHelperTrust);
}
async function completePreparedRollback(recovery, options, stateDir, env, runBoundUpdaterWorker, authority, assertUpdaterHelperTrust) {
    if (recovery.outcome !== 'rollback_pending')
        return recovery;
    const workerExitCode = await executeBoundUpdaterWorker(runBoundUpdaterWorker, stateDir, env, authority, assertUpdaterHelperTrust);
    if (workerExitCode !== 0) {
        return { ...recovery, outcome: 'blocked', failureCode: 'rollback_apply_failed' };
    }
    assertOwnedRecoveryAuthority(authority);
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
function stateAllowsDelegatedSpawn(state) {
    return state.outcome === 'none'
        || state.outcome === 'confirmed'
        || state.outcome === 'rolled_back';
}
function assertOwnedRecoveryAuthority(authority) {
    if (authority?.kind !== 'owned') {
        throw new Error('self_update_recovery_controller_owner_lease_required');
    }
    authority.assertAuthorized();
}
async function revalidateBoundWindowsController(options, processExecPath, expected, authority) {
    authority.assertAuthorized();
    const actual = await bindStableWindowsRecoveryController(options, processExecPath);
    if (actual.controllerPath !== expected.controllerPath
        || actual.stateDir !== expected.stateDir
        || actual.targetPath !== expected.targetPath) {
        throw new Error('self_update_windows_recovery_controller_binding_changed');
    }
    authority.assertAuthorized();
}
function spawnTarget(targetPath, env, startupAttestation) {
    const startupGate = env[RECOVERY_CHILD_START_GATE_ENV] !== undefined;
    return spawn(targetPath, ['proxy'], {
        env,
        stdio: startupGate
            ? ['inherit', 'inherit', 'inherit', startupAttestation ? 'pipe' : 'ignore', 'pipe']
            : startupAttestation
                ? ['inherit', 'inherit', 'inherit', 'pipe']
                : 'inherit',
        windowsHide: true,
    });
}
async function runUpdaterWorker(workerPath, _stateDir, env, startupGateToken, timeoutMs, stopTimeoutMs, startupGateTimeoutMs, armChild, disarmChild, assertChildAuthority, spawnWorker) {
    const child = spawnWorker(workerPath, env);
    const exit = waitForNativeExit(child);
    const spawned = waitForNativeSpawn(child);
    try {
        // Protect the updater PID generation before yielding to its spawn event.
        armChild(child);
    }
    catch {
        if (await spawned && !await stopNativeChild(child, exit, stopTimeoutMs)) {
            throw new NativeChildTerminationUnconfirmedError(child, exit);
        }
        throw new Error('windows_updater_worker_guardian_arm_failed');
    }
    if (!await spawned) {
        disarmChild();
        return 1;
    }
    try {
        assertChildAuthority();
    }
    catch {
        if (!await stopNativeChild(child, exit, stopTimeoutMs)) {
            throw new NativeChildTerminationUnconfirmedError(child, exit);
        }
        try {
            disarmChild();
        }
        catch {
            // The lost authority remains the primary failure.
        }
        throw new Error('windows_updater_worker_authority_lost_before_start_gate');
    }
    if (!await deliverRecoveryChildStartGate(child, startupGateToken, startupGateTimeoutMs)) {
        if (!await stopNativeChild(child, exit, stopTimeoutMs)) {
            throw new NativeChildTerminationUnconfirmedError(child, exit);
        }
        disarmChild();
        return 1;
    }
    const event = await Promise.race([
        exit.then((result) => ({ type: 'exit', result })),
        delay(timeoutMs).then(() => ({ type: 'timeout' })),
    ]);
    if (event.type === 'exit') {
        disarmChild();
        return exitCode(event.result);
    }
    if (!await stopNativeChild(child, exit, stopTimeoutMs)) {
        throw new NativeChildTerminationUnconfirmedError(child, exit);
    }
    disarmChild();
    return 1;
}
function spawnUpdaterWorker(workerPath, env) {
    return spawn(workerPath, ['proxy', WINDOWS_UPDATER_WORKER_ARG], {
        env,
        stdio: ['inherit', 'inherit', 'inherit', 'ignore', 'pipe'],
        windowsHide: true,
    });
}
async function executeBoundUpdaterWorker(runner, stateDir, env, authority, assertUpdaterHelperTrust) {
    assertOwnedRecoveryAuthority(authority);
    const workerEnv = { ...env, EVOLVER_SELF_UPDATE_STATE_DIR: stateDir };
    const prepared = authority.prepareWorker(workerEnv);
    assertOwnedRecoveryAuthority(authority);
    const paths = resolveWindowsUpdaterPaths(stateDir);
    const bound = await revalidatePendingWindowsUpdaterHelper({
        stateDir,
        helperPath: paths.helperPath,
        platform: 'win32',
        ...(assertUpdaterHelperTrust ? { assertHelperTrust: assertUpdaterHelperTrust } : {}),
    });
    assertOwnedRecoveryAuthority(authority);
    const result = await runner(bound.executablePath, bound.stateDir, prepared.env, prepared.startupGateToken);
    assertOwnedRecoveryAuthority(authority);
    return result;
}
function waitForNativeExit(child) {
    return new Promise((resolve) => {
        let spawned = child.pid !== undefined;
        const cleanup = () => {
            child.off('spawn', onSpawn);
            child.off('error', onError);
        };
        const onSpawn = () => { spawned = true; };
        const onError = (error) => {
            // A post-spawn process error does not prove that the native child exited.
            if (spawned)
                return;
            cleanup();
            resolve({ code: null, signal: null, error });
        };
        child.once('spawn', onSpawn);
        child.on('error', onError);
        child.once('exit', (code, signal) => {
            cleanup();
            resolve({ code, signal });
        });
    });
}
function waitForNativeSpawn(child) {
    if (child.pid !== undefined)
        return Promise.resolve(true);
    return new Promise((resolve) => {
        const finish = (spawned) => {
            child.off('spawn', onSpawn);
            child.off('error', onError);
            resolve(spawned);
        };
        const onSpawn = () => { finish(true); };
        const onError = () => { finish(false); };
        child.once('spawn', onSpawn);
        child.once('error', onError);
    });
}
function waitForStartupAttestation(child, token, timeoutMs) {
    const stream = child.stdio[3];
    if (!stream || typeof stream.on !== 'function')
        return Promise.resolve(false);
    const readable = stream;
    const expected = `${token}\n`;
    return new Promise((resolve) => {
        let raw = '';
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            readable.off('data', onData);
            readable.off('end', onEnd);
            readable.off('error', onError);
            resolve(result);
        };
        const onData = (chunk) => {
            raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
            if (Buffer.byteLength(raw, 'utf8') > 128 || !expected.startsWith(raw))
                finish(false);
        };
        const onEnd = () => { finish(raw === expected); };
        const onError = () => { finish(false); };
        const timer = setTimeout(() => { finish(false); }, timeoutMs);
        readable.on('data', onData);
        readable.once('end', onEnd);
        readable.once('error', onError);
    });
}
async function stopNativeChild(child, exit, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return true;
    try {
        child.kill('SIGTERM');
    }
    catch {
        // A failed signal is not an exit; the bounded native-exit wait remains authoritative.
    }
    const stopped = await Promise.race([
        exit.then(() => true),
        delay(timeoutMs).then(() => false),
    ]);
    if (!stopped) {
        try {
            child.kill('SIGKILL');
        }
        catch {
            // A failed signal is not an exit; the second bounded wait still protects authority.
        }
        return Promise.race([
            exit.then(() => true),
            delay(timeoutMs).then(() => false),
        ]);
    }
    return true;
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