import { spawn } from 'node:child_process';
import { bindStableUnixRecoveryController, inspectDurableSelfUpdate, recoverDurableSelfUpdate, rollbackDurableSelfUpdate, } from './transaction.js';
import { SELF_UPDATE_FAILURE_CODES } from './failureCodes.js';
export const UNIX_RECOVERY_CONTROLLER_ARG = '--evolver-unix-recovery-controller';
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const PENDING_CONTROLLER_STAGES = new Set(['installed', 'restarted', 'health_check_pending']);
const RECOVER_BEFORE_START_STAGES = new Set([
    'preparing',
    'downloaded',
    'verified',
    'backed_up',
    'rolling_back',
    'rollback_pending',
]);
export async function maybeRunUnixRecoveryController(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== 'proxy' || argv[1] !== UNIX_RECOVERY_CONTROLLER_ARG)
        return undefined;
    if ((options.platform ?? process.platform) === 'win32') {
        throw new Error('unix_recovery_controller_unsupported_platform');
    }
    return runUnixRecoveryController(options);
}
export async function runUnixRecoveryController(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const processExecPath = options.processExecPath ?? process.execPath;
    const logger = options.logger ?? process.stderr;
    const confirmationTimeoutMs = positiveDuration(options.confirmationTimeoutMs, DEFAULT_CONFIRMATION_TIMEOUT_MS);
    const pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const stopTimeoutMs = positiveDuration(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    const transactionOptions = { ...options, env, platform, processExecPath };
    const { targetPath } = await bindStableUnixRecoveryController(transactionOptions, processExecPath);
    let initial = await inspectDurableSelfUpdate(transactionOptions);
    if (initial.outcome === 'blocked' || initial.stage === 'install_pending') {
        logger.write('[evolver-controller] recovery_blocked_before_start\n');
        return 1;
    }
    if (initial.stage !== undefined && RECOVER_BEFORE_START_STAGES.has(initial.stage)) {
        initial = await recoverDurableSelfUpdate(transactionOptions);
        if (initial.outcome === 'blocked') {
            logger.write('[evolver-controller] recovery_blocked_before_start\n');
            return 1;
        }
    }
    const pendingAtLaunch = isControllerPending(initial);
    let child;
    let stoppingSignal;
    const forwardSignal = (signal) => {
        stoppingSignal = signal;
        child?.kill(signal);
    };
    const onSigterm = () => { forwardSignal('SIGTERM'); };
    const onSigint = () => { forwardSignal('SIGINT'); };
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    try {
        const launched = spawn(targetPath, ['proxy'], {
            env,
            stdio: 'inherit',
            windowsHide: true,
        });
        child = launched;
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
            if (stoppingSignal) {
                await stopNativeChild(launched, childExit, stopTimeoutMs);
                let rollback;
                try {
                    rollback = await rollbackDurableSelfUpdate(transactionOptions, 'controller_stopped_during_health_check');
                }
                catch {
                    logger.write('[evolver-controller] rollback_blocked\n');
                    return 1;
                }
                if (rollback.outcome !== 'rolled_back' && rollback.outcome !== 'confirmed') {
                    logger.write('[evolver-controller] rollback_blocked\n');
                    return 1;
                }
                return 128 + signalNumber(stoppingSignal);
            }
            let state;
            try {
                state = await inspectDurableSelfUpdate(transactionOptions);
            }
            catch {
                if (event.type === 'exit' || Date.now() >= deadline) {
                    logger.write('[evolver-controller] recovery_state_unavailable\n');
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
                child = spawnTarget(targetPath, env);
                return exitCode(await waitForNativeExit(child));
            }
            if (event.type === 'exit' || Date.now() >= deadline) {
                await stopNativeChild(launched, childExit, stopTimeoutMs);
                const rollback = await rollbackDurableSelfUpdate(transactionOptions, event.type === 'exit'
                    ? SELF_UPDATE_FAILURE_CODES.RESTART_FAILED
                    : 'health_confirmation_timeout');
                if (rollback.outcome !== 'rolled_back' && rollback.outcome !== 'confirmed') {
                    logger.write('[evolver-controller] rollback_blocked\n');
                    return 1;
                }
                if (rollback.outcome === 'confirmed')
                    return exitCode(await childExit);
                child = spawnTarget(targetPath, env);
                return exitCode(await waitForNativeExit(child));
            }
        }
    }
    finally {
        process.off('SIGTERM', onSigterm);
        process.off('SIGINT', onSigint);
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