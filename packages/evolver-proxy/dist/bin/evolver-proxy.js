#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap as coreBootstrap, daemon, hub as hubNs, mailbox, util, verify } from '@evomap/evolver-core';
import { AtpHubClient, connectPublicHub, globalFetchLike, isNodeSecret, parseNodeSecretVersion } from '@evomap/evolver-adapter-public';
import { ProxyDaemon } from '../daemon/proxyDaemon.js';
import { resolveHubMode, resolveHubUrl } from '../daemon/selectHub.js';
import { resolveIpcPort } from '../daemon/ipcConfig.js';
import { traceCollectionEnabled } from '../llm/traceConfig.js';
import { connectPrivateProxyHub, resolvePrivateEnterpriseToken, resolvePrivateInvitationToken, resolvePrivateNodeSecret, } from '../private/adapterLoader.js';
import { PrivateNodeCredentialStore, PrivateNodeCredentialReadError, } from '../private/nodeCredentialStore.js';
import { createAtpOrderConsentGate } from '../daemon/atpConsent.js';
import { SystemdNotifier } from '../daemon/systemdNotifier.js';
import { resolveProxyStorePath } from './proxyStorePath.js';
import { publishProxySettings } from './proxySettings.js';
import { expandHomePath, loadEnvFileFromEnv } from './envFile.js';
import { readLegacyNodeId, resolveProxyNodeId } from '../lifecycle/legacyNodeId.js';
import { createClaimNudge, wrapHelloWithClaimNudge } from '../lifecycle/claimNudge.js';
import { acquireLifecycleBootstrapOwnerLease, assertSupervisedLifecycleBootstrapState, bootstrapDegradedSelfUpdateStartup, clearRecoveryControllerLifecycleOwnerCapability, lifecycleBootstrapStatePresent, publishRecoveryControllerLifecycleStartupAttestation, RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV, } from '../selfUpdate/bootstrap.js';
import { getCurrentVersion } from '../selfUpdate/version.js';
import { resolveEffectiveSelfUpdatePolicy, selfUpdateSupervisorAttested, } from '../selfUpdate/policy.js';
import { resolveSelfUpdatePublicKey } from '../selfUpdate/builtinKey.js';
import { atomicReplaceExecutable, assertSelfUpdateProcessTargetBound as assertReleaseSelfUpdateProcessTargetBound, downloadGithubReleaseArtifact, resolveGithubReleaseManifest, } from '../selfUpdate/releaseBinary.js';
import { beginDurableSelfUpdate, confirmDurableSelfUpdate, recoverDurableSelfUpdate, rollbackDurableSelfUpdate, } from '../selfUpdate/transaction.js';
import { SELF_UPDATE_FAILURE_CODES, selfUpdateFailure } from '../selfUpdate/failureCodes.js';
import { maybeRunWindowsUpdaterWorkerFromArgv, WINDOWS_UPDATER_WORKER_ARG, } from '../selfUpdate/windowsUpdater.js';
import { maybeRunUnixRecoveryController } from '../selfUpdate/unixController.js';
import { maybeRunWindowsRecoveryController } from '../selfUpdate/windowsController.js';
import { consumeRecoveryChildStartGate, RECOVERY_CHILD_START_GATE_ENV, } from '../selfUpdate/recoveryChildStartGate.js';
import { publishLifecycleBootstrapReadiness } from '../selfUpdate/bootstrapReadiness.js';
import { finalizeSelfUpdateRecoveryLastUpdate } from '../selfUpdate/lastUpdate.js';
export function writeBootstrapStartupResult(result, writers = {}) {
    const line = `${result.message}\n`;
    if (result.disposition === 'handoff') {
        (writers.stdout ?? ((text) => { process.stdout.write(text); }))(line);
        return result.exitCode;
    }
    (writers.stderr ?? ((text) => { process.stderr.write(text); }))(line);
    return result.disposition === 'fail_closed' ? result.exitCode : undefined;
}
export async function runProxyMain(options = {}) {
    if (process.env[RECOVERY_CHILD_START_GATE_ENV] !== undefined) {
        throw new Error('self_update_recovery_child_start_gate_unconsumed');
    }
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write(proxyUsage());
        return;
    }
    // Recovery must run before any hub/store/runtime initialization. In particular,
    // a broken store or env-file pointer must not prevent a pending-health update from restoring the old binary.
    const requireLifecycleBootstrapState = options.requireLifecycleBootstrapState
        ?? unpinnedLegacySupervisorRequiresLifecycleState(process.env);
    const recoveryEnvironment = proxyRecoveryEnvironment(process.env);
    assertSupervisedLifecycleBootstrapState(recoveryEnvironment, {
        requireLifecycleState: requireLifecycleBootstrapState,
    });
    const recovery = options.recoveryPrepared
        ?? await recoverBoundDurableSelfUpdate({
            env: recoveryEnvironment,
            processExecPath: process.execPath,
        });
    if (recovery.outcome === 'blocked') {
        throw new Error(`self_update_recovery_blocked:${recovery.failureCode ?? 'unknown'}`);
    }
    if (recovery.restartRequired)
        process.exit(78);
    if (!options.environmentPrepared) {
        const envFile = loadProxyEnvFile(process.env);
        if (envFile.error)
            throw new Error(`failed to load EVOLVER_ENV_FILE: ${safeLoopMessage(envFile.error)}`);
    }
    assertSupervisedLifecycleBootstrapState(process.env, {
        requireLifecycleState: requireLifecycleBootstrapState,
    });
    try {
        publishRecoveryControllerLifecycleStartupAttestation(process.env);
    }
    finally {
        clearRecoveryControllerLifecycleOwnerCapability(process.env);
    }
    let storePath;
    let store;
    let proxyDaemon;
    let confirmation;
    let mode;
    let hubUrl;
    let port;
    let evolverVersion;
    let selfUpdatePolicy;
    const proxySettingsState = {};
    let publishLocalProxySettings = () => { };
    try {
        mode = resolveHubMode(process.env);
        hubUrl = resolveHubUrl(process.env);
        storePath = resolveProxyStorePath(process.env);
        store = new mailbox.MailboxStore({ path: storePath });
        finalizeRecoveryTelemetry(store, recovery);
        // `?.trim() ||` not `??`: an EMPTY/whitespace EVOLVER_IPC_TOKEN (e.g. a blank `.env` entry or `export
        // EVOLVER_IPC_TOKEN=`) must be treated as unset and get a strong random token, never fall through as `''` —
        // an empty token would authenticate any `Authorization: Bearer ` request and defeat the loopback IPC auth.
        const ipcToken = process.env['EVOLVER_IPC_TOKEN']?.trim() || randomBytes(24).toString('hex');
        const ipcPort = resolveIpcPort(process.env);
        // Trim + treat blank as unset, preferring the first NON-EMPTY override so an
        // empty `EVOMAP_NODE_ID=` (k8s configmap / `$(cat missing)`) neither shadows a
        // valid A2A_NODE_ID nor suppresses the legacy recovery below. v1 parity:
        // a2aProtocol trimmed the env id before use.
        const configuredNodeId = (process.env['EVOMAP_NODE_ID']?.trim() || process.env['A2A_NODE_ID']?.trim()) || undefined;
        // store node_id → env override → legacy ~/.evomap/node_id (PORT v1 #117): when
        // the store is unprimed AND no env override is set, recover the id the legacy
        // GEP path persisted before letting hello() mint a fresh A2ANode under the
        // same owner. See lifecycle/legacyNodeId.ts for the duplicate-node rationale.
        const senderId = () => resolveProxyNodeId({ storedNodeId: store.getState('node_id'), configuredNodeId });
        evolverVersion = getCurrentVersion();
        // Default (unset) 'auto' without a durable supervisor attestation degrades to 'off' so
        // unsupervised foreground runs keep starting; explicit 'auto' stays fail-closed at assembly below.
        const effectiveSelfUpdate = resolveEffectiveSelfUpdatePolicy(process.env);
        selfUpdatePolicy = effectiveSelfUpdate.policy;
        const recoverLifecycleBootstrap = !selfUpdateSupervisorAttested(process.env)
            && lifecycleBootstrapStatePresent(process.env);
        if (effectiveSelfUpdate.degraded || recoverLifecycleBootstrap) {
            const bootstrap = await bootstrapDegradedSelfUpdateStartup(process.env, process.platform);
            const bootstrapExitCode = writeBootstrapStartupResult(bootstrap);
            if (bootstrapExitCode !== undefined)
                process.exit(bootstrapExitCode);
        }
        const proxyStartedAt = new Date().toISOString();
        publishLocalProxySettings = () => {
            if (!proxySettingsState.url)
                return;
            publishProxySettings({
                env: process.env,
                record: {
                    url: proxySettingsState.url,
                    token: ipcToken,
                    pid: process.pid,
                    started_at: proxyStartedAt,
                    version: evolverVersion,
                },
            });
        };
        const privateNodeCredentialStore = mode === 'private'
            ? new PrivateNodeCredentialStore(storePath)
            : undefined;
        const runtime = await (options.connectRuntime ?? connectHubRuntime)({
            mode,
            hubUrl,
            senderId,
            store,
            ...(privateNodeCredentialStore ? { privateNodeCredentialStore } : {}),
        });
        proxyDaemon = new ProxyDaemon({
            ...createProxyDaemonDeps({
                runtime,
                store,
                hubMode: mode,
                ipcToken,
                ...(ipcPort !== undefined ? { ipcPort } : {}),
                evolverVersion,
                selfUpdatePolicy,
                env: process.env,
            }),
            onIpcListen: (listeningPort) => {
                proxySettingsState.url = `http://127.0.0.1:${listeningPort}`;
                publishLocalProxySettings();
            },
            onIpcAuthFailure: publishLocalProxySettings,
        });
        port = await proxyDaemon.start();
        if (recovery.outcome === 'pending_health') {
            assertSelfUpdateProcessTargetBound({ env: process.env, processExecPath: process.execPath });
            confirmation = await confirmDurableSelfUpdate({ env: process.env, processExecPath: process.execPath });
            if (confirmation.outcome !== 'confirmed') {
                throw new Error(`self_update_confirmation_failed:${confirmation.outcome}`);
            }
        }
        publishLifecycleBootstrapReadiness({
            env: process.env,
            startedAt: proxyStartedAt,
            ipcUrl: `http://127.0.0.1:${port}`,
        });
    }
    catch (error) {
        if (recovery.outcome === 'pending_health') {
            const rollback = await rollbackPendingStartup({
                ...(storePath ? { storePath } : {}),
                ...(store ? { store } : {}),
                ...(proxyDaemon ? { daemon: proxyDaemon } : {}),
                startupError: error,
                env: process.env,
            });
            process.stderr.write(`[evolver-proxy] self-update startup health check failed; ${rollback.outcome}: ${safeLoopErrorMessage(error)}\n`);
            process.exit(startupRollbackExitCode(rollback));
        }
        await closeStartupResources({ store, daemon: proxyDaemon });
        throw error;
    }
    if (confirmation)
        finalizeRecoveryTelemetry(store, confirmation);
    proxySettingsState.url = `http://127.0.0.1:${port}`;
    publishLocalProxySettings();
    process.stdout.write(`[evolver-proxy] mode=${mode} hub=${hubUrl} ipc=127.0.0.1:${port} v=${evolverVersion} self-update=${selfUpdatePolicy}\n`);
    const systemdNotifier = new SystemdNotifier({
        env: process.env,
        health: () => proxyDaemon.health(),
    });
    await runManagedProxyLoop({
        daemon: proxyDaemon,
        store: store,
        notifier: systemdNotifier,
        logger: process.stderr,
        ...(options.runLoop ? { runLoop: options.runLoop } : {}),
    });
}
export async function recoverBoundDurableSelfUpdate(options) {
    return recoverDurableSelfUpdate({
        ...options,
        beforeJournalMutation: () => {
            assertSelfUpdateProcessTargetBound(options);
        },
    });
}
export function loadProxyEnvFile(env) {
    const supervisor = env['EVOLVER_SELF_UPDATE_SUPERVISOR'];
    const lifecycleStateDir = env['EVOLVER_LIFECYCLE_STATE_DIR'];
    const stateDir = env['EVOLVER_SELF_UPDATE_STATE_DIR'];
    const targetPath = env['EVOLVER_SELF_UPDATE_TARGET_PATH'];
    const bootstrapTransactionId = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV];
    const recoveryControllerOwnerCapability = env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV];
    const recoveryChildStartGate = env[RECOVERY_CHILD_START_GATE_ENV];
    const systemRootBindings = Object.entries(env)
        .filter(([key]) => key.toLowerCase() === 'systemroot');
    const result = loadEnvFileFromEnv(env);
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'systemroot')
            delete env[key];
    }
    for (const [key, value] of systemRootBindings) {
        if (value !== undefined)
            env[key] = value;
    }
    if (recoveryControllerOwnerCapability === undefined) {
        delete env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV];
    }
    else {
        env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV] =
            recoveryControllerOwnerCapability;
    }
    if (recoveryChildStartGate === undefined) {
        delete env[RECOVERY_CHILD_START_GATE_ENV];
    }
    else {
        env[RECOVERY_CHILD_START_GATE_ENV] = recoveryChildStartGate;
    }
    if (supervisor === undefined) {
        delete env['EVOLVER_SELF_UPDATE_SUPERVISOR'];
        delete env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV];
    }
    else {
        env['EVOLVER_SELF_UPDATE_SUPERVISOR'] = supervisor;
        if (lifecycleStateDir !== undefined)
            env['EVOLVER_LIFECYCLE_STATE_DIR'] = lifecycleStateDir;
        if (stateDir !== undefined)
            env['EVOLVER_SELF_UPDATE_STATE_DIR'] = stateDir;
        if (targetPath !== undefined)
            env['EVOLVER_SELF_UPDATE_TARGET_PATH'] = targetPath;
        if (bootstrapTransactionId !== undefined) {
            env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV] = bootstrapTransactionId;
        }
        else {
            delete env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV];
        }
    }
    return result;
}
function proxyRecoveryEnvironment(env) {
    const recoveryEnv = { ...env };
    loadProxyEnvFile(recoveryEnv);
    return recoveryEnv;
}
function unpinnedLegacySupervisorRequiresLifecycleState(env) {
    return selfUpdateSupervisorAttested(env)
        && !env['EVOLVER_LIFECYCLE_STATE_DIR']?.trim()
        && Boolean(env['EVOLVER_ENV_FILE']?.trim());
}
function finalizeRecoveryTelemetry(store, recovery) {
    try {
        finalizeSelfUpdateRecoveryLastUpdate(store, recovery);
    }
    catch (error) {
        process.stderr.write(`[evolver-proxy] failed to persist self-update recovery telemetry: ${safeLoopErrorMessage(error)}\n`);
    }
}
export async function rollbackPendingStartup(options) {
    await closeStartupResources(options);
    let rollback;
    try {
        const processExecPath = options.processExecPath ?? process.execPath;
        assertSelfUpdateProcessTargetBound({ env: options.env ?? process.env, processExecPath }, true);
        rollback = await (options.rollback ?? rollbackDurableSelfUpdate)({ env: options.env ?? process.env, processExecPath }, SELF_UPDATE_FAILURE_CODES.RESTART_FAILED);
    }
    catch (error) {
        throw new Error(`self_update_recovery_blocked:${safeLoopErrorMessage(error)}`, {
            cause: options.startupError,
        });
    }
    if (options.storePath) {
        let telemetryStore;
        try {
            telemetryStore = (options.openTelemetryStore ?? ((storePath) => (new mailbox.MailboxStore({ path: storePath }))))(options.storePath);
            (options.persistTelemetry ?? ((openedStore, recovery) => {
                finalizeRecoveryTelemetry(openedStore, recovery);
            }))(telemetryStore, rollback);
        }
        catch {
            (options.logger ?? process.stderr).write('[evolver-proxy] failed to reopen self-update telemetry store\n');
        }
        finally {
            try {
                telemetryStore?.close();
            }
            catch { /* rollback already completed; telemetry cleanup is best-effort */ }
        }
    }
    return rollback;
}
async function closeStartupResources(options) {
    let daemonStopped = false;
    if (options.daemon) {
        try {
            await options.daemon.stop();
            daemonStopped = true;
        }
        catch {
            // Continue closing the directly-created store before rollback.
        }
    }
    if (options.store && !daemonStopped) {
        try {
            options.store.close();
        }
        catch { /* rollback must not be blocked by resource cleanup */ }
    }
}
export function startupRollbackExitCode(rollback) {
    if (rollback.outcome === 'blocked') {
        throw new Error(`self_update_recovery_blocked:${rollback.failureCode ?? 'unknown'}`);
    }
    if (rollback.outcome !== 'rollback_pending'
        && rollback.outcome !== 'rolled_back'
        && rollback.outcome !== 'confirmed') {
        throw new Error(`self_update_recovery_blocked:unexpected_${rollback.outcome}`);
    }
    return 78;
}
export function proxyUsage(command = 'evolver-proxy') {
    return [
        `Usage: ${command} [options]`,
        '',
        'Starts the local Evolver proxy daemon.',
        '',
        'Options (CLI overrides environment variables):',
        '  --home <dir>         Root for assets, store, settings, and traces',
        '  --evomap-home <dir>  Identity home for node_id/node_secret (EVOMAP_HOME); defaults to --home',
        '  --store <path>       Mailbox store path (EVOLVER_PROXY_STORE)',
        '  --settings <path>    Proxy settings file (EVOLVER_PROXY_SETTINGS_FILE)',
        '  --env-file <path>    Environment file (EVOLVER_ENV_FILE)',
        '  -h, --help           Show this help',
        '',
        'Required for public mode:',
        '  EVOMAP_NODE_SECRET or A2A_NODE_SECRET',
        '',
        'Required for private mode:',
        '  EVOMAP_HUB_MODE=private',
        '  EVOMAP_HUB_URL=<private hub url>',
        '  EVOMAP_ENTERPRISE_TOKEN=<token>',
        '',
        'Hub URL precedence:',
        '  A2A_HUB_URL -> EVOMAP_HUB_URL -> EVOLVER_DEFAULT_HUB_URL -> https://evomap.ai',
        '',
        'Useful options are configured through env or EVOLVER_ENV_FILE:',
        '  EVOLVER_IPC_PORT, EVOLVER_IPC_TOKEN, EVOLVER_PROXY_SETTINGS_FILE',
        '  EVOLVER_NATIVE_PUBLISH_VERIFIER=1, EVOLVER_PUBLISH_VALIDATION_ROOT=<dir> (必须显式设置)',
        '  EVOLVER_SELF_UPDATE, EVOLVER_LLM_TRACE_CAPTURE_BODIES',
        '',
    ].join('\n');
}
const PROXY_PATH_FLAGS = new Map([
    ['--home', 'home'],
    ['--evomap-home', 'evomapHome'],
    ['--store', 'store'],
    ['--settings', 'settings'],
    ['--env-file', 'envFile'],
]);
export function parseProxyCliPathOptions(argv) {
    const options = { help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }
        const equalsIndex = arg.indexOf('=');
        const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
        const key = PROXY_PATH_FLAGS.get(flag);
        if (key) {
            const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : argv[++index];
            if (!value?.trim() || (equalsIndex < 0 && value.startsWith('-'))) {
                throw new Error(`${flag} requires a path`);
            }
            options[key] = resolve(expandHomePath(value.trim()));
            continue;
        }
        if (arg.startsWith('-'))
            throw new Error(`unknown option: ${arg}`);
    }
    return options;
}
export function prepareProxyCliEnvironment(argv, env) {
    const options = parseProxyCliPathOptions(argv);
    if (options.envFile)
        env['EVOLVER_ENV_FILE'] = options.envFile;
    const envFile = loadProxyEnvFile(env);
    applyProxyCliPathOptions(options, env);
    return { options, envFile };
}
function applyProxyCliPathOptions(options, env) {
    if (options.home) {
        env['EVOMAP_DIR'] = options.home;
        env['EVOLVER_HOME'] = options.home;
        env['EVOMAP_HOME'] = options.home;
        env['EVOLVER_SETTINGS_DIR'] = options.home;
        env['EVOLVER_PROXY_STORE'] = join(options.home, 'proxy', 'mailbox.db');
        env['EVOLVER_PROXY_SETTINGS_FILE'] = join(options.home, 'settings.json');
        env['EVOLVER_LLM_TRACE_DIR'] = join(options.home, 'proxy', 'traces');
    }
    // Identity/state split for embedders whose node identity lives outside the state root (evox agentDir keeps
    // node_id/node_secret under <agentDir>/evomap while evolver state lives under <agentDir>/evolver, #555 T2).
    // Applied AFTER --home so it overrides the single-root EVOMAP_HOME derivation; state paths stay on --home.
    if (options.evomapHome)
        env['EVOMAP_HOME'] = options.evomapHome;
    if (options.store)
        env['EVOLVER_PROXY_STORE'] = options.store;
    if (options.settings)
        env['EVOLVER_PROXY_SETTINGS_FILE'] = options.settings;
}
export async function runProxyCli(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const processExecPath = options.processExecPath ?? process.execPath;
    const startupGateRole = recoveryChildStartGateRole(argv);
    let startupGateConsumed = false;
    try {
        startupGateConsumed = await (options.consumeChildStartGate ?? consumeRecoveryChildStartGate)(env, startupGateRole);
        if (!startupGateConsumed
            && (startupGateRole === 'windows-updater'
                || env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV] !== undefined)) {
            throw new Error('self_update_recovery_child_start_gate_required');
        }
    }
    catch (error) {
        process.stderr.write(`[evolver-proxy] fatal: ${safeLoopErrorMessage(error)}\n`);
        return 1;
    }
    const unixControllerExitCode = await (options.runUnixRecoveryController ?? maybeRunUnixRecoveryController)({
        argv,
        env,
        platform,
        processExecPath,
    });
    if (unixControllerExitCode !== undefined)
        return unixControllerExitCode;
    const windowsControllerExitCode = await (options.runWindowsRecoveryController ?? maybeRunWindowsRecoveryController)({
        argv,
        env,
        platform,
        processExecPath,
    });
    if (windowsControllerExitCode !== undefined)
        return windowsControllerExitCode;
    const workerExitCode = await (options.runWindowsUpdaterWorker ?? maybeRunWindowsUpdaterWorkerFromArgv)({
        argv,
        env,
        platform,
        processExecPath,
        startupGateConsumed,
    });
    if (workerExitCode !== undefined)
        return workerExitCode;
    const uninstallUnhandledRejectionGuard = daemon.installUnhandledRejectionWindow();
    try {
        const cliOptions = parseProxyCliPathOptions(argv);
        if (cliOptions.help) {
            process.stdout.write(proxyUsage(argv[0] === 'proxy' ? 'evolver proxy' : 'evolver-proxy'));
            return 0;
        }
        if (cliOptions.envFile)
            env['EVOLVER_ENV_FILE'] = cliOptions.envFile;
        applyProxyCliPathOptions(cliOptions, env);
        const requireLifecycleBootstrapState = unpinnedLegacySupervisorRequiresLifecycleState(env);
        const recoveryEnvironment = proxyRecoveryEnvironment(env);
        assertSupervisedLifecycleBootstrapState(recoveryEnvironment, {
            requireLifecycleState: requireLifecycleBootstrapState,
        });
        const recovery = options.recoverStartup || !options.runMain
            ? await (options.recoverStartup ?? recoverBoundDurableSelfUpdate)({
                env: recoveryEnvironment,
                processExecPath: options.processExecPath ?? process.execPath,
            })
            : undefined;
        if (recovery?.outcome === 'blocked') {
            throw new Error(`self_update_recovery_blocked:${recovery.failureCode ?? 'unknown'}`);
        }
        if (recovery?.restartRequired)
            return 78;
        const prepared = prepareProxyCliEnvironment(argv, env);
        if (prepared.envFile.error) {
            throw new Error(`failed to load EVOLVER_ENV_FILE: ${safeLoopMessage(prepared.envFile.error)}`);
        }
        await (options.runMain ?? runProxyMain)({
            environmentPrepared: true,
            requireLifecycleBootstrapState,
            ...(recovery ? { recoveryPrepared: recovery } : {}),
        });
        return 0;
    }
    catch (error) {
        process.stderr.write(`[evolver-proxy] fatal: ${safeLoopErrorMessage(error)}\n`);
        return 1;
    }
    finally {
        uninstallUnhandledRejectionGuard();
    }
}
function recoveryChildStartGateRole(argv) {
    if (argv.length === 1 && argv[0] === 'proxy')
        return 'proxy-target';
    if (argv.length === 2
        && argv[0] === 'proxy'
        && argv[1] === WINDOWS_UPDATER_WORKER_ARG) {
        return 'windows-updater';
    }
    return undefined;
}
if (isDirectRun(import.meta.url, process.argv[1])) {
    void runProxyCli().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
export function createVerifiedPublicSender(initialNodeId) {
    let verifiedNodeId = initialNodeId;
    return {
        senderId: () => verifiedNodeId,
        adopt: (nodeId) => {
            verifiedNodeId = nodeId;
        },
    };
}
export function adoptVerifiedPublicNodeId(store, selection, sender, nodeId) {
    store.setState('node_id', nodeId);
    selection.nodeId = nodeId;
    sender.adopt(nodeId);
}
export async function runProxyLoop(daemon, options = {}) {
    const minDelayMs = options.minDelayMs ?? 1_000;
    const errorDelayMs = options.errorDelayMs ?? 5_000;
    const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
    const useDaemonSleep = options.sleep === undefined && daemon.sleep !== undefined;
    const sleep = options.sleep ?? daemon.sleep?.bind(daemon) ?? sleepMs;
    // Error backoff must NOT be wake-interruptible (see the healthy/error branch below).
    // An injected sleep (tests) is honored; prod uses a plain unref'd timer rather than
    // daemon.sleep so wakeRunner() can't shortcut it.
    const errorSleep = options.sleep ?? nonInterruptibleSleep;
    const setWakeHandler = useDaemonSleep ? undefined : daemon.setWakeHandler?.bind(daemon);
    const maxConsecutiveTickFailures = options.maxConsecutiveTickFailures ?? 10;
    let consecutiveTickFailures = 0;
    try {
        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
            daemon.setExpectedNextTick?.(undefined);
            let delayMs = errorDelayMs;
            let tickHealthy = false;
            let exitForResolvedFailure;
            try {
                const rep = await daemon.tick();
                const resolvedFailure = resolvedTickFailureMessage(rep);
                if (resolvedFailure) {
                    logLoopResolvedFailure(options.logger, resolvedFailure);
                    consecutiveTickFailures += 1;
                    if (consecutiveTickFailures >= maxConsecutiveTickFailures) {
                        exitForResolvedFailure = new Error(`tick failed ${consecutiveTickFailures} consecutive times; exiting for supervisor restart: ${resolvedFailure}`);
                    }
                }
                else {
                    tickHealthy = true;
                    consecutiveTickFailures = 0;
                    try {
                        delayMs = daemon.nextDelay(rep.inbound);
                    }
                    catch (err) {
                        logLoopError(options.logger, 'nextDelay', err);
                    }
                }
            }
            catch (err) {
                logLoopError(options.logger, 'tick', err);
                consecutiveTickFailures += 1;
                if (consecutiveTickFailures >= maxConsecutiveTickFailures) {
                    // 连续多轮 tick 抛错 = 很可能是不可自愈的致命故障(坏 store/满盘);
                    // 抛出交 main().catch → process.exit(1) → supervisor 重启, 而非永久空转。
                    throw new Error(`tick failed ${consecutiveTickFailures} consecutive times; exiting for supervisor restart: ${safeLoopErrorMessage(err)}`);
                }
            }
            if (exitForResolvedFailure)
                throw exitForResolvedFailure;
            if (iteration + 1 >= maxIterations)
                break;
            if (tickHealthy) {
                // Healthy idle: wake-interruptible so new outbound/inbound work re-ticks promptly.
                const healthyDelayMs = Math.max(minDelayMs, delayMs);
                daemon.setExpectedNextTick?.(healthyDelayMs);
                await sleepUntilDelayOrWake(healthyDelayMs, sleep, setWakeHandler);
            }
            else {
                // Error / fatal-candidate backoff: NON-interruptible. Otherwise wakeRunner()
                // (fired by every IPC outbound send and heartbeat poke) shortcuts the backoff,
                // and a persistent tick failure under steady IPC traffic spins the CPU into a
                // fast crash-loop toward maxConsecutiveTickFailures. (PR #223 review follow-up.)
                await errorSleep(Math.max(minDelayMs, delayMs));
            }
        }
    }
    finally {
        daemon.setExpectedNextTick?.(undefined);
        if (!useDaemonSleep)
            daemon.setWakeHandler?.(undefined);
    }
}
export async function runManagedProxyLoop(options) {
    try {
        await options.notifier.readyOrThrow();
        await (options.runLoop ?? runProxyLoop)(options.daemon, options.logger ? { logger: options.logger } : {});
    }
    finally {
        try {
            options.notifier.stop();
        }
        finally {
            await closeStartupResources({ store: options.store, daemon: options.daemon });
        }
    }
}
export function createProxyDaemonDeps(options) {
    const selfUpdate = createSelfUpdateDeps(options.selfUpdatePolicy, options.evolverVersion, options.env ?? process.env, options.selfUpdateOverrides);
    const env = options.env ?? process.env;
    const traceBackfill = resolveTraceBackfillConfig(env);
    const heartbeatIntervalMs = positiveIntegerEnv(env['HEARTBEAT_INTERVAL_MS']);
    const publishExecutionVerifier = resolveNativePublishExecutionVerifier(env);
    return {
        hub: options.runtime.hub,
        ...(options.hubMode ? { hubMode: options.hubMode } : {}),
        store: options.store,
        ipcToken: options.ipcToken,
        ...(options.ipcPort !== undefined ? { ipcPort: options.ipcPort } : {}),
        ...(options.runtime.atp ? {
            atp: options.runtime.atp,
            atpOrderConsent: createAtpOrderConsentGate(options.env ?? process.env),
        } : {}),
        evolverVersion: options.evolverVersion,
        hello: options.runtime.hello,
        heartbeat: options.runtime.heartbeat,
        ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
        ...(options.runtime.helloMode ? { helloMode: options.runtime.helloMode } : {}),
        ...(selfUpdate ? { selfUpdate } : {}),
        ...(traceBackfill ? { traceBackfill } : {}),
        ...(publishExecutionVerifier ? { publishExecutionVerifier } : {}),
    };
}
/**
 * 仅在显式启用且具备完整 OS 隔离时接入本地发布验证器；默认仍保持 draft-only。
 * 这样不会把普通桌面进程意外变成可发布执行器，也不会在 Windows/macOS 上静默降级为弱隔离。
 */
function resolveNativePublishExecutionVerifier(env) {
    if (env['EVOLVER_NATIVE_PUBLISH_VERIFIER']?.trim() !== '1')
        return undefined;
    // 原生发布验证器只能在完整的 OS 隔离可用时装配。Windows/macOS 目前没有
    // 与 Linux namespace、只读文件系统和 cgroup 等价的实现，必须保持 draft-only，
    // 不能先暴露一个运行时必然失败的“验证器”能力。
    try {
        if (!verify.readOnlyIsolationAvailable())
            return undefined;
    }
    catch {
        // 隔离探测本身失败也必须保持 fail-closed，而不能阻止代理启动。
        return undefined;
    }
    // 发布验证必须绑定到调用方明确配置的项目根目录；回退到 daemon 当前目录会让验证对象与发布对象脱钩。
    const configuredRoot = env['EVOLVER_PUBLISH_VALIDATION_ROOT']?.trim();
    if (!configuredRoot)
        return undefined;
    const validationRoot = resolve(configuredRoot);
    return async (input, signal) => {
        const commands = Array.isArray(input.validation)
            ? input.validation.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
            : [];
        if (commands.length === 0
            || commands.length > 8
            || !Array.isArray(input.validation)
            || input.validation.length !== commands.length
            || commands.some((command) => command.length > 180 || !verify.isValidationCommandAllowed(command))
            || signal.aborted)
            return null;
        const result = await verify.runSandboxedValidation(commands, validationRoot, {
            requireIsolation: true,
            signal,
        });
        if (signal.aborted || !result.passed || result.results.length !== commands.length)
            return null;
        return {
            validation: commands,
            trace: result.results.map((row) => ({
                command: row.cmd,
                exit: row.exitCode ?? 1,
                ...(row.stdoutSummary ? { summary: row.stdoutSummary } : {}),
            })),
        };
    };
}
function positiveIntegerEnv(value) {
    const trimmed = value?.trim();
    if (!trimmed || !/^\d+$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function resolveTraceBackfillConfig(env) {
    if (!traceCollectionEnabled(env))
        return undefined;
    if (env['EVOLVER_LLM_TRACE_MAILBOX'] === '0')
        return undefined;
    if (!traceBackfillExplicitlyConfigured(env))
        return undefined;
    return {
        dir: resolveTraceDir(env),
        env,
    };
}
function traceBackfillExplicitlyConfigured(env) {
    return env['EVOLVER_LLM_TRACE_DIR'] !== undefined
        || traceFlag(env['EVOLVER_LLM_TRACE_CAPTURE_BODIES'])
        || traceFlag(env['EVOLVER_LLM_TRACE_ENCRYPTION'])
        || traceFlag(env['EVOLVER_LLM_TRACE_PROFILE_ANALYSIS'])
        || traceFlag(env['EVOMAP_PROXY_TRACE_PROFILE_ANALYSIS'])
        || Boolean(env['EVOLVER_LLM_TRACE_HUB_PUBLIC_KEY']?.trim())
        || Boolean(env['EVOMAP_PROXY_TRACE_HUB_PUBLIC_KEY']?.trim());
}
function traceFlag(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}
function resolveTraceDir(env = process.env) {
    return String(env['EVOLVER_LLM_TRACE_DIR'] ?? join(evomapHome(env), 'proxy', 'traces'));
}
function sleepMs(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
// Non-interruptible delay for error backoff: a plain timer that wakeRunner() can't
// shortcut (unlike daemon.sleep). unref'd so it never keeps the event loop alive on
// its own. Used only for error/fatal-candidate iterations; healthy idle keeps the
// wake-interruptible sleep so new work re-ticks promptly.
function nonInterruptibleSleep(delayMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        if (typeof timer.unref === 'function')
            timer.unref();
    });
}
function sleepUntilDelayOrWake(delayMs, sleep, setWakeHandler) {
    if (!setWakeHandler)
        return sleep(delayMs);
    if (sleep === sleepMs) {
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => finish(), delayMs);
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                setWakeHandler(undefined);
                resolve();
            };
            setWakeHandler(finish);
        });
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            setWakeHandler(undefined);
            resolve();
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            setWakeHandler(undefined);
            reject(err);
        };
        setWakeHandler(finish);
        sleep(delayMs).then(finish, fail);
    });
}
function logLoopError(logger, phase, err) {
    logger?.write(`[evolver-proxy] ${phase} failed (non-fatal): ${safeLoopErrorMessage(err)}\n`);
}
function logLoopResolvedFailure(logger, message) {
    logger?.write(`[evolver-proxy] tick reported fatal candidate (non-fatal): ${safeLoopMessage(message)}\n`);
}
function resolvedTickFailureMessage(report) {
    const failedPhases = report.failedPhases ?? [];
    const failed = new Set(failedPhases);
    const allCriticalSyncFailed = failed.has('core') && failed.has('outbound') && failed.has('inbound');
    if (report.fatalCandidate !== true && !allCriticalSyncFailed)
        return null;
    if (tickReportHasSyncProgress(report))
        return null;
    const phaseList = failedPhases.length > 0 ? failedPhases.join(',') : 'unknown';
    const details = report.errors?.map((err) => `${err.phase}: ${safeLoopMessage(err.message)}`).join('; ');
    return details
        ? `failed phases: ${phaseList}; ${details}`
        : `failed phases: ${phaseList}`;
}
function tickReportHasSyncProgress(report) {
    return report.outbound.sent > 0
        || report.outbound.terminal > 0
        || report.inbound.received > 0
        || report.inbound.enqueued > 0
        || report.inbound.hasMore;
}
function safeLoopMessage(message) {
    try {
        return hubNs.redactString(message).slice(0, 2_000);
    }
    catch {
        return '[REDACTED]';
    }
}
function safeLoopErrorMessage(err) {
    return safeLoopMessage(errorMessage(err));
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
export function createSelfUpdateDeps(policy, currentVersion, env = process.env, overrides = {}) {
    if (policy !== 'auto')
        return undefined;
    const { supervisorAttested, restart, stagedBinaryProbe, processExecPath: _ignoredProcessExecPath, ...binaryOverrides } = overrides;
    if (!supervisorAttested && !selfUpdateSupervisorAttested(env)) {
        throw new Error('self_update_supervisor_required');
    }
    const publicKey = resolveSelfUpdatePublicKey(env);
    if (!publicKey)
        throw new Error('self_update_public_key_required');
    const releaseOpts = {
        env,
        ...binaryOverrides,
        processExecPath: supervisorAttested?.processExecPath ?? process.execPath,
        requireSignedManifest: true,
    };
    const assertBound = () => assertSelfUpdateProcessTargetBound(releaseOpts);
    let activeLifecycleLease;
    const acquireLifecycleLease = () => {
        assertBound();
        if (activeLifecycleLease) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'self_update_lifecycle_owner_lease_already_active');
        }
        let acquired;
        try {
            acquired = acquireLifecycleBootstrapOwnerLease(env);
        }
        catch (error) {
            if (error instanceof util.LockTimeoutError) {
                throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED, 'self_update_lifecycle_owner_lock_busy', { cause: error });
            }
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `self_update_lifecycle_owner_lease_acquire_failed:${safeLoopErrorMessage(error)}`, { cause: error });
        }
        let released = false;
        const lease = {
            assertOwned: () => {
                if (released || activeLifecycleLease !== lease) {
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'self_update_lifecycle_owner_lease_not_active');
                }
                assertBound();
                try {
                    acquired.assertOwned();
                }
                catch (error) {
                    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `self_update_lifecycle_owner_lease_lost:${safeLoopErrorMessage(error)}`, { cause: error });
                }
            },
            release: () => {
                if (released)
                    return;
                try {
                    acquired.release();
                }
                finally {
                    released = true;
                    if (activeLifecycleLease === lease)
                        activeLifecycleLease = undefined;
                }
            },
        };
        activeLifecycleLease = lease;
        return lease;
    };
    const assertOperationAllowed = () => {
        if (!activeLifecycleLease) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, 'self_update_lifecycle_owner_lease_required');
        }
        activeLifecycleLease.assertOwned();
    };
    assertBound();
    return {
        policy,
        currentVersion,
        acquireLifecycleLease,
        resolveManifest: (directive) => {
            assertOperationAllowed();
            return resolveGithubReleaseManifest(directive, releaseOpts);
        },
        download: (targetVersion, directive) => {
            assertOperationAllowed();
            return downloadGithubReleaseArtifact(targetVersion, directive, releaseOpts);
        },
        atomicReplace: (stagedPath) => {
            assertOperationAllowed();
            return atomicReplaceExecutable(stagedPath, releaseOpts);
        },
        beginTransaction: async (targetVersion) => {
            assertOperationAllowed();
            const transaction = await beginDurableSelfUpdate(targetVersion, {
                ...releaseOpts,
                currentVersion,
                ...(stagedBinaryProbe ? { stagedBinaryProbe } : {}),
            });
            return {
                ...transaction,
                adoptDownloaded: async (download) => {
                    assertOperationAllowed();
                    return transaction.adoptDownloaded(download);
                },
                markVerified: async (artifacts) => {
                    assertOperationAllowed();
                    await transaction.markVerified(artifacts);
                },
                install: async () => {
                    assertOperationAllowed();
                    await transaction.install();
                },
                markRestartRequested: async () => {
                    assertOperationAllowed();
                    await transaction.markRestartRequested();
                },
            };
        },
        restart: () => {
            assertOperationAllowed();
            (restart ?? (() => { process.exit(78); }))();
        },
        publicKey,
    };
}
export function assertSelfUpdateProcessTargetBound(options, allowUnresolvedTarget = false) {
    assertReleaseSelfUpdateProcessTargetBound(options, allowUnresolvedTarget);
}
export function resolvePublicNodeSecret(deps) {
    const explicit = resolveExplicitPublicNodeCredentials(process.env);
    const storedNodeSecret = deps.store.getState('node_secret');
    const storedNodeId = deps.store.getState('node_id')?.trim() || undefined;
    const storedSource = deps.store.getState('node_secret_source');
    const storedNodeSecretVersion = parseNodeSecretVersion(deps.store.getState('node_secret_version'));
    const storeSecret = storedSource?.startsWith('pending_')
        ? undefined
        : storedNodeSecret && isNodeSecret(storedNodeSecret) ? storedNodeSecret : undefined;
    const legacy = readLegacyNodeSecret(process.env);
    const pairedStoreNodeId = storedNodeId
        ?? (explicit.nodeSecret === storeSecret ? explicit.nodeId : undefined)
        ?? (legacy && legacy.nodeSecret === storeSecret ? legacy.nodeId : undefined);
    const completeExplicitOverridesOrphan = Boolean(explicit.nodeId
        && explicit.nodeSecret
        && explicit.nodeSecret !== storeSecret
        && pairedStoreNodeId !== explicit.nodeId);
    if (storedSource === 'hub_rotate' && storeSecret && !completeExplicitOverridesOrphan) {
        return {
            nodeSecret: storeSecret,
            ...(pairedStoreNodeId ? { nodeId: pairedStoreNodeId } : {}),
            nodeSecretVersion: storedNodeSecretVersion,
            source: 'hub_rotate',
            storeSecret,
        };
    }
    if (explicit.nodeSecret) {
        const pairedNodeId = explicit.nodeId
            ?? (legacy?.nodeSecret === explicit.nodeSecret ? legacy.nodeId : undefined);
        const pairedStoreVersion = explicit.nodeSecret === storeSecret ? storedNodeSecretVersion : undefined;
        return {
            nodeSecret: explicit.nodeSecret,
            ...(pairedNodeId ? { nodeId: pairedNodeId } : {}),
            nodeSecretVersion: explicit.nodeSecretVersion ?? pairedStoreVersion,
            source: 'env',
            storeSecret,
        };
    }
    if (storeSecret) {
        return {
            nodeSecret: storeSecret,
            ...(pairedStoreNodeId ? { nodeId: pairedStoreNodeId } : {}),
            nodeSecretVersion: storedNodeSecretVersion,
            source: 'store',
            storeSecret,
        };
    }
    if (legacy)
        return { ...legacy, source: 'legacy_file' };
    return { nodeSecret: undefined, source: 'store' };
}
function resolveExplicitPublicNodeCredentials(env) {
    const evomap = publicCredentialNamespace(env, 'EVOMAP');
    const a2a = publicCredentialNamespace(env, 'A2A');
    if (evomap.nodeId && evomap.nodeSecret)
        return evomap;
    if (a2a.nodeId && a2a.nodeSecret)
        return a2a;
    if (evomap.nodeId && a2a.nodeId && evomap.nodeId === a2a.nodeId) {
        return evomap.nodeSecret ? evomap : a2a.nodeSecret ? a2a : {};
    }
    if (evomap.nodeId || a2a.nodeId)
        return {};
    return evomap.nodeSecret ? evomap : a2a.nodeSecret ? a2a : {};
}
function publicCredentialNamespace(env, prefix) {
    const nodeId = env[`${prefix}_NODE_ID`]?.trim() || undefined;
    const nodeSecret = env[`${prefix}_NODE_SECRET`]?.trim() || undefined;
    const nodeSecretVersion = parseNodeSecretVersion(env[`${prefix}_NODE_SECRET_VERSION`]);
    return {
        ...(nodeId ? { nodeId } : {}),
        ...(nodeSecret ? { nodeSecret } : {}),
        ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
    };
}
function setOptionalStoreState(store, key, value) {
    store.setState(key, value ?? '');
}
function evomapHome(env = process.env) {
    return String(env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(env['HOME'] || homedir(), '.evomap'));
}
function readTrimmedFile(path) {
    try {
        const value = readFileSync(path, 'utf8').trim();
        return value || undefined;
    }
    catch {
        return undefined;
    }
}
// Identity-home probe order (#555 T2): EVOMAP_HOME is THE identity home and outranks the state root
// (EVOLVER_HOME) — under the evox agentDir split (`--home <agentDir>/evolver --evomap-home <agentDir>/evomap`)
// node files live only under the evomap dir, and the old single-home read (EVOLVER_HOME-first) would miss
// them and fall back to the machine-global ~/.evomap node. Probing is a fall-through union, so single-home
// setups (only EVOLVER_HOME, or neither) resolve exactly as before.
function identityHomeCandidates(env = process.env) {
    const candidates = [
        env['EVOMAP_HOME'],
        env['EVOMAP_DIR'],
        env['EVOLVER_HOME'],
        join(env['HOME'] || homedir(), '.evomap'),
    ];
    return [...new Set(candidates.map((value) => value?.trim()).filter((value) => Boolean(value)))];
}
function readLegacyNodeSecret(env = process.env) {
    for (const home of identityHomeCandidates(env)) {
        const nodeSecret = readTrimmedFile(join(home, 'node_secret'));
        if (!nodeSecret || !isNodeSecret(nodeSecret))
            continue;
        const nodeId = readLegacyNodeId({ candidates: [join(home, 'node_id')] });
        const nodeSecretVersion = parseNodeSecretVersion(readTrimmedFile(join(home, 'node_secret_version')));
        return {
            ...(nodeId ? { nodeId } : {}),
            nodeSecret,
            ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
        };
    }
    return undefined;
}
// Durable copies of the legacy node_secret, cleared on hub-signalled divergence.
// Store keys mirror cli LOCAL_SECRET_STATE_KEYS (index.ts:82); on-disk files mirror
// recipe.ts writeLegacyNodeSecret*. Kept in one place so the divergence handler and
// the secret-selection path can't drift over what "the local secret" means.
const LOCAL_SECRET_STATE_KEYS = ['node_secret', 'node_secret_source', 'node_secret_version'];
const LEGACY_SECRET_FILES = ['node_secret', 'node_secret_version'];
/**
 * Hub rejected the cached node_secret as diverged (v1 a2aProtocol.js L1983-2017). Clear every
 * durable copy — store keys + on-disk legacy files — so the next start re-acquires cleanly via an
 * unauthenticated hello. The in-memory secret is already dropped by LegacyAuthShim before this runs.
 */
export function clearDivergedPublicNodeSecret(store, env = process.env) {
    for (const key of LOCAL_SECRET_STATE_KEYS)
        store.setState(key, '');
    // Wipe every identity-home candidate, not just the resolved state home: under the identity/state split
    // (EVOMAP_HOME ≠ EVOLVER_HOME) the diverged files live in the evomap dir, and clearing only one home would
    // leave them to resurrect the diverged secret on the next start (same union rationale as reset-local-secret).
    for (const home of identityHomeCandidates(env)) {
        for (const file of LEGACY_SECRET_FILES) {
            try {
                rmSync(join(home, file), { force: true });
            }
            catch (err) {
                process.stderr.write(`[evolver-proxy] failed to unlink diverged ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
            }
        }
    }
}
export function persistSelectedPublicNodeSecret(store, selection) {
    if (selection.source !== 'legacy_file' || !selection.nodeSecret)
        return;
    store.setState('node_secret_source', 'pending_legacy');
    if (selection.nodeId)
        store.setState('node_id', selection.nodeId);
    store.setState('node_secret', selection.nodeSecret);
    setOptionalStoreState(store, 'node_secret_version', selection.nodeSecretVersion !== undefined ? String(selection.nodeSecretVersion) : undefined);
    store.setState('node_secret_source', 'legacy_file');
}
export function persistRotatedPublicNodeCredentials(store, selection, secret, version) {
    store.setState('node_secret_source', 'pending_rotate');
    if (selection.nodeId)
        store.setState('node_id', selection.nodeId);
    store.setState('node_secret', secret);
    setOptionalStoreState(store, 'node_secret_version', version !== undefined ? String(version) : undefined);
    store.setState('node_secret_source', 'hub_rotate');
}
export function persistPublicNodeSecretVersion(store, selection, version) {
    const currentStoreSecret = store.getState('node_secret');
    const currentStoreSource = store.getState('node_secret_source');
    if (currentStoreSource === 'hub_rotate' && currentStoreSecret && isNodeSecret(currentStoreSecret)) {
        setOptionalStoreState(store, 'node_secret_version', version !== undefined ? String(version) : undefined);
        return;
    }
    if (selection.source !== 'env' || selection.nodeSecret === selection.storeSecret) {
        setOptionalStoreState(store, 'node_secret_version', version !== undefined ? String(version) : undefined);
        return;
    }
    if (selection.nodeSecret && version !== undefined) {
        store.setState('node_secret', selection.nodeSecret);
        store.setState('node_secret_source', 'env_seed');
        setOptionalStoreState(store, 'node_secret_version', String(version));
    }
}
function isDirectRun(metaUrl, argv1) {
    if (!argv1)
        return false;
    try {
        return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
    }
    catch {
        return false;
    }
}
export async function connectHubRuntime(deps) {
    if (deps.mode === 'private') {
        const storedInvitationFingerprint = deps.store.getState('private_invitation_fingerprint')?.trim();
        const runtimeEnv = deps.env ?? process.env;
        let storedNodeSecret;
        try {
            storedNodeSecret = deps.privateNodeCredentialStore?.read();
        }
        catch (error) {
            if (!(error instanceof PrivateNodeCredentialReadError)
                || !hasPrivateEnrollmentFallback(runtimeEnv, storedInvitationFingerprint)) {
                throw error;
            }
        }
        const runtime = await connectPrivateProxyHub({
            hubUrl: deps.hubUrl,
            senderId: deps.senderId,
            env: runtimeEnv,
            ...(storedNodeSecret ? { storedNodeSecret } : {}),
            ...(storedInvitationFingerprint ? { storedInvitationFingerprint } : {}),
            ...(deps.privateNodeCredentialStore ? {
                onNodeSecretAdopted: (nodeSecret) => {
                    deps.privateNodeCredentialStore?.write(nodeSecret);
                    deps.store.setState('private_node_secret_source', 'hub_enrollment');
                },
            } : {}),
            onInvitationRedeemed: (fingerprint) => {
                deps.store.setState('private_invitation_fingerprint', fingerprint);
            },
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.privateImporter ? { importer: deps.privateImporter } : {}),
        });
        return {
            hub: runtime.hub,
            hello: runtime.hello,
            heartbeat: (opts) => runtime.hub.heartbeat(opts),
            helloMode: 'enterprise_token',
        };
    }
    const selection = resolvePublicNodeSecret(deps);
    const { nodeSecret, nodeSecretVersion } = selection;
    if (!nodeSecret)
        throw new Error('public legacy 模式需 EVOMAP_NODE_SECRET');
    persistSelectedPublicNodeSecret(deps.store, selection);
    const verifiedSender = createVerifiedPublicSender(selection.nodeId);
    const senderId = verifiedSender.senderId;
    const { hub, auth } = connectPublicHub({
        hubUrl: deps.hubUrl,
        authMode: 'legacy',
        nodeSecret,
        ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
        senderId,
        antiAbuse: { source: 'evolver-proxy', proxyPortConfigured: true },
        onNodeSecretRotated: (secret, version) => {
            persistRotatedPublicNodeCredentials(deps.store, selection, secret, version);
        },
        onNodeSecretVersionUpdated: (version) => {
            persistPublicNodeSecretVersion(deps.store, selection, version);
        },
        // Legacy path only. enterprise_token mode connects via connectPrivateProxyHub above and
        // never reaches this branch, so the divergence self-heal can't touch a private node.
        onNodeSecretDiverged: () => {
            clearDivergedPublicNodeSecret(deps.store, process.env);
        },
    });
    const hello = wrapHelloWithClaimNudge(async (opts) => {
        const result = await hub.hello(opts);
        if (result.nodeId)
            adoptVerifiedPublicNodeId(deps.store, selection, verifiedSender, result.nodeId);
        return result;
    }, createClaimNudge({
        store: deps.store,
        hubUrl: deps.hubUrl,
        env: deps.env ?? process.env,
        ...(deps.now ? { now: deps.now } : {}),
    }));
    return {
        hub,
        atp: new AtpHubClient({ baseUrl: deps.hubUrl, auth, fetchFn: globalFetchLike, senderId }),
        hello,
        heartbeat: (opts) => hub.heartbeat(opts),
    };
}
function hasPrivateEnrollmentFallback(env, storedInvitationFingerprint) {
    if (resolvePrivateNodeSecret(env) || resolvePrivateEnterpriseToken(env))
        return true;
    const invitationToken = resolvePrivateInvitationToken(env);
    if (!invitationToken)
        return false;
    return createHash('sha256').update(invitationToken).digest('hex') !== storedInvitationFingerprint;
}
export function resolveLegacyNodeSecret(envNodeSecret, storedNodeSecret, storedSource) {
    if (envNodeSecret)
        return envNodeSecret;
    if (storedSource === 'hub_rotate' && storedNodeSecret && isNodeSecret(storedNodeSecret))
        return storedNodeSecret;
    return storedNodeSecret;
}