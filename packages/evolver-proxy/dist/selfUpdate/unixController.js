import { spawn } from 'node:child_process';
import { bindStableUnixRecoveryController, inspectDurableSelfUpdate, recoverDurableSelfUpdate, rollbackDurableSelfUpdate, } from './transaction.js';
import { SELF_UPDATE_FAILURE_CODES } from './failureCodes.js';
import { resolveRecoveryControllerAuthority, } from './controllerLifecycleAuthority.js';
import { DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS, deliverRecoveryChildStartGate, RECOVERY_CHILD_START_GATE_ENV, } from './recoveryChildStartGate.js';
export const UNIX_RECOVERY_CONTROLLER_ARG = '--evolver-unix-recovery-controller';
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
// The child performs up to three native owner-identity probes before acknowledging. On Windows
// each PowerShell-backed probe has its own 15s budget, so keep enough headroom for a loaded host.
const DEFAULT_STARTUP_ATTESTATION_TIMEOUT_MS = 120_000;
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
    const startupGateTimeoutMs = positiveDuration(options.startupGateTimeoutMs, DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS);
    const startupAttestationTimeoutMs = positiveDuration(options.startupAttestationTimeoutMs, DEFAULT_STARTUP_ATTESTATION_TIMEOUT_MS);
    const spawnBoundTarget = options.spawnTarget ?? spawnTarget;
    let authority;
    const baseTransactionOptions = {
        ...options,
        env,
        platform,
        processExecPath,
    };
    const bound = await bindStableUnixRecoveryController(baseTransactionOptions, processExecPath);
    const transactionOptions = {
        ...baseTransactionOptions,
        beforeJournalMutation: async () => {
            assertOwnedRecoveryAuthority(authority);
            await options.beforeJournalMutation?.();
            await revalidateBoundUnixController(baseTransactionOptions, processExecPath, bound, authority);
            assertOwnedRecoveryAuthority(authority);
        },
    };
    const observed = await inspectDurableSelfUpdate(transactionOptions);
    if (observed.outcome === 'blocked' || observed.stage === 'install_pending') {
        logger.write('[evolver-controller] recovery_blocked_before_start\n');
        return 1;
    }
    let child;
    let childExit;
    let stoppingSignal;
    let releaseAttempted = false;
    const forwardSignal = (signal) => {
        stoppingSignal = signal;
        child?.kill(signal);
    };
    const onSigterm = () => { forwardSignal('SIGTERM'); };
    const onSigint = () => { forwardSignal('SIGINT'); };
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    const guardUnconfirmedChild = async (_target, exit) => {
        logger.write('[evolver-controller] child_termination_unconfirmed\n');
        if (authority?.kind === 'owned') {
            try {
                authority.retainProcess();
                logger.write('[evolver-controller] child_guardian_active\n');
                return;
            }
            catch {
                logger.write('[evolver-controller] child_guardian_retain_failed\n');
            }
        }
        // Without a verifiable PID generation there is no safe lock handoff. Keep this live owner
        // until exact exit instead of returning a dead-owner lock that another process could reclaim.
        await exit;
    };
    const armBoundChild = (target) => {
        if (authority?.kind !== 'owned')
            return true;
        if (target.pid === undefined) {
            logger.write('[evolver-controller] child_guardian_arm_failed\n');
            return false;
        }
        try {
            authority.armProcess(target.pid);
            return true;
        }
        catch {
            logger.write('[evolver-controller] child_guardian_arm_failed\n');
            return false;
        }
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
    const releaseAuthority = async () => {
        if (!authority || releaseAttempted)
            return true;
        releaseAttempted = true;
        try {
            authority.release();
            return true;
        }
        catch {
            logger.write('[evolver-controller] lifecycle_authority_release_failed\n');
            if (child && childExit)
                await stopBoundChild(child, childExit);
            return false;
        }
    };
    const launchTerminalTarget = async () => {
        await revalidateBoundUnixController(baseTransactionOptions, processExecPath, bound, authority);
        if (stoppingSignal) {
            if (!await releaseAuthority())
                return 1;
            return 128 + signalNumber(stoppingSignal);
        }
        authority.assertAuthorized();
        const prepared = authority.prepareTarget(env);
        const launched = spawnBoundTarget(bound.targetPath, prepared.env, prepared.startupAckToken !== undefined);
        child = launched;
        childExit = waitForNativeExit(launched);
        const spawned = waitForNativeSpawn(launched);
        // Node publishes the native PID synchronously when spawn succeeds. Arm the guardian before
        // the first await so a hard controller crash cannot expose a stale-reclaimable parent lock.
        if (!armBoundChild(launched)) {
            if (await spawned)
                await stopBoundChild(launched, childExit);
            await releaseAuthority();
            return 1;
        }
        if (!await spawned) {
            disarmBoundChild();
            await releaseAuthority();
            return 1;
        }
        if (stoppingSignal) {
            if (!await stopBoundChild(launched, childExit))
                return 1;
            if (!await releaseAuthority())
                return 1;
            return 128 + signalNumber(stoppingSignal);
        }
        authority.assertAuthorized();
        if (!await deliverRecoveryChildStartGate(launched, prepared.startupGateToken, startupGateTimeoutMs)) {
            logger.write('[evolver-controller] startup_gate_failed\n');
            await stopBoundChild(launched, childExit);
            await releaseAuthority();
            return 1;
        }
        if (prepared.startupAckToken
            && !await waitForStartupAttestation(launched, prepared.startupAckToken, startupAttestationTimeoutMs)) {
            logger.write('[evolver-controller] startup_attestation_failed\n');
            await stopBoundChild(launched, childExit);
            await releaseAuthority();
            return 1;
        }
        if (!await releaseAuthority())
            return 1;
        return exitCode(await childExit);
    };
    try {
        authority = await resolveRecoveryControllerAuthority(env, options.lifecycleAuthority);
        await revalidateBoundUnixController(baseTransactionOptions, processExecPath, bound, authority);
        let initial = await inspectDurableSelfUpdate(transactionOptions);
        if (initial.outcome === 'blocked' || initial.stage === 'install_pending') {
            logger.write('[evolver-controller] recovery_blocked_before_start\n');
            return 1;
        }
        if (authority.kind === 'delegated' && !stateAllowsDelegatedSpawn(initial)) {
            logger.write('[evolver-controller] lifecycle_authority_blocked\n');
            return 1;
        }
        if (stoppingSignal) {
            if (!await releaseAuthority())
                return 1;
            return 128 + signalNumber(stoppingSignal);
        }
        if (initial.stage !== undefined && RECOVER_BEFORE_START_STAGES.has(initial.stage)) {
            assertOwnedRecoveryAuthority(authority);
            initial = await recoverDurableSelfUpdate(transactionOptions);
            if (initial.outcome === 'blocked') {
                logger.write('[evolver-controller] recovery_blocked_before_start\n');
                return 1;
            }
        }
        const pendingAtLaunch = isControllerPending(initial);
        if (!pendingAtLaunch)
            return await launchTerminalTarget();
        await revalidateBoundUnixController(baseTransactionOptions, processExecPath, bound, authority);
        if (stoppingSignal) {
            if (!await releaseAuthority())
                return 1;
            return 128 + signalNumber(stoppingSignal);
        }
        assertOwnedRecoveryAuthority(authority);
        const prepared = authority.prepareTarget(env);
        const launched = spawnBoundTarget(bound.targetPath, prepared.env, prepared.startupAckToken !== undefined);
        child = launched;
        childExit = waitForNativeExit(launched);
        const spawned = waitForNativeSpawn(launched);
        // Arm before yielding for the same hard-crash boundary as terminal launches.
        if (!armBoundChild(launched)) {
            if (await spawned)
                await stopBoundChild(launched, childExit);
            await releaseAuthority();
            return 1;
        }
        if (!await spawned) {
            disarmBoundChild();
            await releaseAuthority();
            return 1;
        }
        if (stoppingSignal) {
            if (!await stopBoundChild(launched, childExit))
                return 1;
            if (!await releaseAuthority())
                return 1;
            return 128 + signalNumber(stoppingSignal);
        }
        authority.assertAuthorized();
        const startupGateAccepted = await deliverRecoveryChildStartGate(launched, prepared.startupGateToken, startupGateTimeoutMs);
        if (!startupGateAccepted) {
            logger.write('[evolver-controller] startup_gate_failed\n');
        }
        if (!startupGateAccepted || (prepared.startupAckToken
            && !await waitForStartupAttestation(launched, prepared.startupAckToken, startupAttestationTimeoutMs))) {
            if (!await stopBoundChild(launched, childExit))
                return 1;
            const rollback = await rollbackDurableSelfUpdate(transactionOptions, SELF_UPDATE_FAILURE_CODES.RESTART_FAILED);
            if (rollback.outcome === 'confirmed') {
                if (!await releaseAuthority())
                    return 1;
                return exitCode(await childExit);
            }
            if (rollback.outcome !== 'rolled_back') {
                logger.write('[evolver-controller] startup_attestation_failed\n');
                return 1;
            }
            child = undefined;
            childExit = undefined;
            return await launchTerminalTarget();
        }
        const deadline = Date.now() + confirmationTimeoutMs;
        for (;;) {
            const event = await Promise.race([
                childExit.then((exit) => ({ type: 'exit', exit })),
                delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
                    .then(() => ({ type: 'poll' })),
            ]);
            assertOwnedRecoveryAuthority(authority);
            if (stoppingSignal) {
                if (!await stopBoundChild(launched, childExit))
                    return 1;
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
                if (!await releaseAuthority())
                    return 1;
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
            if (state?.outcome === 'confirmed') {
                if (!await releaseAuthority())
                    return 1;
                return exitCode(await childExit);
            }
            if (state?.outcome === 'blocked') {
                await stopBoundChild(launched, childExit);
                return 1;
            }
            if (state?.outcome === 'rolled_back') {
                if (!await stopBoundChild(launched, childExit))
                    return 1;
                child = undefined;
                childExit = undefined;
                return await launchTerminalTarget();
            }
            if (event.type === 'exit' || Date.now() >= deadline) {
                if (!await stopBoundChild(launched, childExit))
                    return 1;
                const rollback = await rollbackDurableSelfUpdate(transactionOptions, event.type === 'exit'
                    ? SELF_UPDATE_FAILURE_CODES.RESTART_FAILED
                    : 'health_confirmation_timeout');
                if (rollback.outcome !== 'rolled_back' && rollback.outcome !== 'confirmed') {
                    logger.write('[evolver-controller] rollback_blocked\n');
                    return 1;
                }
                if (rollback.outcome === 'confirmed') {
                    if (!await releaseAuthority())
                        return 1;
                    return exitCode(await childExit);
                }
                child = undefined;
                childExit = undefined;
                return await launchTerminalTarget();
            }
        }
    }
    catch {
        logger.write('[evolver-controller] lifecycle_authority_blocked\n');
        if (child && childExit)
            await stopBoundChild(child, childExit);
        await releaseAuthority();
        return 1;
    }
    finally {
        process.off('SIGTERM', onSigterm);
        process.off('SIGINT', onSigint);
        if (!releaseAttempted)
            await releaseAuthority();
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
async function revalidateBoundUnixController(options, processExecPath, expected, authority) {
    authority.assertAuthorized();
    const actual = await bindStableUnixRecoveryController(options, processExecPath);
    if (actual.controllerPath !== expected.controllerPath || actual.targetPath !== expected.targetPath) {
        throw new Error('self_update_unix_recovery_controller_binding_changed');
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
            // Keep the error listener attached after timeout. stopNativeChild may close
            // the child pipe with ECONNRESET; removing it here turns expected cleanup
            // into an unhandled error in the test runner and in long-lived controllers.
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