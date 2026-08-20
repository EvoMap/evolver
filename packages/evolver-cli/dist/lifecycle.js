import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, posix, resolve as resolvePath, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap as coreBootstrap, util as coreUtil } from '@evomap/evolver-core';
import { expandHomePath, loadEnvFile, loadEnvFileFromEnv, parseEnvFile } from '@evomap/evolver-mcp';
import { acquireBootstrapOwnerLock, acquireBootstrapReadinessLock, adoptLegacyBootstrapMarker, applyBootstrapCanonicalQuarantine, assertTrustedArtifactParent, assertActiveBootstrapRegistrationIntentToken, assertPlannedArtifactsAbsent, assertBootstrapTransactionClaimsAbsent, bootstrapArtifactClaimPath, bootstrapArtifactContentIdentityForFile, bootstrapArtifactIdentityForBytes, bootstrapJournalPath, bootstrapJournalFromMarker, bootstrapJournalManagerArtifactPath, bootstrapMarkerPath, bootstrapReadinessPath, captureBootstrapArtifactIdentities, createLegacyBootstrapRemovalJournal, createBootstrapJournal, ensureBootstrapManualTransition, finalizeBootstrapCanonicalQuarantine, planBootstrapCanonicalQuarantine, readBootstrapJournal, readBootstrapArtifactFile, readLegacyBootstrapMarker, readBootstrapManualTransition, readBootstrapMarker, readBootstrapReadiness, recordPublishedBootstrapArtifact, removeBootstrapJournal, removeBootstrapManualTransition, removeBootstrapReadiness, removeDurableFile, removeOwnedBootstrapArtifacts, restoreBootstrapCanonicalQuarantine, updateBootstrapJournal, writeBootstrapJournal, writeDurableBytesExclusive, writeDurableJsonExclusive, writeDurableTextExclusive, LEGACY_BOOTSTRAP_REMOVAL_OPERATION, } from './lifecycleBootstrapTransaction.js';
const requireFromHere = createRequire(import.meta.url);
const DEFAULT_DAEMON_NAME = 'evolver-proxy';
const DEFAULT_LABEL = 'com.evomap.evolver-proxy';
const AUTOEXEC_LABEL = 'com.evomap.evolver-autoexec';
const DEFAULT_HEALTH_TIMEOUT_MS = 700;
const DEFAULT_WATCH_INTERVAL_MS = 120_000;
const BOOTSTRAP_ENV_FILE_HANDOFF = 'EVOLVER_INTERNAL_BOOTSTRAP_ENV_FILE';
const BOOTSTRAP_TRANSACTION_BUDGET_MS = 180_000;
const BOOTSTRAP_ROLLBACK_RESERVE_MS = 60_000;
const BOOTSTRAP_ROLLBACK_FINALIZATION_RESERVE_MS = 5_000;
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 60_000;
const BOOTSTRAP_ERROR_DETAIL_LIMIT = 512;
const BOOTSTRAP_HEALTH_TIMEOUT_MS = 15_000;
const MAX_PROXY_SETTINGS_BYTES = 64 * 1024;
const SYSTEMCTL_PATH = selectExistingPosixCommand([
    '/usr/bin/systemctl',
    '/bin/systemctl',
    '/run/current-system/sw/bin/systemctl',
]);
const PS_PATH = selectExistingPosixCommand([
    '/bin/ps',
    '/usr/bin/ps',
    '/run/current-system/sw/bin/ps',
]);
const LAUNCHCTL_PATH = '/bin/launchctl';
const UNIX_RECOVERY_CONTROLLER_FILENAME = 'evolver-recovery-controller';
const HOST_WINDOWS_SYSTEM_ROOT = process.env['SystemRoot']?.trim() || 'C:\\Windows';
const LIFECYCLE_USAGE = 'Usage: evolver lifecycle <start|stop|restart|status|check|watch|install-service --target=launchd|systemd|windows [--with-autoexec] [--autoexec-home=<path>]|remove-service --target=launchd|systemd|windows [--dry-run] [--env-file=<path>]|bootstrap [--target=launchd|systemd|windows] [--dry-run]|remove-autoexec-service --target=launchd|systemd|windows [--dry-run]>\n';
export function selectExistingPosixCommand(candidates, exists = existsSync) {
    if (candidates.length === 0 || candidates.some((candidate) => !posix.isAbsolute(candidate))) {
        throw new Error('trusted command candidates must be non-empty absolute POSIX paths');
    }
    return candidates.find(exists) ?? candidates[0];
}
class BootstrapRolledBackError extends Error {
}
class BootstrapManagerNotRunningError extends Error {
}
class BootstrapCommitAmbiguousError extends Error {
}
class LifecycleCommittedLockReleaseError extends Error {
    action;
    result;
    releaseDetail;
    constructor(action, result, failures) {
        const releaseDetail = bootstrapLockReleaseFailuresDetail(failures);
        super(`${action} committed but lifecycle lock release is unconfirmed: ${releaseDetail}`, {
            cause: new AggregateError(failures.map((failure) => failure.error)),
        });
        this.name = 'LifecycleCommittedLockReleaseError';
        this.action = action;
        this.result = result;
        this.releaseDetail = releaseDetail;
    }
}
function lifecycleOutcomeIsCommitted(action, outcome) {
    if (action === 'bootstrap') {
        return outcome.status === 'bootstrapped' || outcome.status === 'already-bootstrapped';
    }
    if (action === 'install-service')
        return outcome.status === 'installed';
    return outcome.status === 'removed' || outcome.status === 'already-removed';
}
function isBootstrapOwnerLockAssertionError(error) {
    return error instanceof Error
        && /^bootstrap owner lock assertion failed: (?:not_owned|ownership_changed)$/.test(error.message);
}
function bootstrapLockReleaseReason(error) {
    const detail = boundedBootstrapError(error);
    const redundantPrefix = 'bootstrap owner lock release failed: ';
    return detail.startsWith(redundantPrefix) ? detail.slice(redundantPrefix.length) : detail;
}
function bootstrapLockReleaseFailuresDetail(failures, maxLength = BOOTSTRAP_ERROR_DETAIL_LIMIT) {
    if (failures.length === 0)
        return '';
    const prefixes = failures.map((failure) => `${failure.label} lock release failed: `);
    const fixedLength = prefixes.reduce((total, prefix) => total + prefix.length, 0)
        + (failures.length - 1) * '; '.length;
    const availableReasonLength = Math.max(0, maxLength - fixedLength);
    const baseReasonLength = Math.floor(availableReasonLength / failures.length);
    const remainder = availableReasonLength % failures.length;
    return failures.map((failure, index) => {
        const reasonLength = baseReasonLength + (index < remainder ? 1 : 0);
        return `${prefixes[index]}${bootstrapLockReleaseReason(failure.error).slice(0, reasonLength)}`;
    }).join('; ');
}
function releaseBootstrapLifecycleLocks(locks) {
    const failures = [];
    for (const { label, lock } of locks) {
        if (!lock)
            continue;
        try {
            lock.release();
        }
        catch (error) {
            failures.push({ label, error });
        }
    }
    return failures;
}
function finishLifecycleOperationAfterLockRelease(input) {
    const { action, outcome, operationError, operationFailed, releaseFailures } = input;
    if (operationFailed) {
        if (releaseFailures.length > 0) {
            const separator = '; ';
            const operationLength = Math.floor((BOOTSTRAP_ERROR_DETAIL_LIMIT - separator.length) / 2);
            const releaseLength = BOOTSTRAP_ERROR_DETAIL_LIMIT - separator.length - operationLength;
            throw new Error(`${boundedBootstrapError(operationError, operationLength)}${separator}${bootstrapLockReleaseFailuresDetail(releaseFailures, releaseLength)}`, { cause: new AggregateError([operationError, ...releaseFailures.map((failure) => failure.error)]) });
        }
        throw operationError;
    }
    if (releaseFailures.length === 0)
        return;
    if (outcome && lifecycleOutcomeIsCommitted(action, outcome)) {
        throw new LifecycleCommittedLockReleaseError(action, outcome, releaseFailures);
    }
    throw new Error(bootstrapLockReleaseFailuresDetail(releaseFailures), {
        cause: new AggregateError(releaseFailures.map((failure) => failure.error)),
    });
}
function ownerGuardedServiceRun(run, assertOwner) {
    return (command, args, timeoutMs) => {
        assertOwner();
        return run(command, args, timeoutMs);
    };
}
export function runLifecycleCommand(argv, deps = {}) {
    return runLifecycleCommandInner(argv, deps).catch((err) => {
        const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
        const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
        if (err instanceof LifecycleCommittedLockReleaseError) {
            const transactionId = err.action === 'bootstrap'
                ? err.result.transactionId
                : undefined;
            stdout(`${JSON.stringify({
                status: `${err.action}-committed-lock-release-unconfirmed`,
                outcome: 'committed',
                ...(transactionId ? { transactionId } : {}),
                result: err.result,
                detail: err.releaseDetail,
            })}\n`);
            return 1;
        }
        const detail = boundedBootstrapError(err);
        stderr(`${detail}\n`);
        if (argv[0] === 'bootstrap') {
            stdout(`${JSON.stringify({
                status: 'bootstrap-failed',
                outcome: err instanceof BootstrapRolledBackError ? 'rolled_back' : 'blocked',
                detail,
            })}\n`);
        }
        return 1;
    });
}
async function runLifecycleCommandInner(argv, deps) {
    const env = deps.env ?? process.env;
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    if (argv[0] === '--help' || argv[0] === '-h') {
        stdout(LIFECYCLE_USAGE);
        return 0;
    }
    const action = argv[0];
    const flags = action === 'bootstrap'
        ? parseBootstrapFlags(argv.slice(1))
        : parseFlags(argv.slice(1));
    const paths = lifecyclePaths(env);
    switch (action) {
        case 'start': {
            const result = await startLifecycle(paths, env);
            stdout(`${JSON.stringify(result)}\n`);
            return 0;
        }
        case 'stop': {
            const result = stopLifecycle(paths);
            stdout(`${JSON.stringify(result)}\n`);
            return 0;
        }
        case 'restart': {
            stopLifecycle(paths);
            const result = await startLifecycle(paths, env);
            stdout(`${JSON.stringify({ ...result, status: result.status === 'started' ? 'restarted' : result.status })}\n`);
            return 0;
        }
        case 'status': {
            const status = await lifecycleStatus(paths, env);
            stdout(`${JSON.stringify(status, null, 2)}\n`);
            return status.running ? 0 : 1;
        }
        case 'check': {
            const status = await lifecycleStatus(paths, env);
            stdout(`${JSON.stringify(status, null, 2)}\n`);
            if (!status.healthy) {
                stderr(`[Lifecycle] unhealthy reason=${status.reason ?? 'unknown'}; restarting\n`);
                stopLifecycle(paths);
                const result = await startLifecycle(paths, env);
                stdout(`${JSON.stringify(result)}\n`);
                const next = await lifecycleStatus(paths, env);
                stdout(`${JSON.stringify({ after_restart: lifecycleStatusForOperator(next), log: 'inspect EVOLVER_LIFECYCLE_LOG_FILE or EVOLVER_LIFECYCLE_LOG_DIR' }, null, 2)}\n`);
                if (!next.healthy) {
                    stderr(`[Lifecycle] restart did not become healthy reason=${next.reason ?? 'unknown'}; inspect EVOLVER_LIFECYCLE_LOG_FILE or EVOLVER_LIFECYCLE_LOG_DIR\n`);
                    return 1;
                }
            }
            return 0;
        }
        case 'watch':
            return runWatch(paths, env, flags, stdout, stderr);
        case 'bootstrap': {
            const inheritedRegistrationToken = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV];
            const requestedEnvFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : undefined;
            const envFileResult = requestedEnvFile
                ? loadEnvFile(requestedEnvFile, env)
                : loadEnvFileFromEnv(env);
            if (inheritedRegistrationToken === undefined) {
                delete env[coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV];
            }
            else {
                env[coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV] =
                    inheritedRegistrationToken;
            }
            if (envFileResult.error)
                throw new Error('failed to load lifecycle environment file');
            const result = await bootstrapService(flags, env, deps.argv1 ?? process.argv[1], deps.bootstrap ?? {}, deps.loadUnixRecoveryController);
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        case 'install-service': {
            if (flags['dry-run'] !== undefined && flags['dry-run'] !== true) {
                throw new Error('--dry-run is a boolean flag and does not accept a value');
            }
            const requestedEnvFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : undefined;
            const envFileResult = requestedEnvFile
                ? loadEnvFile(requestedEnvFile, env)
                : loadEnvFileFromEnv(env);
            if (envFileResult.error)
                throw new Error('failed to load lifecycle environment file');
            const target = serviceTarget(flags);
            const dryRun = flags['dry-run'] === true;
            const stateDir = lifecyclePaths(env).stateDir;
            const ownerLock = dryRun ? undefined : acquireBootstrapOwnerLock(stateDir);
            let readinessLock;
            let manualTransition;
            let outcome;
            let operationError;
            let operationFailed = false;
            const assertOwner = ownerLock ? () => ownerLock.assertOwned() : undefined;
            try {
                if (!dryRun) {
                    await assertNoActiveDurableSelfUpdateRecovery({
                        action: 'install-service',
                        target,
                        stateDir,
                        ownerLock: ownerLock,
                        env,
                        argv1: deps.argv1 ?? process.argv[1],
                        deps: deps.bootstrap ?? {},
                    });
                    assertOwner();
                    readinessLock = acquireBootstrapReadinessLock(stateDir);
                    if (readBootstrapJournal(stateDir)) {
                        throw new Error('install-service refused while first-run bootstrap recovery is pending; run lifecycle bootstrap before replacing the service');
                    }
                    let marker;
                    let legacyMarker;
                    try {
                        marker = readBootstrapMarker(stateDir);
                    }
                    catch (error) {
                        if (!filesystemEntryExists(bootstrapMarkerPath(stateDir)))
                            throw error;
                        legacyMarker = readLegacyBootstrapMarker(stateDir);
                    }
                    const readiness = readBootstrapReadiness(stateDir);
                    if (marker || legacyMarker) {
                        if (readiness && (!marker || readiness.transactionId !== marker.transactionId)) {
                            throw new Error('install-service refused inconsistent committed bootstrap readiness; run lifecycle bootstrap recovery');
                        }
                        const autoexecSuffix = flags['with-autoexec'] === true ? ' --with-autoexec' : '';
                        throw new Error(`install-service cannot rewrite a committed proxy service; use lifecycle remove-service --target=${target}, then lifecycle install-service --target=${target}${autoexecSuffix}; service downtime is expected between commands`);
                    }
                    if (readiness) {
                        throw new Error('install-service refused while first-run bootstrap readiness is active; run lifecycle bootstrap recovery');
                    }
                    manualTransition = readBootstrapManualTransition(stateDir);
                    if (manualTransition && manualTransition.target !== target) {
                        throw new Error(`install-service target ${target} does not match manual-transition target ${manualTransition.target}`);
                    }
                }
                outcome = await (deps.bootstrap?.install ?? installService)(target, flags, env, deps.argv1 ?? process.argv[1], deps.loadUnixRecoveryController, assertOwner ? { assertOwner } : undefined);
                assertOwner?.();
                if (manualTransition) {
                    assertOwner();
                    removeBootstrapManualTransition(stateDir, manualTransition.transitionId);
                }
            }
            catch (error) {
                if (!outcome
                    || !lifecycleOutcomeIsCommitted('install-service', outcome)
                    || !isBootstrapOwnerLockAssertionError(error)) {
                    operationError = error;
                    operationFailed = true;
                }
            }
            const releaseFailures = releaseBootstrapLifecycleLocks([
                { label: 'bootstrap readiness', lock: readinessLock },
                { label: 'bootstrap owner', lock: ownerLock },
            ]);
            finishLifecycleOperationAfterLockRelease({
                action: 'install-service',
                outcome,
                operationError,
                operationFailed,
                releaseFailures,
            });
            if (!outcome)
                throw new Error('install-service completed without a lifecycle outcome');
            stdout(`${JSON.stringify(outcome, null, 2)}\n`);
            return 0;
        }
        case 'remove-service': {
            const removeFlags = parseRemoveServiceFlags(argv.slice(1));
            const envFileResult = removeFlags.envFile
                ? loadEnvFile(removeFlags.envFile, env)
                : loadEnvFileFromEnv(env);
            if (envFileResult.error)
                throw new Error('failed to load lifecycle environment file');
            const result = await removeBootstrapService(removeFlags.target, removeFlags.dryRun, env, deps.bootstrap ?? {}, deps.argv1 ?? process.argv[1], deps.loadUnixRecoveryController, removeFlags.envFile ? { 'env-file': removeFlags.envFile } : {});
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        case 'remove-autoexec-service': {
            if (flags['dry-run'] !== undefined && flags['dry-run'] !== true) {
                throw new Error('--dry-run is a boolean flag and does not accept a value');
            }
            const target = serviceTarget(flags);
            const result = (deps.removeAutoexecService ?? removeAutoexecService)(target, flags['dry-run'] === true);
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        default:
            stderr(LIFECYCLE_USAGE);
            return action === undefined ? 0 : 1;
    }
}
function lifecycleStatusForOperator(status) {
    const { logFile: _logFile, ...safe } = status;
    return safe;
}
export async function maybeAutoRestartProxyForSessionStart(env = process.env, argv1 = process.argv[1], deps = {}) {
    if (!sessionAutoRestartEnabled(env))
        return;
    if (!proxyExpected(env))
        return;
    const paths = lifecyclePaths(env);
    const verbose = sessionStartHookVerboseEnabled(env);
    const stderr = verbose
        ? (deps.stderr ?? ((text) => { process.stderr.write(text); }))
        : undefined;
    const status = await lifecycleStatus(paths, env, { timeoutMs: 250, quietSettingsReadError: !verbose, stderr });
    if (status.healthy)
        return;
    if ((deps.platform ?? process.platform) === 'win32') {
        stderr?.(`[evolver-session-start] proxy daemon unhealthy (${status.reason ?? 'unknown'}); scheduled task/service manager should restart it on Windows.\n`);
        return;
    }
    const cliPath = argv1 && argv1.trim() ? argv1 : resolveCurrentCliPath();
    const spawnDetached = deps.spawnDetached ?? spawn;
    const child = spawnDetached(process.execPath, [cliPath, 'lifecycle', 'start'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...env },
        windowsHide: true,
    });
    child.once('error', (err) => {
        stderr?.(`[evolver-session-start] background restart spawn failed: ${err.message}\n`);
    });
    child.unref();
    stderr?.(`[evolver-session-start] proxy daemon unhealthy (${status.reason ?? 'unknown'}); attempted background restart (PID ${child.pid}).\n`);
}
export async function startLifecycle(paths, env = process.env) {
    loadEnvFileFromEnv(env);
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
    const current = await lifecycleStatus(paths, env);
    if (current.healthy && current.pid)
        return { status: 'already_running', pid: current.pid, logFile: paths.logFile };
    if (current.pid && current.running)
        stopLifecycle(paths);
    else
        rmSync(paths.pidFile, { force: true });
    const command = resolveDaemonCommand(env);
    const cwd = env['EVOLVER_LIFECYCLE_CWD'] || process.cwd();
    const out = openSync(paths.logFile, 'a');
    const err = openSync(paths.logFile, 'a');
    const child = spawn(command.command, command.args, {
        cwd,
        detached: true,
        stdio: ['ignore', out, err],
        env: oneShotChildEnv(env),
        windowsHide: true,
    });
    child.once('error', (err) => {
        process.stderr.write(`[Lifecycle] failed to spawn ${command.command}: ${err.message}\n`);
    });
    child.unref();
    if (!child.pid)
        throw new Error('failed to determine lifecycle daemon pid');
    writePidFile(paths.pidFile, {
        owner: 'evolver-lifecycle',
        pid: child.pid,
        parentPid: process.pid,
        command: command.command,
        args: command.args,
        cwd,
        createdAt: new Date().toISOString(),
    });
    return { status: 'started', pid: child.pid, logFile: paths.logFile };
}
function oneShotChildEnv(env) {
    const childEnv = { ...env };
    delete childEnv['EVOLVER_SELF_UPDATE_SUPERVISOR'];
    return childEnv;
}
export function stopLifecycle(paths, deps = {}) {
    const pidFile = readPidFile(paths.pidFile);
    const pid = pidFile.pid;
    if (!pid || !isPidRunning(pid)) {
        rmSync(paths.pidFile, { force: true });
        return { status: 'not_running' };
    }
    if (!pidFile.owned || !waitForPidFileRecordMatch(pidFile, 1_000, deps.processCommandLine ?? processCommandLine, deps.processIdentity ?? processIdentity, deps.platform ?? process.platform)) {
        return { status: 'not_owned', pid, reason: 'pidfile_owner_unconfirmed' };
    }
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (err) {
        return { status: 'stop_failed', pid, reason: err instanceof Error ? err.message : String(err) };
    }
    const stopped = waitForExit(pid, 5_000);
    if (!stopped)
        forceKill(pid);
    rmSync(paths.pidFile, { force: true });
    return { status: 'stopped', pids: [pid] };
}
export async function lifecycleStatus(paths, env = process.env, options = {}) {
    const settings = readProxySettings(paths.settingsFile, {
        quietReadError: options.quietSettingsReadError === true,
        stderr: options.stderr,
    });
    const pidFile = readPidFile(paths.pidFile);
    const pid = pidFile.pid;
    if (!pid || !isPidRunning(pid)) {
        if (pid)
            rmSync(paths.pidFile, { force: true });
        const settingsStatus = await lifecycleStatusFromSettings(settings, paths, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
        if (settingsStatus)
            return settingsStatus;
        return { running: false, healthy: false, reason: 'not_running', logFile: paths.logFile };
    }
    if (!pidFile.owned || !pidFileRecordMatchesProcess(pidFile)) {
        const settingsStatus = await lifecycleStatusFromSettings(settings, paths, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
        if (settingsStatus)
            return settingsStatus;
        return { running: false, pid, healthy: false, reason: 'pidfile_owner_unconfirmed', logFile: paths.logFile };
    }
    if (env['EVOLVER_LIFECYCLE_REQUIRE_PROXY_STATUS'] === '0') {
        return { running: true, pid, healthy: true, logFile: paths.logFile };
    }
    if (!settings.url || !settings.token) {
        return { running: true, pid, healthy: false, reason: 'proxy_settings_missing', logFile: paths.logFile };
    }
    if (settings.pid && settings.pid !== pid && !isPidRunning(settings.pid)) {
        return { running: true, pid, healthy: false, reason: 'proxy_settings_stale_pid', logFile: paths.logFile };
    }
    const ok = await proxyStatusOk(settings, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    return {
        running: true,
        pid,
        healthy: ok,
        ...(settings.pid === pid && settings.startedAt ? { startedAt: settings.startedAt } : {}),
        ...(settings.url ? { url: settings.url } : {}),
        ...(ok ? {} : { reason: 'proxy_unreachable' }),
        logFile: paths.logFile,
    };
}
/** Fetch enriched connection status for the daily summary. Builds on lifecycleStatus, adding hub details. */
export async function dailyConnectionStatus(paths, env = process.env, options = {}) {
    const base = await lifecycleStatus(paths, env, { ...options, quietSettingsReadError: true });
    if (!base.running || !base.healthy)
        return base;
    // Proxy is healthy — fetch /proxy/status for hub details
    const settings = readProxySettings(paths.settingsFile, { quietReadError: true });
    if (!settings.url || !settings.token)
        return base;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    try {
        const url = `${settings.url.replace(/\/+$/, '')}/proxy/status`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${settings.token}` }, signal: controller.signal });
        if (!res.ok)
            return base;
        const body = await res.json();
        return {
            ...base,
            hubAuthStatus: typeof body['hub_auth_status'] === 'string' ? body['hub_auth_status'] : undefined,
            lastSyncAt: typeof body['last_sync_at'] === 'string' ? body['last_sync_at'] : undefined,
        };
    }
    catch {
        return base;
    }
    finally {
        clearTimeout(timeout);
    }
}
export function lifecyclePaths(env = process.env) {
    const home = env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
    const stateDir = resolvePath(nonBlankEnv(env, 'EVOLVER_LIFECYCLE_STATE_DIR') ?? join(home, 'lifecycle'));
    const logDir = env['EVOLVER_LIFECYCLE_LOG_DIR'] ?? join(home, 'logs');
    const name = env['EVOLVER_LIFECYCLE_NAME'] ?? DEFAULT_DAEMON_NAME;
    const settingsHome = nonBlankEnv(env, 'EVOLVER_SETTINGS_DIR') ?? join(homedir(), '.evolver');
    return {
        home,
        stateDir,
        logDir,
        pidFile: env['EVOLVER_LIFECYCLE_PID_FILE'] ?? join(stateDir, `${name}.pid`),
        logFile: env['EVOLVER_LIFECYCLE_LOG_FILE'] ?? join(logDir, `${name}.log`),
        settingsFile: nonBlankEnv(env, 'EVOLVER_PROXY_SETTINGS_FILE') ?? join(settingsHome, 'settings.json'),
    };
}
function nonBlankEnv(env, key) {
    const value = env[key]?.trim();
    return value ? value : undefined;
}
export function renderSystemdUnit(opts = {}) {
    const execStart = opts.execStart === undefined
        ? assertSingleLine(defaultServiceExecStart(), 'systemd ExecStart')
        : escapeSystemdPercent(assertSingleLine(opts.execStart, 'systemd ExecStart'));
    const workingDirectory = opts.workingDirectory === undefined
        ? '%h'
        : escapeSystemdPercent(quoteSystemdArg(isAbsolute(opts.workingDirectory) ? opts.workingDirectory : resolvePath(opts.workingDirectory)));
    return [
        '# Linux systemd user unit -- ~/.config/systemd/user/evolver-proxy.service',
        '[Unit]',
        'Description=EvoMap Evolver Proxy Daemon',
        'After=network-online.target',
        'Wants=network-online.target',
        'StartLimitBurst=5',
        'StartLimitIntervalSec=120s',
        '',
        '[Service]',
        'Type=notify',
        '# The stable recovery controller may be MainPID; the proxy child invokes systemd-notify.',
        'NotifyAccess=all',
        'WatchdogSec=180s',
        `WorkingDirectory=${workingDirectory}`,
        ...(opts.envFile ? [`Environment="EVOLVER_ENV_FILE=${escapeSystemdEnvValue(opts.envFile)}"`] : []),
        'Environment="EVOLVER_SELF_UPDATE_SUPERVISOR=systemd"',
        ...(opts.lifecycleStateDir
            ? [`Environment="EVOLVER_LIFECYCLE_STATE_DIR=${escapeSystemdEnvValue(opts.lifecycleStateDir)}"`]
            : []),
        ...(opts.selfUpdateStateDir
            ? [`Environment="EVOLVER_SELF_UPDATE_STATE_DIR=${escapeSystemdEnvValue(opts.selfUpdateStateDir)}"`]
            : []),
        ...(opts.selfUpdateTarget
            ? [`Environment="EVOLVER_SELF_UPDATE_TARGET_PATH=${escapeSystemdEnvValue(opts.selfUpdateTarget)}"`]
            : []),
        ...(opts.bootstrapTransactionId
            ? [`Environment="${coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV}=${escapeSystemdEnvValue(opts.bootstrapTransactionId)}"`]
            : []),
        `ExecStart=${execStart}`,
        'Restart=on-failure',
        'RestartSec=5s',
        'RestartPreventExitStatus=0',
        'RestartForceExitStatus=78',
        'TimeoutStopSec=30s',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=evolver-proxy',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}
export function renderAutoexecSystemdUnit(opts) {
    const execStart = escapeSystemdPercent(assertSingleLine(opts.execStart, 'systemd ExecStart'));
    const workingDirectory = opts.workingDirectory === undefined
        ? '%h'
        : escapeSystemdPercent(quoteSystemdArg(isAbsolute(opts.workingDirectory) ? opts.workingDirectory : resolvePath(opts.workingDirectory)));
    return [
        '# Linux systemd user unit -- ~/.config/systemd/user/evolver-autoexec.service',
        '[Unit]',
        'Description=EvoMap Evolver Autoexec Daemon',
        'After=network-online.target evolver-proxy.service',
        'Wants=network-online.target evolver-proxy.service',
        'StartLimitBurst=5',
        'StartLimitIntervalSec=120s',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${workingDirectory}`,
        ...(opts.envFile ? [`Environment="EVOLVER_ENV_FILE=${escapeSystemdEnvValue(opts.envFile)}"`] : []),
        `ExecStart=${execStart}`,
        'Restart=on-failure',
        'RestartSec=5s',
        'RestartPreventExitStatus=0',
        'TimeoutStopSec=30s',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=evolver-autoexec',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}
export function renderLaunchdPlist(opts = {}) {
    const workingDirectory = opts.workingDirectory ?? '/Users/YOU/your-project';
    const nodePath = opts.nodePath ?? '/usr/local/bin/node';
    const proxyBin = opts.proxyBin ?? '/Users/YOU/your-project/node_modules/@evomap/evolver-proxy/dist/bin/evolver-proxy.js';
    const programArguments = opts.programArguments ?? [nodePath, proxyBin];
    const logDir = opts.logDir ?? '/Users/YOU/Library/Logs';
    const label = opts.label ?? DEFAULT_LABEL;
    const logName = opts.logName ?? 'evolver-proxy';
    const selfUpdateSupervisor = opts.selfUpdateSupervisor ?? true;
    const envFileBlock = opts.envFile ? `        <key>EVOLVER_ENV_FILE</key>\n        <string>${escapeXml(opts.envFile)}</string>\n` : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${escapeXml(label)}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...programArguments.map((argument) => `        <string>${escapeXml(argument)}</string>`),
        '    </array>',
        '    <key>WorkingDirectory</key>',
        `    <string>${escapeXml(workingDirectory)}</string>`,
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        envFileBlock.trimEnd(),
        ...(opts.lifecycleStateDir ? [
            '        <key>EVOLVER_LIFECYCLE_STATE_DIR</key>',
            `        <string>${escapeXml(opts.lifecycleStateDir)}</string>`,
        ] : []),
        ...(selfUpdateSupervisor ? [
            '        <key>EVOLVER_SELF_UPDATE_SUPERVISOR</key>',
            '        <string>launchd</string>',
        ] : []),
        ...(opts.selfUpdateStateDir ? [
            '        <key>EVOLVER_SELF_UPDATE_STATE_DIR</key>',
            `        <string>${escapeXml(opts.selfUpdateStateDir)}</string>`,
        ] : []),
        ...(opts.selfUpdateTarget ? [
            '        <key>EVOLVER_SELF_UPDATE_TARGET_PATH</key>',
            `        <string>${escapeXml(opts.selfUpdateTarget)}</string>`,
        ] : []),
        ...(opts.bootstrapTransactionId ? [
            `        <key>${coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV}</key>`,
            `        <string>${escapeXml(opts.bootstrapTransactionId)}</string>`,
        ] : []),
        '        <key>PATH</key>',
        '        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>',
        '    </dict>',
        '    <key>RunAtLoad</key>',
        '    <true/>',
        '    <key>KeepAlive</key>',
        '    <dict>',
        '        <key>SuccessfulExit</key>',
        '        <false/>',
        '    </dict>',
        '    <key>ThrottleInterval</key>',
        '    <integer>5</integer>',
        '    <key>StandardOutPath</key>',
        `    <string>${escapeXml(posix.join(logDir, `${logName}.log`))}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${escapeXml(posix.join(logDir, `${logName}.err.log`))}</string>`,
        '    <key>ProcessType</key>',
        '    <string>Standard</string>',
        '    <key>LowPriorityIO</key>',
        '    <false/>',
        '    <key>LowPriorityBackgroundIO</key>',
        '    <false/>',
        '</dict>',
        '</plist>',
        '',
    ].filter((line) => line !== '').join('\n');
}
export function renderAutoexecLaunchdPlist(opts) {
    return renderLaunchdPlist({
        ...opts,
        label: AUTOEXEC_LABEL,
        logName: 'evolver-autoexec',
        selfUpdateSupervisor: false,
    });
}
const LEGACY_WINDOWS_BASE_DEFAULT_NAMES = [
    'EvolverBin',
    'NodePath',
    'ProxyBin',
    'EnvFile',
    'SelfUpdateStateDir',
];
const LEGACY_WINDOWS_INSTALLER_PROFILES = [
    {
        family: 'v907',
        names: LEGACY_WINDOWS_BASE_DEFAULT_NAMES,
        bytes: 6_796,
        sha256: '5d7c53c9c96f41cb4a956d3aa662739a5bbf4426070a57ff2bddf86e01127eb3',
    },
    {
        family: 'v918',
        names: [
            'EvolverBin',
            'NodePath',
            'ProxyBin',
            'EnvFile',
            'LifecycleStateDir',
            'SelfUpdateStateDir',
        ],
        bytes: 7_052,
        sha256: '059c84253cb3a84b571f51d4c9fe019cd42b357c5ed0ca6160ca6a3dedb9fcf7',
    },
];
function parseLegacyWindowsInstallerDefaults(source) {
    const lines = source.split(/\r?\n/);
    for (const profile of LEGACY_WINDOWS_INSTALLER_PROFILES) {
        const values = new Map();
        const canonicalLines = [...lines];
        let valid = true;
        for (const name of profile.names) {
            const prefix = `  [string]$${name} = '`;
            const matches = lines.flatMap((line, index) => {
                if (!line.startsWith(prefix) || (!line.endsWith("'") && !line.endsWith("',")))
                    return [];
                const comma = line.endsWith("',") ? ',' : '';
                const encoded = line.slice(prefix.length, line.length - 1 - comma.length);
                let value = '';
                for (let offset = 0; offset < encoded.length; offset += 1) {
                    if (encoded[offset] !== "'") {
                        value += encoded[offset];
                        continue;
                    }
                    if (encoded[offset + 1] !== "'")
                        return [];
                    value += "'";
                    offset += 1;
                }
                return [{ index, value, comma }];
            });
            if (matches.length !== 1) {
                valid = false;
                break;
            }
            const match = matches[0];
            values.set(name, match.value);
            canonicalLines[match.index] = `  [string]$${name} = ''${match.comma}`;
        }
        if (!valid)
            continue;
        const canonicalBytes = Buffer.from(canonicalLines.join('\n'), 'utf8');
        if (canonicalBytes.length !== profile.bytes
            || createHash('sha256').update(canonicalBytes).digest('hex') !== profile.sha256)
            continue;
        const evolverBin = values.get('EvolverBin');
        const nodePath = values.get('NodePath');
        const proxyBin = values.get('ProxyBin');
        const envFile = values.get('EnvFile');
        const lifecycleStateDir = values.get('LifecycleStateDir') ?? '';
        const selfUpdateStateDir = values.get('SelfUpdateStateDir');
        if ((Boolean(evolverBin) === Boolean(nodePath || proxyBin))
            || (Boolean(nodePath) !== Boolean(proxyBin))
            || (!evolverBin && Boolean(selfUpdateStateDir))
            || (profile.family === 'v918' && !lifecycleStateDir))
            continue;
        return {
            family: profile.family,
            defaults: {
                ...(evolverBin ? { evolverBin } : { nodePath, proxyBin }),
                ...(envFile ? { envFile } : {}),
                ...(lifecycleStateDir ? { lifecycleStateDir } : {}),
                ...(selfUpdateStateDir ? { selfUpdateStateDir } : {}),
                wscriptPath: trustedWindowsSystemExecutable('wscript.exe'),
            },
        };
    }
    throw new Error('legacy Windows installer does not match an exact supported pre-transaction template');
}
export const _parseLegacyWindowsInstallerDefaultsForTest = parseLegacyWindowsInstallerDefaults;
function trustedWindowsSystemExecutable(name) {
    if (!win32.isAbsolute(HOST_WINDOWS_SYSTEM_ROOT) || /[\r\n\0]/.test(HOST_WINDOWS_SYSTEM_ROOT)) {
        throw new Error('Windows SystemRoot is not an absolute trusted path');
    }
    return win32.join(HOST_WINDOWS_SYSTEM_ROOT, 'System32', name);
}
function trustedWindowsPowerShell() {
    return trustedWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe');
}
function renderWindowsProxyLauncherBytes(defaults) {
    const vbs = (value) => assertSingleLine(value ?? '', 'Windows launcher value').replaceAll('"', '""');
    const evolver = vbs(defaults.evolverBin);
    const node = vbs(defaults.nodePath);
    const proxy = vbs(defaults.proxyBin);
    const envFile = vbs(defaults.envFile);
    const lifecycleStateDir = vbs(defaults.lifecycleStateDir);
    const selfUpdateStateDir = vbs(defaults.selfUpdateStateDir);
    const bootstrapTransactionId = vbs(defaults.bootstrapTransactionId);
    const source = [
        "' AUTO-GENERATED by install-evolver-proxy-windows.ps1 -- do not edit.",
        "' wscript.exe is a Windows-subsystem host. WshShell.Run(..., 0, True)",
        "' launches node.exe hidden and waits so Task Scheduler sees the exit code.",
        'Dim WshShell, env, fso, stateDir, pendingPath, updaterPath, controllerPath, controllerCmd, cmd, rc',
        'Set WshShell = CreateObject("WScript.Shell")',
        'Set env = WshShell.Environment("PROCESS")',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'If "' + envFile + '" <> "" Then env("EVOLVER_ENV_FILE") = "' + envFile + '"',
        'If "' + lifecycleStateDir + '" <> "" Then env("EVOLVER_LIFECYCLE_STATE_DIR") = "' + lifecycleStateDir + '"',
        'env("EVOLVER_SELF_UPDATE_SUPERVISOR") = "windows-scheduled-task"',
        ...(bootstrapTransactionId ? [
            `env("${coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV}") = "${bootstrapTransactionId}"`,
        ] : []),
        'If "' + evolver + '" <> "" Then',
        '  stateDir = "' + selfUpdateStateDir + '"',
        '  env("EVOLVER_SELF_UPDATE_STATE_DIR") = stateDir',
        '  env("EVOLVER_SELF_UPDATE_TARGET_PATH") = "' + evolver + '"',
        '  pendingPath = stateDir & "\\windows-updater\\pending.json"',
        '  updaterPath = stateDir & "\\windows-updater\\updater.exe"',
        '  controllerPath = stateDir & "\\windows-controller\\evolver-recovery-controller.exe"',
        '  cmd = """' + evolver + '"" proxy"',
        '  If Not fso.FileExists(controllerPath) Then WScript.Quit 1',
        '  If fso.FileExists(pendingPath) And Not fso.FileExists(updaterPath) Then WScript.Quit 1',
        '  controllerCmd = """" & controllerPath & """ proxy --evolver-windows-recovery-controller"',
        '  rc = WshShell.Run(controllerCmd, 0, True)',
        '  WScript.Quit rc',
        'Else',
        '  cmd = """' + node + '"" ""' + proxy + '"""',
        'End If',
        'rc = WshShell.Run(cmd, 0, True)',
        'WScript.Quit rc',
        '',
    ].join('\r\n');
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]);
}
function renderLegacyWindowsProxyLauncherBytes(proof) {
    const rendered = renderWindowsProxyLauncherBytes(proof.defaults);
    if (proof.family === 'v918')
        return rendered;
    const source = rendered.subarray(2).toString('utf16le');
    const lifecycleLine = 'If "" <> "" Then env("EVOLVER_LIFECYCLE_STATE_DIR") = ""\r\n';
    if (source.split(lifecycleLine).length !== 2) {
        throw new Error('legacy Windows v907 launcher renderer did not find the #918-only state binding');
    }
    return Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source.replace(lifecycleLine, ''), 'utf16le'),
    ]);
}
export const _renderWindowsProxyLauncherBytesForTest = renderWindowsProxyLauncherBytes;
export function renderWindowsInstaller(defaults = {}) {
    const ps = (value) => `'${assertSingleLine(value ?? '', 'Windows installer value').replaceAll("'", "''")}'`;
    const bootstrapLauncherBase64 = renderWindowsProxyLauncherBytes(defaults).toString('base64');
    return String.raw `param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$BootstrapExclusive,
  [switch]$BootstrapCleanup,
  [string]$TaskName = 'EvoMapEvolverProxyDaemon',
  [string]$EvolverBin = ${ps(defaults.evolverBin)},
  [string]$NodePath = ${ps(defaults.nodePath)},
  [string]$ProxyBin = ${ps(defaults.proxyBin)},
  [string]$EnvFile = ${ps(defaults.envFile)},
  [string]$LifecycleStateDir = ${ps(defaults.lifecycleStateDir)},
  [string]$SelfUpdateStateDir = ${ps(defaults.selfUpdateStateDir)},
  [string]$BootstrapLauncherBase64 = ${ps(bootstrapLauncherBase64)},
  [string]$BootstrapTransactionId = ${ps(defaults.bootstrapTransactionId)},
  [string]$WscriptPath = ${ps(defaults.wscriptPath ?? trustedWindowsSystemExecutable('wscript.exe'))}
)

$ErrorActionPreference = 'Stop'

if ($Install -eq $Uninstall) {
  Write-Host 'Usage: install-evolver-proxy-windows.ps1 -Install [-EvolverBin ... | -NodePath ... -ProxyBin ...] [-EnvFile ...]'
  Write-Host '       install-evolver-proxy-windows.ps1 -Uninstall [-TaskName ...]'
  exit 1
}
if ($BootstrapExclusive -and -not $Install) { Write-Error '-BootstrapExclusive requires -Install'; exit 1 }
if ($BootstrapCleanup -and -not $Uninstall) { Write-Error '-BootstrapCleanup requires -Uninstall'; exit 1 }

if ($BootstrapExclusive -or $BootstrapCleanup) {
  if (-not $LifecycleStateDir) { Write-Error 'LifecycleStateDir is required for bootstrap ownership'; exit 1 }
  if ($BootstrapTransactionId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') { Write-Error 'A valid bootstrap transaction id is required'; exit 1 }
  if (-not $WscriptPath -or -not [System.IO.Path]::IsPathRooted($WscriptPath)) { Write-Error 'An absolute wscript path is required'; exit 1 }
  try { $fullWscriptPath = [System.IO.Path]::GetFullPath($WscriptPath) } catch { Write-Error 'The wscript path is invalid'; exit 1 }
  if ($fullWscriptPath -ine $WscriptPath) { Write-Error 'A canonical absolute wscript path is required'; exit 1 }
  $WscriptPath = $fullWscriptPath
  $launcherDir = [System.IO.Path]::GetFullPath($LifecycleStateDir)
} else {
  if (-not $env:LOCALAPPDATA) { Write-Error 'LOCALAPPDATA is required'; exit 1 }
  $launcherDir = Join-Path $env:LOCALAPPDATA 'EvoMap'
}
$launcherPath = Join-Path $launcherDir 'evolver-proxy-task-launcher.vbs'

function Get-ExactEvolverTaskInventory {
  try {
    return @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $TaskName })
  } catch {
    Write-Error 'Unable to inventory the Evolver Scheduled Task.'
    exit 1
  }
}

function Get-SingleEvolverTask {
  $tasks = @(Get-ExactEvolverTaskInventory)
  if ($tasks.Count -gt 1) {
    Write-Error 'Multiple Evolver Scheduled Tasks matched the exact task name.'
    exit 1
  }
  if ($tasks.Count -eq 1) { return $tasks[0] }
  return $null
}

if ($Uninstall) {
  $existing = Get-SingleEvolverTask
  if ($existing) {
    if ($BootstrapCleanup -and $existing.Description -ne ('EvoMap Evolver bootstrap transaction ' + $BootstrapTransactionId)) {
      Write-Error 'Bootstrap cleanup refused a Scheduled Task owned by another transaction.'
      exit 1
    }
    if ($existing.State -eq 'Running') {
      Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName
      $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 100
        $existing = Get-SingleEvolverTask
      } while ($existing -and $existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
      if ($existing -and $existing.State -eq 'Running') {
        Write-Error 'Existing Evolver Scheduled Task did not stop; refusing to uninstall.'
        exit 1
      }
    }
    $existing = Get-SingleEvolverTask
    if ($existing) {
      if ($BootstrapCleanup -and $existing.Description -ne ('EvoMap Evolver bootstrap transaction ' + $BootstrapTransactionId)) {
        Write-Error 'Bootstrap cleanup observed Scheduled Task ownership change before unregister.'
        exit 1
      }
      Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
    }
  }
  $remainingTasks = @(Get-ExactEvolverTaskInventory)
  if ($remainingTasks.Count -ne 0) {
    Write-Error 'Evolver Scheduled Task still exists after unregister.'
    exit 1
  }
  if (-not $BootstrapCleanup) {
    if (Test-Path -LiteralPath $launcherPath) { Remove-Item -LiteralPath $launcherPath -Force }
    if (Test-Path -LiteralPath $launcherPath) {
      Write-Error 'Evolver task launcher still exists after removal.'
      exit 1
    }
  }
  exit 0
}

if (-not $EvolverBin) {
  if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Error 'Pass -EvolverBin, or install node.exe / pass -NodePath.'; exit 1 }
    $NodePath = $cmd.Source
  }
  if (-not $ProxyBin) { Write-Error 'Pass -EvolverBin, or -ProxyBin pointing at evolver-proxy.js.'; exit 1 }
  if (-not (Test-Path $ProxyBin)) { Write-Error "Proxy bin not found at $ProxyBin"; exit 1 }
} elseif (-not (Test-Path $EvolverBin)) {
  Write-Error "Evolver binary not found at $EvolverBin"; exit 1
}

if ($EvolverBin) {
  if (-not $SelfUpdateStateDir) { $SelfUpdateStateDir = $env:EVOLVER_SELF_UPDATE_STATE_DIR }
  if (-not $SelfUpdateStateDir) {
    $SelfUpdateStateDir = Join-Path (Split-Path -Parent $EvolverBin) '.evolver-update'
  }
}

foreach ($launcherValue in @($EvolverBin, $NodePath, $ProxyBin, $EnvFile, $LifecycleStateDir, $SelfUpdateStateDir)) {
  if ($launcherValue -match "[\r\n]") {
    Write-Error 'Launcher paths must not contain line breaks.'
    exit 1
  }
}

if ($EvolverBin) {
  $EvolverBin = [System.IO.Path]::GetFullPath($EvolverBin)
  $SelfUpdateStateDir = [System.IO.Path]::GetFullPath($SelfUpdateStateDir)
  $controllerPath = Join-Path $SelfUpdateStateDir 'windows-controller\evolver-recovery-controller.exe'
}

if ($BootstrapExclusive) {
  $existingBootstrapTasks = @(Get-ExactEvolverTaskInventory)
  if ($existingBootstrapTasks.Count -ne 0) {
    Write-Error 'Bootstrap refuses to replace a pre-existing Evolver Scheduled Task.'
    exit 1
  }
  if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    Write-Error 'Bootstrap launcher was not durably prepared by the transaction owner.'
    exit 1
  }
  $actualLauncherBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($launcherPath))
  if ($actualLauncherBase64 -ne $BootstrapLauncherBase64) {
    Write-Error 'Bootstrap launcher bytes do not match the durable transaction plan.'
    exit 1
  }
  if ($controllerPath -and -not (Test-Path -LiteralPath $controllerPath -PathType Leaf)) {
    Write-Error 'Bootstrap recovery controller was not durably prepared by the transaction owner.'
    exit 1
  }
}

if ($EvolverBin -and -not $BootstrapExclusive) {
  # Service installation is the explicit upgrade boundary for the stable controller.
  $existingTask = Get-SingleEvolverTask
  if ($existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 100
      $existingTask = Get-SingleEvolverTask
    } while ($existingTask -and $existingTask.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
    if ($existingTask -and $existingTask.State -eq 'Running') {
      Write-Error 'Existing Evolver Scheduled Task did not stop; refusing to replace its recovery controller.'
      exit 1
    }
  }
  $env:EVOLVER_SELF_UPDATE_STATE_DIR = $SelfUpdateStateDir
  $env:EVOLVER_SELF_UPDATE_TARGET_PATH = $EvolverBin
  $env:EVOLVER_INTERNAL_BOOTSTRAP_EXCLUSIVE = if ($BootstrapExclusive) { '1' } else { '0' }
  & $EvolverBin 'proxy' '--evolver-windows-recovery-controller-provision'
  $controllerExitCode = $LASTEXITCODE
  Remove-Item Env:\EVOLVER_INTERNAL_BOOTSTRAP_EXCLUSIVE -ErrorAction SilentlyContinue
  if ($controllerExitCode -ne 0) {
    Write-Error 'Failed to provision the stable Windows recovery controller.'
    exit 1
  }
}

if (-not (Test-Path $launcherDir)) { New-Item -ItemType Directory -Path $launcherDir | Out-Null }
$launcherDirItem = Get-Item -LiteralPath $launcherDir -Force
if (-not $launcherDirItem.PSIsContainer -or (($launcherDirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
  Write-Error 'Evolver launcher directory must be a regular local directory.'
  exit 1
}

$nodeEsc = if ($NodePath) { $NodePath.Replace('"', '""') } else { '' }
$proxyEsc = if ($ProxyBin) { $ProxyBin.Replace('"', '""') } else { '' }
$evolverEsc = if ($EvolverBin) { $EvolverBin.Replace('"', '""') } else { '' }
$envEsc = if ($EnvFile) { $EnvFile.Replace('"', '""') } else { '' }
$lifecycleStateDirEsc = if ($LifecycleStateDir) { $LifecycleStateDir.Replace('"', '""') } else { '' }
$stateDirEsc = if ($SelfUpdateStateDir) { $SelfUpdateStateDir.Replace('"', '""') } else { '' }

$launcherBody = @"
' AUTO-GENERATED by install-evolver-proxy-windows.ps1 -- do not edit.
' wscript.exe is a Windows-subsystem host. WshShell.Run(..., 0, True)
' launches node.exe hidden and waits so Task Scheduler sees the exit code.
Dim WshShell, env, fso, stateDir, pendingPath, updaterPath, controllerPath, controllerCmd, cmd, rc
Set WshShell = CreateObject("WScript.Shell")
Set env = WshShell.Environment("PROCESS")
Set fso = CreateObject("Scripting.FileSystemObject")
If "$envEsc" <> "" Then env("EVOLVER_ENV_FILE") = "$envEsc"
If "$lifecycleStateDirEsc" <> "" Then env("EVOLVER_LIFECYCLE_STATE_DIR") = "$lifecycleStateDirEsc"
env("EVOLVER_SELF_UPDATE_SUPERVISOR") = "windows-scheduled-task"
If "$evolverEsc" <> "" Then
  stateDir = "$stateDirEsc"
  env("EVOLVER_SELF_UPDATE_STATE_DIR") = stateDir
  env("EVOLVER_SELF_UPDATE_TARGET_PATH") = "$evolverEsc"
  pendingPath = stateDir & "\windows-updater\pending.json"
  updaterPath = stateDir & "\windows-updater\updater.exe"
  controllerPath = stateDir & "\windows-controller\evolver-recovery-controller.exe"
  cmd = """$evolverEsc"" proxy"
  If Not fso.FileExists(controllerPath) Then WScript.Quit 1
  If fso.FileExists(pendingPath) And Not fso.FileExists(updaterPath) Then WScript.Quit 1
  controllerCmd = """" & controllerPath & """ proxy --evolver-windows-recovery-controller"
  rc = WshShell.Run(controllerCmd, 0, True)
  WScript.Quit rc
Else
  cmd = """$nodeEsc"" ""$proxyEsc"""
End If
rc = WshShell.Run(cmd, 0, True)
WScript.Quit rc
"@
$tempLauncherPath = Join-Path $launcherDir ('.evolver-proxy-task-launcher.' + [Guid]::NewGuid().ToString('N') + '.tmp')
if (-not $BootstrapExclusive) {
  try {
    Set-Content -LiteralPath $tempLauncherPath -Value $launcherBody -Encoding Unicode
    Move-Item -LiteralPath $tempLauncherPath -Destination $launcherPath -Force
  } finally {
    if (Test-Path -LiteralPath $tempLauncherPath) { Remove-Item -LiteralPath $tempLauncherPath -Force }
  }
}

$action = New-ScheduledTaskAction -Execute $WscriptPath -Argument ('"{0}"' -f $launcherPath)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$description = if ($BootstrapExclusive) { 'EvoMap Evolver bootstrap transaction ' + $BootstrapTransactionId } else { 'EvoMap Evolver Proxy Daemon' }
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description
if ($BootstrapExclusive) {
  Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -InputObject $task | Out-Null
} else {
  Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -InputObject $task -Force | Out-Null
}
# The proxy hands off right after bootstrap; start the task now so the current session is
# supervised immediately, while the -AtLogOn trigger keeps it durable across logins.
Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
Write-Host "Installed scheduled task '$TaskName' using hidden wscript launcher $launcherPath."
`;
}
export function renderWindowsAutoexecInstaller(defaults = {}) {
    const ps = (value) => `'${assertSingleLine(value ?? '', 'Windows installer value').replaceAll("'", "''")}'`;
    return String.raw `param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$TaskName = 'EvoMapEvolverAutoexecDaemon',
  [string]$EvolverBin = ${ps(defaults.evolverBin)},
  [string]$NodePath = ${ps(defaults.nodePath)},
  [string]$CliBin = ${ps(defaults.cliBin)},
  [string]$EnvFile = ${ps(defaults.envFile)},
  [string]$AutoexecHome = ${ps(defaults.autoexecHome)},
  [string]$WorkingDirectory = ${ps(defaults.workingDirectory)},
  [string]$WscriptPath = ${ps(defaults.wscriptPath ?? trustedWindowsSystemExecutable('wscript.exe'))}
)

$ErrorActionPreference = 'Stop'

if (-not ($Install -or $Uninstall) -or ($Install -and $Uninstall)) {
  Write-Host 'Usage: install-evolver-autoexec-windows.ps1 -Install [-EvolverBin ... | -NodePath ... -CliBin ...] [-EnvFile ...] [-AutoexecHome ...]'
  Write-Host '       install-evolver-autoexec-windows.ps1 -Uninstall [-TaskName ...]'
  exit 1
}

if (-not $env:LOCALAPPDATA) { Write-Error 'LOCALAPPDATA is required'; exit 1 }
$launcherDir = Join-Path $env:LOCALAPPDATA 'EvoMap'
$launcherPath = Join-Path $launcherDir 'evolver-autoexec-task-launcher.vbs'

function Get-ExactEvolverAutoexecTaskInventory {
  try {
    return @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $TaskName })
  } catch {
    Write-Error 'Unable to inventory the Evolver Autoexec Scheduled Task.'
    exit 1
  }
}

function Get-SingleEvolverAutoexecTask {
  $tasks = @(Get-ExactEvolverAutoexecTaskInventory)
  if ($tasks.Count -gt 1) {
    Write-Error 'Multiple Evolver Autoexec Scheduled Tasks matched the exact task name.'
    exit 1
  }
  if ($tasks.Count -eq 1) { return $tasks[0] }
  return $null
}

if ($Uninstall) {
  $existing = Get-SingleEvolverAutoexecTask
  if ($existing) {
    if ($existing.State -eq 'Running') {
      Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName
      $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 100
        $existing = Get-SingleEvolverAutoexecTask
      } while ($existing -and $existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
      if ($existing -and $existing.State -eq 'Running') {
        Write-Error 'Existing Evolver Autoexec Scheduled Task did not stop; refusing to uninstall.'
        exit 1
      }
    }
    $existing = Get-SingleEvolverAutoexecTask
    if ($existing) {
      Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
    }
  }
  if (@(Get-ExactEvolverAutoexecTaskInventory).Count -ne 0) {
    Write-Error 'Evolver Autoexec Scheduled Task still exists after unregister.'
    exit 1
  }
  if (Test-Path -LiteralPath $launcherPath) { Remove-Item -LiteralPath $launcherPath -Force }
  if (Test-Path -LiteralPath $launcherPath) {
    Write-Error 'Evolver Autoexec task launcher still exists after removal.'
    exit 1
  }
  exit 0
}

if (-not $EvolverBin) {
  if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Error 'Pass -EvolverBin, or install node.exe / pass -NodePath.'; exit 1 }
    $NodePath = $cmd.Source
  }
  if (-not $CliBin) { Write-Error 'Pass -EvolverBin, or -CliBin pointing at evolver CLI cli.js.'; exit 1 }
  if (-not (Test-Path $CliBin)) { Write-Error "Evolver CLI not found at $CliBin"; exit 1 }
} elseif (-not (Test-Path $EvolverBin)) {
  Write-Error "Evolver binary not found at $EvolverBin"
  exit 1
}

foreach ($launcherValue in @($EvolverBin, $NodePath, $CliBin, $EnvFile, $AutoexecHome, $WorkingDirectory)) {
  if ($launcherValue -match "[\r\n]") {
    Write-Error 'Launcher paths must not contain line breaks.'
    exit 1
  }
}

if (-not $WorkingDirectory) { $WorkingDirectory = $env:USERPROFILE }
if (-not (Test-Path $WorkingDirectory -PathType Container)) {
  Write-Error 'WorkingDirectory must be an existing directory.'
  exit 1
}

$existing = Get-SingleEvolverAutoexecTask
if ($existing -and $existing.State -eq 'Running') {
  Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 100
    $existing = Get-SingleEvolverAutoexecTask
  } while ($existing -and $existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
  if ($existing -and $existing.State -eq 'Running') {
    Write-Error 'Existing Evolver Autoexec Scheduled Task did not stop; refusing to replace it.'
    exit 1
  }
}

if (-not (Test-Path $launcherDir)) { New-Item -ItemType Directory -Path $launcherDir | Out-Null }

$nodeEsc = if ($NodePath) { $NodePath.Replace('"', '""') } else { '' }
$cliEsc = if ($CliBin) { $CliBin.Replace('"', '""') } else { '' }
$evolverEsc = if ($EvolverBin) { $EvolverBin.Replace('"', '""') } else { '' }
$envEsc = if ($EnvFile) { $EnvFile.Replace('"', '""') } else { '' }
$homeEsc = if ($AutoexecHome) { $AutoexecHome.Replace('"', '""') } else { '' }

$launcherBody = @"
' AUTO-GENERATED by install-evolver-autoexec-windows.ps1 -- do not edit.
Dim WshShell, env, cmd, rc
Set WshShell = CreateObject("WScript.Shell")
Set env = WshShell.Environment("PROCESS")
If "$envEsc" <> "" Then env("EVOLVER_ENV_FILE") = "$envEsc"
If "$evolverEsc" <> "" Then
  cmd = """$evolverEsc"" autoexec"
Else
  cmd = """$nodeEsc"" ""$cliEsc"" autoexec"
End If
If "$homeEsc" <> "" Then cmd = cmd & " ""$homeEsc"""
rc = WshShell.Run(cmd, 0, True)
WScript.Quit rc
"@
Set-Content -LiteralPath $launcherPath -Value $launcherBody -Encoding Unicode

$action = New-ScheduledTaskAction -Execute $WscriptPath -Argument ('"{0}"' -f $launcherPath) -WorkingDirectory $WorkingDirectory
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -InputObject $task -Force | Out-Null
if (-not (Get-SingleEvolverAutoexecTask)) {
  Write-Error 'Evolver Autoexec Scheduled Task was not present after registration.'
  exit 1
}
Write-Host "Installed scheduled task '$TaskName' using hidden wscript launcher $launcherPath."
`;
}
function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg?.startsWith('--'))
            continue;
        const raw = arg.slice(2);
        const eq = raw.indexOf('=');
        if (eq >= 0)
            out[raw.slice(0, eq)] = raw.slice(eq + 1);
        else if (argv[i + 1] && !argv[i + 1].startsWith('--'))
            out[raw] = argv[++i];
        else
            out[raw] = true;
    }
    return out;
}
function parseRemoveServiceFlags(argv) {
    const values = new Map();
    const allowed = new Set(['target', 'dry-run', 'env-file']);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) {
            throw new Error(`remove-service does not accept positional argument: ${argument}`);
        }
        const raw = argument.slice(2);
        const separator = raw.indexOf('=');
        const name = separator >= 0 ? raw.slice(0, separator) : raw;
        if (!allowed.has(name))
            throw new Error(`remove-service does not accept --${name || '<empty>'}`);
        if (values.has(name))
            throw new Error(`remove-service received duplicate --${name}`);
        if (name === 'dry-run') {
            if (separator >= 0) {
                throw new Error('--dry-run is a boolean flag and does not accept a value');
            }
            values.set(name, true);
            continue;
        }
        const inlineValue = separator >= 0 ? raw.slice(separator + 1) : undefined;
        const followingValue = separator < 0 ? argv[index + 1] : undefined;
        const value = inlineValue ?? followingValue;
        if (value === undefined || value.startsWith('--') || !value.trim()) {
            throw new Error(`--${name} requires a non-empty value`);
        }
        if (separator < 0)
            index += 1;
        values.set(name, value.trim());
    }
    const target = serviceTarget(Object.fromEntries(values));
    const envFile = values.get('env-file');
    return {
        target,
        dryRun: values.get('dry-run') === true,
        ...(typeof envFile === 'string' ? { envFile } : {}),
    };
}
function parseBootstrapFlags(argv) {
    const out = {};
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--') || argument === '--') {
            throw new Error('lifecycle bootstrap does not accept positional arguments');
        }
        const separator = argument.indexOf('=');
        const name = argument.slice(2, separator >= 0 ? separator : undefined);
        if (name === 'with-autoexec' || name === 'autoexec-home') {
            throw new Error('lifecycle bootstrap manages only the proxy supervisor; --with-autoexec and --autoexec-home are unsupported and no artifacts were changed');
        }
        if (!['target', 'env-file', 'cwd', 'dry-run'].includes(name)) {
            throw new Error('lifecycle bootstrap received an unknown option');
        }
        if (seen.has(name)) {
            throw new Error(`lifecycle bootstrap received duplicate --${name}`);
        }
        seen.add(name);
        if (name === 'dry-run') {
            if (separator >= 0) {
                throw new Error('--dry-run is a boolean flag and does not accept a value');
            }
            out[name] = true;
            continue;
        }
        const value = separator >= 0
            ? argument.slice(separator + 1)
            : argv[index + 1]?.startsWith('--') === false
                ? argv[++index]
                : undefined;
        if (value === undefined || value.trim().length === 0) {
            throw new Error(`--${name} requires a non-empty value`);
        }
        assertSingleLine(value, `bootstrap --${name}`);
        if (name === 'target' && !['launchd', 'systemd', 'windows'].includes(value)) {
            throw new Error('missing or invalid --target (expected: launchd|systemd|windows)');
        }
        out[name] = value;
    }
    return out;
}
function serviceTarget(flags) {
    const value = typeof flags['target'] === 'string' ? flags['target'] : '';
    if (value === 'launchd' || value === 'systemd' || value === 'windows')
        return value;
    throw new Error('missing or invalid --target (expected: launchd|systemd|windows)');
}
function filesystemEntryExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (typeof error === 'object' && error !== null
            && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function sameLifecyclePath(left, right, target) {
    return bootstrapInventoryKey(left, target) === bootstrapInventoryKey(right, target);
}
function canonicalLifecycleBindingPath(value, target, label) {
    return canonicalLegacyPath(value, target, label);
}
function exactMarkerArtifactReceipt(artifacts, path, target) {
    const canonical = canonicalLifecycleBindingPath(path, target, 'self-update controller');
    const matches = artifacts.filter((artifact) => sameLifecyclePath(artifact.path, canonical, target));
    if (matches.length !== 1) {
        throw new Error('committed lifecycle manager does not uniquely receipt its recovery controller');
    }
    const expected = matches[0];
    if (!expected.device || !expected.inode) {
        throw new Error('committed lifecycle recovery controller has no exact durable identity');
    }
    const actual = readBootstrapArtifactFile(canonical, undefined, { role: 'owned' }).identity;
    if (actual.size !== expected.size
        || actual.sha256 !== expected.sha256
        || actual.device !== expected.device
        || actual.inode !== expected.inode) {
        throw new Error('committed lifecycle recovery controller changed after its receipt');
    }
}
function unixManagerSelfUpdateBinding(input) {
    const source = input.bytes.toString('utf8');
    if (!input.bytes.equals(Buffer.from(source, 'utf8'))) {
        throw new Error('committed lifecycle manager artifact is not canonical UTF-8');
    }
    const environment = input.target === 'systemd'
        ? systemdUnitEnvironment(source)
        : launchdPlistEnvironment(source);
    const transaction = environment.get(coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV);
    if (input.bindingKind === 'transaction'
        ? transaction !== input.transactionId
        : transaction !== undefined) {
        throw new Error('committed lifecycle manager transaction does not match its marker');
    }
    const targetPath = environment.get('EVOLVER_SELF_UPDATE_TARGET_PATH');
    const selfUpdateStateDir = environment.get('EVOLVER_SELF_UPDATE_STATE_DIR');
    if (targetPath === undefined && selfUpdateStateDir === undefined)
        return undefined;
    if (!targetPath || !selfUpdateStateDir) {
        throw new Error('committed lifecycle manager has a partial self-update binding');
    }
    const expectedSupervisor = input.target === 'systemd' ? 'systemd' : 'launchd';
    if (environment.get('EVOLVER_SELF_UPDATE_SUPERVISOR') !== expectedSupervisor) {
        throw new Error('committed lifecycle manager has an invalid self-update supervisor binding');
    }
    const lifecycleStateDir = environment.get('EVOLVER_LIFECYCLE_STATE_DIR');
    if (input.bindingKind === 'transaction'
        ? !lifecycleStateDir || !sameLifecyclePath(lifecycleStateDir, input.stateDir, input.target)
        : lifecycleStateDir !== undefined
            && !sameLifecyclePath(lifecycleStateDir, input.stateDir, input.target)) {
        throw new Error('committed lifecycle manager does not bind the marker state directory');
    }
    const canonicalTarget = canonicalLifecycleBindingPath(targetPath, input.target, 'self-update target');
    const canonicalStateDir = canonicalLifecycleBindingPath(selfUpdateStateDir, input.target, 'self-update state directory');
    const pathApi = input.target === 'systemd' || input.target === 'launchd' ? posix : win32;
    const expectedController = pathApi.join(canonicalStateDir, 'unix-controller', UNIX_RECOVERY_CONTROLLER_FILENAME);
    const managerArguments = input.target === 'systemd'
        ? systemdUnitExecArguments(source)
        : launchdPlistProgramArguments(source);
    if (managerArguments.length !== 3
        || !sameLifecyclePath(managerArguments[0], expectedController, input.target)
        || managerArguments[1] !== 'proxy'
        || managerArguments[2] !== '--evolver-unix-recovery-controller') {
        throw new Error('committed lifecycle manager does not invoke its exact recovery controller');
    }
    exactMarkerArtifactReceipt(input.artifacts, expectedController, input.target);
    return { targetPath: canonicalTarget, stateDir: canonicalStateDir };
}
function windowsManagerSelfUpdateBinding(input) {
    const journal = {
        transactionId: input.transactionId,
        managerBinding: {
            artifactPath: input.managerArtifactPath,
            kind: input.bindingKind,
        },
        artifacts: input.artifacts.map((artifact) => ({
            path: artifact.path,
            claimPath: '',
            rollbackPath: '',
            before: 'absent',
            identity: {
                size: artifact.size,
                sha256: artifact.sha256,
                ...(artifact.device ? { device: artifact.device } : {}),
                ...(artifact.inode ? { inode: artifact.inode } : {}),
            },
        })),
    };
    const parsed = parseWindowsBootstrapLauncherBinding(journal, input.bytes);
    if (parsed.mode === 'direct')
        return undefined;
    if (!parsed.selfUpdateStateDir || !parsed.controllerExecutable) {
        throw new Error('committed Windows lifecycle manager has a partial recovery binding');
    }
    if (input.bindingKind === 'transaction'
        ? !parsed.lifecycleStateDir
            || !sameLifecyclePath(parsed.lifecycleStateDir, input.stateDir, 'windows')
        : parsed.lifecycleStateDir !== undefined
            && !sameLifecyclePath(parsed.lifecycleStateDir, input.stateDir, 'windows')) {
        throw new Error('committed Windows lifecycle manager does not bind the marker state directory');
    }
    const targetPath = canonicalLifecycleBindingPath(parsed.proxyExecutable, 'windows', 'self-update target');
    const selfUpdateStateDir = canonicalLifecycleBindingPath(parsed.selfUpdateStateDir, 'windows', 'self-update state directory');
    const expectedController = win32.join(selfUpdateStateDir, 'windows-controller', 'evolver-recovery-controller.exe');
    if (!sameLifecyclePath(parsed.controllerExecutable, expectedController, 'windows')) {
        throw new Error('committed Windows lifecycle manager does not invoke its exact recovery controller');
    }
    exactMarkerArtifactReceipt(input.artifacts, expectedController, 'windows');
    return { targetPath, stateDir: selfUpdateStateDir };
}
function managerSelfUpdateBinding(input) {
    return input.target === 'windows'
        ? windowsManagerSelfUpdateBinding(input)
        : unixManagerSelfUpdateBinding({ ...input, target: input.target });
}
function defaultBootstrapControlRun(command, args, timeoutMs = BOOTSTRAP_COMMAND_TIMEOUT_MS) {
    const result = spawnSync(command, [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        windowsHide: true,
    });
    return {
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
        ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
    };
}
function readLegacyLifecycleSelfUpdateSnapshot(input) {
    const { legacy, target, stateDir, env, deps } = input;
    if (legacy.marker.target !== target) {
        throw new Error(`lifecycle target ${target} does not match committed bootstrap target ${legacy.marker.target}`);
    }
    const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    const run = deps.run ?? defaultBootstrapControlRun;
    let managerState;
    let legacyWindowsLauncherPath;
    if (target === 'windows') {
        managerState = probeBootstrapManagerState(target, run, uid, BOOTSTRAP_COMMAND_TIMEOUT_MS);
        requireBootstrapManagerState(managerState, ['absent', 'present', 'disabled'], 'legacy self-update guard manager preflight');
        if (managerState !== 'absent') {
            legacyWindowsLauncherPath = probeLegacyWindowsLauncherPath(run, BOOTSTRAP_COMMAND_TIMEOUT_MS, managerState !== 'disabled');
        }
    }
    const plan = legacyBootstrapArtifactPlan(legacy, {
        status: 'rendered',
        files: legacy.marker.files,
        service: legacy.marker.service,
    }, target, env, stateDir, legacyWindowsLauncherPath, managerState === 'absent', true, uid);
    const artifacts = captureLegacyBootstrapArtifactReceipts(plan.paths, plan.expected, target, uid);
    let binding;
    if (target === 'windows') {
        const installerPath = resolvePath(legacy.marker.files[0]);
        const installer = readBootstrapArtifactFile(installerPath, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'owned' });
        const source = installer.bytes.toString('utf8');
        if (!installer.bytes.equals(Buffer.from(source, 'utf8'))) {
            throw new Error('legacy Windows lifecycle installer is not canonical UTF-8');
        }
        const defaults = parseLegacyWindowsInstallerDefaults(source).defaults;
        if (defaults.evolverBin) {
            const targetPath = canonicalLifecycleBindingPath(defaults.evolverBin, target, 'self-update target');
            const selfUpdateStateDir = canonicalLifecycleBindingPath(defaults.selfUpdateStateDir
                ?? win32.join(win32.dirname(targetPath), '.evolver-update'), target, 'self-update state directory');
            binding = { targetPath, stateDir: selfUpdateStateDir };
        }
    }
    else {
        const managerArtifactPath = bootstrapManagerArtifact(target, artifacts.map((artifact) => artifact.path));
        const manager = readBootstrapArtifactFile(managerArtifactPath, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'owned' });
        binding = managerSelfUpdateBinding({
            target,
            stateDir,
            transactionId: '00000000-0000-4000-8000-000000000000',
            bindingKind: coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING,
            artifacts,
            managerArtifactPath,
            bytes: manager.bytes,
        });
    }
    return {
        kind: 'legacy',
        marker: legacy,
        ...(binding ? { binding } : {}),
        ...(managerState ? { managerState } : {}),
    };
}
function readCommittedLifecycleSelfUpdateSnapshot(input) {
    if (input.action === 'remove-service') {
        const pending = readBootstrapJournal(input.stateDir);
        if (pending?.terminalAction === 'remove_committed'
            && pending.managerDetached === true
            && pending.artifactsRestored === true) {
            return { kind: 'absent' };
        }
    }
    const markerPath = bootstrapMarkerPath(input.stateDir);
    if (!filesystemEntryExists(markerPath))
        return { kind: 'absent' };
    let marker;
    try {
        marker = readBootstrapMarker(input.stateDir);
    }
    catch {
        try {
            const legacy = readLegacyBootstrapMarker(input.stateDir);
            if (!legacy) {
                throw new Error('committed lifecycle marker changed while establishing self-update authority');
            }
            return readLegacyLifecycleSelfUpdateSnapshot({ ...input, legacy });
        }
        catch (legacyError) {
            if (input.action !== 'bootstrap')
                throw legacyError;
            const uid = input.deps.uid
                ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
            const managerState = probeBootstrapManagerState(input.target, input.deps.run ?? defaultBootstrapControlRun, uid, BOOTSTRAP_COMMAND_TIMEOUT_MS);
            requireBootstrapManagerState(managerState, ['absent'], 'invalid marker self-update guard manager preflight');
            const invalid = readBootstrapArtifactFile(markerPath, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES);
            return {
                kind: 'invalid',
                bytes: invalid.bytes,
                identity: invalid.identity,
            };
        }
    }
    if (!marker) {
        throw new Error('committed lifecycle marker changed while establishing self-update authority');
    }
    if (marker.target !== input.target) {
        throw new Error(`lifecycle target ${input.target} does not match committed bootstrap target ${marker.target}`);
    }
    const bindingKind = marker.managerBindingKind ?? 'transaction';
    if (bindingKind === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING) {
        assertLegacyMarkerStateRootBinding(marker, input.stateDir, input.deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined));
    }
    const now = input.deps.now?.() ?? Date.now();
    const receipt = bootstrapJournalFromMarker(marker, input.owner, now + BOOTSTRAP_TRANSACTION_BUDGET_MS, now);
    const managerArtifact = readVerifiedBootstrapManagerArtifact(receipt);
    const binding = managerSelfUpdateBinding({
        target: marker.target,
        stateDir: input.stateDir,
        transactionId: marker.transactionId,
        bindingKind,
        artifacts: marker.artifacts,
        managerArtifactPath: marker.managerArtifactPath,
        bytes: managerArtifact,
    });
    return { kind: 'current', marker, ...(binding ? { binding } : {}) };
}
function sameCommittedLifecycleSelfUpdateSnapshot(left, right) {
    if (left.kind !== right.kind)
        return false;
    if (left.kind === 'absent' || right.kind === 'absent')
        return true;
    if (left.kind === 'invalid' && right.kind === 'invalid') {
        return left.bytes.equals(right.bytes)
            && left.identity.size === right.identity.size
            && left.identity.sha256 === right.identity.sha256
            && left.identity.device === right.identity.device
            && left.identity.inode === right.identity.inode;
    }
    if (left.kind === 'invalid' || right.kind === 'invalid')
        return false;
    const sameBinding = left.binding?.targetPath === right.binding?.targetPath
        && left.binding?.stateDir === right.binding?.stateDir;
    if (!sameBinding)
        return false;
    if (left.kind === 'current' && right.kind === 'current') {
        return sameBootstrapMarker(left.marker, right.marker);
    }
    if (left.kind !== 'legacy' || right.kind !== 'legacy')
        return false;
    return left.managerState === right.managerState
        && left.marker.raw === right.marker.raw
        && left.marker.identity.size === right.marker.identity.size
        && left.marker.identity.sha256 === right.marker.identity.sha256
        && left.marker.identity.device === right.marker.identity.device
        && left.marker.identity.inode === right.marker.identity.inode;
}
function configuredLifecycleSelfUpdateBindings(input, committed) {
    const configuredTarget = nonBlankEnv(input.env, 'EVOLVER_SELF_UPDATE_TARGET_PATH');
    const configuredStateDir = nonBlankEnv(input.env, 'EVOLVER_SELF_UPDATE_STATE_DIR');
    const canonicalConfiguredTarget = configuredTarget
        ? canonicalLifecycleBindingPath(configuredTarget, input.target, 'self-update target')
        : undefined;
    const pathApi = input.target === 'windows' ? win32 : posix;
    const configuredBinding = canonicalConfiguredTarget
        ? {
            targetPath: canonicalConfiguredTarget,
            stateDir: configuredStateDir
                ? canonicalLifecycleBindingPath(configuredStateDir, input.target, 'self-update state directory')
                : pathApi.join(pathApi.dirname(canonicalConfiguredTarget), '.evolver-update'),
        }
        : undefined;
    const committedBinding = committed.kind === 'current' || committed.kind === 'legacy'
        ? committed.binding
        : undefined;
    if (committedBinding) {
        const targetMismatch = canonicalConfiguredTarget !== undefined
            && !sameLifecyclePath(canonicalConfiguredTarget, committedBinding.targetPath, input.target);
        const stateMismatch = configuredStateDir !== undefined
            && !sameLifecyclePath(canonicalLifecycleBindingPath(configuredStateDir, input.target, 'self-update state directory'), committedBinding.stateDir, input.target);
        if (!targetMismatch && !stateMismatch)
            return [committedBinding];
        if (input.action === 'bootstrap' && configuredBinding) {
            assertActiveBootstrapRegistrationIntentToken(input.stateDir, input.env[coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV]);
            return sameLifecyclePath(committedBinding.targetPath, configuredBinding.targetPath, input.target) && sameLifecyclePath(committedBinding.stateDir, configuredBinding.stateDir, input.target)
                ? [committedBinding]
                : [committedBinding, configuredBinding];
        }
        throw new Error(targetMismatch
            ? 'configured self-update target does not match the committed lifecycle manager'
            : 'configured self-update state directory does not match the committed lifecycle manager');
    }
    if (committed.kind === 'current' || committed.kind === 'legacy') {
        if (!configuredTarget && !configuredStateDir)
            return [];
        if (input.action !== 'bootstrap' || !configuredBinding) {
            throw new Error('committed lifecycle manager has no authoritative self-update binding');
        }
        const registrationToken = input.env[coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV];
        assertActiveBootstrapRegistrationIntentToken(input.stateDir, registrationToken);
    }
    if (!configuredBinding) {
        if (configuredStateDir) {
            throw new Error('self-update state directory requires an authoritative target');
        }
        const executable = resolveSelfUpdatingExecutable(process.execPath, input.argv1);
        if (!executable
            || executable.args.length !== 1
            || executable.args[0] !== 'proxy')
            return [];
        const targetPath = canonicalLifecycleBindingPath(executable.command, input.target, 'self-update target');
        return [{
                targetPath,
                stateDir: pathApi.join(pathApi.dirname(targetPath), '.evolver-update'),
            }];
    }
    return [configuredBinding];
}
async function assertNoActiveDurableSelfUpdateRecovery(input) {
    const snapshotInput = { ...input, owner: input.ownerLock.owner };
    const committed = readCommittedLifecycleSelfUpdateSnapshot(snapshotInput);
    const bindings = configuredLifecycleSelfUpdateBindings(input, committed);
    if (bindings.length === 0) {
        input.ownerLock.assertOwned();
        return;
    }
    const inspect = input.deps.inspectSelfUpdate
        ?? (await import('@evomap/evolver-proxy')).inspectDurableSelfUpdate;
    input.ownerLock.assertOwned();
    for (const binding of bindings) {
        const recovery = await inspect({
            env: {
                ...input.env,
                EVOLVER_SELF_UPDATE_TARGET_PATH: binding.targetPath,
                EVOLVER_SELF_UPDATE_STATE_DIR: binding.stateDir,
            },
            processExecPath: binding.targetPath,
            targetPath: binding.targetPath,
            stateDir: binding.stateDir,
        });
        input.ownerLock.assertOwned();
        if (recovery.outcome !== 'none'
            && recovery.outcome !== 'confirmed'
            && recovery.outcome !== 'rolled_back') {
            const stage = recovery.stage ? `, stage=${recovery.stage}` : '';
            throw new Error(`lifecycle ${input.action} refused while durable self-update recovery is active `
                + `(outcome=${recovery.outcome}${stage}); complete self-update recovery before retrying`);
        }
    }
    const revalidated = readCommittedLifecycleSelfUpdateSnapshot(snapshotInput);
    if (!sameCommittedLifecycleSelfUpdateSnapshot(committed, revalidated)) {
        throw new Error('committed lifecycle self-update authority changed during inspection');
    }
    input.ownerLock.assertOwned();
}
async function installService(target, flags, env, argv1, loadUnixRecoveryController = () => import('@evomap/evolver-proxy'), options = {}) {
    const dryRun = flags['dry-run'] === true;
    const lifecycleStateDir = lifecyclePaths(env).stateDir;
    if (flags['with-autoexec'] !== undefined && flags['with-autoexec'] !== true) {
        throw new Error('--with-autoexec is a boolean flag and does not accept a value');
    }
    if (flags['autoexec-home'] === true) {
        throw new Error('--autoexec-home requires a path');
    }
    const withAutoexec = flags['with-autoexec'] === true;
    if (!withAutoexec && flags['autoexec-home'] !== undefined) {
        throw new Error('--autoexec-home requires --with-autoexec');
    }
    const configuredEnvFile = typeof flags['env-file'] === 'string'
        ? flags['env-file'].trim()
        : nonBlankEnv(env, 'EVOLVER_ENV_FILE');
    const envFile = configuredEnvFile
        ? resolvePath(expandHomePath(configuredEnvFile))
        : undefined;
    const supervised = configuredSelfUpdateTarget(env)
        ? resolveDaemonCommand(env, process.execPath, argv1)
        : resolveSelfUpdatingExecutable(process.execPath, argv1);
    const standaloneTarget = supervised?.args.length === 1 && supervised.args[0] === 'proxy'
        ? supervised.command
        : undefined;
    let unixController;
    let unixControllerStateDir;
    if (target !== 'windows' && standaloneTarget) {
        const controllerModule = await loadUnixRecoveryController();
        options.assertOwner?.();
        const { provisionStableUnixRecoveryController, stableUnixRecoveryControllerPathForTarget, UNIX_RECOVERY_CONTROLLER_ARG, } = controllerModule;
        const stateDir = env['EVOLVER_SELF_UPDATE_STATE_DIR']?.trim() || undefined;
        const stableControllerPath = stableUnixRecoveryControllerPathForTarget(standaloneTarget, stateDir);
        const controllerPublication = options.exclusive && !dryRun
            ? bootstrapPublication(stableControllerPath, options)
            : undefined;
        const controllerPath = dryRun
            ? stableControllerPath
            : await (async () => {
                options.assertOwner?.();
                const published = await provisionStableUnixRecoveryController({
                    env: { ...env, EVOLVER_SELF_UPDATE_TARGET_PATH: standaloneTarget },
                    processExecPath: standaloneTarget,
                    replaceExisting: !options.exclusive,
                    ...(controllerPublication ? {
                        artifactClaimPath: controllerPublication.claimPath,
                        onArtifactPublished: controllerPublication.onPublished,
                    } : {}),
                });
                options.assertOwner?.();
                return published;
            })();
        options.assertOwner?.();
        unixController = {
            command: controllerPath,
            args: ['proxy', UNIX_RECOVERY_CONTROLLER_ARG],
            display: `${controllerPath} proxy ${UNIX_RECOVERY_CONTROLLER_ARG}`,
        };
        unixControllerStateDir = dirname(dirname(controllerPath));
    }
    const serviceCommand = unixController ?? supervised;
    const autoexecHomeFlag = typeof flags['autoexec-home'] === 'string' ? flags['autoexec-home'].trim() : undefined;
    if (autoexecHomeFlag !== undefined && !autoexecHomeFlag) {
        throw new Error('--autoexec-home requires a non-empty path');
    }
    const companionWorkingDirectoryFlag = typeof flags['cwd'] === 'string'
        ? assertSingleLine(flags['cwd'].trim(), 'service working directory')
        : undefined;
    const companionWorkingDirectory = companionWorkingDirectoryFlag
        ? (isAbsolute(companionWorkingDirectoryFlag) ? companionWorkingDirectoryFlag : resolvePath(companionWorkingDirectoryFlag))
        : process.cwd();
    const autoexecHome = autoexecHomeFlag
        ? assertSingleLine(isAbsolute(autoexecHomeFlag) ? autoexecHomeFlag : resolvePath(companionWorkingDirectory, autoexecHomeFlag), 'autoexec home')
        : undefined;
    const autoexecCommand = withAutoexec
        ? resolveAutoexecDaemonCommand(env, process.execPath, argv1, autoexecHome)
        : undefined;
    if (withAutoexec && !autoexecCommand) {
        throw new Error('cannot resolve the current evolver CLI for --with-autoexec; pass a standalone Evolver binary or run through cli.js');
    }
    if (target === 'systemd') {
        const path = expandHome('~/.config/systemd/user/evolver-proxy.service');
        const autoexecPath = expandHome('~/.config/systemd/user/evolver-autoexec.service');
        const workingDirectory = typeof flags['cwd'] === 'string' ? flags['cwd'] : undefined;
        const unit = renderSystemdUnit({
            envFile,
            lifecycleStateDir,
            workingDirectory,
            ...(serviceCommand
                ? { execStart: [serviceCommand.command, ...serviceCommand.args].map(quoteSystemdArg).join(' ') }
                : {}),
            ...(standaloneTarget ? { selfUpdateTarget: standaloneTarget } : {}),
            ...(unixControllerStateDir ? { selfUpdateStateDir: unixControllerStateDir } : {}),
            ...(options.transactionId ? { bootstrapTransactionId: options.transactionId } : {}),
        });
        if (!dryRun)
            writeServiceArtifact(path, unit, 0o644, options);
        let autoexecUnit;
        if (autoexecCommand) {
            autoexecUnit = renderAutoexecSystemdUnit({
                envFile,
                workingDirectory: companionWorkingDirectory,
                execStart: [autoexecCommand.command, ...autoexecCommand.args].map(quoteSystemdArg).join(' '),
            });
            if (!dryRun)
                writeServiceArtifact(autoexecPath, autoexecUnit, 0o644, options);
        }
        return {
            status: dryRun ? 'rendered' : 'installed',
            files: [path, ...(autoexecCommand ? [autoexecPath] : []), ...(unixController ? [unixController.command] : [])],
            bootstrapArtifacts: [path, ...(autoexecCommand ? [autoexecPath] : []), ...(unixController ? [unixController.command] : [])],
            bootstrapArtifactIdentities: expectedBootstrapArtifactIdentities([
                [path, unit],
                ...(autoexecUnit ? [[autoexecPath, autoexecUnit]] : []),
                ...(unixController && standaloneTarget && existsSync(standaloneTarget)
                    ? [[unixController.command, { sourcePath: standaloneTarget }]]
                    : []),
            ]),
            service: 'systemd-user',
            ...(autoexecHome ? { autoexecHome } : {}),
        };
    }
    if (target === 'launchd') {
        const path = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        const autoexecPath = expandHome('~/Library/LaunchAgents/com.evomap.evolver-autoexec.plist');
        const workingDirectory = companionWorkingDirectory;
        const logDir = join(homedir(), 'Library', 'Logs');
        const plist = renderLaunchdPlist({
            envFile,
            lifecycleStateDir,
            workingDirectory,
            ...(serviceCommand
                ? { programArguments: [serviceCommand.command, ...serviceCommand.args] }
                : {}),
            ...(standaloneTarget ? { selfUpdateTarget: standaloneTarget } : {}),
            ...(unixControllerStateDir ? { selfUpdateStateDir: unixControllerStateDir } : {}),
            nodePath: resolveStableNodePath(),
            proxyBin: resolveProxyBinPath() ?? (argv1?.startsWith('/') ? argv1 : undefined) ?? '/ABSOLUTE/PATH/TO/evolver-proxy.js',
            logDir,
            ...(options.transactionId ? { bootstrapTransactionId: options.transactionId } : {}),
        });
        if (!dryRun)
            writeServiceArtifact(path, plist, 0o644, options);
        let autoexecPlist;
        if (autoexecCommand) {
            autoexecPlist = renderAutoexecLaunchdPlist({
                envFile,
                workingDirectory,
                programArguments: [autoexecCommand.command, ...autoexecCommand.args],
                logDir,
            });
            if (!dryRun)
                writeServiceArtifact(autoexecPath, autoexecPlist, 0o644, options);
        }
        return {
            status: dryRun ? 'rendered' : 'installed',
            files: [path, ...(autoexecCommand ? [autoexecPath] : []), ...(unixController ? [unixController.command] : [])],
            bootstrapArtifacts: [path, ...(autoexecCommand ? [autoexecPath] : []), ...(unixController ? [unixController.command] : [])],
            bootstrapArtifactIdentities: expectedBootstrapArtifactIdentities([
                [path, plist],
                ...(autoexecPlist ? [[autoexecPath, autoexecPlist]] : []),
                ...(unixController && standaloneTarget && existsSync(standaloneTarget)
                    ? [[unixController.command, { sourcePath: standaloneTarget }]]
                    : []),
            ]),
            service: 'launchd',
            ...(autoexecHome ? { autoexecHome } : {}),
        };
    }
    let path = expandHome('~/install-evolver-proxy-windows.ps1');
    let autoexecPath = expandHome('~/install-evolver-autoexec-windows.ps1');
    const selfUpdateStateDir = env['EVOLVER_SELF_UPDATE_STATE_DIR']?.trim();
    const standalone = standaloneTarget;
    const bootstrapArtifacts = windowsBootstrapArtifacts(path, standalone, selfUpdateStateDir, env, options.exclusive === true);
    const effectiveSelfUpdateStateDir = standalone
        ? (selfUpdateStateDir ? resolvePath(selfUpdateStateDir) : join(dirname(resolvePath(standalone)), '.evolver-update'))
        : undefined;
    const windowsDefaults = {
        ...(standalone ? { evolverBin: resolvePath(standalone) } : {
            nodePath: resolveStableNodePath(),
            proxyBin: resolveProxyBinPath(),
        }),
        ...(envFile ? { envFile } : {}),
        lifecycleStateDir,
        ...(effectiveSelfUpdateStateDir ? { selfUpdateStateDir: effectiveSelfUpdateStateDir } : {}),
        ...(options.transactionId ? { bootstrapTransactionId: options.transactionId } : {}),
        wscriptPath: trustedWindowsSystemExecutable('wscript.exe'),
    };
    const script = renderWindowsInstaller(windowsDefaults);
    const windowsIdentityEntries = [[path, script]];
    if (bootstrapArtifacts[1]) {
        windowsIdentityEntries.push([bootstrapArtifacts[1], renderWindowsProxyLauncherBytes(windowsDefaults)]);
    }
    if (standalone && bootstrapArtifacts[2] && existsSync(standalone)) {
        windowsIdentityEntries.push([bootstrapArtifacts[2], { sourcePath: standalone }]);
    }
    if (!dryRun) {
        if (options.exclusive) {
            if (standalone && bootstrapArtifacts[2]) {
                const controllers = await loadUnixRecoveryController();
                options.assertOwner?.();
                if (!controllers.provisionStableWindowsRecoveryController) {
                    throw new Error('Windows recovery controller publisher is unavailable');
                }
                const controllerPublication = bootstrapPublication(bootstrapArtifacts[2], options);
                if (!controllerPublication)
                    throw new Error('Windows recovery controller requires exclusive publication');
                options.assertOwner?.();
                await controllers.provisionStableWindowsRecoveryController({
                    env: { ...env, EVOLVER_SELF_UPDATE_TARGET_PATH: standalone },
                    platform: 'win32',
                    processExecPath: standalone,
                    replaceExisting: false,
                    artifactClaimPath: controllerPublication.claimPath,
                    onArtifactPublished: controllerPublication.onPublished,
                }, standalone);
                options.assertOwner?.();
            }
            options.assertOwner?.();
            writeDurableTextExclusive(path, script, 0o600, bootstrapPublication(path, options));
            if (bootstrapArtifacts[1]) {
                options.assertOwner?.();
                writeDurableBytesExclusive(bootstrapArtifacts[1], renderWindowsProxyLauncherBytes(windowsDefaults), 0o600, bootstrapPublication(bootstrapArtifacts[1], options));
            }
        }
        else {
            options.assertOwner?.();
            path = writeWindowsHelper(path, script);
        }
    }
    if (autoexecCommand) {
        const standaloneAutoexec = autoexecCommand.args[0] === 'autoexec';
        const autoexecScript = renderWindowsAutoexecInstaller({
            ...(standaloneAutoexec
                ? { evolverBin: autoexecCommand.command }
                : { nodePath: autoexecCommand.command, cliBin: autoexecCommand.args[0] }),
            ...(envFile ? { envFile } : {}),
            ...(autoexecHome ? { autoexecHome } : {}),
            workingDirectory: companionWorkingDirectory,
        });
        if (!dryRun) {
            options.assertOwner?.();
            autoexecPath = writeWindowsHelper(autoexecPath, autoexecScript);
        }
    }
    return {
        status: dryRun ? 'rendered' : 'installed',
        files: [path, ...(autoexecCommand ? [autoexecPath] : [])],
        bootstrapArtifacts,
        bootstrapArtifactIdentities: expectedBootstrapArtifactIdentities(windowsIdentityEntries),
        service: 'windows-scheduled-task',
        ...(autoexecHome ? { autoexecHome } : {}),
    };
}
function defaultBootstrapTarget(platform) {
    if (platform === 'darwin')
        return 'launchd';
    if (platform === 'win32')
        return 'windows';
    return 'systemd';
}
async function adoptLegacyBootstrapService(input) {
    const { legacy, target, installFlags, env, argv1, loadUnixRecoveryController, install, ownerLock, deps, run, uid, deadlineMs, now, } = input;
    const assertOwner = () => ownerLock.assertOwned();
    if (legacy.marker.target !== target) {
        throw new Error(`legacy bootstrap target ${legacy.marker.target} does not match requested target ${target}`);
    }
    assertForwardMutationBudget(deadlineMs, now());
    requireBootstrapManagerState(probeBootstrapManagerState(target, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), ['present'], 'legacy adoption manager preflight');
    const legacyWindowsLauncherPath = target === 'windows'
        ? probeLegacyWindowsLauncherPath(run, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS))
        : undefined;
    assertOwner();
    const planned = await install(target, { ...installFlags, 'dry-run': true }, env, argv1, loadUnixRecoveryController, { assertOwner });
    assertOwner();
    const artifactPlan = legacyBootstrapArtifactPlan(legacy, planned, target, env, lifecyclePaths(env).stateDir, legacyWindowsLauncherPath, false, true, uid);
    const receipts = captureLegacyBootstrapArtifactReceipts(artifactPlan.paths, artifactPlan.expected, target, uid);
    const marker = {
        schema: coreBootstrap.LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA,
        transactionId: randomUUID(),
        bootstrappedAt: legacy.marker.bootstrappedAt,
        target,
        service: legacy.marker.service,
        files: [
            ...receipts.map((artifact) => artifact.path),
            ...artifactPlan.preserved.map((artifact) => artifact.path),
        ],
        managerArtifactPath: bootstrapManagerArtifact(target, receipts.map((artifact) => artifact.path)),
        managerBindingKind: coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING,
        artifacts: receipts,
        ...(artifactPlan.preserved.length > 0
            ? { preservedArtifacts: artifactPlan.preserved }
            : {}),
        ...(artifactPlan.legacyStateRootProof
            ? { legacyStateRootProof: artifactPlan.legacyStateRootProof }
            : {}),
    };
    let journal = bootstrapJournalFromMarker(marker, ownerLock.owner, deadlineMs, now());
    journal = {
        ...journal,
        stage: 'prepared',
        activationStarted: false,
        artifactsRestored: true,
    };
    journal = captureBootstrapArtifactIdentities(journal, true);
    const managerPid = assertBootstrapManagerBinding(journal, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
    if (managerPid === undefined) {
        throw new Error('legacy bootstrap manager has no running exact process binding');
    }
    await requireLegacyBootstrapProxyHealth(lifecyclePaths(env), env, journal, managerPid, deps, run, uid, deadlineMs, now, assertOwner);
    assertOwner();
    assertForwardMutationBudget(deadlineMs, now());
    await adoptLegacyBootstrapMarker(lifecyclePaths(env).stateDir, legacy, marker, journal, now, {
        assertOwner,
        beforeQuarantine: () => {
            assertOwner();
            assertForwardMutationBudget(deadlineMs, now());
        },
        beforePublish: async (durableJournal) => {
            assertOwner();
            assertForwardMutationBudget(deadlineMs, now());
            captureBootstrapArtifactIdentities(durableJournal, true);
            for (const preserved of marker.preservedArtifacts ?? []) {
                assertTrustedArtifactParent(preserved.path, target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux', uid);
                const current = readBootstrapArtifactFile(preserved.path, undefined, { role: 'preserved' }).identity;
                if (current.size !== preserved.size || current.sha256 !== preserved.sha256
                    || current.device !== preserved.device || current.inode !== preserved.inode) {
                    throw new Error('legacy preserved companion changed before durable adoption');
                }
            }
            const currentManagerPid = assertBootstrapManagerBinding(durableJournal, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
            if (currentManagerPid !== managerPid) {
                throw new Error('legacy bootstrap manager binding changed before durable adoption');
            }
            await requireLegacyBootstrapProxyHealth(lifecyclePaths(env), env, durableJournal, currentManagerPid, deps, run, uid, deadlineMs, now, assertOwner);
            assertOwner();
            assertForwardMutationBudget(deadlineMs, now());
            captureBootstrapArtifactIdentities(durableJournal, true);
            for (const preserved of marker.preservedArtifacts ?? []) {
                assertTrustedArtifactParent(preserved.path, target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux', uid);
                const current = readBootstrapArtifactFile(preserved.path, undefined, { role: 'preserved' }).identity;
                if (current.size !== preserved.size || current.sha256 !== preserved.sha256
                    || current.device !== preserved.device || current.inode !== preserved.inode) {
                    throw new Error('legacy preserved companion changed after final health verification');
                }
            }
            const finalManagerPid = assertBootstrapManagerBinding(durableJournal, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
            if (finalManagerPid !== currentManagerPid) {
                throw new Error('legacy bootstrap manager binding changed after final health verification');
            }
        },
    });
    assertOwner();
    return marker;
}
export const _renderLegacyWindowsProxyLauncherBytesForTest = renderLegacyWindowsProxyLauncherBytes;
async function removeLegacyBootstrapService(input) {
    const { legacy, target, installFlags, env, argv1, loadUnixRecoveryController, install, ownerLock, run, uid, deadlineMs, now, } = input;
    const assertOwner = () => ownerLock.assertOwned();
    if (legacy.marker.target !== target) {
        throw new Error(`legacy bootstrap target ${legacy.marker.target} does not match requested target ${target}`);
    }
    const stateDir = lifecyclePaths(env).stateDir;
    assertForwardMutationBudget(deadlineMs, now());
    const managerState = probeBootstrapManagerState(target, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
    requireBootstrapManagerState(managerState, ['absent', 'present', 'disabled'], 'legacy removal manager preflight');
    const legacyWindowsLauncherPath = target === 'windows' && managerState !== 'absent'
        ? probeLegacyWindowsLauncherPath(run, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), managerState !== 'disabled')
        : undefined;
    assertOwner();
    const planned = await install(target, { ...installFlags, 'dry-run': true }, env, argv1, loadUnixRecoveryController, { assertOwner });
    assertOwner();
    const artifactPlan = legacyBootstrapArtifactPlan(legacy, planned, target, env, stateDir, legacyWindowsLauncherPath, managerState === 'absent', false, uid);
    const receipts = captureLegacyBootstrapArtifactReceipts(artifactPlan.paths, artifactPlan.expected, target, uid);
    const managerArtifactPath = managerState === 'absent'
        ? undefined
        : bootstrapManagerArtifact(target, receipts.map((artifact) => artifact.path));
    let journal = createLegacyBootstrapRemovalJournal({
        owner: ownerLock.owner,
        target,
        service: legacy.marker.service,
        deadlineMs,
        managerState: managerState,
        ...(managerArtifactPath ? { managerArtifactPath } : {}),
        artifacts: receipts,
        ...(artifactPlan.preserved.length > 0
            ? { preservedArtifacts: artifactPlan.preserved }
            : {}),
        ...(artifactPlan.legacyStateRootProof
            ? { legacyStateRootProof: artifactPlan.legacyStateRootProof }
            : {}),
        now: now(),
    });
    if (managerState !== 'absent') {
        assertBootstrapManagerBinding(journal, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), false, false, managerState === 'disabled');
    }
    journal = captureBootstrapArtifactIdentities(journal, true);
    for (const preserved of journal.preservedArtifacts ?? []) {
        assertTrustedArtifactParent(preserved.path, target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux', uid);
        const current = readBootstrapArtifactFile(preserved.path, undefined, { role: 'preserved' }).identity;
        if (current.size !== preserved.size || current.sha256 !== preserved.sha256
            || current.device !== preserved.device || current.inode !== preserved.inode) {
            throw new Error('legacy preserved companion changed before durable removal');
        }
    }
    journal = planBootstrapCanonicalQuarantine(stateDir, journal, ['marker']);
    const markerQuarantine = journal.canonicalQuarantine?.[0];
    if (!markerQuarantine
        || markerQuarantine.identity.size !== legacy.identity.size
        || markerQuarantine.identity.sha256 !== legacy.identity.sha256
        || markerQuarantine.identity.device !== legacy.identity.device
        || markerQuarantine.identity.inode !== legacy.identity.inode) {
        throw new Error('legacy bootstrap removal journal does not bind the exact raw marker');
    }
    assertBootstrapTransactionClaimsAbsent(journal);
    assertOwner();
    writeBootstrapJournal(stateDir, journal);
    assertOwner();
    ensureBootstrapManualTransition(stateDir, journal, now());
    assertOwner();
    applyBootstrapCanonicalQuarantine(stateDir, journal, assertOwner);
    journal = updateBootstrapJournal(journal, {
        stage: 'rollback_pending',
        lastError: 'operator requested verified legacy bootstrap service removal',
    }, now());
    assertOwner();
    writeBootstrapJournal(stateDir, journal);
    const finalManagerState = probeBootstrapManagerState(target, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
    if (finalManagerState === 'unavailable' || finalManagerState === 'inconclusive') {
        throw new Error(`legacy bootstrap removal cannot prove manager state before mutation: ${finalManagerState}`);
    }
    if (journal.managerBinding.kind === 'legacy-v907-absent') {
        if (finalManagerState !== 'absent') {
            throw new Error('legacy bootstrap manager appeared after its exact absent preflight');
        }
    }
    else if (finalManagerState === 'absent') {
        journal = updateBootstrapJournal(journal, { activationStarted: false }, now());
        assertOwner();
        writeBootstrapJournal(stateDir, journal);
    }
    else {
        assertBootstrapManagerBinding(journal, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), false, false, finalManagerState === 'disabled');
    }
    assertOwner();
    rollbackBootstrapTransaction(stateDir, journal, run, uid, now, deadlineMs, false, true, assertOwner);
    const rolledBack = readBootstrapJournal(stateDir);
    if (!rolledBack || rolledBack.stage !== 'rolled_back') {
        throw new Error('legacy bootstrap removal rollback was not durably confirmed');
    }
    requireBootstrapManagerState(probeBootstrapManagerState(target, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), ['absent'], 'verify legacy manager is absent after removal');
    if (filesystemEntryExists(bootstrapMarkerPath(stateDir))) {
        throw new Error('legacy bootstrap removal found new canonical marker state');
    }
    assertOwner();
    finalizeBootstrapCanonicalQuarantine(stateDir, rolledBack, {
        beforeMove: () => assertOwner(),
        afterMove: () => assertOwner(),
        beforeDelete: () => assertOwner(),
    });
    assertOwner();
    removeBootstrapJournal(stateDir);
    return {
        status: 'removed',
        files: receipts.map((artifact) => artifact.path),
        preservedFiles: artifactPlan.preserved.map((artifact) => artifact.path),
        service: legacy.marker.service,
        actions: target === 'systemd'
            ? ['systemctl --user disable --now evolver-proxy.service', 'systemctl --user daemon-reload']
            : target === 'launchd'
                ? [`launchctl bootout gui/${uid}/com.evomap.evolver-proxy`]
                : managerState === 'absent'
                    ? ['verified EvoMapEvolverProxyDaemon is absent; removed only exact legacy-owned artifacts']
                    : ['verified and unregistered owned EvoMapEvolverProxyDaemon scheduled task'],
    };
}
/** First-run supervision bootstrap with exclusive ownership, durable recovery, and verified rollback. */
async function bootstrapService(flags, env, argv1, deps, loadUnixRecoveryController) {
    if (flags['dry-run'] !== undefined && flags['dry-run'] !== true) {
        throw new Error('--dry-run is a boolean flag and does not accept a value');
    }
    if (flags['with-autoexec'] !== undefined || flags['autoexec-home'] !== undefined) {
        throw new Error('lifecycle bootstrap manages only the proxy supervisor; --with-autoexec and --autoexec-home are unsupported and no artifacts were changed');
    }
    const platform = deps.platform ?? process.platform;
    const target = typeof flags['target'] === 'string' ? serviceTarget(flags) : defaultBootstrapTarget(platform);
    const dryRun = flags['dry-run'] === true;
    const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    const install = deps.install ?? installService;
    const handedOffEnvFile = nonBlankEnv(env, BOOTSTRAP_ENV_FILE_HANDOFF);
    const installFlags = handedOffEnvFile && typeof flags['env-file'] !== 'string'
        ? { ...flags, 'env-file': handedOffEnvFile }
        : flags;
    const transactionId = randomUUID();
    const now = deps.now ?? Date.now;
    const stateDir = lifecyclePaths(env).stateDir;
    const deadlineMs = resolveBootstrapDeadline(env, now());
    const run = deps.run ?? ((command, args, timeoutMs = BOOTSTRAP_COMMAND_TIMEOUT_MS) => {
        const result = spawnSync(command, [...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true,
        });
        return {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
        };
    });
    if (dryRun) {
        const planned = await install(target, { ...installFlags, 'dry-run': true }, env, argv1, loadUnixRecoveryController, { exclusive: true, transactionId });
        const plannedFiles = planned.files ?? [];
        return {
            status: 'planned',
            files: plannedFiles,
            service: planned.service,
            actions: bootstrapActivationPlan(target, plannedFiles, uid),
        };
    }
    const nativeTarget = platform === 'linux'
        ? 'systemd'
        : platform === 'darwin'
            ? 'launchd'
            : platform === 'win32'
                ? 'windows'
                : undefined;
    if (!nativeTarget || target !== nativeTarget) {
        throw new Error(`bootstrap target ${target} is not supported on runtime platform ${platform}`);
    }
    if ((target === 'systemd' || target === 'launchd') && uid === 0) {
        throw new Error('bootstrap must run as a regular (non-root) user: the systemd --user manager and the launchd gui domain do not exist for root; install as your normal user and, on headless hosts, run `loginctl enable-linger` for that user');
    }
    const ownerLock = acquireBootstrapOwnerLock(stateDir, deps.lock ?? { maxTries: 1_200, waitMs: 100 });
    const assertOwner = () => ownerLock.assertOwned();
    const ownerRun = ownerGuardedServiceRun(run, assertOwner);
    let outcome;
    let operationError;
    let operationFailed = false;
    try {
        outcome = await (async () => {
            await assertNoActiveDurableSelfUpdateRecovery({
                action: 'bootstrap',
                target,
                stateDir,
                ownerLock,
                env,
                argv1,
                deps,
            });
            assertOwner();
            const registrationToken = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV];
            if (registrationToken !== undefined) {
                assertActiveBootstrapRegistrationIntentToken(stateDir, registrationToken);
            }
            const recovered = recoverBootstrapTransaction(stateDir, ownerRun, uid, now, deadlineMs, assertOwner);
            if (recovered.status === 'remove-completed') {
                throw new BootstrapRolledBackError(`manual service removal completed; run lifecycle install-service --target=${recovered.target} explicitly before automatic bootstrap can resume`);
            }
            const manualTransition = readBootstrapManualTransition(stateDir);
            if (manualTransition) {
                throw new BootstrapRolledBackError(`manual service transition is pending; run lifecycle install-service --target=${manualTransition.target} explicitly before automatic bootstrap can resume`);
            }
            let existingMarker;
            let legacyMarker;
            let corruptMarker = false;
            try {
                existingMarker = readBootstrapMarker(stateDir);
            }
            catch (error) {
                if (!filesystemEntryExists(bootstrapMarkerPath(stateDir)))
                    throw error;
                try {
                    legacyMarker = readLegacyBootstrapMarker(stateDir);
                }
                catch {
                    corruptMarker = true;
                }
            }
            if (legacyMarker) {
                const adopted = await adoptLegacyBootstrapService({
                    legacy: legacyMarker,
                    target,
                    installFlags,
                    env,
                    argv1,
                    loadUnixRecoveryController,
                    install,
                    ownerLock,
                    deps,
                    run: ownerRun,
                    uid,
                    deadlineMs,
                    now,
                });
                assertOwner();
                if (registrationToken === undefined) {
                    return {
                        status: 'already-bootstrapped',
                        transactionId: adopted.transactionId,
                        files: adopted.files,
                        service: adopted.service,
                        actions: [],
                    };
                }
                // An authorized automatic child must compare the adopted launcher with its own exact
                // target plan. Adoption proves ownership; it does not prove that a historical Node
                // launcher already binds the standalone executable which created this child.
                existingMarker = adopted;
            }
            if (existingMarker) {
                if (existingMarker.managerBindingKind === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING) {
                    assertLegacyMarkerStateRootBinding(existingMarker, stateDir, uid);
                }
                const receipt = bootstrapJournalFromMarker(existingMarker, ownerLock.owner, deadlineMs, now());
                const markerState = probeBootstrapManagerState(receipt.target, ownerRun, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
                if (markerState === 'present' || markerState === 'disabled') {
                    const managerPid = assertBootstrapManagerBinding(receipt, ownerRun, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), false, false, markerState === 'disabled');
                    let migratedTargetBindingMatches = true;
                    if (registrationToken !== undefined) {
                        assertForwardMutationBudget(deadlineMs, now());
                        const expected = await install(target, { ...installFlags, 'dry-run': true }, env, argv1, loadUnixRecoveryController, {
                            exclusive: true,
                            transactionId: existingMarker.transactionId,
                            assertOwner,
                        });
                        assertOwner();
                        const expectedFiles = expected.files ?? [];
                        const expectedArtifacts = expected.bootstrapArtifacts ?? expectedFiles;
                        const expectedIdentities = expected.bootstrapArtifactIdentities;
                        if (expectedArtifacts.length === 0 || !expectedIdentities) {
                            throw new Error('bootstrap migration target plan did not declare expected artifact identities');
                        }
                        migratedTargetBindingMatches = bootstrapMarkerMatchesPlannedArtifacts(existingMarker, target, expectedArtifacts, expectedIdentities);
                    }
                    try {
                        if (markerState === 'disabled') {
                            throw new BootstrapManagerNotRunningError('bootstrap committed service manager is no longer durably enabled');
                        }
                        if (managerPid === undefined) {
                            throw new BootstrapManagerNotRunningError('bootstrap committed service manager has no running supervisor process');
                        }
                        if (receipt.managerBinding.kind === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING) {
                            await requireLegacyBootstrapProxyHealth(lifecyclePaths(env), env, receipt, managerPid, deps, ownerRun, uid, deadlineMs, now, assertOwner);
                        }
                        else {
                            await requireBootstrapProxyHealth(lifecyclePaths(env), env, receipt, managerPid, deps, ownerRun, uid, deadlineMs, now, assertOwner);
                        }
                        assertOwner();
                        captureBootstrapArtifactIdentities(receipt, true);
                        if (!migratedTargetBindingMatches) {
                            throw new BootstrapManagerNotRunningError('bootstrap committed service does not bind the migrated standalone target');
                        }
                        return {
                            status: 'already-bootstrapped',
                            transactionId: existingMarker.transactionId,
                            files: existingMarker.files,
                            service: existingMarker.service,
                            actions: [],
                        };
                    }
                    catch {
                        assertOwner();
                        // A bound but unhealthy service is cleaned up through the same durable receipt below.
                    }
                }
                else if (markerState === 'unavailable' || markerState === 'inconclusive') {
                    throw new Error('bootstrap cannot revalidate its committed service manager state');
                }
                const cleanup = updateBootstrapJournal(receipt, {
                    stage: 'rollback_pending',
                    deadlineMs,
                    lastError: 'committed bootstrap service is absent, disabled, or unhealthy',
                }, now());
                assertOwner();
                writeBootstrapJournal(stateDir, cleanup);
                rollbackBootstrapTransaction(stateDir, cleanup, ownerRun, uid, now, deadlineMs, true, false, assertOwner);
            }
            const quarantineKinds = [];
            if (corruptMarker)
                quarantineKinds.push('marker');
            if (filesystemEntryExists(bootstrapReadinessPath(stateDir))) {
                const staleReadiness = readBootstrapReadiness(stateDir);
                if (!staleReadiness) {
                    throw new Error('bootstrap readiness disappeared during stale-state preflight');
                }
                const processStatuses = inspectBootstrapReadinessProcessAttestations(staleReadiness, deps);
                if (!processStatuses.every((status) => status === 'dead' || status === 'pid_reused')) {
                    throw new Error(`bootstrap refused to quarantine readiness whose process identity is not provably stale (${processStatuses.join(', ')})`);
                }
                quarantineKinds.push('readiness');
            }
            if (quarantineKinds.length > 0) {
                requireBootstrapManagerState(probeBootstrapManagerState(target, ownerRun, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), ['absent'], quarantineKinds.includes('readiness')
                    ? 'stale readiness cleanup preflight'
                    : 'corrupt marker quarantine preflight');
            }
            assertForwardMutationBudget(deadlineMs, now());
            assertOwner();
            const planned = await install(target, { ...installFlags, 'dry-run': true }, env, argv1, loadUnixRecoveryController, { exclusive: true, transactionId, assertOwner });
            assertOwner();
            const plannedFiles = planned.files ?? [];
            const plannedArtifacts = planned.bootstrapArtifacts ?? plannedFiles;
            const plannedArtifactIdentities = planned.bootstrapArtifactIdentities;
            if (plannedArtifacts.length === 0)
                throw new Error('bootstrap install plan did not declare owned artifacts');
            if (!plannedArtifactIdentities)
                throw new Error('bootstrap install plan did not declare expected artifact identities');
            requireBootstrapManagerState(probeBootstrapManagerState(target, ownerRun, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), ['absent'], 'preflight existing service check');
            // Trust the artifact-parent chain with the HOST platform, never the injected target platform.
            // The deeper owner-lock guard (assertTrustedArtifactParent at .bootstrap-owner) already uses
            // process.platform; matching it here keeps preflight consistent. Routing this preflight through an
            // injected POSIX platform on a Windows host would run the POSIX mode-bit chain against a real NTFS
            // directory, where Node simulates group/world-writable bits and the guard false-positives (#972: the
            // native-CI bootstrap suite runs with platform:'linux'/'darwin' fixtures on a Windows runner).
            assertPlannedArtifactsAbsent(plannedArtifacts, process.platform, uid);
            assertForwardMutationBudget(deadlineMs, now());
            let journal = createBootstrapJournal({
                owner: ownerLock.owner,
                transactionId,
                target,
                service: planned.service ?? target,
                deadlineMs,
                artifactPaths: plannedArtifacts,
                artifactIdentities: plannedArtifactIdentities,
                managerArtifactPath: bootstrapManagerArtifact(target, plannedArtifacts),
                now: now(),
            });
            journal = planBootstrapCanonicalQuarantine(stateDir, journal, quarantineKinds);
            assertBootstrapTransactionClaimsAbsent(journal);
            assertForwardMutationBudget(deadlineMs, now());
            try {
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                applyBootstrapCanonicalQuarantine(stateDir, journal, () => {
                    assertOwner();
                    assertForwardMutationBudget(deadlineMs, now());
                });
                journal = updateBootstrapJournal(journal, { stage: 'installing' }, now());
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                assertForwardMutationBudget(deadlineMs, now());
                const applyFlags = { ...installFlags };
                delete applyFlags['dry-run'];
                const onArtifactPublished = (path, claimPath) => {
                    assertOwner();
                    let ownershipPersisted = false;
                    journal = recordPublishedBootstrapArtifact(journal, path, claimPath, (ownershipJournal) => {
                        journal = ownershipJournal;
                        assertOwner();
                        writeBootstrapJournal(stateDir, journal);
                        ownershipPersisted = true;
                    });
                    if (!ownershipPersisted) {
                        assertOwner();
                        writeBootstrapJournal(stateDir, journal);
                    }
                };
                assertOwner();
                const installed = await install(target, applyFlags, env, argv1, loadUnixRecoveryController, { exclusive: true, transactionId, onArtifactPublished, assertOwner });
                assertOwner();
                const files = installed.files ?? [];
                const actualArtifacts = installed.bootstrapArtifacts ?? files;
                assertSameBootstrapInventory(plannedArtifacts, actualArtifacts);
                journal = captureBootstrapArtifactIdentities(updateBootstrapJournal(journal, { stage: 'installed' }, now()));
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                assertForwardMutationBudget(deadlineMs, now());
                journal = updateBootstrapJournal(journal, { stage: 'activating', activationStarted: true }, now());
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                assertForwardMutationBudget(deadlineMs, now());
                const forwardRun = (command, args, timeoutMs) => {
                    const result = ownerRun(command, args, timeoutMs ?? commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
                    assertForwardMutationBudget(deadlineMs, now());
                    return result;
                };
                const actions = activateBootstrapTarget(target, files, forwardRun, uid, deadlineMs, now);
                const managerPid = await waitForBootstrapManagerBinding(journal, forwardRun, uid, deadlineMs, now, deps.healthTimeoutMs ?? BOOTSTRAP_HEALTH_TIMEOUT_MS, assertOwner);
                assertOwner();
                const healthyReadiness = await requireBootstrapProxyHealth(lifecyclePaths(env), env, journal, managerPid, deps, forwardRun, uid, deadlineMs, now, assertOwner);
                assertOwner();
                journal = updateBootstrapJournal(journal, { stage: 'activated' }, now());
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                assertForwardMutationBudget(deadlineMs, now());
                journal = updateBootstrapJournal(journal, { stage: 'committing' }, now());
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                assertForwardMutationBudget(deadlineMs, now());
                assertBootstrapManagerStillBound(journal, healthyReadiness, managerPid, forwardRun, uid, () => commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), deps);
                journal = captureBootstrapArtifactIdentities(journal, true);
                assertForwardMutationBudget(deadlineMs, now());
                assertOwner();
                writeBootstrapJournal(stateDir, journal);
                assertForwardMutationBudget(deadlineMs, now());
                const marker = {
                    schema: coreBootstrap.LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA,
                    transactionId: journal.transactionId,
                    bootstrappedAt: new Date(now()).toISOString(),
                    target,
                    service: installed.service ?? journal.service,
                    files: journal.artifacts.map((artifact) => artifact.path),
                    managerArtifactPath: bootstrapJournalManagerArtifactPath(journal),
                    managerBindingKind: 'transaction',
                    artifacts: journal.artifacts.map((artifact) => {
                        if (!artifact.identity)
                            throw new Error('bootstrap cannot commit an artifact without durable identity');
                        return { path: artifact.path, ...artifact.identity };
                    }),
                };
                assertForwardMutationBudget(deadlineMs, now());
                try {
                    assertOwner();
                    (deps.writeMarker ?? ((path, value) => { writeDurableJsonExclusive(path, value, 0o600); }))(bootstrapMarkerPath(stateDir), marker);
                }
                catch (error) {
                    const publication = inspectBootstrapMarkerPublication(stateDir, marker);
                    if (publication === 'exact') {
                        throw new BootstrapCommitAmbiguousError(`${boundedBootstrapError(error)}; exact bootstrap marker is visible but durability was not confirmed; recovery state was preserved`, { cause: error });
                    }
                    if (publication === 'ambiguous') {
                        throw new BootstrapCommitAmbiguousError(`${boundedBootstrapError(error)}; bootstrap marker publication is foreign or invalid; recovery state was preserved`, { cause: error });
                    }
                    throw error;
                }
                journal = updateBootstrapJournal(journal, { stage: 'committed' }, now());
                try {
                    assertOwner();
                    writeBootstrapJournal(stateDir, journal);
                    finalizeBootstrapCanonicalQuarantine(stateDir, journal, {
                        beforeMove: () => assertOwner(),
                        afterMove: () => assertOwner(),
                        beforeDelete: () => assertOwner(),
                    });
                    assertOwner();
                    removeBootstrapJournal(stateDir);
                }
                catch {
                    // The durable versioned marker is the commit point. Recovery recognizes its transaction id.
                }
                return {
                    status: 'bootstrapped',
                    transactionId: marker.transactionId,
                    files: [...marker.files, bootstrapMarkerPath(stateDir)],
                    service: marker.service,
                    actions,
                };
            }
            catch (error) {
                if (error instanceof BootstrapCommitAmbiguousError)
                    throw error;
                const detail = boundedBootstrapError(error);
                if (journal.stage === 'prepared') {
                    try {
                        assertOwner();
                        restoreBootstrapCanonicalQuarantine(stateDir, journal, {
                            beforeMove: () => assertOwner(),
                            afterMove: () => assertOwner(),
                        });
                        assertOwner();
                        removeBootstrapJournal(stateDir);
                    }
                    catch (rollbackError) {
                        throw new Error(`${detail}; bootstrap recovery remains pending: ${boundedBootstrapError(rollbackError)}`);
                    }
                    throw new BootstrapRolledBackError(`${detail}; launcher transaction was rolled back`);
                }
                try {
                    journal = updateBootstrapJournal(journal, { stage: 'rollback_pending', lastError: detail }, now());
                    assertOwner();
                    writeBootstrapJournal(stateDir, journal);
                    rollbackBootstrapTransaction(stateDir, journal, ownerRun, uid, now, deadlineMs, false, true, assertOwner);
                    assertOwner();
                    restoreBootstrapCanonicalQuarantine(stateDir, journal, {
                        beforeMove: () => assertOwner(),
                        afterMove: () => assertOwner(),
                    });
                    assertOwner();
                    removeBootstrapJournal(stateDir);
                }
                catch (rollbackError) {
                    throw new Error(`${detail}; bootstrap recovery remains pending: ${boundedBootstrapError(rollbackError)}`);
                }
                throw new BootstrapRolledBackError(`${detail}; launcher transaction was rolled back`);
            }
        })();
        assertOwner();
    }
    catch (error) {
        if (!outcome
            || !lifecycleOutcomeIsCommitted('bootstrap', outcome)
            || !isBootstrapOwnerLockAssertionError(error)) {
            operationError = error;
            operationFailed = true;
        }
    }
    const releaseFailures = releaseBootstrapLifecycleLocks([
        { label: 'bootstrap owner', lock: ownerLock },
    ]);
    finishLifecycleOperationAfterLockRelease({
        action: 'bootstrap',
        outcome,
        operationError,
        operationFailed,
        releaseFailures,
    });
    if (!outcome)
        throw new Error('bootstrap completed without a lifecycle outcome');
    return outcome;
}
function bootstrapActivationPlan(target, files, uid) {
    if (target === 'systemd') {
        return [
            'systemctl --user daemon-reload',
            'systemctl --user enable --now evolver-proxy.service',
        ];
    }
    if (target === 'launchd') {
        const plist = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        return [`launchctl bootstrap gui/${uid ?? '<uid>'} ${plist}`];
    }
    const installer = files[0] ?? expandHome('~/install-evolver-proxy-windows.ps1');
    return [`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${installer} -Install -BootstrapExclusive`];
}
function activateBootstrapTarget(target, files, run, uid, deadlineMs = Date.now() + BOOTSTRAP_TRANSACTION_BUDGET_MS, now = Date.now) {
    if (target === 'systemd') {
        requireBootstrapActivation(run(SYSTEMCTL_PATH, ['--user', 'daemon-reload'], commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), [0], 'reload systemd user manager');
        requireBootstrapActivation(run(SYSTEMCTL_PATH, ['--user', 'enable', '--now', 'evolver-proxy.service'], commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), [0], 'enable systemd user service', 'if no user session bus exists, run `loginctl enable-linger` and retry');
        return bootstrapActivationPlan(target, files, uid);
    }
    if (target === 'launchd') {
        const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        if (userId === undefined)
            throw new Error('cannot determine the current user id for launchd bootstrap');
        const plist = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        requireBootstrapActivation(run(LAUNCHCTL_PATH, ['bootstrap', `gui/${userId}`, plist]), [0], 'bootstrap launchd agent', 'launchctl bootstrap gui/<uid> requires an active GUI (Aqua) login session; log in at the console (or retry after your next GUI login)');
        return [`launchctl bootstrap gui/${userId} ${plist}`];
    }
    const installer = files[0];
    if (!installer)
        throw new Error('bootstrap could not locate the generated Windows installer script');
    requireBootstrapActivation(run(trustedWindowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Install', '-BootstrapExclusive']), [0], 'register Windows scheduled task');
    return [`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${installer} -Install -BootstrapExclusive`];
}
function requireBootstrapActivation(result, allowedStatuses, operation, hint) {
    if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
        throw new Error(`bootstrap activation failed during ${operation}${hint ? ` (hint: ${hint})` : ''}`);
    }
}
function resolveBootstrapDeadline(env, now) {
    const raw = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_DEADLINE_ENV]?.trim();
    if (raw !== undefined) {
        const parsed = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isSafeInteger(parsed) || parsed > now + 10 * 60_000) {
            throw new Error('bootstrap transaction deadline is invalid');
        }
        if (parsed <= now)
            throw new Error('bootstrap transaction deadline has expired');
        return parsed;
    }
    return now + BOOTSTRAP_TRANSACTION_BUDGET_MS;
}
function commandTimeout(deadlineMs, now, reserveMs) {
    const available = deadlineMs - now() - reserveMs;
    if (available <= 0)
        throw new Error('bootstrap transaction deadline exhausted before the next command');
    return Math.max(1, Math.min(BOOTSTRAP_COMMAND_TIMEOUT_MS, available));
}
function bootstrapRollbackCommandBudget(target, deadlineMs, now) {
    let remainingCommands = target === 'systemd' ? 8 : 4;
    return {
        nextTimeout: () => {
            const available = deadlineMs - now() - BOOTSTRAP_ROLLBACK_FINALIZATION_RESERVE_MS;
            if (remainingCommands <= 0 || available < remainingCommands) {
                throw new Error('bootstrap rollback command budget is exhausted; durable recovery remains pending');
            }
            const timeout = Math.max(1, Math.floor(available / remainingCommands));
            remainingCommands -= 1;
            return Math.min(BOOTSTRAP_COMMAND_TIMEOUT_MS, timeout);
        },
    };
}
function assertForwardMutationBudget(deadlineMs, now) {
    if (deadlineMs - now <= BOOTSTRAP_ROLLBACK_RESERVE_MS) {
        throw new Error('bootstrap transaction deadline cannot reserve a complete rollback window');
    }
}
function boundedBootstrapError(error, maxLength = BOOTSTRAP_ERROR_DETAIL_LIMIT) {
    const limit = Math.max(0, Math.min(BOOTSTRAP_ERROR_DETAIL_LIMIT, Math.floor(maxLength)));
    if (limit === 0)
        return '';
    const detail = error instanceof Error ? error.message : String(error);
    let sanitized = '';
    let replacingControl = false;
    for (const character of detail) {
        const code = character.charCodeAt(0);
        const control = code <= 0x1f || code === 0x7f;
        if (control) {
            if (!replacingControl)
                sanitized += ' ';
        }
        else {
            sanitized += character;
        }
        replacingControl = control;
        if (sanitized.length >= limit)
            break;
    }
    return sanitized.slice(0, limit);
}
function assertSameBootstrapInventory(planned, actual) {
    const expected = [...new Set(planned.map((path) => resolvePath(path)))].sort();
    const received = [...new Set(actual.map((path) => resolvePath(path)))].sort();
    if (expected.length !== received.length || expected.some((path, index) => path !== received[index])) {
        throw new Error('bootstrap install changed its ownership inventory after the durable plan was committed');
    }
}
function bootstrapInventoryKey(path, target) {
    const canonical = target === 'windows' ? win32.normalize(path) : resolvePath(path);
    return target === 'windows' ? canonical.toLowerCase() : canonical;
}
function sameBootstrapContentIdentity(actual, expected) {
    return actual.size === expected.size && actual.sha256 === expected.sha256;
}
function bootstrapMarkerMatchesPlannedArtifacts(marker, target, plannedArtifacts, plannedIdentities) {
    if (marker.artifacts.length !== plannedArtifacts.length)
        return false;
    if (bootstrapInventoryKey(marker.managerArtifactPath, target)
        !== bootstrapInventoryKey(bootstrapManagerArtifact(target, plannedArtifacts), target)) {
        return false;
    }
    const markerArtifacts = new Map(marker.artifacts.map((artifact) => [
        bootstrapInventoryKey(artifact.path, target),
        artifact,
    ]));
    return plannedArtifacts.every((path) => {
        const expected = plannedIdentities[resolvePath(path)] ?? plannedIdentities[path];
        const actual = markerArtifacts.get(bootstrapInventoryKey(path, target));
        return expected !== undefined
            && actual !== undefined
            && sameBootstrapContentIdentity(actual, expected);
    });
}
function systemdUnitDirective(unit, name) {
    const prefix = `${name}=`;
    const values = unit.split(/\r?\n/)
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length));
    if (values.length !== 1)
        throw new Error(`legacy systemd unit must declare one ${name}`);
    return values[0];
}
function renderFrozenLegacySystemdUnit(opts) {
    const execStart = assertSingleLine(opts.execStart, 'legacy systemd ExecStart');
    const workingDirectory = opts.workingDirectory === undefined
        ? '%h'
        : quoteSystemdArg(opts.workingDirectory);
    return [
        '# Linux systemd user unit -- ~/.config/systemd/user/evolver-proxy.service',
        '[Unit]',
        'Description=EvoMap Evolver Proxy Daemon',
        'After=network-online.target',
        'Wants=network-online.target',
        'StartLimitBurst=5',
        'StartLimitIntervalSec=120s',
        '',
        '[Service]',
        'Type=notify',
        '# The stable recovery controller may be MainPID; the proxy child invokes systemd-notify.',
        'NotifyAccess=all',
        'WatchdogSec=180s',
        `WorkingDirectory=${workingDirectory}`,
        ...(opts.envFile ? [`Environment="EVOLVER_ENV_FILE=${escapeSystemdEnvValue(opts.envFile)}"`] : []),
        'Environment="EVOLVER_SELF_UPDATE_SUPERVISOR=systemd"',
        ...(opts.lifecycleStateDir
            ? [`Environment="EVOLVER_LIFECYCLE_STATE_DIR=${escapeSystemdEnvValue(opts.lifecycleStateDir)}"`]
            : []),
        ...(opts.selfUpdateStateDir
            ? [`Environment="EVOLVER_SELF_UPDATE_STATE_DIR=${escapeSystemdEnvValue(opts.selfUpdateStateDir)}"`]
            : []),
        ...(opts.selfUpdateTarget
            ? [`Environment="EVOLVER_SELF_UPDATE_TARGET_PATH=${escapeSystemdEnvValue(opts.selfUpdateTarget)}"`]
            : []),
        `ExecStart=${execStart}`,
        'Restart=on-failure',
        'RestartSec=5s',
        'RestartPreventExitStatus=0',
        'RestartForceExitStatus=78',
        'TimeoutStopSec=30s',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=evolver-proxy',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}
function renderFrozenLegacyLaunchdPlist(opts) {
    const envFileBlock = opts.envFile
        ? `        <key>EVOLVER_ENV_FILE</key>\n        <string>${escapeXml(opts.envFile)}</string>\n`
        : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${DEFAULT_LABEL}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...opts.programArguments.map((argument) => `        <string>${escapeXml(argument)}</string>`),
        '    </array>',
        '    <key>WorkingDirectory</key>',
        `    <string>${escapeXml(opts.workingDirectory)}</string>`,
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        envFileBlock.trimEnd(),
        ...(opts.lifecycleStateDir ? [
            '        <key>EVOLVER_LIFECYCLE_STATE_DIR</key>',
            `        <string>${escapeXml(opts.lifecycleStateDir)}</string>`,
        ] : []),
        '        <key>EVOLVER_SELF_UPDATE_SUPERVISOR</key>',
        '        <string>launchd</string>',
        ...(opts.selfUpdateStateDir ? [
            '        <key>EVOLVER_SELF_UPDATE_STATE_DIR</key>',
            `        <string>${escapeXml(opts.selfUpdateStateDir)}</string>`,
        ] : []),
        ...(opts.selfUpdateTarget ? [
            '        <key>EVOLVER_SELF_UPDATE_TARGET_PATH</key>',
            `        <string>${escapeXml(opts.selfUpdateTarget)}</string>`,
        ] : []),
        '        <key>PATH</key>',
        '        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>',
        '    </dict>',
        '    <key>RunAtLoad</key>',
        '    <true/>',
        '    <key>KeepAlive</key>',
        '    <dict>',
        '        <key>SuccessfulExit</key>',
        '        <false/>',
        '    </dict>',
        '    <key>ThrottleInterval</key>',
        '    <integer>5</integer>',
        '    <key>StandardOutPath</key>',
        `    <string>${escapeXml(posix.join(opts.logDir, 'evolver-proxy.log'))}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${escapeXml(posix.join(opts.logDir, 'evolver-proxy.err.log'))}</string>`,
        '    <key>ProcessType</key>',
        '    <string>Standard</string>',
        '    <key>LowPriorityIO</key>',
        '    <false/>',
        '    <key>LowPriorityBackgroundIO</key>',
        '    <false/>',
        '</dict>',
        '</plist>',
        '',
    ].filter((line) => line !== '').join('\n');
}
export const _renderFrozenLegacySystemdUnitForTest = renderFrozenLegacySystemdUnit;
export const _renderFrozenLegacyLaunchdPlistForTest = renderFrozenLegacyLaunchdPlist;
function assertFrozenLegacyUnixManager(target, source) {
    if (target === 'systemd') {
        const environment = systemdUnitEnvironment(source);
        const workingWords = parseSystemdWords(systemdUnitDirective(source, 'WorkingDirectory'));
        const execArguments = systemdUnitExecArguments(source);
        if (workingWords?.length !== 1) {
            throw new Error('legacy systemd unit has an invalid WorkingDirectory');
        }
        const rendered = renderFrozenLegacySystemdUnit({
            ...(environment.get('EVOLVER_ENV_FILE') ? { envFile: environment.get('EVOLVER_ENV_FILE') } : {}),
            ...(workingWords[0] === '%h' ? {} : { workingDirectory: workingWords[0] }),
            execStart: execArguments.map(quoteSystemdArg).join(' '),
            ...(environment.get('EVOLVER_LIFECYCLE_STATE_DIR')
                ? { lifecycleStateDir: environment.get('EVOLVER_LIFECYCLE_STATE_DIR') }
                : {}),
            ...(environment.get('EVOLVER_SELF_UPDATE_STATE_DIR')
                ? { selfUpdateStateDir: environment.get('EVOLVER_SELF_UPDATE_STATE_DIR') }
                : {}),
            ...(environment.get('EVOLVER_SELF_UPDATE_TARGET_PATH')
                ? { selfUpdateTarget: environment.get('EVOLVER_SELF_UPDATE_TARGET_PATH') }
                : {}),
        });
        if (source !== rendered) {
            throw new Error('legacy systemd unit does not match an exact frozen #907/#918 renderer');
        }
        const lifecycleStateDir = environment.get('EVOLVER_LIFECYCLE_STATE_DIR');
        const envFile = environment.get('EVOLVER_ENV_FILE');
        return {
            family: lifecycleStateDir ? 'v918' : 'v907',
            ...(envFile ? { envFile } : {}),
            ...(lifecycleStateDir ? { lifecycleStateDir } : {}),
        };
    }
    const environment = launchdPlistEnvironment(source);
    const stdoutPath = generatedPlistString(source, 'StandardOutPath');
    const stderrPath = generatedPlistString(source, 'StandardErrorPath');
    const logDir = posix.dirname(stdoutPath);
    if (posix.basename(stdoutPath) !== 'evolver-proxy.log'
        || stderrPath !== posix.join(logDir, 'evolver-proxy.err.log')) {
        throw new Error('legacy launchd plist has invalid frozen log paths');
    }
    const rendered = renderFrozenLegacyLaunchdPlist({
        ...(environment.get('EVOLVER_ENV_FILE') ? { envFile: environment.get('EVOLVER_ENV_FILE') } : {}),
        workingDirectory: generatedPlistString(source, 'WorkingDirectory'),
        programArguments: launchdPlistProgramArguments(source),
        logDir,
        ...(environment.get('EVOLVER_LIFECYCLE_STATE_DIR')
            ? { lifecycleStateDir: environment.get('EVOLVER_LIFECYCLE_STATE_DIR') }
            : {}),
        ...(environment.get('EVOLVER_SELF_UPDATE_STATE_DIR')
            ? { selfUpdateStateDir: environment.get('EVOLVER_SELF_UPDATE_STATE_DIR') }
            : {}),
        ...(environment.get('EVOLVER_SELF_UPDATE_TARGET_PATH')
            ? { selfUpdateTarget: environment.get('EVOLVER_SELF_UPDATE_TARGET_PATH') }
            : {}),
    });
    if (source !== rendered) {
        throw new Error('legacy launchd plist does not match an exact frozen #907/#918 renderer');
    }
    const lifecycleStateDir = environment.get('EVOLVER_LIFECYCLE_STATE_DIR');
    const envFile = environment.get('EVOLVER_ENV_FILE');
    return {
        family: lifecycleStateDir ? 'v918' : 'v907',
        ...(envFile ? { envFile } : {}),
        ...(lifecycleStateDir ? { lifecycleStateDir } : {}),
    };
}
function legacyUnixArtifactIdentities(target, paths) {
    const expected = {};
    const managerName = target === 'systemd'
        ? 'evolver-proxy.service'
        : 'com.evomap.evolver-proxy.plist';
    const managerPath = paths.find((path) => basename(path) === managerName);
    if (!managerPath)
        throw new Error('legacy Unix plan has no manager artifact');
    const canonical = resolvePath(managerPath);
    const managerRead = readBootstrapArtifactFile(canonical, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'owned' });
    const source = managerRead.bytes.toString('utf8');
    if (!managerRead.bytes.equals(Buffer.from(source, 'utf8'))) {
        throw new Error('legacy Unix manager artifact is not canonical UTF-8');
    }
    const managerProof = assertFrozenLegacyUnixManager(target, source);
    expected[canonical] = managerRead.identity;
    const controllerPaths = paths
        .map((path) => resolvePath(path))
        .filter((path) => path !== canonical);
    if (controllerPaths.length > 1
        || (controllerPaths[0] && basename(controllerPaths[0]) !== UNIX_RECOVERY_CONTROLLER_FILENAME)) {
        throw new Error('legacy Unix marker has an invalid owned controller inventory');
    }
    const managerArguments = target === 'systemd'
        ? systemdUnitExecArguments(source)
        : launchdPlistProgramArguments(source);
    const managerControllerPath = managerArguments[0]
        && basename(managerArguments[0]) === UNIX_RECOVERY_CONTROLLER_FILENAME
        ? resolvePath(managerArguments[0])
        : undefined;
    if (controllerPaths.length === 0 && managerControllerPath) {
        throw new Error('legacy Unix manager binds an unreceipted recovery controller');
    }
    if (controllerPaths.length === 1 && managerControllerPath !== controllerPaths[0]) {
        throw new Error('legacy Unix marker controller does not match the frozen manager binding');
    }
    if (controllerPaths[0]) {
        expected[controllerPaths[0]] = readBootstrapArtifactFile(controllerPaths[0], undefined, { role: 'owned' }).identity;
    }
    return { expected, managerProof };
}
function canonicalLegacyPath(value, target, label) {
    const paths = target === 'windows' ? win32 : posix;
    if (!value || !paths.isAbsolute(value) || paths.normalize(value) !== value) {
        throw new Error(`legacy ${label} must be an absolute canonical path`);
    }
    return value;
}
function legacyV907EnvFileStateRootProof(envFile, stateDir, target, uid) {
    if (!envFile) {
        throw new Error('legacy #907 bootstrap adoption requires an exact env file that pins EVOLVER_LIFECYCLE_STATE_DIR');
    }
    const canonicalEnvFile = canonicalLegacyPath(envFile, target, 'env file');
    const canonicalStateDir = canonicalLegacyPath(stateDir, target, 'lifecycle state directory');
    assertTrustedArtifactParent(canonicalEnvFile, target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux', uid);
    const read = readBootstrapArtifactFile(canonicalEnvFile, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'preserved' });
    const source = read.bytes.toString('utf8');
    if (!read.bytes.equals(Buffer.from(source, 'utf8'))) {
        throw new Error('legacy #907 env file is not canonical UTF-8');
    }
    const configuredStateDir = parseEnvFile(source)['EVOLVER_LIFECYCLE_STATE_DIR'];
    if (!configuredStateDir
        || bootstrapInventoryKey(canonicalLegacyPath(configuredStateDir, target, 'env-file lifecycle state directory'), target) !== bootstrapInventoryKey(canonicalStateDir, target)) {
        throw new Error('legacy #907 env file does not pin EVOLVER_LIFECYCLE_STATE_DIR to the marker directory');
    }
    return {
        receipt: { path: canonicalEnvFile, ...read.identity },
        proof: {
            kind: coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_ENV_FILE_STATE_ROOT_PROOF,
            envFilePath: canonicalEnvFile,
            stateDir: canonicalStateDir,
        },
    };
}
function assertLegacyMarkerStateRootBinding(marker, stateDir, uid) {
    const target = marker.target;
    const proof = marker.legacyStateRootProof;
    if (proof) {
        if (bootstrapInventoryKey(proof.stateDir, target)
            !== bootstrapInventoryKey(stateDir, target)) {
            throw new Error('legacy bootstrap state-root proof does not match the marker location');
        }
        const expectedReceipt = marker.preservedArtifacts?.find((artifact) => bootstrapInventoryKey(artifact.path, target)
            === bootstrapInventoryKey(proof.envFilePath, target));
        if (!expectedReceipt) {
            throw new Error('legacy bootstrap state-root proof has no preserved env-file receipt');
        }
        const current = legacyV907EnvFileStateRootProof(proof.envFilePath, stateDir, target, uid).receipt;
        if (current.size !== expectedReceipt.size
            || current.sha256 !== expectedReceipt.sha256
            || current.device !== expectedReceipt.device
            || current.inode !== expectedReceipt.inode) {
            throw new Error('legacy bootstrap env-file state-root attestation changed after adoption');
        }
        return;
    }
    assertTrustedArtifactParent(marker.managerArtifactPath, target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux', uid);
    const manager = readBootstrapArtifactFile(marker.managerArtifactPath, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'owned' });
    if (target === 'systemd' || target === 'launchd') {
        const source = manager.bytes.toString('utf8');
        if (!manager.bytes.equals(Buffer.from(source, 'utf8'))) {
            throw new Error('legacy bootstrap manager artifact is not canonical UTF-8');
        }
        const managerProof = assertFrozenLegacyUnixManager(target, source);
        if (managerProof.family !== 'v918'
            || !managerProof.lifecycleStateDir
            || bootstrapInventoryKey(managerProof.lifecycleStateDir, target)
                !== bootstrapInventoryKey(stateDir, target)) {
            throw new Error('legacy bootstrap marker lacks a durable lifecycle state-root binding');
        }
        return;
    }
    if (manager.bytes.length < 2
        || manager.bytes[0] !== 0xff
        || manager.bytes[1] !== 0xfe
        || manager.bytes.length % 2 !== 0) {
        throw new Error('legacy Windows launcher is not a UTF-16LE script');
    }
    const expectedStateDir = canonicalLegacyPath(stateDir, target, 'lifecycle state directory')
        .replaceAll('"', '""');
    const expectedLine = `If "${expectedStateDir}" <> "" Then env("EVOLVER_LIFECYCLE_STATE_DIR") = "${expectedStateDir}"`;
    const stateRootLines = manager.bytes.subarray(2).toString('utf16le').split(/\r?\n/)
        .filter((line) => line.includes('env("EVOLVER_LIFECYCLE_STATE_DIR")'));
    if (stateRootLines.length !== 1 || stateRootLines[0] !== expectedLine) {
        throw new Error('legacy bootstrap marker lacks a durable lifecycle state-root binding');
    }
}
function verifyLegacyAutoexecArtifact(target, path) {
    const canonical = resolvePath(path);
    const read = readBootstrapArtifactFile(canonical, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'preserved' });
    const source = read.bytes.toString('utf8');
    if (!read.bytes.equals(Buffer.from(source, 'utf8'))) {
        throw new Error('legacy autoexec helper is not canonical UTF-8');
    }
    if (target === 'systemd') {
        const environment = systemdUnitEnvironment(source);
        const workingWords = parseSystemdWords(systemdUnitDirective(source, 'WorkingDirectory'));
        const execArguments = systemdUnitExecArguments(source);
        if (workingWords?.length !== 1)
            throw new Error('legacy autoexec systemd unit has invalid working directory');
        const rendered = renderAutoexecSystemdUnit({
            ...(environment.get('EVOLVER_ENV_FILE') ? { envFile: environment.get('EVOLVER_ENV_FILE') } : {}),
            ...(workingWords[0] === '%h' ? {} : { workingDirectory: workingWords[0] }),
            execStart: execArguments.map(quoteSystemdArg).join(' '),
        });
        if (source !== rendered)
            throw new Error('legacy autoexec systemd unit is not an exact frozen helper');
    }
    else if (target === 'launchd') {
        const environment = launchdPlistEnvironment(source);
        const stdoutPath = generatedPlistString(source, 'StandardOutPath');
        const stderrPath = generatedPlistString(source, 'StandardErrorPath');
        const logDir = posix.dirname(stdoutPath);
        if (posix.basename(stdoutPath) !== 'evolver-autoexec.log'
            || stderrPath !== posix.join(logDir, 'evolver-autoexec.err.log')) {
            throw new Error('legacy autoexec launchd plist has invalid log paths');
        }
        const rendered = renderAutoexecLaunchdPlist({
            ...(environment.get('EVOLVER_ENV_FILE') ? { envFile: environment.get('EVOLVER_ENV_FILE') } : {}),
            workingDirectory: generatedPlistString(source, 'WorkingDirectory'),
            programArguments: launchdPlistProgramArguments(source),
            logDir,
        });
        if (source !== rendered)
            throw new Error('legacy autoexec launchd plist is not an exact frozen helper');
    }
    else {
        const names = ['EvolverBin', 'NodePath', 'CliBin', 'EnvFile', 'AutoexecHome', 'WorkingDirectory'];
        const lines = source.split(/\r?\n/);
        const canonicalLines = [...lines];
        for (const name of names) {
            const prefix = `  [string]$${name} = '`;
            const matches = lines.flatMap((line, index) => {
                if (!line.startsWith(prefix) || (!line.endsWith("'") && !line.endsWith("',")))
                    return [];
                const comma = line.endsWith("',") ? ',' : '';
                const encoded = line.slice(prefix.length, line.length - 1 - comma.length);
                if (encoded.replaceAll("''", '').includes("'"))
                    return [];
                return [{ index, comma }];
            });
            if (matches.length !== 1)
                throw new Error(`legacy Windows autoexec helper has invalid ${name}`);
            canonicalLines[matches[0].index] = `  [string]$${name} = ''${matches[0].comma}`;
        }
        const normalized = Buffer.from(canonicalLines.join('\n'), 'utf8');
        if (normalized.length !== 5_116
            || createHash('sha256').update(normalized).digest('hex')
                !== '200a36aa686e0ac9e303eb0a255c9be4bcd357176ab9b004ce563d68673360e3') {
            throw new Error('legacy Windows autoexec installer is not the exact frozen helper');
        }
    }
    return { path: canonical, ...read.identity };
}
function legacyBootstrapArtifactPlan(legacy, planned, target, env, stateDir, legacyWindowsLauncherPath, allowAbsentWindowsManager = false, requireStateRootProof = false, uid) {
    const platform = target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux';
    for (const path of legacy.marker.files) {
        assertTrustedArtifactParent(path, platform, uid);
    }
    const plannedFiles = planned.files ?? [];
    if (planned.service !== legacy.marker.service) {
        throw new Error('legacy bootstrap marker service does not match the exact generated service');
    }
    if (target !== 'windows') {
        let preserved = [];
        if (legacy.marker.files.length < 1 || legacy.marker.files.length > 3) {
            throw new Error('legacy Unix marker has an invalid helper inventory');
        }
        const expectedManagerName = target === 'systemd'
            ? 'evolver-proxy.service'
            : 'com.evomap.evolver-proxy.plist';
        const plannedManagerPath = plannedFiles.find((path) => basename(path) === expectedManagerName);
        const legacyManagerPath = legacy.marker.files[0];
        if (!plannedManagerPath || !legacyManagerPath
            || basename(legacyManagerPath) !== expectedManagerName
            || resolvePath(plannedManagerPath) !== resolvePath(legacyManagerPath)) {
            throw new Error('legacy Unix marker manager path does not match the canonical install location');
        }
        const autoexecName = target === 'systemd'
            ? 'evolver-autoexec.service'
            : 'com.evomap.evolver-autoexec.plist';
        const hasAutoexec = basename(legacy.marker.files[1] ?? '') === autoexecName;
        if (hasAutoexec) {
            const autoexecPath = legacy.marker.files[1];
            preserved = [verifyLegacyAutoexecArtifact(target, autoexecPath)];
        }
        const paths = legacy.marker.files.filter((_, index) => !hasAutoexec || index !== 1);
        if (paths.length < 1 || paths.length > 2) {
            throw new Error('legacy Unix marker has an invalid owned artifact inventory');
        }
        const unixProof = legacyUnixArtifactIdentities(target, paths);
        let legacyStateRootProof;
        if (unixProof.managerProof.family === 'v918') {
            const pinnedStateDir = unixProof.managerProof.lifecycleStateDir;
            if (!pinnedStateDir
                || bootstrapInventoryKey(pinnedStateDir, target)
                    !== bootstrapInventoryKey(stateDir, target)) {
                throw new Error('legacy #918 Unix manager lifecycle state directory does not match the marker location');
            }
        }
        else if (requireStateRootProof) {
            const stateRoot = legacyV907EnvFileStateRootProof(unixProof.managerProof.envFile, stateDir, target, uid);
            if (legacy.marker.files.some((path) => bootstrapInventoryKey(path, target)
                === bootstrapInventoryKey(stateRoot.receipt.path, target))) {
                throw new Error('legacy #907 env-file proof collides with the historical artifact inventory');
            }
            preserved = [...preserved, stateRoot.receipt];
            legacyStateRootProof = stateRoot.proof;
        }
        return {
            paths,
            expected: unixProof.expected,
            preserved,
            ...(legacyStateRootProof ? { legacyStateRootProof } : {}),
        };
    }
    if (legacy.marker.files.length < 1 || legacy.marker.files.length > 2) {
        throw new Error('legacy Windows marker has an invalid helper inventory');
    }
    const installerPath = resolvePath(legacy.marker.files[0]);
    const installerName = basename(installerPath);
    if (!/^install-evolver-proxy-windows(?:-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.ps1$/i.test(installerName)
        || dirname(installerPath) !== dirname(resolvePath(plannedFiles[0] ?? ''))) {
        throw new Error('legacy Windows marker installer is outside the exact generated inventory');
    }
    let preserved = [];
    if (legacy.marker.files.length === 2) {
        const autoexecPath = resolvePath(legacy.marker.files[1]);
        if (!/^install-evolver-autoexec-windows(?:-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.ps1$/i.test(basename(autoexecPath))
            || dirname(autoexecPath) !== dirname(installerPath)) {
            throw new Error('legacy Windows autoexec helper is outside the exact generated inventory');
        }
        preserved = [verifyLegacyAutoexecArtifact(target, autoexecPath)];
    }
    const installerRead = readBootstrapArtifactFile(installerPath, MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES, { role: 'owned' });
    if (installerRead.identity.size < 1) {
        throw new Error('legacy Windows installer is not bounded');
    }
    const installerSource = installerRead.bytes.toString('utf8');
    const installerBytes = Buffer.from(installerSource, 'utf8');
    if (!installerBytes.equals(installerRead.bytes)) {
        throw new Error('legacy Windows installer is not canonical UTF-8');
    }
    const installerProof = parseLegacyWindowsInstallerDefaults(installerSource);
    const { defaults } = installerProof;
    if (installerProof.family === 'v918'
        && (!defaults.lifecycleStateDir
            || bootstrapInventoryKey(defaults.lifecycleStateDir, target)
                !== bootstrapInventoryKey(stateDir, target))) {
        throw new Error('legacy Windows installer lifecycle state directory does not match the marker location');
    }
    let legacyStateRootProof;
    if (installerProof.family === 'v907' && requireStateRootProof) {
        const stateRoot = legacyV907EnvFileStateRootProof(defaults.envFile, stateDir, target, uid);
        if (legacy.marker.files.some((path) => bootstrapInventoryKey(path, target)
            === bootstrapInventoryKey(stateRoot.receipt.path, target))) {
            throw new Error('legacy #907 env-file proof collides with the historical artifact inventory');
        }
        preserved = [...preserved, stateRoot.receipt];
        legacyStateRootProof = stateRoot.proof;
    }
    if (!legacyWindowsLauncherPath && allowAbsentWindowsManager) {
        const paths = [installerPath];
        const expected = {
            [installerPath]: installerRead.identity,
        };
        return {
            paths,
            expected,
            preserved,
            ...(legacyStateRootProof ? { legacyStateRootProof } : {}),
        };
    }
    if (!legacyWindowsLauncherPath
        || !win32.isAbsolute(legacyWindowsLauncherPath)
        || win32.normalize(legacyWindowsLauncherPath) !== legacyWindowsLauncherPath
        || win32.basename(legacyWindowsLauncherPath).toLowerCase() !== 'evolver-proxy-task-launcher.vbs'
        || win32.basename(win32.dirname(legacyWindowsLauncherPath)).toLowerCase() !== 'evomap') {
        throw new Error('legacy Windows task does not bind a canonical generated launcher path');
    }
    const effectiveSelfUpdateStateDir = defaults.evolverBin
        ? defaults.selfUpdateStateDir
            || win32.join(win32.dirname(defaults.evolverBin), '.evolver-update')
        : undefined;
    const launcherProof = {
        family: installerProof.family,
        defaults: {
            ...defaults,
            ...(effectiveSelfUpdateStateDir ? { selfUpdateStateDir: effectiveSelfUpdateStateDir } : {}),
        },
    };
    const launcherPath = resolvePath(legacyWindowsLauncherPath);
    assertTrustedArtifactParent(launcherPath, platform, uid);
    const paths = [installerPath, launcherPath];
    const expected = {
        [installerPath]: installerRead.identity,
        [launcherPath]: bootstrapArtifactIdentityForBytes(renderLegacyWindowsProxyLauncherBytes(launcherProof)),
    };
    if (defaults.evolverBin) {
        const controllerPath = resolvePath(effectiveSelfUpdateStateDir, 'windows-controller', 'evolver-recovery-controller.exe');
        assertTrustedArtifactParent(controllerPath, platform, uid);
        paths.push(controllerPath);
        expected[controllerPath] = readBootstrapArtifactFile(controllerPath, undefined, { role: 'owned' }).identity;
    }
    return {
        paths,
        expected,
        preserved,
        ...(legacyStateRootProof ? { legacyStateRootProof } : {}),
    };
}
export const _planLegacyBootstrapArtifactsForTest = legacyBootstrapArtifactPlan;
function captureLegacyBootstrapArtifactReceipts(paths, expected, target, uid) {
    return paths.map((path) => {
        const canonical = resolvePath(path);
        assertTrustedArtifactParent(canonical, target === 'windows' ? 'win32' : target === 'launchd' ? 'darwin' : 'linux', uid);
        const expectedIdentity = expected[canonical];
        if (!expectedIdentity) {
            throw new Error(`legacy bootstrap artifact has no generated identity: ${canonical}`);
        }
        const actual = readBootstrapArtifactFile(canonical, undefined, { role: 'owned' }).identity;
        if (!sameBootstrapContentIdentity(actual, expectedIdentity)) {
            throw new Error(`legacy bootstrap artifact bytes do not match the exact generated artifact: ${canonical}`);
        }
        return { path: canonical, ...actual };
    });
}
function sameBootstrapMarker(actual, expected) {
    return actual.schema === expected.schema
        && actual.transactionId === expected.transactionId
        && actual.bootstrappedAt === expected.bootstrappedAt
        && actual.target === expected.target
        && actual.service === expected.service
        && (actual.managerBindingKind ?? 'transaction') === (expected.managerBindingKind ?? 'transaction')
        && actual.legacyStateRootProof?.kind === expected.legacyStateRootProof?.kind
        && actual.legacyStateRootProof?.envFilePath === expected.legacyStateRootProof?.envFilePath
        && actual.legacyStateRootProof?.stateDir === expected.legacyStateRootProof?.stateDir
        && actual.managerArtifactPath === expected.managerArtifactPath
        && actual.files.length === expected.files.length
        && actual.files.every((path, index) => path === expected.files[index])
        && actual.artifacts.length === expected.artifacts.length
        && actual.artifacts.every((artifact, index) => {
            const expectedArtifact = expected.artifacts[index];
            return expectedArtifact !== undefined
                && artifact.path === expectedArtifact.path
                && artifact.size === expectedArtifact.size
                && artifact.sha256 === expectedArtifact.sha256
                && artifact.device === expectedArtifact.device
                && artifact.inode === expectedArtifact.inode;
        })
        && (actual.preservedArtifacts?.length ?? 0) === (expected.preservedArtifacts?.length ?? 0)
        && (actual.preservedArtifacts ?? []).every((artifact, index) => {
            const expectedArtifact = expected.preservedArtifacts?.[index];
            return expectedArtifact !== undefined
                && artifact.path === expectedArtifact.path
                && artifact.size === expectedArtifact.size
                && artifact.sha256 === expectedArtifact.sha256
                && artifact.device === expectedArtifact.device
                && artifact.inode === expectedArtifact.inode;
        });
}
function inspectBootstrapMarkerPublication(stateDir, expected) {
    try {
        const actual = readBootstrapMarker(stateDir);
        if (!actual)
            return 'absent';
        return sameBootstrapMarker(actual, expected) ? 'exact' : 'ambiguous';
    }
    catch {
        return filesystemEntryExists(bootstrapMarkerPath(stateDir)) ? 'ambiguous' : 'absent';
    }
}
function bootstrapManagerArtifact(target, artifacts) {
    const artifact = target === 'systemd'
        ? artifacts.find((path) => basename(path) === 'evolver-proxy.service')
        : target === 'launchd'
            ? artifacts.find((path) => basename(path) === 'com.evomap.evolver-proxy.plist')
            : artifacts.find((path) => basename(path) === 'evolver-proxy-task-launcher.vbs');
    if (!artifact)
        throw new Error('bootstrap install plan did not declare its manager-bound artifact');
    return artifact;
}
function windowsTaskProbeCommand() {
    return 'try { $task = @(Get-ScheduledTask -TaskPath \'\\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq \'EvoMapEvolverProxyDaemon\' }) } catch { exit 9 }; if ($task.Count -eq 0) { exit 3 } elseif ($task.Count -ne 1) { exit 9 } elseif ($task[0].Settings.Enabled) { exit 0 } else { exit 4 }';
}
export const _windowsTaskProbeCommandForTest = windowsTaskProbeCommand;
function probeBootstrapManagerState(target, run, uid, timeoutMs) {
    let result;
    try {
        if (target === 'systemd') {
            result = run(SYSTEMCTL_PATH, [
                '--user', 'show', 'evolver-proxy.service',
                '--property=LoadState', '--property=UnitFileState',
            ], timeoutMs);
            if (result.error || result.status !== 0 || typeof result.stdout !== 'string'
                || Buffer.byteLength(result.stdout, 'utf8') > 1_024)
                return 'inconclusive';
            const properties = parseSystemdShow(result.stdout);
            if (Object.keys(properties).length !== 2
                || !Object.hasOwn(properties, 'LoadState')
                || !Object.hasOwn(properties, 'UnitFileState'))
                return 'inconclusive';
            const loadState = properties['LoadState'];
            const unitFileState = properties['UnitFileState'];
            if (loadState === 'not-found') {
                return unitFileState === '' || unitFileState === 'not-found' ? 'absent' : 'inconclusive';
            }
            if (loadState !== 'loaded' || !unitFileState)
                return 'inconclusive';
            if (unitFileState === 'disabled'
                || unitFileState === 'masked'
                || unitFileState === 'masked-runtime')
                return 'disabled';
            return 'present';
        }
        if (target === 'launchd') {
            const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
            if (userId === undefined)
                return 'inconclusive';
            result = run(LAUNCHCTL_PATH, ['print', 'gui/' + String(userId) + '/com.evomap.evolver-proxy'], timeoutMs);
            if (result.error || result.status === null)
                return 'inconclusive';
            if (result.status === 0)
                return 'present';
            if (result.status === 3)
                return 'absent';
            if (result.status === 113)
                return 'unavailable';
            return 'inconclusive';
        }
        result = run(trustedWindowsPowerShell(), [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsTaskProbeCommand(),
        ], timeoutMs);
        if (result.error || result.status === null)
            return 'inconclusive';
        if (result.status === 0)
            return 'present';
        if (result.status === 3)
            return 'absent';
        if (result.status === 4)
            return 'disabled';
        return 'inconclusive';
    }
    catch {
        return 'inconclusive';
    }
}
function requireBootstrapManagerState(state, allowed, operation) {
    if (!allowed.includes(state)) {
        throw new Error('bootstrap ' + operation + ' failed closed with manager state ' + state);
    }
}
function recoverBootstrapTransaction(stateDir, run, uid, now, deadlineMs, assertOwner) {
    let journal = readBootstrapJournal(stateDir);
    if (!journal)
        return { status: 'none' };
    if (journal.operation === LEGACY_BOOTSTRAP_REMOVAL_OPERATION) {
        if (journal.stage === 'prepared') {
            assertOwner();
            restoreBootstrapCanonicalQuarantine(stateDir, journal, {
                beforeMove: () => assertOwner(),
                afterMove: () => assertOwner(),
            });
            const transition = readBootstrapManualTransition(stateDir);
            if (transition) {
                if (transition.removedTransactionId !== journal.transactionId
                    || transition.target !== journal.target
                    || transition.service !== journal.service) {
                    throw new Error('legacy bootstrap removal journal conflicts with manual-transition state');
                }
                assertOwner();
                removeBootstrapManualTransition(stateDir, transition.transitionId);
            }
            assertOwner();
            removeBootstrapJournal(stateDir);
            return { status: 'none' };
        }
        if (journal.stage === 'rollback_pending') {
            const managerState = probeBootstrapManagerState(journal.target, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
            if (managerState === 'unavailable' || managerState === 'inconclusive') {
                throw new Error(`legacy bootstrap removal recovery cannot prove manager state: ${managerState}`);
            }
            if (managerState === 'absent') {
                if (journal.managerBinding.kind !== 'legacy-v907-absent') {
                    journal = updateBootstrapJournal(journal, { activationStarted: false }, now());
                    assertOwner();
                    writeBootstrapJournal(stateDir, journal);
                }
            }
            else {
                if (journal.managerBinding.kind === 'legacy-v907-absent') {
                    throw new Error('legacy bootstrap manager appeared after an absent removal receipt');
                }
                assertBootstrapManagerBinding(journal, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), false, false, managerState === 'disabled');
            }
            rollbackBootstrapTransaction(stateDir, journal, run, uid, now, deadlineMs, false, true, assertOwner);
            journal = readBootstrapJournal(stateDir) ?? journal;
        }
        requireBootstrapManagerState(probeBootstrapManagerState(journal.target, run, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS)), ['absent'], 'verify legacy manager is absent after removal');
        if (filesystemEntryExists(bootstrapMarkerPath(stateDir))) {
            throw new Error('legacy bootstrap removal recovery found new canonical marker state');
        }
        assertOwner();
        finalizeBootstrapCanonicalQuarantine(stateDir, journal, {
            beforeMove: () => assertOwner(),
            afterMove: () => assertOwner(),
            beforeDelete: () => assertOwner(),
        });
        assertOwner();
        removeBootstrapJournal(stateDir);
        return {
            status: 'remove-completed',
            transactionId: journal.transactionId,
            target: journal.target,
            service: journal.service,
            files: journal.artifacts.map((artifact) => artifact.path),
            preservedFiles: (journal.preservedArtifacts ?? []).map((artifact) => artifact.path),
        };
    }
    if (journal.terminalAction === 'remove_committed') {
        const marker = readBootstrapMarker(stateDir);
        if (marker)
            assertBootstrapMarkerMatchesJournal(marker, journal);
        assertOwner();
        ensureBootstrapManualTransition(stateDir, journal, now());
        if (journal.stage === 'rolled_back') {
            if (marker) {
                throw new Error('bootstrap removal recovery found a committed marker after durable rollback');
            }
        }
        else {
            rollbackBootstrapTransaction(stateDir, journal, run, uid, now, deadlineMs, marker !== undefined, true, assertOwner);
        }
        assertOwner();
        restoreBootstrapCanonicalQuarantine(stateDir, journal, {
            beforeMove: () => assertOwner(),
            afterMove: () => assertOwner(),
        });
        assertOwner();
        removeBootstrapJournal(stateDir);
        return {
            status: 'remove-completed',
            transactionId: journal.transactionId,
            target: journal.target,
            service: journal.service,
            files: journal.artifacts.map((artifact) => artifact.path),
            preservedFiles: (journal.preservedArtifacts ?? []).map((artifact) => artifact.path),
        };
    }
    if (journal.stage === 'prepared' || journal.stage === 'rolled_back') {
        assertOwner();
        restoreBootstrapCanonicalQuarantine(stateDir, journal, {
            beforeMove: () => assertOwner(),
            afterMove: () => assertOwner(),
        });
        assertOwner();
        removeBootstrapJournal(stateDir);
        return { status: 'none' };
    }
    const marker = readBootstrapMarker(stateDir);
    if (marker) {
        assertBootstrapMarkerMatchesJournal(marker, journal);
        assertOwner();
        finalizeBootstrapCanonicalQuarantine(stateDir, journal, {
            beforeMove: () => assertOwner(),
            afterMove: () => assertOwner(),
            beforeDelete: () => assertOwner(),
        });
        assertOwner();
        removeBootstrapJournal(stateDir);
        return { status: 'none' };
    }
    journal = updateBootstrapJournal(journal, {
        stage: 'rollback_pending',
        deadlineMs,
        lastError: 'recovering an interrupted bootstrap transaction',
    }, now());
    assertOwner();
    writeBootstrapJournal(stateDir, journal);
    rollbackBootstrapTransaction(stateDir, journal, run, uid, now, deadlineMs, false, true, assertOwner);
    assertOwner();
    restoreBootstrapCanonicalQuarantine(stateDir, journal, {
        beforeMove: () => assertOwner(),
        afterMove: () => assertOwner(),
    });
    assertOwner();
    removeBootstrapJournal(stateDir);
    return { status: 'none' };
}
function probeLegacyWindowsLauncherPath(run, timeoutMs, expectedEnabled = true) {
    const enabledCondition = expectedEnabled
        ? '-or -not $settings.Enabled '
        : '-or $settings.Enabled ';
    const command = 'try { $tasks = @(Get-ScheduledTask -TaskPath \'\\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq \'EvoMapEvolverProxyDaemon\' }) } catch { exit 9 }; '
        + 'if ($tasks.Count -ne 1) { exit 3 }; $task = $tasks[0]; $actions = @($task.Actions); $triggers = @($task.Triggers); $settings = $task.Settings; '
        + '$expectedUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; '
        + 'if ($task.TaskPath -ne \'\\\' -or -not [string]::IsNullOrEmpty([string]$task.Description) '
        + '-or $actions.Count -ne 1 -or $actions[0].Execute -ine \'wscript.exe\' '
        + '-or $task.Principal.UserId -ine $expectedUser -or $task.Principal.RunLevel -ne \'Limited\' '
        + '-or $task.Principal.LogonType -ne \'Interactive\' -or $triggers.Count -ne 1 '
        + '-or $triggers[0].CimClass.CimClassName -ne \'MSFT_TaskLogonTrigger\' '
        + '-or $triggers[0].UserId -ine $expectedUser -or -not $triggers[0].Enabled '
        + '-or -not [string]::IsNullOrEmpty([string]$triggers[0].Delay) '
        + enabledCondition + '-or $settings.RestartCount -ne 5 -or $settings.RestartInterval -ne \'PT2M\' '
        + '-or $settings.ExecutionTimeLimit -ne \'PT0S\' -or $settings.MultipleInstances -ne \'IgnoreNew\' '
        + '-or $settings.DisallowStartIfOnBatteries -or $settings.StopIfGoingOnBatteries '
        + '-or $settings.StartWhenAvailable) { exit 5 }; '
        + '$match = [regex]::Match([string]$actions[0].Arguments, \'^"([^"\\r\\n]+)"$\'); '
        + 'if (-not $match.Success) { exit 5 }; $path = $match.Groups[1].Value; '
        + 'try { $full = [System.IO.Path]::GetFullPath($path) } catch { exit 5 }; '
        + 'if (-not [System.IO.Path]::IsPathRooted($path) -or $full -ine $path) { exit 5 }; Write-Output $path; exit 0';
    const result = run(trustedWindowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], timeoutMs);
    requireBootstrapActivation(result, [0], 'inspect exact legacy Windows scheduled task');
    const path = (result.stdout ?? '').trim();
    if (!path || /[\r\n\0]/.test(path)) {
        throw new Error('legacy Windows scheduled task returned an invalid launcher path');
    }
    return path;
}
export const _probeLegacyWindowsLauncherPathForTest = probeLegacyWindowsLauncherPath;
function assertBootstrapMarkerMatchesJournal(marker, journal) {
    if (journal.successMarkerIdentity) {
        const serializedIdentity = bootstrapArtifactIdentityForBytes(Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8'));
        if (serializedIdentity.size !== journal.successMarkerIdentity.size
            || serializedIdentity.sha256 !== journal.successMarkerIdentity.sha256) {
            throw new Error('bootstrap recovery found a success marker inconsistent with its journal');
        }
    }
    if (marker.transactionId !== journal.transactionId
        || marker.target !== journal.target
        || marker.service !== journal.service
        || (marker.managerBindingKind ?? 'transaction') !== (journal.managerBinding.kind ?? 'transaction')
        || resolvePath(marker.managerArtifactPath) !== bootstrapJournalManagerArtifactPath(journal)
        || marker.artifacts.length !== journal.artifacts.length) {
        throw new Error('bootstrap recovery found a success marker inconsistent with its journal');
    }
    for (let index = 0; index < marker.artifacts.length; index += 1) {
        const receipt = marker.artifacts[index];
        const artifact = journal.artifacts[index];
        if (!artifact.identity
            || resolvePath(receipt.path) !== artifact.path
            || receipt.size !== artifact.identity.size
            || receipt.sha256 !== artifact.identity.sha256
            || receipt.device !== artifact.identity.device
            || receipt.inode !== artifact.identity.inode) {
            throw new Error('bootstrap recovery found a success marker inconsistent with its journal');
        }
    }
}
function requireDetachedBootstrapManager(target, run, uid, budget) {
    if (target === 'systemd') {
        requireBootstrapActivation(run(SYSTEMCTL_PATH, ['--user', 'is-active', '--quiet', 'evolver-proxy.service'], budget.nextTimeout()), [3, 4], 'verify systemd user service is inactive');
        requireBootstrapManagerState(probeBootstrapManagerState(target, run, uid, budget.nextTimeout()), ['disabled', 'absent'], 'verify systemd user service is disabled');
        return;
    }
    requireBootstrapManagerState(probeBootstrapManagerState(target, run, uid, budget.nextTimeout()), ['absent'], 'verify service registration is absent');
}
const MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES = 128 * 1024;
function readVerifiedBootstrapManagerArtifact(journal) {
    const managerPath = resolvePath(bootstrapJournalManagerArtifactPath(journal));
    const managerArtifacts = journal.artifacts.filter((candidate) => candidate.path === managerPath);
    if (managerArtifacts.length !== 1) {
        throw new Error('bootstrap manager artifact is not uniquely represented in the durable inventory');
    }
    const artifact = managerArtifacts[0];
    const identity = artifact?.identity;
    if (!identity?.device || !identity.inode
        || identity.size < 1 || identity.size > MAX_BOOTSTRAP_MANAGER_ARTIFACT_BYTES) {
        throw new Error('bootstrap manager artifact has no bounded durable identity');
    }
    const descriptor = openSync(managerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile()
            || String(opened.dev) !== identity.device
            || String(opened.ino) !== identity.inode
            || opened.size !== BigInt(identity.size)) {
            throw new Error('bootstrap manager artifact changed while opening');
        }
        const bytes = Buffer.alloc(identity.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
            if (count === 0)
                throw new Error('bootstrap manager artifact was truncated while reading');
            offset += count;
        }
        const after = fstatSync(descriptor, { bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || createHash('sha256').update(bytes).digest('hex') !== identity.sha256) {
            throw new Error('bootstrap manager artifact changed while reading');
        }
        return bytes;
    }
    finally {
        closeSync(descriptor);
    }
}
function parseSystemdWords(value) {
    const words = [];
    let current = '';
    let quoted = false;
    let started = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '\\') {
            const escaped = value[index + 1];
            if (escaped === undefined)
                return undefined;
            const simple = { s: ' ', n: '\n', r: '\r', t: '\t' }[escaped];
            const hexLength = escaped === 'x' ? 2 : escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0;
            if (simple !== undefined) {
                current += simple;
                index += 1;
            }
            else if (hexLength > 0) {
                const hex = value.slice(index + 2, index + 2 + hexLength);
                if (hex.length !== hexLength || !/^[0-9a-f]+$/i.test(hex))
                    return undefined;
                const codePoint = Number.parseInt(hex, 16);
                try {
                    current += String.fromCodePoint(codePoint);
                }
                catch {
                    return undefined;
                }
                index += 1 + hexLength;
            }
            else if (/[0-7]/.test(escaped)) {
                const octal = value.slice(index + 1, index + 4);
                if (!/^[0-7]{3}$/.test(octal))
                    return undefined;
                current += String.fromCodePoint(Number.parseInt(octal, 8));
                index += 3;
            }
            else {
                current += escaped;
                index += 1;
            }
            started = true;
        }
        else if (character === '"') {
            quoted = !quoted;
            started = true;
        }
        else if (/\s/.test(character) && !quoted) {
            if (started) {
                words.push(current);
                current = '';
                started = false;
            }
        }
        else {
            current += character;
            started = true;
        }
    }
    if (quoted)
        return undefined;
    if (started)
        words.push(current);
    return words;
}
function systemdUnitExecArguments(unit) {
    const execStarts = unit.split(/\r?\n/)
        .filter((line) => line.startsWith('ExecStart='))
        .map((line) => line.slice('ExecStart='.length));
    if (execStarts.length !== 1) {
        throw new Error('bootstrap systemd artifact must declare exactly one ExecStart');
    }
    const words = parseSystemdWords(execStarts[0]);
    if (!words?.[0])
        throw new Error('bootstrap systemd artifact has an invalid ExecStart');
    return words.map((word) => word.replaceAll('%%', '%'));
}
function parseSystemdShow(stdout) {
    const properties = {};
    for (const line of stdout.split(/\r?\n/)) {
        if (!line)
            continue;
        const separator = line.indexOf('=');
        if (separator <= 0)
            throw new Error('systemd returned an invalid manager binding property');
        const name = line.slice(0, separator);
        if (Object.hasOwn(properties, name)) {
            throw new Error(`systemd returned duplicate manager binding property: ${name}`);
        }
        properties[name] = line.slice(separator + 1);
    }
    return properties;
}
function systemdShowExecBinding(value) {
    const match = /^\{\s*path=(.*?)\s*;\s*argv\[\]=(.*)\s+;\s+ignore_errors=/.exec(value.trim());
    if (!match?.[1] || match[2] === undefined)
        return undefined;
    const paths = parseSystemdWords(match[1]);
    const argumentsList = parseSystemdWords(match[2]);
    return paths?.length === 1 && paths[0] && argumentsList?.[0]
        ? { path: resolvePath(paths[0]), arguments: argumentsList }
        : undefined;
}
function environmentAssignments(assignments, label) {
    const environment = new Map();
    for (const assignment of assignments) {
        const separator = assignment.indexOf('=');
        if (separator <= 0)
            throw new Error(`${label} has an invalid environment assignment`);
        const name = assignment.slice(0, separator);
        if (environment.has(name))
            throw new Error(`${label} has a duplicate environment assignment`);
        environment.set(name, assignment.slice(separator + 1));
    }
    return environment;
}
function systemdUnitEnvironment(unit) {
    const assignments = unit.split(/\r?\n/).flatMap((line) => {
        if (!line.startsWith('Environment='))
            return [];
        const words = parseSystemdWords(line.slice('Environment='.length));
        if (!words)
            throw new Error('bootstrap systemd artifact has invalid environment quoting');
        return words.map((word) => word.replaceAll('%%', '%'));
    });
    return environmentAssignments(assignments, 'bootstrap systemd artifact');
}
export function validateSystemdBootstrapManagerBinding(journal, unit, stdout, requireRunning = true) {
    const properties = parseSystemdShow(stdout);
    const expected = resolvePath(bootstrapJournalManagerArtifactPath(journal));
    const rawEnvironment = parseSystemdWords(properties['Environment'] ?? '');
    if (!rawEnvironment)
        throw new Error('systemd returned invalid environment quoting');
    const actualEnvironment = environmentAssignments(rawEnvironment, 'systemd manager binding');
    const expectedEnvironment = systemdUnitEnvironment(unit);
    const expectedTransaction = expectedEnvironment.get(coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV);
    const transactionMatches = (journal.managerBinding.kind ?? 'transaction') !== 'transaction'
        ? expectedTransaction === undefined
        : expectedTransaction === journal.transactionId;
    const environmentMatches = actualEnvironment.size === expectedEnvironment.size
        && [...expectedEnvironment].every(([name, value]) => actualEnvironment.get(name) === value);
    const expectedExecArguments = systemdUnitExecArguments(unit);
    const loadedExec = systemdShowExecBinding(properties['ExecStart'] ?? '');
    const execMatches = loadedExec !== undefined
        && loadedExec.path === resolvePath(expectedExecArguments[0])
        && loadedExec.arguments.length === expectedExecArguments.length
        && loadedExec.arguments.every((argument, index) => argument === expectedExecArguments[index]);
    const rawManagerPid = properties['MainPID'];
    const managerPid = rawManagerPid !== undefined && /^\d+$/.test(rawManagerPid)
        ? Number(rawManagerPid)
        : Number.NaN;
    if (!properties['FragmentPath'] || resolvePath(properties['FragmentPath']) !== expected
        || properties['DropInPaths']?.trim() !== ''
        || properties['NeedDaemonReload'] !== 'no'
        || !execMatches
        || !transactionMatches
        || !environmentMatches) {
        throw new Error('bootstrap rollback refused a changed systemd manager binding');
    }
    if (!Number.isSafeInteger(managerPid) || managerPid < 0) {
        throw new Error('bootstrap could not prove the systemd supervisor process');
    }
    if (requireRunning && managerPid === 0) {
        throw new BootstrapManagerNotRunningError('bootstrap could not prove the systemd supervisor process');
    }
    return managerPid === 0 ? undefined : managerPid;
}
function decodeGeneratedPlistString(value) {
    if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) {
        throw new Error('bootstrap launchd artifact contains an unsupported XML entity');
    }
    return value
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&amp;', '&');
}
function launchdPlistProgramArguments(plist) {
    const matches = [...plist.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
        throw new Error('bootstrap launchd artifact must declare one ProgramArguments array');
    }
    const body = matches[0][1];
    const argumentsList = [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)]
        .map((match) => decodeGeneratedPlistString(match[1] ?? ''));
    const residue = body.replace(/<string>[\s\S]*?<\/string>/g, '').trim();
    if (residue || argumentsList.length === 0 || argumentsList.some((argument) => !argument)) {
        throw new Error('bootstrap launchd artifact has invalid ProgramArguments');
    }
    return argumentsList;
}
function generatedPlistString(plist, key) {
    const marker = `<key>${key}</key>`;
    const parts = plist.split(marker);
    const match = parts.length === 2
        ? /^\s*<string>([\s\S]*?)<\/string>/.exec(parts[1])
        : undefined;
    if (match?.[1] === undefined) {
        throw new Error(`bootstrap launchd artifact must declare one ${key} string`);
    }
    return decodeGeneratedPlistString(match[1]);
}
function launchdPlistEnvironment(plist) {
    const matches = [...plist.matchAll(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
        throw new Error('bootstrap launchd artifact must declare one EnvironmentVariables dictionary');
    }
    const body = matches[0][1];
    const assignments = [...body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map((match) => `${decodeGeneratedPlistString(match[1] ?? '')}=${decodeGeneratedPlistString(match[2] ?? '')}`);
    const residue = body.replace(/<key>[\s\S]*?<\/key>\s*<string>[\s\S]*?<\/string>/g, '').trim();
    if (residue)
        throw new Error('bootstrap launchd artifact has invalid environment entries');
    return environmentAssignments(assignments, 'bootstrap launchd artifact');
}
function launchdPrintScalar(stdout, name, required = true) {
    const prefix = name + ' = ';
    const matches = stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length));
    if (matches.length > 1 || (required && (matches.length !== 1 || !matches[0]))) {
        throw new Error(`launchd returned an invalid ${name} binding`);
    }
    return matches[0];
}
function launchdPrintBlock(stdout, name) {
    const lines = stdout.split(/\r?\n/);
    const starts = lines.flatMap((line, index) => line.trim() === `${name} = {` ? [index] : []);
    if (starts.length !== 1)
        throw new Error(`launchd returned an invalid ${name} binding`);
    const values = [];
    for (let index = starts[0] + 1; index < lines.length; index += 1) {
        const value = lines[index].trim();
        if (value === '}')
            return values;
        if (!value || value.endsWith(' = {')) {
            throw new Error(`launchd returned an invalid ${name} binding`);
        }
        values.push(value);
    }
    throw new Error(`launchd returned an unterminated ${name} binding`);
}
function launchdPrintEnvironment(stdout) {
    const assignments = launchdPrintBlock(stdout, 'environment').map((entry) => {
        const separator = entry.indexOf(' => ');
        if (separator <= 0)
            throw new Error('launchd returned an invalid environment binding');
        return entry.slice(0, separator) + '=' + entry.slice(separator + 4);
    });
    return environmentAssignments(assignments, 'launchd manager binding');
}
export function validateLaunchdBootstrapManagerBinding(journal, plist, stdout, requireRunning = true) {
    const expectedPath = resolvePath(bootstrapJournalManagerArtifactPath(journal));
    const expectedArguments = launchdPlistProgramArguments(plist);
    const expectedEnvironment = launchdPlistEnvironment(plist);
    const actualArguments = launchdPrintBlock(stdout, 'arguments');
    const actualEnvironment = launchdPrintEnvironment(stdout);
    const expectedTransaction = expectedEnvironment.get(coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV);
    const transactionMatches = (journal.managerBinding.kind ?? 'transaction') !== 'transaction'
        ? expectedTransaction === undefined
        : expectedTransaction === journal.transactionId;
    const environmentMatches = [...expectedEnvironment]
        .every(([name, value]) => actualEnvironment.get(name) === value);
    const unexpectedDangerousEnvironment = [...actualEnvironment.keys()].some((name) => !expectedEnvironment.has(name)
        && (name.startsWith('EVOLVER_')
            || name.startsWith('DYLD_')
            || name.startsWith('LD_')
            || name === 'NODE_OPTIONS'
            || name === 'NODE_PATH'));
    const actualPath = launchdPrintScalar(stdout, 'path');
    const actualProgram = launchdPrintScalar(stdout, 'program');
    const actualWorkingDirectory = launchdPrintScalar(stdout, 'working directory');
    const rawPid = launchdPrintScalar(stdout, 'pid', false);
    const pid = rawPid !== undefined && /^\d+$/.test(rawPid) ? Number(rawPid) : undefined;
    if (!actualPath
        || resolvePath(actualPath) !== expectedPath
        || actualProgram !== expectedArguments[0]
        || actualWorkingDirectory !== generatedPlistString(plist, 'WorkingDirectory')
        || actualArguments.length !== expectedArguments.length
        || actualArguments.some((argument, index) => argument !== expectedArguments[index])
        || !transactionMatches
        || !environmentMatches
        || unexpectedDangerousEnvironment) {
        throw new Error('bootstrap rollback refused a changed launchd manager binding');
    }
    if (rawPid !== undefined && (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0)) {
        throw new Error('bootstrap could not prove the launchd supervisor process');
    }
    if (requireRunning && pid === undefined) {
        throw new BootstrapManagerNotRunningError('bootstrap could not prove the launchd supervisor process');
    }
    return pid;
}
function canonicalWindowsLauncherPath(value, label) {
    if (!value || !win32.isAbsolute(value) || win32.normalize(value) !== value || value.includes('"')) {
        throw new Error(`bootstrap Windows launcher has an invalid ${label}`);
    }
    return value;
}
export function parseWindowsBootstrapLauncherBinding(journal, bytes) {
    if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xfe || bytes.length % 2 !== 0) {
        throw new Error('bootstrap Windows launcher is not a UTF-16LE script');
    }
    const source = bytes.subarray(2).toString('utf16le');
    const lines = source.split(/\r?\n/);
    const transactionLine = `env("${coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV}") = "${journal.transactionId}"`;
    const transactionLines = lines.filter((line) => line.startsWith(`env("${coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV}") = `));
    const transactionMatches = (journal.managerBinding.kind ?? 'transaction') !== 'transaction'
        ? transactionLines.length === 0
        : transactionLines.length === 1 && transactionLines[0] === transactionLine;
    if (!transactionMatches
        || lines.filter((line) => line === 'env("EVOLVER_SELF_UPDATE_SUPERVISOR") = "windows-scheduled-task"').length !== 1) {
        throw new Error('bootstrap Windows launcher has an invalid transaction binding');
    }
    const modeLines = lines.flatMap((line) => {
        const match = /^If "([^"]*)" <> "" Then$/.exec(line);
        return match ? [match[1] ?? ''] : [];
    });
    if (modeLines.length !== 1)
        throw new Error('bootstrap Windows launcher has an invalid mode binding');
    const quote = String.fromCharCode(34);
    const lifecycleStatePrefix = 'If ' + quote;
    const lifecycleStateSeparator = quote + ' <> ' + quote + quote
        + ' Then env(' + quote + 'EVOLVER_LIFECYCLE_STATE_DIR' + quote + ') = ' + quote;
    const lifecycleStateLines = lines.flatMap((line) => {
        if (!line.startsWith(lifecycleStatePrefix) || !line.endsWith(quote))
            return [];
        const body = line.slice(lifecycleStatePrefix.length, -quote.length);
        const parts = body.split(lifecycleStateSeparator);
        return parts.length === 2 && parts[0] && parts[0] === parts[1] ? [parts[0]] : [];
    });
    if (lifecycleStateLines.length > 1) {
        throw new Error('bootstrap Windows launcher has an invalid lifecycle state binding');
    }
    const lifecycleStateDir = lifecycleStateLines[0]
        ? canonicalWindowsLauncherPath(lifecycleStateLines[0], 'lifecycle state directory')
        : undefined;
    const controllerArtifacts = journal.artifacts.filter((artifact) => artifact.path !== bootstrapJournalManagerArtifactPath(journal)
        && win32.basename(artifact.path).toLowerCase() === 'evolver-recovery-controller.exe');
    const standaloneTarget = modeLines[0];
    if (standaloneTarget) {
        const stateDirPrefix = '  stateDir = ' + quote;
        const stateDirLines = lines.flatMap((line) => line.startsWith(stateDirPrefix) && line.endsWith(quote)
            ? [line.slice(stateDirPrefix.length, -quote.length)]
            : []);
        const commandLines = lines.flatMap((line) => {
            const match = /^ {2}cmd = """([^"]+)"" proxy"$/.exec(line);
            return match?.[1] ? [match[1]] : [];
        });
        if (commandLines.length !== 1 || commandLines[0] !== standaloneTarget
            || controllerArtifacts.length !== 1 || stateDirLines.length !== 1) {
            throw new Error('bootstrap Windows launcher has an invalid recovery-controller binding');
        }
        return {
            mode: 'controller',
            proxyExecutable: canonicalWindowsLauncherPath(standaloneTarget, 'proxy executable'),
            controllerExecutable: canonicalWindowsLauncherPath(controllerArtifacts[0].path, 'controller executable'),
            ...(lifecycleStateDir ? { lifecycleStateDir } : {}),
            selfUpdateStateDir: canonicalWindowsLauncherPath(stateDirLines[0], 'self-update state directory'),
        };
    }
    const directCommands = lines.flatMap((line) => {
        const match = /^ {2}cmd = """([^"]+)"" ""([^"]+)"""$/.exec(line);
        return match?.[1] && match[2] ? [[match[1], match[2]]] : [];
    });
    if (directCommands.length !== 1 || controllerArtifacts.length !== 0) {
        throw new Error('bootstrap Windows launcher has an invalid direct proxy binding');
    }
    return {
        mode: 'direct',
        proxyExecutable: canonicalWindowsLauncherPath(directCommands[0][0], 'proxy executable'),
        proxyScript: canonicalWindowsLauncherPath(directCommands[0][1], 'proxy script'),
        ...(lifecycleStateDir ? { lifecycleStateDir } : {}),
    };
}
function bootstrapManagerDescription(journal) {
    return (journal.managerBinding.kind ?? 'transaction') !== 'transaction'
        ? ''
        : `EvoMap Evolver bootstrap transaction ${journal.transactionId}`;
}
function assertBootstrapManagerBinding(journal, run, uid, timeoutMs, requireRunning = true, allowNotReady = false, allowDisabled = false) {
    const expected = resolvePath(bootstrapJournalManagerArtifactPath(journal));
    const managerArtifact = readVerifiedBootstrapManagerArtifact(journal);
    if (journal.target === 'systemd') {
        const result = run(SYSTEMCTL_PATH, [
            '--user', 'show', 'evolver-proxy.service',
            '--property=FragmentPath', '--property=DropInPaths', '--property=NeedDaemonReload',
            '--property=ExecStart', '--property=MainPID', '--property=Environment',
        ], timeoutMs);
        if (allowNotReady && (result.error || result.status === null || result.status !== 0)) {
            throw new BootstrapManagerNotRunningError('bootstrap systemd manager binding is not running yet');
        }
        requireBootstrapActivation(result, [0], 'verify systemd manager binding');
        return validateSystemdBootstrapManagerBinding(journal, managerArtifact.toString('utf8'), result.stdout ?? '', requireRunning);
    }
    if (journal.target === 'launchd') {
        const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        if (userId === undefined)
            throw new Error('cannot determine the current user id for launchd binding verification');
        const result = run(LAUNCHCTL_PATH, [
            'print', 'gui/' + String(userId) + '/com.evomap.evolver-proxy',
        ], timeoutMs);
        if (allowNotReady && (result.error || result.status === null || result.status !== 0)) {
            throw new BootstrapManagerNotRunningError('bootstrap launchd manager binding is not running yet');
        }
        requireBootstrapActivation(result, [0], 'verify launchd manager binding');
        return validateLaunchdBootstrapManagerBinding(journal, managerArtifact.toString('utf8'), result.stdout ?? '', requireRunning);
    }
    parseWindowsBootstrapLauncherBinding(journal, managerArtifact);
    const escaped = expected.replaceAll("'", "''");
    const escapedWscript = trustedWindowsSystemExecutable('wscript.exe').replaceAll("'", "''");
    const escapedDescription = bootstrapManagerDescription(journal).replaceAll("'", "''");
    const legacyBinding = (journal.managerBinding.kind ?? 'transaction') !== 'transaction';
    const escapedTaskExecute = (legacyBinding ? 'wscript.exe' : trustedWindowsSystemExecutable('wscript.exe'))
        .replaceAll("'", "''");
    const descriptionCondition = legacyBinding
        ? '[string]::IsNullOrEmpty([string]$task.Description)'
        : '$task.Description -eq $expectedDescription';
    const availabilityCondition = legacyBinding
        ? '-and -not $settings.StartWhenAvailable '
        : '-and $settings.StartWhenAvailable ';
    const runningCondition = requireRunning ? '-and $task.State -eq \'Running\'' : '';
    const enabledCondition = allowDisabled
        ? '-and -not $settings.Enabled '
        : '-and $settings.Enabled ';
    const runningAction = 'try { $scheduler = New-Object -ComObject \'Schedule.Service\'; $scheduler.Connect(); '
        + '$registered = $scheduler.GetFolder(\'\\\').GetTask(\'\\EvoMapEvolverProxyDaemon\'); '
        + '$instances = $registered.GetInstances(0) } catch { exit 9 }; '
        + 'if ($instances.Count -ne 1) { exit 6 }; $enginePid = [int64]$instances.Item(1).EnginePID; '
        + 'if ($enginePid -le 0) { exit 7 }; '
        + '$engine = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $enginePid) -ErrorAction Stop); '
        + 'if ($engine.Count -ne 1) { exit 8 }; '
        + '$children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $enginePid) -ErrorAction Stop); '
        + '$candidates = @($engine[0]) + $children; $quotedLauncher = \'"\' + $expected + \'"\'; '
        + '$expectedCommand = $expectedWscript + \' \' + $quotedLauncher; '
        + '$expectedQuotedCommand = \'"\' + $expectedWscript + \'" \' + $quotedLauncher; '
        + '$actionProcesses = @($candidates | Where-Object { $_.ExecutablePath -ieq $expectedWscript '
        + '-and $_.CommandLine -and ($_.CommandLine.Trim() -ieq $expectedCommand '
        + '-or $_.CommandLine.Trim() -ieq $expectedQuotedCommand) }); '
        + 'if ($actionProcesses.Count -ne 1) { exit 10 }; '
        + 'Write-Output ([string]$actionProcesses[0].ProcessId); exit 0';
    const boundAction = requireRunning
        ? runningAction
        : `if ($task.State -eq 'Running') { ${runningAction} } else { exit 0 }`;
    const command = 'try { $tasks = @(Get-ScheduledTask -TaskPath \'\\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq \'EvoMapEvolverProxyDaemon\' }) } catch { exit 9 }; '
        + `if ($tasks.Count -ne 1) { exit 3 }; $task = $tasks[0]; $expected = '${escaped}'; `
        + `$expectedWscript = '${escapedWscript}'; $expectedTaskExecute = '${escapedTaskExecute}'; $expectedDescription = '${escapedDescription}'; $actions = @($task.Actions); `
        + '$triggers = @($task.Triggers); $settings = $task.Settings; '
        + '$expectedUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; '
        + `if ($task.TaskPath -eq '\\' -and ${descriptionCondition} `
        + '-and $actions.Count -eq 1 -and $actions[0].Execute -ieq $expectedTaskExecute '
        + '-and $actions[0].Arguments -eq (\'"\' + $expected + \'"\') '
        + '-and $task.Principal.UserId -ieq $expectedUser -and $task.Principal.RunLevel -eq \'Limited\' '
        + '-and $task.Principal.LogonType -eq \'Interactive\' -and $triggers.Count -eq 1 '
        + '-and $triggers[0].CimClass.CimClassName -eq \'MSFT_TaskLogonTrigger\' '
        + '-and $triggers[0].UserId -ieq $expectedUser -and $triggers[0].Enabled '
        + '-and [string]::IsNullOrEmpty([string]$triggers[0].Delay) '
        + enabledCondition + '-and $settings.RestartCount -eq 5 -and $settings.RestartInterval -eq \'PT2M\' '
        + '-and $settings.ExecutionTimeLimit -eq \'PT0S\' -and $settings.MultipleInstances -eq \'IgnoreNew\' '
        + '-and -not $settings.DisallowStartIfOnBatteries -and -not $settings.StopIfGoingOnBatteries '
        + availabilityCondition + runningCondition + ') { '
        + boundAction + ' } else { exit 5 }';
    const result = run(trustedWindowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], timeoutMs);
    if (result.status === 5) {
        throw new Error('bootstrap rollback refused a changed Windows scheduled task binding');
    }
    if (!requireRunning && [3, 6, 7, 8, 9, 10].includes(result.status ?? -1)) {
        return undefined;
    }
    if (requireRunning && (result.error || result.status === null || result.status !== 0)) {
        throw new BootstrapManagerNotRunningError('bootstrap Windows scheduled task binding is not running yet');
    }
    requireBootstrapActivation(result, [0], 'verify Windows scheduled task binding');
    const rawPid = (result.stdout ?? '').trim();
    if (!requireRunning && rawPid === '')
        return undefined;
    if (requireRunning && rawPid === '') {
        throw new BootstrapManagerNotRunningError('bootstrap could not prove the Windows task action process');
    }
    if (!/^\d+$/.test(rawPid))
        throw new Error('bootstrap could not prove the Windows task action process');
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('bootstrap could not prove the Windows task action process');
    }
    return pid;
}
async function waitForBootstrapManagerBinding(journal, run, uid, deadlineMs, now, maxWaitMs, assertOwner) {
    const available = deadlineMs - now() - BOOTSTRAP_ROLLBACK_RESERVE_MS;
    const waitMs = Math.min(maxWaitMs, available);
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
        throw new Error('bootstrap cannot reserve manager binding verification before rollback deadline');
    }
    const wallDeadlineMs = Date.now() + waitMs;
    let lastTransient;
    while (Date.now() < wallDeadlineMs
        && deadlineMs - now() > BOOTSTRAP_ROLLBACK_RESERVE_MS) {
        const timeoutMs = bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadlineMs);
        const managerState = probeBootstrapManagerState(journal.target, run, uid, timeoutMs);
        assertForwardMutationBudget(deadlineMs, now());
        if (managerState === 'unavailable') {
            throw new Error('bootstrap post-activation manager domain is unavailable');
        }
        if (managerState === 'present') {
            try {
                const managerPid = assertBootstrapManagerBinding(journal, run, uid, bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadlineMs), false, true);
                if (managerPid === undefined) {
                    throw new BootstrapManagerNotRunningError('bootstrap service manager did not expose a supervisor process');
                }
                return managerPid;
            }
            catch (error) {
                if (!(error instanceof BootstrapManagerNotRunningError))
                    throw error;
                lastTransient = error;
            }
        }
        else {
            lastTransient = new BootstrapManagerNotRunningError(`bootstrap service manager is not running yet (${managerState})`);
        }
        if (Date.now() >= wallDeadlineMs)
            break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        assertOwner();
    }
    throw new Error('bootstrap service manager did not expose a running exact binding before the forward deadline', { cause: lastTransient });
}
function inspectBootstrapReadinessProcessAttestations(readiness, deps) {
    if (!coreBootstrap.parseLifecycleBootstrapReadiness(readiness)) {
        throw new Error('bootstrap readiness process attestation is invalid');
    }
    const inspect = deps.readinessOwnerProcessStatus ?? coreUtil.inspectFileLockOwnerProcess;
    const pidStatus = inspect({
        pid: readiness.pid,
        processStartIdentity: readiness.pidProcessStartIdentity,
    });
    if (readiness.supervisorPid === readiness.pid)
        return [pidStatus];
    return [
        pidStatus,
        inspect({
            pid: readiness.supervisorPid,
            processStartIdentity: readiness.supervisorProcessStartIdentity,
        }),
    ];
}
function assertBootstrapReadinessProcessAttestationsCurrent(readiness, deps) {
    const statuses = inspectBootstrapReadinessProcessAttestations(readiness, deps);
    if (statuses.some((status) => status !== 'current')) {
        throw new Error(`bootstrap readiness process attestation is no longer current (${statuses.join(', ')})`);
    }
}
function assertWindowsBootstrapProxyProcessBinding(journal, proxyPid, managerPid, run, timeoutMs, expectedControllerPid) {
    const launcher = parseWindowsBootstrapLauncherBinding(journal, readVerifiedBootstrapManagerArtifact(journal));
    const ps = (value) => `'${value.replaceAll("'", "''")}'`;
    const expectedWscript = ps(trustedWindowsSystemExecutable('wscript.exe'));
    const expectedLauncher = ps(bootstrapJournalManagerArtifactPath(journal));
    const proxyExecutable = ps(launcher.proxyExecutable);
    const common = [
        `$managerPid = ${managerPid}`,
        `$proxyPid = ${proxyPid}`,
        `$expectedWscript = ${expectedWscript}`,
        `$expectedLauncher = ${expectedLauncher}`,
        `$expectedProxy = ${proxyExecutable}`,
        '$manager = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $managerPid) -ErrorAction Stop)',
        '$proxy = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $proxyPid) -ErrorAction Stop)',
        'if ($manager.Count -ne 1 -or $proxy.Count -ne 1) { exit 11 }',
        'if ($manager[0].ExecutablePath -ine $expectedWscript -or $proxy[0].ExecutablePath -ine $expectedProxy) { exit 12 }',
        '$quotedLauncher = [char]34 + $expectedLauncher + [char]34',
        '$expectedManagerCommand = $expectedWscript + " " + $quotedLauncher',
        '$expectedQuotedManagerCommand = [char]34 + $expectedWscript + [char]34 + " " + $quotedLauncher',
        'if (-not $manager[0].CommandLine -or ($manager[0].CommandLine.Trim() -ine $expectedManagerCommand '
            + '-and $manager[0].CommandLine.Trim() -ine $expectedQuotedManagerCommand)) { exit 19 }',
    ];
    const modeSpecific = launcher.mode === 'controller'
        ? [
            `$controllerPid = ${expectedControllerPid ?? '$proxy[0].ParentProcessId'}`,
            `$expectedController = ${ps(launcher.controllerExecutable)}`,
            '$controller = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $controllerPid) -ErrorAction Stop)',
            'if ($controller.Count -ne 1) { exit 13 }',
            'if ($controller[0].ParentProcessId -ne $managerPid -or $proxy[0].ParentProcessId -ne $controllerPid) { exit 14 }',
            'if ($controller[0].ExecutablePath -ine $expectedController) { exit 15 }',
            "if ($controller[0].CommandLine -notmatch '(?i)(?:^|[ ])proxy[ ]+--evolver-windows-recovery-controller(?:[ ]|$)') { exit 16 }",
            "if ($proxy[0].CommandLine -notmatch '(?i)(?:^|[ ])proxy(?:[ ]|$)') { exit 17 }",
        ]
        : [
            `$expectedProxyScript = ${ps(launcher.proxyScript)}`,
            '$quotedProxyScript = [char]34 + $expectedProxyScript + [char]34',
            'if ($proxy[0].ParentProcessId -ne $managerPid -or -not $proxy[0].CommandLine.Contains($quotedProxyScript)) { exit 18 }',
        ];
    requireBootstrapActivation(run(trustedWindowsPowerShell(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [...common, ...modeSpecific, 'exit 0'].join('; '),
    ], timeoutMs), [0], 'verify Windows scheduled task process ancestry');
}
function assertBootstrapManagerStillBound(journal, readiness, expectedManagerPid, run, uid, nextTimeout, deps) {
    assertBootstrapReadinessProcessAttestationsCurrent(readiness, deps);
    const currentManagerPid = assertBootstrapManagerBinding(journal, run, uid, nextTimeout());
    if (currentManagerPid !== expectedManagerPid
        || !bootstrapReadinessMatchesManager(journal, readiness, currentManagerPid)) {
        throw new Error('bootstrap service manager binding changed during health verification');
    }
    if (journal.target === 'windows') {
        assertWindowsBootstrapProcessBinding(journal, readiness, currentManagerPid, run, nextTimeout());
    }
}
function bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadlineMs) {
    const wallAvailable = wallDeadlineMs - Date.now();
    if (wallAvailable <= 0) {
        throw new Error('bootstrap health verification deadline expired before manager verification');
    }
    return Math.min(wallAvailable, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
}
function assertWindowsBootstrapProcessBinding(journal, readiness, managerPid, run, timeoutMs) {
    if (!bootstrapReadinessMatchesManager(journal, readiness, managerPid)) {
        throw new Error('bootstrap Windows readiness is not bound to the scheduled task action');
    }
    assertWindowsBootstrapProxyProcessBinding(journal, readiness.pid, managerPid, run, timeoutMs, readiness.supervisorPid);
}
async function requireBootstrapProxyHealth(paths, env, journal, managerPid, deps, run, uid, deadlineMs, now, assertOwner) {
    const available = deadlineMs - now() - BOOTSTRAP_ROLLBACK_RESERVE_MS;
    const timeoutMs = Math.min(deps.healthTimeoutMs ?? BOOTSTRAP_HEALTH_TIMEOUT_MS, available);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('bootstrap cannot reserve health verification before rollback deadline');
    }
    const wallDeadline = Date.now() + timeoutMs;
    const readinessProbe = deps.readiness ?? readBootstrapReadiness;
    do {
        if (Date.now() >= wallDeadline || deadlineMs - now() <= BOOTSTRAP_ROLLBACK_RESERVE_MS)
            break;
        const readiness = readinessProbe(paths.stateDir);
        const status = readiness
            ? await probeBootstrapReadinessHealth(paths, env, readiness, deps.health, bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadline), assertOwner)
            : { running: false, healthy: false };
        assertOwner();
        assertForwardMutationBudget(deadlineMs, now());
        if (readiness?.transactionId === journal.transactionId
            && status.running && status.healthy
            && status.pid === readiness.pid
            && status.startedAt === readiness.startedAt
            && status.url === readiness.ipcUrl
            && bootstrapReadinessMatchesManager(journal, readiness, managerPid)) {
            assertBootstrapManagerStillBound(journal, readiness, managerPid, run, uid, () => bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadline), deps);
            return readiness;
        }
        if (Date.now() >= wallDeadline)
            break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        assertOwner();
    } while (deadlineMs - now() > BOOTSTRAP_ROLLBACK_RESERVE_MS);
    throw new Error('bootstrap service did not become healthy under the verified manager binding');
}
export function bootstrapReadinessMatchesManager(journal, readiness, managerPid) {
    if (managerPid === undefined)
        return false;
    const controllerFilename = journal.target === 'windows'
        ? 'evolver-recovery-controller.exe'
        : UNIX_RECOVERY_CONTROLLER_FILENAME;
    const controllerArtifacts = journal.artifacts.filter((artifact) => artifact.path !== bootstrapJournalManagerArtifactPath(journal)
        && (journal.target === 'windows' ? win32.basename(artifact.path) : basename(artifact.path))
            .toLowerCase() === controllerFilename);
    if (controllerArtifacts.length > 1)
        return false;
    if (controllerArtifacts.length === 1) {
        if (journal.target === 'windows') {
            return readiness.pid !== readiness.supervisorPid
                && readiness.supervisorPid !== managerPid
                && readiness.pid !== managerPid;
        }
        return readiness.pid !== managerPid && readiness.supervisorPid === managerPid;
    }
    if (journal.target === 'windows') {
        return readiness.pid !== managerPid && readiness.supervisorPid === managerPid;
    }
    return readiness.pid === managerPid;
}
async function probeBootstrapReadinessHealth(paths, env, readiness, injected, timeoutMs, assertOwner) {
    if (!injected) {
        const settings = readProxySettings(paths.settingsFile, { quietReadError: true });
        if (settings.pid !== readiness.pid || settings.startedAt !== readiness.startedAt
            || settings.url !== readiness.ipcUrl || !settings.token || !isPidRunning(readiness.pid)) {
            return { running: false, healthy: false };
        }
        const healthy = await proxyStatusOk(settings, Math.max(1, Math.min(DEFAULT_HEALTH_TIMEOUT_MS, timeoutMs)));
        assertOwner();
        return {
            running: true,
            pid: readiness.pid,
            healthy,
            startedAt: readiness.startedAt,
            url: readiness.ipcUrl,
        };
    }
    let timer;
    try {
        const status = await Promise.race([
            injected(paths, env),
            new Promise((resolvePromise) => {
                timer = setTimeout(() => resolvePromise({ running: false, healthy: false, reason: 'health_timeout' }), timeoutMs);
            }),
        ]);
        assertOwner();
        return status;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function assertLegacyUnixProxyProcessBinding(journal, proxyPid, managerPid, run, timeoutMs) {
    const controllerArtifacts = journal.artifacts.filter((artifact) => artifact.path !== bootstrapJournalManagerArtifactPath(journal)
        && basename(artifact.path) === UNIX_RECOVERY_CONTROLLER_FILENAME);
    if (controllerArtifacts.length > 1) {
        throw new Error('legacy Unix bootstrap has an ambiguous recovery-controller inventory');
    }
    if (controllerArtifacts.length === 0) {
        if (proxyPid !== managerPid) {
            throw new Error('legacy Unix proxy health PID is not the exact service-manager PID');
        }
        return;
    }
    if (proxyPid === managerPid) {
        throw new Error('legacy Unix controller proxy PID is not a child process');
    }
    const result = run(PS_PATH, ['-o', 'ppid=', '-p', String(proxyPid)], timeoutMs);
    requireBootstrapActivation(result, [0], 'verify legacy Unix proxy process ancestry');
    const parent = (result.stdout ?? '').trim();
    if (!/^\d+$/.test(parent) || Number(parent) !== managerPid) {
        throw new Error('legacy Unix proxy process is not a direct child of the exact recovery controller');
    }
}
async function requireLegacyBootstrapProxyHealth(paths, env, journal, managerPid, deps, run, uid, deadlineMs, now, assertOwner) {
    const available = deadlineMs - now() - BOOTSTRAP_ROLLBACK_RESERVE_MS;
    const timeoutMs = Math.min(deps.healthTimeoutMs ?? BOOTSTRAP_HEALTH_TIMEOUT_MS, available);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('legacy bootstrap cannot reserve health verification before rollback deadline');
    }
    const wallDeadline = Date.now() + timeoutMs;
    do {
        const probeTimeout = bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadline);
        let timer;
        let status;
        try {
            status = await Promise.race([
                deps.health
                    ? deps.health(paths, env)
                    : lifecycleStatus(paths, env, { timeoutMs: probeTimeout, quietSettingsReadError: true }),
                new Promise((resolvePromise) => {
                    timer = setTimeout(() => resolvePromise({ running: false, healthy: false, reason: 'health_timeout' }), probeTimeout);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        assertOwner();
        if (status.running && status.healthy && Number.isSafeInteger(status.pid) && (status.pid ?? 0) > 0) {
            const currentManagerPid = assertBootstrapManagerBinding(journal, run, uid, bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadline));
            if (currentManagerPid !== managerPid) {
                throw new Error('legacy bootstrap manager PID changed during health verification');
            }
            if (journal.target === 'windows') {
                assertWindowsBootstrapProxyProcessBinding(journal, status.pid, managerPid, run, bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadline));
            }
            else {
                assertLegacyUnixProxyProcessBinding(journal, status.pid, managerPid, run, bootstrapHealthCommandTimeout(deadlineMs, now, wallDeadline));
            }
            return;
        }
        if (Date.now() >= wallDeadline)
            break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        assertOwner();
    } while (deadlineMs - now() > BOOTSTRAP_ROLLBACK_RESERVE_MS);
    throw new Error('legacy bootstrap service is not healthy under the exact manager process tree');
}
function detachBootstrapManager(journal, run, uid, budget) {
    const state = probeBootstrapManagerState(journal.target, run, uid, budget.nextTimeout());
    if (state === 'absent')
        return;
    if (state === 'unavailable' || state === 'inconclusive') {
        throw new Error('bootstrap rollback cannot prove the service manager state');
    }
    if (journal.target === 'systemd') {
        const active = run(SYSTEMCTL_PATH, ['--user', 'is-active', '--quiet', 'evolver-proxy.service'], budget.nextTimeout());
        requireBootstrapActivation(active, [0, 3, 4], 'inspect systemd activity during rollback');
        const isActive = active.status === 0;
        if (!isActive && state === 'disabled')
            return;
        assertBootstrapManagerBinding(journal, run, uid, budget.nextTimeout(), isActive);
        requireBootstrapActivation(run(SYSTEMCTL_PATH, ['--user', 'disable', '--now', 'evolver-proxy.service'], budget.nextTimeout()), [0], 'disable systemd user service during rollback');
    }
    else if (journal.target === 'launchd') {
        assertBootstrapManagerBinding(journal, run, uid, budget.nextTimeout(), false);
        const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        if (userId === undefined)
            throw new Error('cannot determine the current user id for launchd rollback');
        requireBootstrapActivation(run(LAUNCHCTL_PATH, ['bootout', 'gui/' + String(userId) + '/com.evomap.evolver-proxy'], budget.nextTimeout()), [0], 'remove launchd agent during rollback');
    }
    else {
        assertBootstrapManagerBinding(journal, run, uid, budget.nextTimeout(), false, false, state === 'disabled');
        const description = bootstrapManagerDescription(journal).replaceAll("'", "''");
        const legacyBinding = (journal.managerBinding.kind ?? 'transaction') !== 'transaction';
        const taskExecute = (legacyBinding ? 'wscript.exe' : trustedWindowsSystemExecutable('wscript.exe'))
            .replaceAll("'", "''");
        const launcher = bootstrapJournalManagerArtifactPath(journal).replaceAll("'", "''");
        const descriptionCondition = legacyBinding
            ? '[string]::IsNullOrEmpty([string]$task.Description)'
            : '$task.Description -eq $expectedDescription';
        const availabilityCondition = legacyBinding
            ? '-and -not $settings.StartWhenAvailable'
            : '-and $settings.StartWhenAvailable';
        const enabledCondition = state === 'disabled'
            ? '-and -not $settings.Enabled '
            : '-and $settings.Enabled ';
        const cleanupTimeoutMs = budget.nextTimeout();
        const stopBudgetMs = Math.max(1, Math.min(10_000, cleanupTimeoutMs > 250 ? cleanupTimeoutMs - 250 : Math.floor(cleanupTimeoutMs / 2)));
        const exactCondition = `$task.TaskPath -eq '\\' -and ${descriptionCondition} `
            + '-and $actions.Count -eq 1 -and $actions[0].Execute -ieq $expectedExecute '
            + '-and $actions[0].Arguments -eq (\'"\' + $expectedLauncher + \'"\') '
            + '-and $task.Principal.UserId -ieq $expectedUser -and $task.Principal.RunLevel -eq \'Limited\' '
            + '-and $task.Principal.LogonType -eq \'Interactive\' -and $triggers.Count -eq 1 '
            + '-and $triggers[0].CimClass.CimClassName -eq \'MSFT_TaskLogonTrigger\' '
            + '-and $triggers[0].UserId -ieq $expectedUser -and $triggers[0].Enabled '
            + '-and [string]::IsNullOrEmpty([string]$triggers[0].Delay) '
            + enabledCondition + '-and $settings.RestartCount -eq 5 -and $settings.RestartInterval -eq \'PT2M\' '
            + '-and $settings.ExecutionTimeLimit -eq \'PT0S\' -and $settings.MultipleInstances -eq \'IgnoreNew\' '
            + '-and -not $settings.DisallowStartIfOnBatteries -and -not $settings.StopIfGoingOnBatteries '
            + availabilityCondition;
        const cleanupCommand = `$expectedDescription = '${description}'; $expectedExecute = '${taskExecute}'; $expectedLauncher = '${launcher}'; `
            + 'try { $tasks = @(Get-ScheduledTask -TaskPath \'\\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq \'EvoMapEvolverProxyDaemon\' }) } catch { exit 9 }; '
            + 'if ($tasks.Count -eq 0) { exit 0 }; if ($tasks.Count -ne 1) { exit 5 }; '
            + '$task = $tasks[0]; $actions = @($task.Actions); $triggers = @($task.Triggers); $settings = $task.Settings; '
            + '$expectedUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; '
            + `if (-not (${exactCondition})) { exit 5 }; `
            + 'if ($task.State -eq \'Running\') { Stop-ScheduledTask -TaskPath \'\\\' -TaskName $task.TaskName -ErrorAction Stop; '
            + `$stopDeadline = [DateTime]::UtcNow.AddMilliseconds(${stopBudgetMs}); do { Start-Sleep -Milliseconds 100; `
            + '$task = Get-ScheduledTask -TaskPath \'\\\' -TaskName \'EvoMapEvolverProxyDaemon\' -ErrorAction Stop } '
            + 'while ($task.State -eq \'Running\' -and [DateTime]::UtcNow -lt $stopDeadline); if ($task.State -eq \'Running\') { exit 6 } }; '
            + '$actions = @($task.Actions); $triggers = @($task.Triggers); $settings = $task.Settings; '
            + `if (-not (${exactCondition})) { exit 5 }; `
            + 'Unregister-ScheduledTask -TaskPath \'\\\' -TaskName \'EvoMapEvolverProxyDaemon\' -Confirm:$false -ErrorAction Stop; '
            + 'try { $left = @(Get-ScheduledTask -TaskPath \'\\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq \'EvoMapEvolverProxyDaemon\' }) } catch { exit 9 }; '
            + 'if ($left.Count -eq 0) { exit 0 } else { exit 7 }';
        requireBootstrapActivation(run(trustedWindowsPowerShell(), [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cleanupCommand,
        ], cleanupTimeoutMs), [0], 'unregister Windows scheduled task during rollback');
    }
    requireDetachedBootstrapManager(journal.target, run, uid, budget);
}
function rollbackBootstrapTransaction(stateDir, initialJournal, run, uid, now, deadlineMs, removeCommittedMarker = false, preserveJournal = false, assertOwner = () => { }) {
    const commandBudget = bootstrapRollbackCommandBudget(initialJournal.target, deadlineMs, now);
    let journal = updateBootstrapJournal(initialJournal, {
        stage: 'rollback_pending',
        deadlineMs,
    }, now());
    assertOwner();
    writeBootstrapJournal(stateDir, journal);
    if (journal.activationStarted && !journal.managerDetached) {
        assertOwner();
        detachBootstrapManager(journal, run, uid, commandBudget);
        journal = updateBootstrapJournal(journal, { managerDetached: true }, now());
        assertOwner();
        writeBootstrapJournal(stateDir, journal);
    }
    assertOwner();
    removeBootstrapReadiness(stateDir, journal.transactionId, assertOwner);
    if (!journal.artifactsRestored) {
        assertOwner();
        removeOwnedBootstrapArtifacts(journal, {
            beforeStagingQuarantine: () => assertOwner(),
            afterStagingQuarantine: () => assertOwner(),
            beforeStagingDelete: () => assertOwner(),
            beforeQuarantine: () => assertOwner(),
            afterQuarantine: () => assertOwner(),
            beforeQuarantineDelete: () => assertOwner(),
            beforeClaimQuarantine: () => assertOwner(),
            beforeClaimQuarantineDelete: () => assertOwner(),
        });
        journal = updateBootstrapJournal(journal, { artifactsRestored: true }, now());
        assertOwner();
        writeBootstrapJournal(stateDir, journal);
    }
    if (journal.target === 'systemd') {
        assertOwner();
        requireBootstrapActivation(run(SYSTEMCTL_PATH, ['--user', 'daemon-reload'], commandBudget.nextTimeout()), [0], 'reload systemd user manager after rollback');
        requireBootstrapManagerState(probeBootstrapManagerState(journal.target, run, uid, commandBudget.nextTimeout()), ['absent'], 'verify systemd unit is absent after rollback');
    }
    const marker = readBootstrapMarker(stateDir);
    if (marker) {
        assertBootstrapMarkerMatchesJournal(marker, journal);
        if (!removeCommittedMarker) {
            throw new Error('bootstrap rollback refused to remove a committed success marker');
        }
        assertOwner();
        removeDurableFile(bootstrapMarkerPath(stateDir));
    }
    journal = updateBootstrapJournal(journal, { stage: 'rolled_back' }, now());
    assertOwner();
    writeBootstrapJournal(stateDir, journal);
    if (!preserveJournal) {
        assertOwner();
        removeBootstrapJournal(stateDir);
    }
}
async function removeBootstrapService(target, dryRun, env, deps, argv1, loadUnixRecoveryController, installFlags) {
    const stateDir = lifecyclePaths(env).stateDir;
    const markerPath = bootstrapMarkerPath(stateDir);
    if (dryRun) {
        if (filesystemEntryExists(bootstrapJournalPath(stateDir))) {
            readBootstrapJournal(stateDir);
            throw new Error('remove-service dry-run refused while bootstrap recovery is pending');
        }
        let marker;
        let legacyMarker;
        if (filesystemEntryExists(markerPath)) {
            try {
                marker = readBootstrapMarker(stateDir);
            }
            catch {
                legacyMarker = readLegacyBootstrapMarker(stateDir);
            }
        }
        const manualTransition = readBootstrapManualTransition(stateDir);
        const markerTarget = marker?.target ?? legacyMarker?.marker.target;
        if (markerTarget && markerTarget !== target) {
            throw new Error(`remove-service target ${target} does not match committed bootstrap target ${markerTarget}`);
        }
        if (manualTransition && manualTransition.target !== target) {
            throw new Error(`remove-service target ${target} does not match manual-transition target ${manualTransition.target}`);
        }
        let legacyOwnedFiles;
        let legacyPreservedFiles;
        let legacyManagerState;
        if (legacyMarker) {
            const dryUid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
            const dryNow = deps.now ?? Date.now;
            const dryDeadlineMs = dryNow() + BOOTSTRAP_TRANSACTION_BUDGET_MS;
            const dryRunManager = deps.run ?? ((command, args, timeoutMs = BOOTSTRAP_COMMAND_TIMEOUT_MS) => {
                const result = spawnSync(command, [...args], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true,
                });
                return {
                    status: result.status,
                    ...(result.error ? { error: result.error } : {}),
                    ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
                };
            });
            legacyManagerState = probeBootstrapManagerState(target, dryRunManager, dryUid, commandTimeout(dryDeadlineMs, dryNow, BOOTSTRAP_ROLLBACK_RESERVE_MS));
            requireBootstrapManagerState(legacyManagerState, ['absent', 'present', 'disabled'], 'legacy removal dry-run manager preflight');
            const launcherPath = target === 'windows' && legacyManagerState !== 'absent'
                ? probeLegacyWindowsLauncherPath(dryRunManager, commandTimeout(dryDeadlineMs, dryNow, BOOTSTRAP_ROLLBACK_RESERVE_MS), legacyManagerState !== 'disabled')
                : undefined;
            const planned = await (deps.install ?? installService)(target, { ...installFlags, 'dry-run': true }, env, argv1, loadUnixRecoveryController);
            const plan = legacyBootstrapArtifactPlan(legacyMarker, planned, target, env, stateDir, launcherPath, legacyManagerState === 'absent', false, dryUid);
            legacyOwnedFiles = captureLegacyBootstrapArtifactReceipts(plan.paths, plan.expected, target, dryUid).map((artifact) => artifact.path);
            legacyPreservedFiles = plan.preserved.map((artifact) => artifact.path);
        }
        return {
            status: marker || legacyMarker ? 'planned-removal' : 'already-removed',
            files: marker?.artifacts.map((artifact) => artifact.path) ?? legacyOwnedFiles ?? [],
            preservedFiles: marker?.preservedArtifacts?.map((artifact) => artifact.path)
                ?? legacyPreservedFiles
                ?? [],
            service: marker?.service ?? legacyMarker?.marker.service ?? target,
            actions: target === 'systemd'
                ? ['systemctl --user disable --now evolver-proxy.service', 'systemctl --user daemon-reload']
                : target === 'launchd'
                    ? [`launchctl bootout gui/${deps.uid ?? '<uid>'}/com.evomap.evolver-proxy`]
                    : legacyManagerState === 'absent'
                        ? ['verify EvoMapEvolverProxyDaemon is absent; remove only exact legacy-owned artifacts']
                        : ['verify and unregister owned EvoMapEvolverProxyDaemon scheduled task'],
        };
    }
    const platform = deps.platform ?? process.platform;
    const nativeTarget = platform === 'linux'
        ? 'systemd'
        : platform === 'darwin'
            ? 'launchd'
            : platform === 'win32'
                ? 'windows'
                : undefined;
    if (!nativeTarget || target !== nativeTarget) {
        throw new Error(`remove-service target ${target} is not supported on runtime platform ${platform}`);
    }
    const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    if ((target === 'systemd' || target === 'launchd') && uid === 0) {
        throw new Error('remove-service must run as the regular user that owns the committed bootstrap service');
    }
    const now = deps.now ?? Date.now;
    const deadlineMs = now() + BOOTSTRAP_TRANSACTION_BUDGET_MS;
    const run = deps.run ?? ((command, args, timeoutMs = BOOTSTRAP_COMMAND_TIMEOUT_MS) => {
        const result = spawnSync(command, [...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true,
        });
        return {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
        };
    });
    const ownerLock = acquireBootstrapOwnerLock(stateDir, deps.lock ?? { maxTries: 1_200, waitMs: 100 });
    const assertOwner = () => ownerLock.assertOwned();
    const ownerRun = ownerGuardedServiceRun(run, assertOwner);
    let operationError;
    let operationFailed = false;
    let outcome;
    try {
        await assertNoActiveDurableSelfUpdateRecovery({
            action: 'remove-service',
            target,
            stateDir,
            ownerLock,
            env,
            argv1,
            deps,
        });
        assertOwner();
        const recovered = recoverBootstrapTransaction(stateDir, ownerRun, uid, now, deadlineMs, assertOwner);
        if (recovered.status === 'remove-completed') {
            if (recovered.target !== target) {
                throw new Error(`remove-service target ${target} does not match recovered removal target ${recovered.target}`);
            }
            outcome = {
                status: 'removed',
                files: recovered.files,
                preservedFiles: recovered.preservedFiles,
                service: recovered.service,
                actions: [],
            };
        }
        let marker;
        let legacyMarker;
        try {
            marker = readBootstrapMarker(stateDir);
        }
        catch (error) {
            if (!filesystemEntryExists(markerPath))
                throw error;
            legacyMarker = readLegacyBootstrapMarker(stateDir);
        }
        if (legacyMarker) {
            outcome = await removeLegacyBootstrapService({
                legacy: legacyMarker,
                target,
                installFlags,
                env,
                argv1,
                loadUnixRecoveryController,
                install: deps.install ?? installService,
                ownerLock,
                run: ownerRun,
                uid,
                deadlineMs,
                now,
            });
            assertOwner();
        }
        const manualTransition = readBootstrapManualTransition(stateDir);
        if (outcome) {
            // Recovery already completed the exact committed removal under this owner lock.
        }
        else if (!marker) {
            if (manualTransition && manualTransition.target !== target) {
                throw new Error(`remove-service target ${target} does not match manual-transition target ${manualTransition.target}`);
            }
            outcome = { status: 'already-removed', files: [], service: target, actions: [] };
        }
        else {
            if (marker.target !== target) {
                throw new Error(`remove-service target ${target} does not match committed bootstrap target ${marker.target}`);
            }
            const readiness = readBootstrapReadiness(stateDir);
            if (readiness && readiness.transactionId !== marker.transactionId) {
                throw new Error('remove-service refused readiness owned by another bootstrap transaction');
            }
            let journal = captureBootstrapArtifactIdentities(bootstrapJournalFromMarker(marker, ownerLock.owner, deadlineMs, now()), true);
            const managerState = probeBootstrapManagerState(target, ownerRun, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS));
            if (managerState === 'unavailable' || managerState === 'inconclusive') {
                throw new Error(`remove-service cannot prove the committed manager state: ${managerState}`);
            }
            if (managerState !== 'absent') {
                assertBootstrapManagerBinding(journal, ownerRun, uid, commandTimeout(deadlineMs, now, BOOTSTRAP_ROLLBACK_RESERVE_MS), false, false, managerState === 'disabled');
            }
            assertOwner();
            ensureBootstrapManualTransition(stateDir, marker, now());
            journal = updateBootstrapJournal(journal, {
                stage: 'rollback_pending',
                terminalAction: 'remove_committed',
                deadlineMs,
                lastError: 'operator requested committed bootstrap service removal',
            }, now());
            assertOwner();
            writeBootstrapJournal(stateDir, journal);
            rollbackBootstrapTransaction(stateDir, journal, ownerRun, uid, now, deadlineMs, true, false, assertOwner);
            outcome = {
                status: 'removed',
                files: marker.artifacts.map((artifact) => artifact.path),
                preservedFiles: marker.preservedArtifacts?.map((artifact) => artifact.path) ?? [],
                service: marker.service,
                actions: target === 'systemd'
                    ? ['systemctl --user disable --now evolver-proxy.service', 'systemctl --user daemon-reload']
                    : target === 'launchd'
                        ? [`launchctl bootout gui/${uid}/com.evomap.evolver-proxy`]
                        : ['verified and unregistered owned EvoMapEvolverProxyDaemon scheduled task'],
            };
        }
    }
    catch (error) {
        if (!outcome
            || !lifecycleOutcomeIsCommitted('remove-service', outcome)
            || !isBootstrapOwnerLockAssertionError(error)) {
            operationError = error;
            operationFailed = true;
        }
    }
    const releaseFailures = releaseBootstrapLifecycleLocks([
        { label: 'bootstrap owner', lock: ownerLock },
    ]);
    finishLifecycleOperationAfterLockRelease({
        action: 'remove-service',
        outcome,
        operationError,
        operationFailed,
        releaseFailures,
    });
    if (!outcome)
        throw new Error('remove-service completed without an outcome');
    return outcome;
}
export function removeAutoexecService(target, dryRun, deps = {}) {
    const paths = {
        systemd: expandHome('~/.config/systemd/user/evolver-autoexec.service'),
        launchd: expandHome('~/Library/LaunchAgents/com.evomap.evolver-autoexec.plist'),
        windows: expandHome('~/install-evolver-autoexec-windows.ps1'),
    };
    const configuredPath = deps.paths?.[target] ?? paths[target];
    const path = target === 'windows' && !dryRun ? randomWindowsHelperPath(configuredPath) : configuredPath;
    const run = deps.run ?? ((command, args) => {
        const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
        return { status: result.status, ...(result.error ? { error: result.error } : {}) };
    });
    const exists = deps.exists ?? existsSync;
    const remove = deps.remove ?? ((file) => { rmSync(file, { force: true }); });
    const write = deps.write ?? ((file, content, mode) => {
        writeTextFile(file, content, mode, 'wx');
    });
    if (target === 'systemd') {
        const actions = [
            'systemctl --user disable --now evolver-autoexec.service',
            `remove ${path}`,
            'systemctl --user daemon-reload',
        ];
        if (dryRun)
            return { status: 'planned', files: [path], service: 'systemd-user', actions };
        const active = requireServiceControlStatus(run(SYSTEMCTL_PATH, ['--user', 'is-active', '--quiet', 'evolver-autoexec.service']), [0, 3, 4], 'inspect systemd autoexec activity');
        const enabled = requireServiceControlStatus(run(SYSTEMCTL_PATH, ['--user', 'is-enabled', '--quiet', 'evolver-autoexec.service']), [0, 1, 4], 'inspect systemd autoexec enablement');
        const hasUnit = exists(path);
        if (active !== 0 && enabled !== 0 && !hasUnit) {
            return { status: 'absent', files: [path], service: 'systemd-user', actions: [] };
        }
        requireServiceControlStatus(run(SYSTEMCTL_PATH, ['--user', 'disable', '--now', 'evolver-autoexec.service']), [0], 'disable systemd autoexec service');
        if (hasUnit)
            remove(path);
        requireServiceControlStatus(run(SYSTEMCTL_PATH, ['--user', 'daemon-reload']), [0], 'reload systemd user services');
        return { status: 'removed', files: [path], service: 'systemd-user', actions };
    }
    if (target === 'launchd') {
        const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        const launchdTarget = `gui/${uid ?? '<uid>'}/${AUTOEXEC_LABEL}`;
        const actions = [`launchctl bootout ${launchdTarget}`, `remove ${path}`];
        if (dryRun)
            return { status: 'planned', files: [path], service: 'launchd', actions };
        if (uid === undefined)
            throw new Error('cannot determine the current user id for launchd autoexec removal');
        requireServiceControlStatus(run(LAUNCHCTL_PATH, ['bootout', `gui/${uid}/${AUTOEXEC_LABEL}`]), [0, 3, 113], 'boot out launchd autoexec service');
        const hasPlist = exists(path);
        if (hasPlist)
            remove(path);
        return {
            status: hasPlist ? 'removed' : 'absent',
            files: [path],
            service: 'launchd',
            actions: hasPlist ? actions : actions.slice(0, 1),
        };
    }
    const actions = [
        `write ${path}`,
        `powershell.exe -File ${path} -Uninstall`,
        `remove ${path}`,
    ];
    if (dryRun)
        return { status: 'planned', files: [path], service: 'windows-scheduled-task', actions };
    write(path, renderWindowsAutoexecInstaller(), 0o644);
    requireServiceControlStatus(run(trustedWindowsPowerShell(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path,
        '-Uninstall',
    ]), [0], 'uninstall Windows autoexec scheduled task');
    remove(path);
    return { status: 'removed', files: [path], service: 'windows-scheduled-task', actions };
}
function requireServiceControlStatus(result, allowedStatuses, operation) {
    if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
        throw new Error(`${operation} failed; companion artifact was retained`);
    }
    return result.status;
}
async function runWatch(paths, env, flags, stdout, stderr) {
    const once = flags['once'] === true;
    const intervalMs = positiveInt(env['EVOLVER_WATCH_INTERVAL_MS'], DEFAULT_WATCH_INTERVAL_MS);
    let prevWall = Date.now();
    let prevMono = process.hrtime.bigint();
    let skippedLastTick = false;
    const tick = async () => {
        const nowWall = Date.now();
        const nowMono = process.hrtime.bigint();
        const wallDelta = nowWall - prevWall;
        const monoDeltaMs = Number((nowMono - prevMono) / 1000000n);
        const status = await lifecycleStatus(paths, env);
        const clockJumped = (wallDelta - monoDeltaMs) > 60_000 && !skippedLastTick;
        if (status.healthy) {
            stdout(`[Watch] ${new Date().toISOString()} healthy pid=${status.pid ?? '-'}\n`);
            skippedLastTick = false;
        }
        else if (clockJumped && status.reason === 'stagnation') {
            stdout(`[Watch] wall-clock jump detected; skipping one stagnation restart\n`);
            skippedLastTick = true;
        }
        else {
            stdout(`[Watch] ${new Date().toISOString()} unhealthy reason=${status.reason ?? 'unknown'} restarting...\n`);
            stopLifecycle(paths);
            const result = await startLifecycle(paths, env);
            stdout(`[Watch] restart result: ${JSON.stringify(result)}\n`);
            skippedLastTick = false;
        }
        prevWall = nowWall;
        prevMono = nowMono;
    };
    await tick().catch((err) => { stderr(`[Watch] tick error: ${err instanceof Error ? err.message : String(err)}\n`); });
    if (once)
        return 0;
    setInterval(() => {
        void tick().catch((err) => { stderr(`[Watch] tick error: ${err instanceof Error ? err.message : String(err)}\n`); });
    }, intervalMs);
    stdout(`[Watch] Supervisor running every ${Math.round(intervalMs / 1000)}s. Ctrl-C to stop.\n`);
    return new Promise(() => { });
}
export function resolveDaemonCommand(env, execPath = process.execPath, argv1 = process.argv[1]) {
    const explicit = env['EVOLVER_LIFECYCLE_COMMAND']?.trim();
    const selfUpdateTarget = configuredSelfUpdateTarget(env);
    if (selfUpdateTarget) {
        const supervised = standaloneProxyCommand(selfUpdateTarget);
        if (explicit) {
            const parsed = repairUnquotedWindowsExePath(explicit, parseCommandLine(explicit));
            if (!matchesStandaloneProxyCommand(parsed, selfUpdateTarget)) {
                throw new Error('EVOLVER_LIFECYCLE_COMMAND must invoke EVOLVER_SELF_UPDATE_TARGET_PATH with only the "proxy" argument; refusing mismatched self-update supervision');
            }
        }
        return supervised;
    }
    if (explicit) {
        const parsed = repairUnquotedWindowsExePath(explicit, parseCommandLine(explicit));
        if (parsed.length === 0)
            throw new Error('EVOLVER_LIFECYCLE_COMMAND is empty');
        return { command: parsed[0], args: parsed.slice(1), display: explicit };
    }
    const selfExecutable = resolveSelfUpdatingExecutable(execPath, argv1);
    if (selfExecutable)
        return selfExecutable;
    const proxyBin = resolveProxyBinPath();
    if (proxyBin)
        return { command: execPath, args: [proxyBin], display: `${execPath} ${proxyBin}` };
    return { command: DEFAULT_DAEMON_NAME, args: [], display: DEFAULT_DAEMON_NAME };
}
function configuredSelfUpdateTarget(env) {
    const target = env['EVOLVER_SELF_UPDATE_TARGET_PATH']?.trim();
    return target || undefined;
}
function standaloneProxyCommand(targetPath) {
    return { command: targetPath, args: ['proxy'], display: `${targetPath} proxy` };
}
function matchesStandaloneProxyCommand(parsed, targetPath) {
    return parsed.length === 2
        && sameExecutablePath(parsed[0], targetPath)
        && parsed[1] === 'proxy';
}
function sameExecutablePath(left, right) {
    if (left === right)
        return true;
    if (process.platform !== 'win32')
        return false;
    const normalizeWindowsPath = (value) => value.replaceAll('/', '\\').toLowerCase();
    return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}
export function resolveSelfUpdatingExecutable(execPath, argv1) {
    const executableName = basename(execPath).toLowerCase();
    if (/^evolver(?:\.exe|-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)|windows-x64\.exe))?$/.test(executableName)) {
        return { command: execPath, args: ['proxy'], display: `${execPath} proxy` };
    }
    if (argv1 && basename(argv1).toLowerCase() === 'cli.js') {
        return { command: execPath, args: [argv1, 'proxy'], display: `${execPath} ${argv1} proxy` };
    }
    return undefined;
}
export function resolveAutoexecDaemonCommand(env, execPath = process.execPath, argv1 = process.argv[1], autoexecHome) {
    const target = configuredSelfUpdateTarget(env);
    const proxyCommand = target
        ? standaloneProxyCommand(target)
        : resolveSelfUpdatingExecutable(execPath, argv1);
    if (!proxyCommand || proxyCommand.args.at(-1) !== 'proxy')
        return undefined;
    const args = [...proxyCommand.args.slice(0, -1), 'autoexec'];
    const home = autoexecHome?.trim();
    if (home)
        args.push(home);
    return {
        command: proxyCommand.command,
        args,
        display: [proxyCommand.command, ...args].join(' '),
    };
}
export function resolveProxyBinPath() {
    try {
        const entry = requireFromHere.resolve('@evomap/evolver-proxy');
        const candidate = join(dirname(entry), 'bin', 'evolver-proxy.js');
        return existsSync(candidate) ? candidate : undefined;
    }
    catch {
        const local = fileURLToPath(new URL('../../evolver-proxy/dist/bin/evolver-proxy.js', import.meta.url));
        return existsSync(local) ? local : undefined;
    }
}
export function resolveStableNodePath() {
    const pathNode = resolvePathCommand('node');
    if (pathNode)
        return pathNode;
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
        if (existsSync(candidate))
            return candidate;
    }
    return process.execPath;
}
function defaultServiceExecStart() {
    const proxyBin = resolveProxyBinPath();
    if (!proxyBin)
        return `${quoteSystemdArg(resolveStableNodePath())} /ABSOLUTE/PATH/TO/evolver-proxy.js`;
    return `${quoteSystemdArg(resolveStableNodePath())} ${quoteSystemdArg(proxyBin)}`;
}
function resolvePathCommand(command) {
    try {
        const out = execFileSync('/bin/sh', ['-lc', `command -v ${command}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return out.startsWith('/') ? out : undefined;
    }
    catch {
        return undefined;
    }
}
function writePidFile(path, record) {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}
function readPidFile(path) {
    try {
        const raw = readFileSync(path, 'utf8').trim();
        if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return { owned: false, legacy: false };
            const record = parsed;
            const rawPid = record['pid'];
            const pid = typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
            const args = record['args'];
            const command = record['command'];
            const cwd = record['cwd'];
            const owner = record['owner'];
            const createdAt = record['createdAt'];
            const parentPid = record['parentPid'];
            if (owner === 'evolver-lifecycle'
                && pid !== undefined
                && (parentPid === undefined || (typeof parentPid === 'number' && Number.isInteger(parentPid) && parentPid > 0))
                && typeof command === 'string'
                && Array.isArray(args)
                && args.every((arg) => typeof arg === 'string')
                && typeof cwd === 'string'
                && typeof createdAt === 'string') {
                return {
                    pid,
                    owned: true,
                    legacy: false,
                    record: { owner, pid, ...(parentPid ? { parentPid } : {}), command, args, cwd, createdAt },
                };
            }
            return { pid, owned: false, legacy: false };
        }
        const pid = Number(raw);
        return { pid: Number.isInteger(pid) && pid > 0 ? pid : undefined, owned: false, legacy: true };
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return { owned: false, legacy: false };
        return { owned: false, legacy: false };
    }
}
function pidFileRecordMatchesProcess(pidFile, readCommandLine = processCommandLine, readIdentity = processIdentity, platform = process.platform) {
    if (!pidFile.owned || !pidFile.record)
        return false;
    const record = pidFile.record;
    const commandLine = readCommandLine(record.pid);
    const commandMatches = Boolean(commandLine
        && commandLine.includes(basename(record.command))
        && record.args.every((arg) => commandLine.includes(arg)));
    const identity = readIdentity(record.pid);
    if (commandLine?.includes(basename(record.command))) {
        if (!commandMatches)
            return false;
        if (identity !== undefined)
            return processIdentityMatchesRecord(record, identity);
        return platform !== 'win32';
    }
    return processIdentityMatchesRecord(record, identity);
}
function waitForPidFileRecordMatch(pidFile, timeoutMs, readCommandLine = processCommandLine, readIdentity = processIdentity, platform = process.platform) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (pidFileRecordMatchesProcess(pidFile, readCommandLine, readIdentity, platform))
            return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return pidFileRecordMatchesProcess(pidFile, readCommandLine, readIdentity, platform);
}
function processCommandLine(pid) {
    if (process.platform === 'win32') {
        try {
            const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`;
            return execFileSync(trustedWindowsPowerShell(), ['-NoProfile', '-Command', script], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            }).trim() || undefined;
        }
        catch {
            return undefined;
        }
    }
    try {
        return execFileSync(PS_PATH, ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function processIdentity(pid) {
    if (process.platform === 'win32') {
        try {
            const script = [
                `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
                'if (-not $p) { exit 1 }',
                '$path=$p.ExecutablePath',
                '$start=if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { "" }',
                '$parent=if ($p.ParentProcessId) { $p.ParentProcessId } else { "" }',
                'Write-Output $path',
                'Write-Output $start',
                'Write-Output $parent',
            ].join('; ');
            const [executable, rawStartedAt, rawParentPid] = execFileSync(trustedWindowsPowerShell(), ['-NoProfile', '-Command', script], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            }).split(/\r?\n/).map((line) => line.trim());
            const startedAt = rawStartedAt ? Number(rawStartedAt) : undefined;
            const parentPid = rawParentPid ? Number(rawParentPid) : undefined;
            return {
                ...(executable ? { executable } : {}),
                ...(parentPid && Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
                ...(startedAt && Number.isFinite(startedAt) ? { startedAt } : {}),
            };
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function processIdentityMatchesRecord(record, identity) {
    if (!identity?.executable || !identity.parentPid || !identity.startedAt)
        return false;
    if (record.parentPid !== undefined && record.parentPid !== identity.parentPid)
        return false;
    if (normalizeFsIdentity(identity.executable) !== normalizeFsIdentity(record.command))
        return false;
    const recordStartedAt = Date.parse(record.createdAt);
    return Number.isFinite(recordStartedAt) && Math.abs(identity.startedAt - recordStartedAt) <= 30_000;
}
function normalizeFsIdentity(value) {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
    }
    catch (err) {
        return err.code === 'EPERM';
    }
    // Detached Unix children that have already exited can remain zombies while kill(0)
    // still succeeds. Treat zombie / defunct state as not running so stop waits complete.
    if (process.platform === 'win32')
        return true;
    try {
        const state = execFileSync(PS_PATH, ['-p', String(pid), '-o', 'state='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (state.startsWith('Z'))
            return false;
    }
    catch {
        // Keep the kill(0) success if process-state inspection is unavailable.
    }
    return true;
}
function waitForExit(pid, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!isPidRunning(pid))
            return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return !isPidRunning(pid);
}
function forceKill(pid) {
    if (process.platform === 'win32') {
        try {
            execFileSync(trustedWindowsSystemExecutable('taskkill.exe'), ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
            return;
        }
        catch (err) {
            process.stderr.write(`[Lifecycle] taskkill failed for PID ${pid}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    try {
        process.kill(pid, 'SIGKILL');
    }
    catch (err) {
        process.stderr.write(`[Lifecycle] SIGKILL failed for PID ${pid}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
function readProxySettings(path, options = {}) {
    let descriptor;
    try {
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_PROXY_SETTINGS_BYTES)
            || before.dev <= 0n || before.ino <= 0n) {
            throw new Error('proxy settings are not a bounded regular file');
        }
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error('proxy settings changed while opening');
        }
        const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
        const after = fstatSync(descriptor, { bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
            throw new Error('proxy settings changed while reading');
        }
        const proxy = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed['proxy'] : undefined;
        if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy))
            return {};
        const record = proxy;
        const url = typeof record['url'] === 'string' && isNumericLoopbackOrigin(record['url'])
            ? record['url']
            : undefined;
        return {
            ...(url ? { url } : {}),
            ...(typeof record['token'] === 'string' && record['token'].length > 0 && record['token'].length <= 4_096
                ? { token: record['token'] }
                : {}),
            ...(Number.isSafeInteger(record['pid']) && record['pid'] > 0 ? { pid: record['pid'] } : {}),
            ...(typeof record['started_at'] === 'string' && !Number.isNaN(Date.parse(record['started_at']))
                ? { startedAt: record['started_at'] }
                : {}),
        };
    }
    catch (err) {
        if (!options.quietReadError && err.code !== 'ENOENT') {
            const stderr = options.stderr ?? ((text) => { process.stderr.write(text); });
            stderr(`[Lifecycle] failed to read proxy settings: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        return {};
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
function isNumericLoopbackOrigin(value) {
    if (value.length === 0 || value.length > 2_048)
        return false;
    try {
        const parsed = new URL(value);
        const port = Number(parsed.port);
        return parsed.protocol === 'http:'
            && ['127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
            && Number.isSafeInteger(port) && port > 0 && port <= 65_535
            && parsed.username === '' && parsed.password === ''
            && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
            && parsed.origin === value;
    }
    catch {
        return false;
    }
}
async function proxyStatusOk(settings, timeoutMs) {
    if (!settings.url || !settings.token)
        return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = `${settings.url.replace(/\/+$/, '')}/proxy/status`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${settings.token}` }, signal: controller.signal });
        if (!res.ok)
            return false;
        const body = await res.json();
        return Boolean(body && typeof body === 'object' && !Array.isArray(body) && body['status'] === 'running');
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function lifecycleStatusFromSettings(settings, paths, timeoutMs) {
    if (!settings.pid || !settings.url || !settings.token || !isPidRunning(settings.pid))
        return undefined;
    const ok = await proxyStatusOk(settings, timeoutMs);
    if (!ok)
        return undefined;
    return {
        running: true,
        pid: settings.pid,
        healthy: true,
        ...(settings.startedAt ? { startedAt: settings.startedAt } : {}),
        url: settings.url,
        logFile: paths.logFile,
    };
}
function sessionAutoRestartEnabled(env) {
    const value = env['EVOLVER_SESSION_AUTO_RESTART']?.trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'off';
}
export function sessionStartHookVerboseEnabled(env = process.env) {
    const value = env['EVOLVER_HOOK_VERBOSE']?.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
export function proxyExpected(env = process.env) {
    if (env['EVOLVER_PROXY_EXPECTED'] === '1')
        return true;
    if (env['EVOMAP_PROXY'] === '1')
        return true;
    if (env['A2A_TRANSPORT']?.toLowerCase() === 'mailbox')
        return true;
    if (isLoopbackUrl(env['EVOLVER_PROXY_URL']) || isLoopbackUrl(env['ANTHROPIC_BASE_URL']))
        return true;
    return existsSync(lifecyclePaths(env).settingsFile);
}
function isLoopbackUrl(value) {
    const raw = value?.trim();
    if (!raw)
        return false;
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
    }
    catch {
        return false;
    }
}
function repairUnquotedWindowsExePath(value, parsed) {
    if (process.platform !== 'win32' || parsed.length === 0)
        return parsed;
    const first = parsed[0];
    if (/\.exe$/i.test(first))
        return parsed;
    const exeEnd = value.toLowerCase().indexOf('.exe');
    if (exeEnd < 0)
        return parsed;
    const command = value.slice(0, exeEnd + 4).trim();
    if (!/^[A-Za-z]:\\/.test(command) && !command.startsWith('\\\\'))
        return parsed;
    if (!existsSync(command))
        return parsed;
    const rest = value.slice(exeEnd + 4).trim();
    return rest ? [command, ...parseCommandLine(rest)] : [command];
}
function parseCommandLine(value) {
    const out = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            const next = value[i + 1];
            if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
                escaped = true;
                continue;
            }
            current += ch;
            continue;
        }
        if ((ch === '"' || ch === "'") && quote === null) {
            quote = ch;
            continue;
        }
        if (ch === quote) {
            quote = null;
            continue;
        }
        if (/\s/.test(ch) && quote === null) {
            if (current) {
                out.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (quote !== null)
        throw new Error('unterminated quote in EVOLVER_LIFECYCLE_COMMAND');
    if (escaped)
        current += '\\';
    if (current)
        out.push(current);
    return out;
}
function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/'))
        return join(homedir(), path.slice(2));
    return path;
}
function randomWindowsHelperPath(preferredPath) {
    const extension = extname(preferredPath) || '.ps1';
    const stem = basename(preferredPath, extension);
    return join(dirname(preferredPath), `${stem}-${randomUUID()}${extension}`);
}
function writeWindowsHelper(preferredPath, content) {
    try {
        writeTextFile(preferredPath, content, 0o600, 'wx');
        return preferredPath;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const fallbackPath = randomWindowsHelperPath(preferredPath);
    writeTextFile(fallbackPath, content, 0o600, 'wx');
    return fallbackPath;
}
function windowsBootstrapArtifacts(installer, standalone, configuredStateDir, env, exclusive) {
    const launcherDirectory = exclusive
        ? lifecyclePaths(env).stateDir
        : env['LOCALAPPDATA']?.trim()
            ? join(resolvePath(env['LOCALAPPDATA']), 'EvoMap')
            : undefined;
    if (!launcherDirectory)
        return [installer];
    const artifacts = [installer, join(launcherDirectory, 'evolver-proxy-task-launcher.vbs')];
    if (standalone) {
        const stateDir = configuredStateDir
            ? resolvePath(configuredStateDir)
            : join(dirname(resolvePath(standalone)), '.evolver-update');
        artifacts.push(join(stateDir, 'windows-controller', 'evolver-recovery-controller.exe'));
    }
    return artifacts;
}
function expectedBootstrapArtifactIdentities(entries) {
    return Object.fromEntries(entries.map(([path, content]) => [
        resolvePath(path),
        typeof content === 'object' && 'sourcePath' in content
            ? bootstrapArtifactContentIdentityForFile(content.sourcePath)
            : bootstrapArtifactIdentityForBytes(typeof content === 'string' ? Buffer.from(content, 'utf8') : content),
    ]));
}
function bootstrapPublication(path, options) {
    if (!options.exclusive)
        return undefined;
    if (!options.transactionId || !options.onArtifactPublished) {
        throw new Error('exclusive bootstrap artifact publication requires a durable transaction owner');
    }
    return {
        claimPath: bootstrapArtifactClaimPath(path, options.transactionId),
        onPublished: (publishedPath, claimPath) => {
            options.assertOwner?.();
            options.onArtifactPublished(publishedPath, claimPath);
        },
    };
}
function writeServiceArtifact(path, content, mode, options) {
    options.assertOwner?.();
    if (options.exclusive)
        writeDurableTextExclusive(path, content, mode, bootstrapPublication(path, options));
    else
        writeTextFile(path, content, mode);
}
export const _writeWindowsHelperForTest = writeWindowsHelper;
function writeTextFile(path, content, mode = 0o600, flag = 'w') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { encoding: 'utf8', mode, flag });
}
function assertSingleLine(value, label) {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f)
            throw new Error(`${label} must not contain control characters`);
    }
    return value;
}
function escapeSystemdPercent(value) {
    return value.replaceAll('%', '%%');
}
function escapeXml(value) {
    return assertSingleLine(value, 'launchd value')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
function escapeSystemdEnvValue(value) {
    return assertSingleLine(value, 'systemd environment value')
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('$', '\\$')
        .replaceAll('%', '%%');
}
function quoteSystemdArg(value) {
    const safe = assertSingleLine(value, 'systemd argument');
    return /^[A-Za-z0-9_/:.@%+=,-]+$/.test(safe)
        ? safe
        : `"${safe.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}
function resolveCurrentCliPath() {
    return fileURLToPath(new URL('./cli.js', import.meta.url));
}