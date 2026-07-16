#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemon, hub as hubNs, mailbox } from '@evomap/evolver-core';
import { AtpHubClient, connectPublicHub, globalFetchLike, isNodeSecret, parseNodeSecretVersion } from '@evomap/evolver-adapter-public';
import { ProxyDaemon } from '../daemon/proxyDaemon.js';
import { resolveHubMode, resolveHubUrl } from '../daemon/selectHub.js';
import { resolveIpcPort } from '../daemon/ipcConfig.js';
import { traceCollectionEnabled } from '../llm/traceConfig.js';
import { connectPrivateProxyHub } from '../private/adapterLoader.js';
import { createAtpOrderConsentGate } from '../daemon/atpConsent.js';
import { resolveProxyStorePath } from './proxyStorePath.js';
import { publishProxySettings } from './proxySettings.js';
import { loadEnvFileFromEnv } from './envFile.js';
import { resolveProxyNodeId } from '../lifecycle/legacyNodeId.js';
import { getCurrentVersion } from '../selfUpdate/version.js';
import { resolveSelfUpdatePolicy } from '../selfUpdate/policy.js';
import { atomicReplaceExecutable, downloadGithubReleaseArtifact, resolveGithubReleaseManifest, } from '../selfUpdate/releaseBinary.js';
/** evolver-proxy 系统级 daemon 入口(M6-7). EVOMAP_HUB_MODE/URL/NODE_SECRET 选址. */
async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write(proxyUsage());
        return;
    }
    const envFile = loadEnvFileFromEnv(process.env);
    if (envFile.error)
        process.stderr.write(`[evolver-proxy] failed to load EVOLVER_ENV_FILE: ${safeLoopMessage(envFile.error)}\n`);
    const mode = resolveHubMode(process.env);
    const hubUrl = resolveHubUrl(process.env);
    const storePath = resolveProxyStorePath(process.env);
    // `?.trim() ||` not `??`: an EMPTY/whitespace EVOLVER_IPC_TOKEN (e.g. a blank `.env` entry or `export
    // EVOLVER_IPC_TOKEN=`) must be treated as unset and get a strong random token, never fall through as `''` —
    // an empty token would authenticate any `Authorization: Bearer ` request and defeat the loopback IPC auth.
    const ipcToken = process.env['EVOLVER_IPC_TOKEN']?.trim() || randomBytes(24).toString('hex');
    const ipcPort = resolveIpcPort(process.env);
    const store = new mailbox.MailboxStore({ path: storePath });
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
    // Read our own version for hello/heartbeat reporting and self-update decisions. EVOLVER_SELF_UPDATE defaults
    // to off; prompt/auto opt into the daemon path, but the release download/replace seams still fail closed until
    // a verified release implementation is wired.
    const evolverVersion = getCurrentVersion();
    const selfUpdatePolicy = resolveSelfUpdatePolicy(process.env);
    const runtime = await connectHubRuntime({ mode, hubUrl, senderId, store });
    const proxyStartedAt = new Date().toISOString();
    const proxySettingsState = {};
    const publishLocalProxySettings = () => {
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
    const daemon = new ProxyDaemon({
        ...createProxyDaemonDeps({
            runtime,
            store,
            ipcToken,
            ...(ipcPort !== undefined ? { ipcPort } : {}),
            evolverVersion,
            selfUpdatePolicy,
            env: process.env,
        }),
        onIpcListen: (port) => {
            proxySettingsState.url = `http://127.0.0.1:${port}`;
            publishLocalProxySettings();
        },
        onIpcAuthFailure: publishLocalProxySettings,
    });
    const port = await daemon.start();
    proxySettingsState.url = `http://127.0.0.1:${port}`;
    publishLocalProxySettings();
    process.stdout.write(`[evolver-proxy] mode=${mode} hub=${hubUrl} ipc=127.0.0.1:${port} v=${evolverVersion} self-update=${selfUpdatePolicy}\n`);
    await runProxyLoop(daemon, { logger: process.stderr });
}
export function proxyUsage() {
    return [
        'usage: evolver-proxy',
        '',
        'Starts the local Evolver proxy daemon.',
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
        '  EVOLVER_SELF_UPDATE, EVOLVER_LLM_TRACE_CAPTURE_BODIES',
        '',
    ].join('\n');
}
export function runProxyCli() {
    const uninstallUnhandledRejectionGuard = daemon.installUnhandledRejectionWindow();
    main().catch((e) => {
        uninstallUnhandledRejectionGuard();
        process.stderr.write(`[evolver-proxy] fatal: ${safeLoopErrorMessage(e)}\n`);
        process.exit(1);
    });
}
if (isDirectRun(import.meta.url, process.argv[1])) {
    runProxyCli();
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
                await sleepUntilDelayOrWake(Math.max(minDelayMs, delayMs), sleep, setWakeHandler);
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
        if (!useDaemonSleep)
            daemon.setWakeHandler?.(undefined);
    }
}
export function createProxyDaemonDeps(options) {
    const selfUpdate = createSelfUpdateDeps(options.selfUpdatePolicy, options.evolverVersion, options.env ?? process.env, options.selfUpdateOverrides);
    const traceBackfill = resolveTraceBackfillConfig(options.env ?? process.env);
    return {
        hub: options.runtime.hub,
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
        ...(options.runtime.helloMode ? { helloMode: options.runtime.helloMode } : {}),
        ...(selfUpdate ? { selfUpdate } : {}),
        ...(traceBackfill ? { traceBackfill } : {}),
    };
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
    const publicKey = env['EVOLVER_SELF_UPDATE_PUBLIC_KEY']?.trim();
    if (!publicKey)
        throw new Error('self_update_public_key_required');
    const releaseOpts = {
        env,
        ...overrides,
        requireSignedManifest: true,
    };
    return {
        policy,
        currentVersion,
        resolveManifest: (directive) => resolveGithubReleaseManifest(directive, releaseOpts),
        download: (targetVersion, directive) => downloadGithubReleaseArtifact(targetVersion, directive, releaseOpts),
        atomicReplace: (stagedPath) => atomicReplaceExecutable(stagedPath, releaseOpts),
        restart: overrides.restart ?? (() => { process.exit(78); }),
        publicKey,
    };
}
export function resolvePublicNodeSecret(deps) {
    const envNodeSecret = process.env['EVOMAP_NODE_SECRET'] ?? process.env['A2A_NODE_SECRET'];
    // version env precedence MUST mirror the node_secret precedence above (EVOMAP-first) so an operator
    // who sets both env pairs always resolves a matched (secret, version). v2 standardizes on EVOMAP_*-first
    // for BOTH secret and version; v1 uses A2A_*-first but pairs the two identically. Do not flip one alone.
    const envNodeSecretVersion = parseNodeSecretVersion(process.env['EVOMAP_NODE_SECRET_VERSION'] ?? process.env['A2A_NODE_SECRET_VERSION']);
    const storedNodeSecret = deps.store.getState('node_secret');
    const storedSource = deps.store.getState('node_secret_source');
    const storedNodeSecretVersion = parseNodeSecretVersion(deps.store.getState('node_secret_version'));
    const storeSecret = storedNodeSecret && isNodeSecret(storedNodeSecret) ? storedNodeSecret : undefined;
    if (storedSource === 'hub_rotate' && storeSecret) {
        return { nodeSecret: storeSecret, nodeSecretVersion: storedNodeSecretVersion, source: 'hub_rotate', storeSecret };
    }
    if (envNodeSecret) {
        const pairedStoreVersion = envNodeSecret === storeSecret ? storedNodeSecretVersion : undefined;
        return { nodeSecret: envNodeSecret, nodeSecretVersion: envNodeSecretVersion ?? pairedStoreVersion, source: 'env', storeSecret };
    }
    if (storeSecret)
        return { nodeSecret: storeSecret, nodeSecretVersion: storedNodeSecretVersion, source: 'store', storeSecret };
    const legacy = readLegacyNodeSecret(process.env);
    if (legacy)
        return { ...legacy, source: 'legacy_file' };
    return { nodeSecret: undefined, source: 'store' };
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
function readLegacyNodeSecret(env = process.env) {
    const home = evomapHome(env);
    const nodeSecret = readTrimmedFile(join(home, 'node_secret'));
    if (!nodeSecret || !isNodeSecret(nodeSecret))
        return undefined;
    const nodeSecretVersion = parseNodeSecretVersion(readTrimmedFile(join(home, 'node_secret_version')));
    return { nodeSecret, ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}) };
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
    const home = evomapHome(env);
    for (const file of LEGACY_SECRET_FILES) {
        try {
            rmSync(join(home, file), { force: true });
        }
        catch (err) {
            process.stderr.write(`[evolver-proxy] failed to unlink diverged ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
}
export function persistSelectedPublicNodeSecret(store, selection) {
    if (selection.source !== 'legacy_file' || !selection.nodeSecret)
        return;
    store.setState('node_secret', selection.nodeSecret);
    store.setState('node_secret_source', 'legacy_file');
    setOptionalStoreState(store, 'node_secret_version', selection.nodeSecretVersion !== undefined ? String(selection.nodeSecretVersion) : undefined);
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
        const { hub } = await connectPrivateProxyHub({
            hubUrl: deps.hubUrl,
            senderId: deps.senderId,
            env: deps.env ?? process.env,
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.privateImporter ? { importer: deps.privateImporter } : {}),
        });
        return { hub, hello: (opts) => hub.hello(opts), heartbeat: (opts) => hub.heartbeat(opts), helloMode: 'enterprise_token' };
    }
    const selection = resolvePublicNodeSecret(deps);
    const { nodeSecret, nodeSecretVersion } = selection;
    if (!nodeSecret)
        throw new Error('public legacy 模式需 EVOMAP_NODE_SECRET');
    persistSelectedPublicNodeSecret(deps.store, selection);
    const { hub, auth } = connectPublicHub({
        hubUrl: deps.hubUrl,
        authMode: 'legacy',
        nodeSecret,
        ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
        senderId: deps.senderId,
        antiAbuse: { source: 'evolver-proxy', proxyPortConfigured: true },
        onNodeSecretRotated: (secret, version) => {
            deps.store.setState('node_secret', secret);
            deps.store.setState('node_secret_source', 'hub_rotate');
            setOptionalStoreState(deps.store, 'node_secret_version', version !== undefined ? String(version) : undefined);
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
    return {
        hub,
        atp: new AtpHubClient({ baseUrl: deps.hubUrl, auth, fetchFn: globalFetchLike, senderId: deps.senderId }),
        hello: (opts) => hub.hello(opts),
        heartbeat: (opts) => hub.heartbeat(opts),
    };
}
export function resolveLegacyNodeSecret(envNodeSecret, storedNodeSecret, storedSource) {
    if (envNodeSecret)
        return envNodeSecret;
    if (storedSource === 'hub_rotate' && storedNodeSecret && isNodeSecret(storedNodeSecret))
        return storedNodeSecret;
    return storedNodeSecret;
}