import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mailbox, hub as hubNs, shadow as shadow_, assetstore, wire, util } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubUnreachableError } from '@evomap/evolver-adapter-public';
import { SyncEngine, SYNC_INTERVALS } from '../sync/engine.js';
import { LifecycleManager } from '../lifecycle/manager.js';
import { executeForceUpdate } from '../selfUpdate/executor.js';
import { reportPendingSelfUpdateLastUpdate, reportSelfUpdateLastUpdate } from '../selfUpdate/lastUpdate.js';
import { backfillProxyTraceUploads } from '../llm/traceBackfill.js';
import { hubAuthFailureHint } from './selectHub.js';
import { CollaborationFacade } from './collaborationFacade.js';
import { PublishRecallVerifier, resolvePublishRecallConfig, } from './publishRecallVerifier.js';
export const DEFAULT_IPC_PORT = 19820;
// V1 local-proxy compatibility contract; independent of the V2 mailbox envelope schema.
const PROXY_PROTOCOL_VERSION = '0.1.0';
const PROXY_STATUS_SCHEMA_VERSION = 1;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_PROXY_TICK_ERROR_LENGTH = 2_000;
const MAX_HEARTBEAT_TICK_ERROR_LENGTH = 1_000;
const MAX_EPHEMERAL_IPC_LISTEN_ATTEMPTS = 5;
const DEFAULT_ASSET_SEARCH_CACHE_TTL_MS = 30_000;
const DEFAULT_ASSET_SEARCH_CACHE_MAX = 256;
const DEFAULT_ASSET_SEARCH_STALE_GRACE_MS = 5 * 60_000;
const MAX_ASSET_SUBMIT_ITEMS = 50;
const ASYNC_ASSET_SUBMIT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ASYNC_ASSET_SUBMIT_PREFIX = 'async_asset_submit:';
const OUTBOUND_HUB_MODE_FIELD = '__evolver_hub_mode';
const SYNC_ASSET_SUBMIT_PREFIX = 'sync_asset_submit:';
const SYNC_ASSET_SUBMIT_TYPE_RANK = {
    Gene: 0,
    Capsule: 1,
    EvolutionEvent: 2,
    AntiGene: 3,
};
const SYNC_ASSET_SUBMIT_SCOPE_STATE_KEY = 'sync_asset_submit:idempotency_scope:v1';
const SYNC_ASSET_SUBMIT_DIRECT_RETRY_GRACE_MS = 30_000;
const DEFAULT_SYNC_ASSET_SUBMIT_RESPONSE_TIMEOUT_MS = 15_000;
class OutboundHubModeMismatchError extends Error {
    retryable = true;
    retryAfterMs = 1_000;
    constructor(expected, actual) {
        super(`asset_submit hub mode mismatch: queued for ${expected}, running in ${actual}`);
        this.name = 'OutboundHubModeMismatchError';
    }
}
/**
 * ProxyDaemon(M6-4) 装配层: 把 core(MailboxStore/Dispatcher/MailboxDaemon/IpcServer) +
 * HubBindings(M6-1) + SyncEngine(M6-2) + LifecycleManager(M6-3) 拼成系统级 proxy.
 * 职责分工(避免双 claim): MailboxDaemon 只 pump 'core'(本地确定性); proxy 出站归 SyncEngine.syncOutbound;
 * inbound 由 SyncEngine.syncInbound 从 hub 拉; agent 消息留给 runtime 经 IPC claim.
 */
export class ProxyDaemon {
    deps;
    store;
    dispatcher;
    daemon;
    sync;
    lifecycle;
    assetStore;
    remoteAssetById;
    reuseResultReporter;
    validator;
    atp;
    collaborationFacade;
    publishRecallVerifier;
    proxyHandler;
    hub;
    recipeComposeStarted = new Set();
    ipc;
    now;
    random;
    assetSearchCacheTtlMs;
    assetSearchCacheMax;
    assetSearchStaleGraceMs;
    assetSubmitResponseTimeoutMs;
    synchronousAssetSubmitScope;
    shadowMode;
    assetSearchCache = new Map();
    assetSearchInflight = new Map();
    synchronousAssetSubmitInflight = new Map();
    assetSearchCooldownUntil = 0;
    nextHeartbeatAt;
    heartbeatFailures = 0;
    heartbeatGeneration = 0;
    /** Resolver for an in-flight runner sleep(); set while sleeping, called to wake early on poke. */
    wakeRunnerResolve;
    /** A poke that arrived between ticks (no sleep in flight) parks the wake here so it is not lost. */
    wakeRunnerPending = false;
    started = false;
    lifecycleArmed = false;
    lastTickAt;
    nextTickDueAt;
    consecutiveTickFailures = 0;
    storeClosed = false;
    forceUpdateTriggerInFlight = false;
    forceUpdateLastTriggeredAt;
    forceUpdateLastTriggeredKey;
    pendingForceUpdateDirective;
    forceUpdateTimer;
    scheduledForceUpdateKey;
    traceBackfillDraining = false;
    loopWakeHandler;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
        this.random = deps.random ?? Math.random;
        this.assetSearchCacheTtlMs = positiveIntegerOr(deps.assetSearchCacheTtlMs, DEFAULT_ASSET_SEARCH_CACHE_TTL_MS);
        this.assetSearchCacheMax = positiveIntegerOr(deps.assetSearchCacheMax, DEFAULT_ASSET_SEARCH_CACHE_MAX);
        this.assetSearchStaleGraceMs = positiveIntegerOr(deps.assetSearchStaleGraceMs, DEFAULT_ASSET_SEARCH_STALE_GRACE_MS);
        this.assetSubmitResponseTimeoutMs = positiveIntegerOr(deps.assetSubmitResponseTimeoutMs, DEFAULT_SYNC_ASSET_SUBMIT_RESPONSE_TIMEOUT_MS);
        if (!deps.store && !deps.storePath)
            throw new Error('ProxyDaemon: 需 store 或 storePath 之一');
        const shadow = deps.shadowMode === 'shadow';
        this.shadowMode = shadow;
        if (shadow && !deps.shadowSink)
            throw new Error('ProxyDaemon: shadow 模式需 shadowSink');
        // M8 shadow 装配: 在边界包 decorator, 下游 makeHubBindings/Dispatcher/SyncEngine/MailboxDaemon 零改.
        this.store = deps.store
            ?? (shadow ? new shadow_.ShadowMailboxStore({ path: deps.storePath }, deps.shadowSink, 'shadow') : new mailbox.MailboxStore({ path: deps.storePath }));
        const existingSynchronousAssetSubmitScope = this.store.getState(SYNC_ASSET_SUBMIT_SCOPE_STATE_KEY);
        this.synchronousAssetSubmitScope = existingSynchronousAssetSubmitScope ?? randomUUID();
        if (!existingSynchronousAssetSubmitScope) {
            this.store.setState(SYNC_ASSET_SUBMIT_SCOPE_STATE_KEY, this.synchronousAssetSubmitScope);
        }
        const assetStoreDir = deps.assetStoreDir ?? (deps.storePath ? join(dirname(deps.storePath), 'assets') : undefined);
        this.assetStore = deps.assetStore ?? (assetStoreDir ? new assetstore.LocalJsonlProvider(assetStoreDir) : undefined);
        this.atp = deps.atp;
        const hubToUse = shadow ? shadow_.shadowHubCapability(deps.hub, deps.shadowSink, 'shadow') : deps.hub;
        this.hub = hubToUse;
        const hubBindings = hubNs.makeHubBindings(hubToUse, deps.publishSanitizeEnv
            ? { sanitize: { env: deps.publishSanitizeEnv } }
            : {});
        this.proxyHandler = hubBindings.asProxyHandler();
        const proxyHandler = this.proxyHandler;
        const syncProxyHandler = (envelope) => this.handleHubModeBoundOutbound(envelope);
        const assetByIdSource = isAssetByIdFetcher(deps.hub) ? deps.hub : (isAssetByIdFetcher(hubToUse) ? hubToUse : undefined);
        this.remoteAssetById = assetByIdSource
            ? async (assetId) => {
                const fetched = await assetByIdSource.fetchAssetById(assetId);
                return assetMatchesId(fetched, assetId) ? fetched : null;
            }
            : undefined;
        const publishRecallConfig = resolvePublishRecallConfig();
        this.publishRecallVerifier = deps.publishRecallVerifier ?? new PublishRecallVerifier({
            store: this.store,
            ...(!shadow && assetByIdSource
                ? { fetchAssetById: (assetId) => assetByIdSource.fetchAssetById(assetId) }
                : {}),
            config: shadow ? { ...publishRecallConfig, enabled: false } : publishRecallConfig,
            now: this.now,
            random: this.random,
            stateKey: `publish_recall_verifier:${deps.runtimeNamespace ?? 'default'}:v1`,
        });
        this.reuseResultReporter = isReuseResultReporter(hubToUse)
            ? hubToUse
            : (!shadow && isReuseResultReporter(deps.hub) ? deps.hub : undefined);
        // validate() makes a LIVE POST /a2a/validate to the real hub (content-safety scan over the asset
        // bundle) — it is the dry-run for a publish that shadow suppresses, so it is disabled under shadow
        // like recordReuseResult and degrades to { valid:false, reason:'validate_not_configured' }.
        this.validator = isValidator(hubToUse)
            ? hubToUse
            : (!shadow && isValidator(deps.hub) ? deps.hub : undefined);
        // proxy handler 装进 Dispatcher 仅供完整性; daemon 只 pump core, 实际出站走 SyncEngine.
        this.dispatcher = new mailbox.Dispatcher({
            store: this.store,
            handlers: { core: (e) => this.handleCore(e), proxy: proxyHandler, agent: () => ({}) },
            now: this.now,
        });
        this.daemon = new mailbox.MailboxDaemon({
            store: this.store, dispatcher: this.dispatcher, now: this.now,
            pumpHandlers: ['core'], // proxy 出站归 SyncEngine, 不在此双 claim
            ...(deps.lockPath ? { lockPath: deps.lockPath } : {}),
        });
        this.collaborationFacade = new CollaborationFacade({
            store: this.store,
            hub: hubToUse,
            now: this.now,
            notifyOutbound: () => this.notifyNewOutbound(),
            ...(deps.runtimeNamespace ? { runtimeNamespace: deps.runtimeNamespace } : {}),
            ...(deps.collaborationOperationTimeoutMs !== undefined ? { operationTimeoutMs: deps.collaborationOperationTimeoutMs } : {}),
        });
        this.sync = new SyncEngine({
            store: this.store, hub: hubToUse, proxyHandler: syncProxyHandler, now: this.now,
            ...(deps.runtimeNamespace ? { runtimeNamespace: deps.runtimeNamespace } : {}),
            onOutboundSucceeded: (envelope, result) => {
                this.collaborationFacade.handleOutboundSucceeded(envelope, result);
                let shouldObserve = true;
                try {
                    const cached = this.cacheSynchronousAssetSubmitSuccess(envelope, result);
                    if (cached === false)
                        shouldObserve = false;
                }
                catch { /* best-effort */ }
                // Observability must never turn a Hub-accepted publish into a failed/retried economic action.
                if (shouldObserve) {
                    try {
                        this.publishRecallVerifier.observeAcceptedPublish(envelope, result);
                    }
                    catch { /* best-effort */ }
                }
                // Recipe is the preferred public artifact. Failure here must not retry the already-accepted asset publish.
                this.composeRecipeAfterAcceptedSubmit(envelope);
            },
            onOutboundTerminal: (envelope, error) => {
                this.collaborationFacade.handleOutboundTerminal(envelope, error);
                try {
                    this.cacheSynchronousAssetSubmitTerminal(envelope, error);
                }
                catch { /* best-effort */ }
            },
            acceptedOutcomeKey: (envelope) => !shadow && isSynchronousAssetSubmitEnvelope(envelope)
                ? synchronousAssetSubmitAcceptanceKey(envelope.idempotencyKey)
                : undefined,
            terminalOutcome: (envelope, error) => {
                if (shadow || !isSynchronousAssetSubmitEnvelope(envelope))
                    return undefined;
                const failure = mapSynchronousPublishFailure(error);
                return {
                    key: synchronousAssetSubmitOutcomeKey(envelope.idempotencyKey),
                    result: { kind: 'failed', ...failure },
                };
            },
            normalizeInboundEnvelope: (envelope) => this.collaborationFacade.normalizeInboundEnvelope(envelope),
            ...(deps.traceBackfill ? { onOutboundFlushed: () => { this.drainProxyTraceBackfill(); } } : {}),
        });
        this.lifecycle = new LifecycleManager({
            store: this.store, auth: hubToUse.auth, hello: deps.hello, heartbeat: deps.heartbeat, now: this.now,
            ...(deps.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: deps.heartbeatIntervalMs } : {}),
            ...(deps.evolverVersion ? { evolverVersion: deps.evolverVersion } : {}),
            ...(deps.helloMode ? { helloMode: deps.helloMode } : {}),
            onForceUpdateDirective: (directive, source) => { this.triggerForceUpdateFromHeartbeat(directive, source); },
        });
        this.nextHeartbeatAt = this.now();
    }
    /**
     * core handler(确定性, 不经 agent): 目前只接 force_update(#108). 其他 core 类型(asset_publish_result/
     * feature_flag_update)仍由 Material/上层处理, 这里 no-op 标完成. force_update 仅当装配了 selfUpdate 才执行;
     * 否则只标完成(不下载/不重启 — 默认 OFF 风险闸). 永不抛: 失败转结构化 telemetry, daemon 续跑旧版本.
     */
    async handleCore(e) {
        if (e.type !== 'force_update')
            return {};
        if (!this.deps.selfUpdate)
            return { ok: false, reason: 'self_update_not_configured' };
        const directive = (e.payload ?? {});
        return this.executeAndReportForceUpdate(directive);
    }
    recordTickError(phase, err) {
        const authLike = isAuthLikeError(err);
        // #314: surface the actionable hint on an auth failure, keyed off the hub error code so it is not silent and
        // not misdirected (a2a_auth_required => private hub; other auth error => credential problem).
        const hint = authLike ? hubAuthFailureHint(process.env, errorMessage(err)) : '';
        const message = safeDaemonMessage(`${phase}_tick: ${errorMessage(err)}${hint ? `. ${hint}` : ''}`, MAX_PROXY_TICK_ERROR_LENGTH);
        try {
            this.store.setState('sync:last_error', message);
            if (authLike)
                this.store.setState('hub:auth_status', 'auth_failed');
        }
        catch {
            // Telemetry write failures must not break tick phase isolation.
        }
        return message;
    }
    /** 启动: 锁 + IPC 监听 + 初次 hello. 返回 IPC 端口. */
    async start() {
        if (this.started)
            throw new Error('ProxyDaemon 已启动');
        try {
            this.daemon.start();
            this.ipc = new mailbox.MailboxIpcServer({
                store: this.store, token: this.deps.ipcToken,
                runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
                ...(this.deps.ipcHost ? { host: this.deps.ipcHost } : {}), now: this.now,
                onSend: (env, result) => {
                    if (result.stored && env.handler === 'proxy')
                        this.notifyNewOutbound();
                },
                ...(this.deps.onIpcAuthFailure ? { onAuthFailure: this.deps.onIpcAuthFailure } : {}),
                extraRoutes: [(ctx) => this.handleProxyRoute(ctx)],
            });
            const port = await this.listenIpc(this.ipc);
            try {
                this.deps.onIpcListen?.(port);
            }
            catch { /* local discovery publishing must not block daemon startup */ }
            await this.lifecycle.doHello();
            this.lifecycleArmed = true;
            this.drainProxyTraceBackfill();
            try {
                this.publishRecallVerifier.start();
            }
            catch { /* verifier availability must not block proxy startup */ }
            this.started = true;
            return port;
        }
        catch (err) {
            await this.closeIpcBestEffort();
            try {
                await this.daemon.stop();
            }
            catch { /* best-effort cleanup */ }
            try {
                this.closeStoreOnce();
            }
            catch { /* best-effort cleanup */ }
            this.started = false;
            this.lifecycleArmed = false;
            throw err;
        }
    }
    async listenIpc(ipc) {
        const requestedPort = this.deps.ipcPort ?? DEFAULT_IPC_PORT;
        if (requestedPort !== 0)
            return ipc.listen(requestedPort);
        for (let attempt = 0; attempt < MAX_EPHEMERAL_IPC_LISTEN_ATTEMPTS; attempt += 1) {
            const assignedPort = await ipc.listen(0);
            if (!util.isFetchForbiddenPort(assignedPort))
                return assignedPort;
            // The outer start() cleanup owns the final listener when retries are exhausted.
            if (attempt === MAX_EPHEMERAL_IPC_LISTEN_ATTEMPTS - 1) {
                throw new Error('proxy_ipc_safe_port_unavailable');
            }
            await ipc.close();
        }
        throw new Error('proxy_ipc_safe_port_unavailable');
    }
    /** 单轮: core pump/TTL/wake + proxy 出站 + hub 入站 + 到点心跳. */
    async tick() {
        const errors = [];
        const finalErrors = [];
        const addFailure = (phase, message) => {
            errors.push({ phase, message });
            finalErrors.push(message);
        };
        try {
            await this.daemon.tick(); // core + TTL + wake
        }
        catch (err) {
            addFailure('core', this.recordTickError('core', err));
        }
        let outbound = emptyOutboundResult();
        let heartbeat;
        try {
            outbound = await this.sync.syncOutbound();
            if (outbound.authFailed) {
                // #314: carry the engine's specific auth error (e.g. a2a_auth_required) up here so the operator-visible
                // sync:last_error shows the real code + the correctly-keyed hint, not a generic "auth_failure".
                const detail = outbound.authErrorMessage ?? 'auth_failure';
                const authHint = hubAuthFailureHint(process.env, detail);
                const outboundError = safeDaemonMessage(`outbound_tick: ${detail}${authHint ? `. ${authHint}` : ''}`, MAX_PROXY_TICK_ERROR_LENGTH);
                try {
                    const generation = this.heartbeatGeneration;
                    const reauthed = await this.lifecycle.reauthenticate();
                    if (reauthed) {
                        heartbeat = { ok: false, reauthed: true };
                        this.recordHeartbeatResult(heartbeat, generation);
                    }
                    else {
                        addFailure('outbound', outboundError);
                    }
                }
                catch (reauthErr) {
                    addFailure('outbound', outboundError);
                    addFailure('heartbeat', this.recordTickError('heartbeat', reauthErr));
                }
            }
        }
        catch (err) {
            addFailure('outbound', this.recordTickError('outbound', err));
        }
        let inbound = emptyInboundResult();
        try {
            inbound = await this.sync.syncInbound();
        }
        catch (err) {
            const inboundError = this.recordTickError('inbound', err);
            if (isAuthLikeError(err)) {
                try {
                    const generation = this.heartbeatGeneration;
                    const reauthed = await this.lifecycle.reauthenticate();
                    if (reauthed) {
                        heartbeat = { ok: false, reauthed: true };
                        this.recordHeartbeatResult(heartbeat, generation);
                    }
                    else {
                        addFailure('inbound', inboundError);
                    }
                }
                catch (reauthErr) {
                    addFailure('inbound', inboundError);
                    addFailure('heartbeat', this.recordTickError('heartbeat', reauthErr));
                }
            }
            else {
                addFailure('inbound', inboundError);
            }
        }
        if (!heartbeat && this.now() >= this.nextHeartbeatAt) {
            const generation = this.heartbeatGeneration;
            try {
                heartbeat = await this.lifecycle.doHeartbeat();
            }
            catch (err) {
                const message = safeHeartbeatTickErrorMessage(err);
                heartbeat = { ok: false, reauthed: false, error: message };
                this.recordHeartbeatTickException(message);
                addFailure('heartbeat', `heartbeat_tick_exception:${message}`);
            }
            this.recordHeartbeatResult(heartbeat, generation);
        }
        if (finalErrors.length > 0) {
            try {
                this.store.setState('sync:last_error', safeDaemonMessage(finalErrors.join('; '), MAX_PROXY_TICK_ERROR_LENGTH));
            }
            catch { /* ignore telemetry persistence failures */ }
        }
        const failedPhases = uniqueTickPhases(errors.map((err) => err.phase));
        const fatalCandidate = errors.length > 0 && isFatalTickCandidate(outbound, inbound, failedPhases);
        this.lastTickAt = this.now();
        this.consecutiveTickFailures = fatalCandidate ? this.consecutiveTickFailures + 1 : 0;
        return {
            outbound,
            inbound,
            ...(heartbeat ? { heartbeat } : {}),
            ...(errors.length > 0 ? { errors, failedPhases, fatalCandidate } : { failedPhases: [], fatalCandidate: false }),
        };
    }
    /** 下一轮建议延时: inbound 背压/idle 与 outbound pending cadence 取更快者. */
    nextDelay(last) {
        const inbound = this.sync.nextInboundDelay(last);
        const outbound = this.sync.nextOutboundDelay();
        const hubDirected = last.hasMore || last.nextPollAfterMs !== undefined;
        const syncDelay = outbound !== SYNC_INTERVALS.outboundPending || hubDirected
            ? inbound
            : Math.min(inbound, outbound);
        const heartbeatDelay = Math.max(0, this.nextHeartbeatAt - this.now());
        return Math.min(syncDelay, heartbeatDelay);
    }
    setWakeHandler(wake) {
        this.loopWakeHandler = wake;
    }
    setExpectedNextTick(delayMs) {
        this.nextTickDueAt = delayMs === undefined
            ? undefined
            : this.now() + Math.max(0, delayMs);
    }
    notifyNewOutbound() {
        if (this.loopWakeHandler) {
            this.loopWakeHandler();
            return;
        }
        this.wakeRunner();
    }
    /**
     * Expedite the next heartbeat: clear the failure backoff, mark the heartbeat due now, and wake an
     * in-flight runner sleep() so the next tick runs immediately. Wake-on-event for the pull-based
     * loop — the interruptible sleep() lets this preempt a long backoff wait the way V1's timer-driven
     * loop did (which armed a 0ms timer). The generation bump prevents a tick that was already in
     * flight from overwriting this reschedule. No-op until the daemon is started.
     */
    pokeHeartbeatLoop() {
        if (!this.started)
            return;
        this.heartbeatGeneration += 1;
        this.heartbeatFailures = 0;
        this.nextHeartbeatAt = this.now();
        this.wakeRunner();
    }
    /**
     * Interruptible delay for the resident runner loop (bin/evolver-proxy.ts): resolves after `ms`, OR
     * immediately when pokeHeartbeatLoop() fires while sleeping. A poke that lands between ticks (before
     * the next sleep starts) sets wakeRunnerPending so the wake is not lost. The timer is unref'd so it
     * never keeps the process alive on its own.
     */
    async sleep(ms) {
        if (this.wakeRunnerPending) {
            this.wakeRunnerPending = false;
            return;
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.wakeRunnerResolve = undefined;
                resolve();
            }, ms);
            if (typeof timer.unref === 'function')
                timer.unref();
            this.wakeRunnerResolve = () => {
                clearTimeout(timer);
                this.wakeRunnerResolve = undefined;
                resolve();
            };
        });
    }
    wakeRunner() {
        if (this.wakeRunnerResolve)
            this.wakeRunnerResolve();
        else
            this.wakeRunnerPending = true;
    }
    health() {
        return {
            running: this.started,
            ipcListening: !!this.ipc,
            lifecycleArmed: this.lifecycleArmed,
            ...(this.lifecycle.nodeId ? { nodeId: this.lifecycle.nodeId } : {}),
            lastWriteAt: this.daemon.lastWriteAt(),
            ...(this.lastTickAt !== undefined ? { lastTickAt: this.lastTickAt } : {}),
            ...(this.nextTickDueAt !== undefined ? { nextTickDueAt: this.nextTickDueAt } : {}),
            consecutiveFailures: this.consecutiveTickFailures,
        };
    }
    async stop() {
        this.started = false;
        this.lifecycleArmed = false;
        this.nextTickDueAt = undefined;
        if (this.forceUpdateTimer) {
            clearTimeout(this.forceUpdateTimer);
            this.forceUpdateTimer = undefined;
            this.scheduledForceUpdateKey = undefined;
        }
        // Release a runner blocked on sleep() so shutdown doesn't wait out a long delay.
        this.wakeRunnerPending = false;
        if (this.wakeRunnerResolve)
            this.wakeRunnerResolve();
        try {
            await this.publishRecallVerifier.stop();
        }
        catch { /* best-effort verifier shutdown */ }
        let stopError;
        try {
            await this.closeIpc();
        }
        catch (err) {
            stopError = stopError ?? err;
        }
        try {
            await this.daemon.stop();
        }
        catch (err) {
            stopError = stopError ?? err;
        }
        try {
            this.closeStoreOnce();
        }
        catch (err) {
            stopError = stopError ?? err;
        }
        if (stopError)
            throw stopError;
    }
    async closeIpc() {
        const ipc = this.ipc;
        this.ipc = undefined;
        if (!ipc)
            return;
        await ipc.close();
    }
    async closeIpcBestEffort() {
        try {
            await this.closeIpc();
        }
        catch { /* best-effort cleanup */ }
    }
    closeStoreOnce() {
        if (this.storeClosed)
            return;
        this.store.close();
        this.storeClosed = true;
    }
    drainProxyTraceBackfill() {
        const cfg = this.deps.traceBackfill;
        const empty = {
            scanned: 0,
            queued: 0,
            duplicates: 0,
            skipped: 0,
            files: 0,
            reasons: {},
        };
        if (!cfg)
            return empty;
        if (this.traceBackfillDraining)
            return { ...empty, deferred: true };
        this.traceBackfillDraining = true;
        try {
            const stats = backfillProxyTraceUploads({
                dir: cfg.dir,
                store: this.store,
                ...(cfg.env ? { env: cfg.env } : {}),
                now: this.now,
                ...(this.deps.runtimeNamespace ? { runtimeNamespace: this.deps.runtimeNamespace } : {}),
            });
            if (stats.queued > 0)
                this.store.setState('llm_trace_backfill:last_queued', String(stats.queued));
            return stats;
        }
        catch (err) {
            this.store.setState('llm_trace_backfill:last_error', safeDaemonErrorMessage(err, MAX_PROXY_TICK_ERROR_LENGTH));
            return { ...empty, skipped: 1, reasons: { thrown: 1 } };
        }
        finally {
            this.traceBackfillDraining = false;
        }
    }
    recordHeartbeatResult(result, generation) {
        // A poke (pokeHeartbeatLoop) bumps heartbeatGeneration; a tick that began under an older
        // generation has been superseded and must touch neither the failure count nor the schedule.
        if (generation !== this.heartbeatGeneration)
            return;
        // V1 parity (lifecycle/manager.js _consecutiveFailures): every heartbeat failure backs off, not
        // only thrown ones. The adapter maps non-auth 4xx (400/429/...) and unknown_node to a structured
        // { ok:false } result with NO `error` field; the previous `!result.error` predicate left
        // heartbeatFailures at 0 and pinned the cadence at the base interval forever — worst for 429,
        // where the hub is rate-limiting and we kept hammering. A successful reauth (reauthed) is a
        // recovery and resets, matching V1's 'recovered' branch. Hub-unreachable failures are diverted
        // before this point and own their hubUnreachableUntil backoff, which nextHeartbeatDelay()
        // prioritizes, so counting them here is harmless.
        if (result.ok || result.reauthed) {
            this.heartbeatFailures = 0;
        }
        else {
            this.heartbeatFailures += 1;
        }
        this.nextHeartbeatAt = this.now() + this.lifecycle.nextHeartbeatDelay(this.heartbeatFailures);
    }
    recordHeartbeatTickException(message) {
        try {
            this.store.setState('sync:last_error', safeDaemonMessage(`heartbeat_tick_exception:${message}`, MAX_HEARTBEAT_TICK_ERROR_LENGTH));
        }
        catch {
            // The daemon loop must keep running even if telemetry persistence is broken.
        }
    }
    async executeAndReportForceUpdate(directive) {
        if (!this.deps.selfUpdate)
            return { ok: false, reason: 'self_update_not_configured' };
        const currentVersion = this.deps.selfUpdate.currentVersion ?? this.deps.evolverVersion ?? '0.0.0';
        const originalTelemetry = this.deps.selfUpdate.onTelemetry;
        const originalCleanupWarning = this.deps.selfUpdate.onCleanupWarning;
        const selfUpdateDeps = {
            ...this.deps.selfUpdate,
            currentVersion,
            onTelemetry: (result) => {
                reportSelfUpdateLastUpdate(this.store, directive, result, {
                    fromVersion: currentVersion,
                    now: this.now(),
                });
                originalTelemetry?.(result);
            },
            onCleanupWarning: (warning, result) => {
                try {
                    this.store.setState('self_update:last_cleanup_warning', safeDaemonMessage(`self_update_cleanup_warning:${warning}`, MAX_PROXY_TICK_ERROR_LENGTH));
                }
                catch {
                    // The returned result still carries cleanupWarning when operator state is unavailable.
                }
                originalCleanupWarning?.(warning, result);
            },
        };
        return executeForceUpdate(directive, selfUpdateDeps);
    }
    triggerForceUpdateFromHeartbeat(directive, source) {
        if (!this.deps.selfUpdate)
            return;
        const now = this.now();
        const cooldownMs = forceUpdateRetryCooldownMs(process.env);
        const key = forceUpdateDirectiveKey(directive);
        if (this.forceUpdateTriggerInFlight) {
            if (key !== this.forceUpdateLastTriggeredKey)
                this.pendingForceUpdateDirective = { directive, source };
            return;
        }
        if (this.scheduledForceUpdateKey) {
            if (source === 'heartbeat_426') {
                if (this.forceUpdateTimer)
                    clearTimeout(this.forceUpdateTimer);
                this.forceUpdateTimer = undefined;
                this.scheduledForceUpdateKey = undefined;
            }
            else {
                if (key !== this.scheduledForceUpdateKey)
                    this.pendingForceUpdateDirective = { directive, source };
                return;
            }
        }
        if (source !== 'heartbeat_426'
            && this.forceUpdateLastTriggeredAt !== undefined
            && this.forceUpdateLastTriggeredKey === key
            && now - this.forceUpdateLastTriggeredAt < cooldownMs)
            return;
        const delayMs = source === 'heartbeat_200' ? forceUpdateScheduleDelayMs(directive, this.random) : 0;
        if (delayMs > 0) {
            this.forceUpdateLastTriggeredAt = now;
            this.forceUpdateLastTriggeredKey = key;
            this.scheduledForceUpdateKey = key;
            this.reportPendingForceUpdate(directive);
            this.forceUpdateTimer = setTimeout(() => {
                this.forceUpdateTimer = undefined;
                this.scheduledForceUpdateKey = undefined;
                this.startForceUpdateExecution(directive, key);
            }, delayMs);
            return;
        }
        this.startForceUpdateExecution(directive, key);
    }
    startForceUpdateExecution(directive, key) {
        this.forceUpdateTriggerInFlight = true;
        this.forceUpdateLastTriggeredAt = this.now();
        this.forceUpdateLastTriggeredKey = key;
        void this.executeAndReportForceUpdate(directive).finally(() => {
            this.forceUpdateTriggerInFlight = false;
            const pending = this.pendingForceUpdateDirective;
            this.pendingForceUpdateDirective = undefined;
            if (pending)
                this.triggerForceUpdateFromHeartbeat(pending.directive, pending.source);
        });
    }
    reportPendingForceUpdate(directive) {
        if (!this.deps.selfUpdate)
            return;
        const currentVersion = this.deps.selfUpdate.currentVersion ?? this.deps.evolverVersion ?? '0.0.0';
        reportPendingSelfUpdateLastUpdate(this.store, directive, {
            fromVersion: currentVersion,
            now: this.now(),
        });
    }
    stateNumber(key) {
        const raw = this.store.getState(key);
        if (!raw)
            return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    async handleProxyRoute(ctx) {
        const expectedHeader = singleHeader(ctx.req.headers['x-evomap-expected-hub-mode']);
        if (hubModeMismatch(expectedHeader, this.deps.hubMode)) {
            ctx.json(409, { error: 'proxy_hub_mode_mismatch' });
            return true;
        }
        const handledAtp = await this.handleAtpRoute(ctx);
        if (handledAtp)
            return true;
        if (ctx.route === 'GET /proxy/status') {
            ctx.json(200, {
                running: true,
                status: 'running',
                proxy_protocol_version: PROXY_PROTOCOL_VERSION,
                schema_version: PROXY_STATUS_SCHEMA_VERSION,
                hub_mode: this.deps.hubMode ?? 'public',
                runtime_namespace: this.deps.runtimeNamespace ?? 'default',
                node_id: this.lifecycle.nodeId ?? null,
                outbound_pending: this.store.countPending('proxy', this.deps.runtimeNamespace),
                inbound_pending: this.store.countPending('agent', this.deps.runtimeNamespace) + this.store.countPending('core', this.deps.runtimeNamespace),
                last_sync_at: this.store.getState('sync:last_sync_at') ?? null,
                last_sync_error: this.store.getState('sync:last_error') || null,
                hub_auth_status: this.store.getState('hub:auth_status') || null,
                reauth_backoff_until: this.stateNumber('lifecycle:reauth_until'),
                hello_rate_limit_until: this.stateNumber('lifecycle:hello_rl_until'),
                publish_recall_verify: this.publishRecallVerifier.status(),
            });
            return true;
        }
        if (ctx.route === 'POST /mailbox/poll') {
            const body = asRecord(await ctx.readJson());
            const limit = boundedRequestLimit(body['limit'], 10, 50);
            if (limit === undefined) {
                ctx.json(400, { error: 'invalid_limit' });
                return true;
            }
            const channel = typeof body['channel'] === 'string' ? body['channel'] : undefined;
            const type = typeof body['type'] === 'string' && body['type'] ? body['type'] : undefined;
            const runtimeNamespace = legacyMailboxRuntimeNamespace(channel, this.deps.runtimeNamespace ?? 'default');
            const messages = runtimeNamespace === undefined
                ? []
                : this.store.list({
                    status: 'pending',
                    direction: mailboxDirection(body['direction']) ?? 'inbound',
                    runtimeNamespace,
                    ...(type ? { type } : {}),
                    limit,
                }).map(mailbox.legacyMailboxMessage);
            ctx.json(200, { messages, count: messages.length });
            return true;
        }
        if (await this.collaborationFacade.handle(ctx))
            return true;
        if (ctx.route === 'POST /asset/search') {
            const body = (await ctx.readJson());
            if (hubModeMismatch(body.expected_hub_mode, this.deps.hubMode)) {
                ctx.json(409, { error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const limit = boundedRequestLimit(body.limit, 5, 25);
            if (limit === undefined) {
                ctx.json(400, { error: 'invalid_limit' });
                return true;
            }
            const rawSignals = Array.isArray(body.signals) ? body.signals : body.signalsAny;
            const signalsAny = Array.isArray(rawSignals) ? rawSignals.filter((s) => typeof s === 'string') : undefined;
            const kind = assetKind(body.kind);
            const query = {
                ...(signalsAny && signalsAny.length > 0 ? { signalsAny } : {}),
                ...(typeof body.text === 'string' ? { text: body.text } : {}),
                ...(kind ? { kind } : {}),
                ...(typeof body.category === 'string' ? { category: body.category } : {}),
                ...(typeof body.gene === 'string' ? { gene: body.gene } : {}),
                limit,
            };
            if (kind === 'AntiGene' && !this.assetStore) {
                ctx.json(200, { results: [], assets: [], query: body });
                return true;
            }
            const results = await this.searchAssets(query);
            ctx.json(200, { results, assets: results, query: body });
            return true;
        }
        if (ctx.route === 'POST /recipe/search') {
            const body = (await ctx.readJson());
            if (hubModeMismatch(body.expected_hub_mode, this.deps.hubMode)) {
                ctx.json(409, { error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const recipes = this.hub.recipes;
            if (!recipes) {
                ctx.json(501, { error: 'recipe_unsupported' });
                return true;
            }
            const limit = boundedRequestLimit(body.limit, 10, 50);
            if (limit === undefined) {
                ctx.json(400, { error: 'invalid_limit' });
                return true;
            }
            const q = [body.q, body.query, body.text].find((value) => typeof value === 'string' && value.trim().length > 0);
            const cursor = typeof body.cursor === 'string' && body.cursor.trim() ? body.cursor.trim() : undefined;
            const sort = typeof body.sort === 'string' && body.sort.trim() ? body.sort.trim() : undefined;
            const request = {
                ...(q ? { q } : {}),
                limit,
                ...(cursor ? { cursor } : {}),
                ...(sort ? { sort } : {}),
            };
            const receipt = q ? await recipes.search(request) : await recipes.list(request);
            ctx.json(200, {
                recipes: receipt.recipes,
                ...(receipt.nextCursor ? { nextCursor: receipt.nextCursor } : {}),
                ...(receipt.hasMore !== undefined ? { hasMore: receipt.hasMore } : {}),
                query: body,
            });
            return true;
        }
        if (ctx.route === 'POST /recipe/express') {
            const body = asRecord(await ctx.readJson());
            if (hubModeMismatch(body['expected_hub_mode'], this.deps.hubMode)) {
                ctx.json(409, { error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const recipes = this.hub.recipes;
            if (!recipes) {
                ctx.json(501, { error: 'recipe_unsupported' });
                return true;
            }
            const recipeId = typeof body['recipe_id'] === 'string'
                ? body['recipe_id']
                : typeof body['recipeId'] === 'string'
                    ? body['recipeId']
                    : '';
            if (!recipeId.trim()) {
                ctx.json(400, { error: 'recipe_id_required' });
                return true;
            }
            const inputPayload = asRecord(body['input_payload']) ?? asRecord(body['inputPayload']) ?? {};
            const receipt = await recipes.express(recipeId.trim(), { inputPayload });
            ctx.json(200, receipt);
            return true;
        }
        if (ctx.route === 'POST /asset/fetch') {
            const body = (await ctx.readJson());
            if (hubModeMismatch(body.expected_hub_mode, this.deps.hubMode)) {
                ctx.json(409, { error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const ids = uniqueStrings([
                ...(Array.isArray(body.asset_ids) ? body.asset_ids : []),
                ...(typeof body.asset_id === 'string' ? [body.asset_id] : []),
            ]);
            const assets = [];
            const missing = [];
            for (const id of ids) {
                let got = null;
                if (this.assetStore) {
                    got = await this.assetStore.get(id);
                }
                if (!got && this.remoteAssetById) {
                    got = await this.remoteAssetById(id);
                }
                if (assetMatchesId(got, id)) {
                    assets.push(got);
                }
                else {
                    missing.push(id);
                }
            }
            ctx.json(200, { assets, missing, query: body });
            return true;
        }
        if (ctx.route === 'POST /asset/submit') {
            const body = asRecord(await ctx.readJson());
            if (hubModeMismatch(body['expected_hub_mode'], this.deps.hubMode)) {
                ctx.json(409, { stored: false, error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const bundle = normalizeAssetSubmitBundle(body);
            const legacyAssetId = typeof body['asset_id'] === 'string' && body['asset_id'].trim()
                ? body['asset_id'].trim()
                : undefined;
            if (!bundle && !legacyAssetId) {
                ctx.json(400, { error: 'assets or asset_id is required' });
                return true;
            }
            let outboundBundle = bundle;
            if (!outboundBundle && legacyAssetId) {
                if (!this.assetStore) {
                    ctx.json(503, { error: 'asset_store_unavailable' });
                    return true;
                }
                const resolved = await this.assetStore.get(legacyAssetId);
                if (!resolved) {
                    ctx.json(404, { error: 'asset_not_found', asset_id: legacyAssetId });
                    return true;
                }
                outboundBundle = [resolved];
            }
            if (outboundBundle && outboundBundle.length > MAX_ASSET_SUBMIT_ITEMS) {
                ctx.json(400, { error: `asset submit accepts at most ${MAX_ASSET_SUBMIT_ITEMS} items` });
                return true;
            }
            const requestedMode = ctx.url.searchParams.get('mode');
            const mode = requestedMode ?? (bundle ? 'sync' : 'async');
            if (mode !== 'sync' && mode !== 'async') {
                ctx.json(400, { error: 'mode must be sync or async' });
                return true;
            }
            if (mode === 'sync') {
                if (!bundle) {
                    ctx.json(400, { error: 'mode=sync requires a full asset bundle' });
                    return true;
                }
                await this.publishAssetSubmitSynchronously(ctx, outboundBundle, hubNs.recipeComposeRequested(body));
                return true;
            }
            const payload = {
                assets: outboundBundle,
                compose_recipe: hubNs.recipeComposeRequested(body),
                [OUTBOUND_HUB_MODE_FIELD]: this.currentHubMode(),
            };
            const requestId = typeof body['request_id'] === 'string' && ASYNC_ASSET_SUBMIT_REQUEST_ID.test(body['request_id'])
                ? body['request_id']
                : undefined;
            delete payload['request_id'];
            const runtimeNamespace = this.deps.runtimeNamespace ?? 'default';
            const stableId = requestId ? asyncAssetSubmitEnvelopeId(runtimeNamespace, requestId) : undefined;
            const env = mailbox.createEnvelope({
                ...(stableId ? { id: stableId, idempotencyKey: stableId } : {}),
                type: 'asset_submit',
                payload,
                runtimeNamespace,
                now: ctx.now,
            });
            const r = this.store.send(env);
            if (r.stored)
                this.notifyNewOutbound();
            ctx.json(202, { id: env.id, message_id: env.id, receiptId: r.receiptId, status: 'pending', stored: r.stored });
            return true;
        }
        if (ctx.route === 'POST /asset/validate') {
            // Pre-publish dry-run against the hub's quality + content-safety gate (nothing stored, no credits).
            // Same {assets:[…]} bundle shape as /asset/submit; the adapter wraps it in a GEP-A2A envelope.
            const body = (await ctx.readJson());
            if (hubModeMismatch(body.expected_hub_mode, this.deps.hubMode)) {
                ctx.json(409, { valid: false, error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const bundle = Array.isArray(body.assets)
                ? body.assets.filter((a) => Boolean(a && typeof a === 'object'))
                : (body.asset && typeof body.asset === 'object' && !Array.isArray(body.asset) ? [body.asset] : []);
            if (bundle.length === 0) {
                ctx.json(400, { valid: false, error: 'assets or asset is required' });
                return true;
            }
            const sanitized = hubNs.sanitizeBundle(bundle, { env: typeof process !== 'undefined' ? process.env : {} });
            if (sanitized.blocked) {
                ctx.json(200, { valid: false, reason: 'leak_blocked' });
                return true;
            }
            if (!this.validator) {
                ctx.json(200, { valid: false, reason: 'validate_not_configured' });
                return true;
            }
            try {
                ctx.json(200, await this.validator.validate(sanitized.bundle));
            }
            catch (e) {
                ctx.json(200, { valid: false, reason: errorMessage(e) });
            }
            return true;
        }
        if (ctx.route === 'POST /asset/reuse-result') {
            const body = await ctx.readJson();
            if (hubModeMismatch(asRecord(body)['expected_hub_mode'], this.deps.hubMode)) {
                ctx.json(409, { recorded: false, error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const parsed = parseReuseResultReport(body);
            if ('error' in parsed) {
                ctx.json(400, { recorded: false, error: parsed.error });
                return true;
            }
            if (!this.reuseResultReporter) {
                ctx.json(200, { recorded: false, reason: 'reuse_result_not_configured' });
                return true;
            }
            try {
                ctx.json(200, await this.reuseResultReporter.recordReuseResult(parsed.report));
            }
            catch (e) {
                ctx.json(200, { recorded: false, reason: safeDaemonErrorMessage(e, MAX_PROXY_TICK_ERROR_LENGTH) });
            }
            return true;
        }
        if (ctx.route === 'POST /conversation/distill') {
            const body = (await ctx.readJson());
            if (hubModeMismatch(body.expected_hub_mode, this.deps.hubMode)) {
                ctx.json(409, { error: 'proxy_hub_mode_mismatch' });
                return true;
            }
            const distill = await hubNs.distillConversation(body, { persist: body.persist === true, store: this.assetStore });
            if (!distill.ok) {
                ctx.json(200, { ...distill, queued: false, submission: null });
                return true;
            }
            let submission = null;
            if (body['publish'] === true) {
                const env = mailbox.createEnvelope({
                    type: 'asset_submit',
                    payload: {
                        source: 'conversation_distillation',
                        distill_id: distill.distill_id,
                        assets: [distill.gene, distill.capsule],
                        compose_recipe: body['publish_recipe'] !== false,
                        title: typeof body.title === 'string' ? body.title : undefined,
                        description: typeof body.summary === 'string' ? body.summary : undefined,
                        [OUTBOUND_HUB_MODE_FIELD]: this.currentHubMode(),
                    },
                    runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
                    now: ctx.now,
                });
                const r = this.store.send(env);
                if (r.stored)
                    this.notifyNewOutbound();
                submission = { id: env.id, message_id: env.id, receiptId: r.receiptId, status: 'pending', stored: r.stored };
            }
            ctx.json(200, { ...distill, queued: submission !== null, submission });
            return true;
        }
        if (ctx.route === 'POST /agent/search') {
            const body = asRecord(await ctx.readJson());
            const directory = this.deps.hub.agentDirectory ?? hubNs.unsupportedAgentDirectoryCapability();
            const parsed = parseAgentSearchRequest(body);
            if (!parsed.ok) {
                respondAgentDirectory(ctx, parsed);
                return true;
            }
            const result = await directory.search(parsed.value);
            respondAgentDirectory(ctx, result);
            return true;
        }
        if (ctx.route === 'POST /agent/profile') {
            const body = asRecord(await ctx.readJson());
            const directory = this.deps.hub.agentDirectory ?? hubNs.unsupportedAgentDirectoryCapability();
            let agentId;
            let timeoutMs;
            try {
                agentId = hubNs.normalizeAgentId(typeof body['agent_id'] === 'string' ? body['agent_id'] : '');
                timeoutMs = hubNs.normalizeAgentDirectoryTimeout(typeof body['timeout_ms'] === 'number' ? body['timeout_ms'] : undefined);
            }
            catch (error) {
                respondAgentDirectory(ctx, invalidAgentDirectoryRequest(error));
                return true;
            }
            const result = await directory.getProfile(agentId, { timeoutMs });
            respondAgentDirectory(ctx, result);
            return true;
        }
        if (ctx.route === 'POST /agent/discover') {
            const body = asRecord(await ctx.readJson());
            const directory = this.deps.hub.agentDirectory ?? hubNs.unsupportedAgentDirectoryCapability();
            let request;
            try {
                request = hubNs.normalizeAgentTaskDiscoveryRequest({
                    title: typeof body['title'] === 'string' ? body['title'] : '',
                    ...(typeof body['description'] === 'string' ? { description: body['description'] } : {}),
                    ...(Array.isArray(body['signals']) ? { signals: body['signals'] } : {}),
                    ...(typeof body['availability'] === 'string' ? { availability: body['availability'] } : {}),
                    ...(typeof body['sort'] === 'string' ? { sort: body['sort'] } : {}),
                    ...(typeof body['order'] === 'string' ? { order: body['order'] } : {}),
                    ...(typeof body['cursor'] === 'string' ? { cursor: body['cursor'] } : {}),
                    ...(typeof body['limit'] === 'number' ? { limit: body['limit'] } : {}),
                    ...(typeof body['timeout_ms'] === 'number' ? { timeoutMs: body['timeout_ms'] } : {}),
                });
            }
            catch (error) {
                respondAgentDirectory(ctx, invalidAgentDirectoryRequest(error));
                return true;
            }
            const result = await directory.discoverForTask(request);
            respondAgentDirectory(ctx, result);
            return true;
        }
    }
    async searchAssets(query) {
        const limit = Math.max(1, Math.min(Number(query.limit ?? 5), 25));
        const local = this.assetStore ? await this.assetStore.search(query) : [];
        if (query.kind === 'AntiGene')
            return local.slice(0, limit);
        const localSafe = local.filter((asset) => asset.type !== 'AntiGene');
        let remote;
        try {
            remote = await this.searchRemoteAssets(query, limit);
        }
        catch (error) {
            if (localSafe.length === 0)
                throw error;
            remote = [];
        }
        if (localSafe.length === 0)
            return remote.slice(0, limit);
        if (remote.length === 0)
            return localSafe.slice(0, limit);
        const seen = new Set();
        const out = [];
        // Keep proxy-backed PHub reuse visible even when the local asset cache has hits.
        for (const asset of [...remote, ...localSafe]) {
            if (seen.has(asset.asset_id))
                continue;
            seen.add(asset.asset_id);
            out.push(asset);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    async searchRemoteAssets(query, limit) {
        const key = assetSearchCacheKey(this.deps.runtimeNamespace, query, limit);
        const now = this.now();
        const cached = this.assetSearchCache.get(key);
        if (cached && cached.expiresAt > now)
            return cached.value;
        if (now < this.assetSearchCooldownUntil) {
            if (cached && cached.staleUntil > now)
                return cached.value;
            if (cached)
                this.assetSearchCache.delete(key);
            throw new HubClientError(429, { error: 'rate_limited', source: 'asset_search_client_cooldown' }, this.assetSearchCooldownUntil - now);
        }
        const inflight = this.assetSearchInflight.get(key);
        if (inflight)
            return inflight;
        const request = (async () => {
            try {
                const value = (await this.deps.hub.search(query))
                    .filter((asset) => asset.type !== 'AntiGene')
                    .slice(0, limit);
                this.cacheRemoteAssetSearch(key, value, this.now());
                return value;
            }
            catch (error) {
                const retryAfterMs = assetSearchRetryAfterMs(error, this.assetSearchCacheTtlMs);
                if (retryAfterMs !== undefined) {
                    const rateLimitedAt = this.now();
                    this.assetSearchCooldownUntil = Math.max(this.assetSearchCooldownUntil, rateLimitedAt + retryAfterMs);
                    const stale = this.assetSearchCache.get(key);
                    if (stale && stale.staleUntil > rateLimitedAt)
                        return stale.value;
                }
                throw error;
            }
        })();
        this.assetSearchInflight.set(key, request);
        const clearInflight = () => {
            if (this.assetSearchInflight.get(key) === request)
                this.assetSearchInflight.delete(key);
        };
        void request.then(clearInflight, clearInflight);
        return request;
    }
    cacheRemoteAssetSearch(key, value, now) {
        if (this.assetSearchCache.size >= this.assetSearchCacheMax && !this.assetSearchCache.has(key)) {
            const oldest = this.assetSearchCache.keys().next().value;
            if (oldest !== undefined)
                this.assetSearchCache.delete(oldest);
        }
        this.assetSearchCache.delete(key);
        this.assetSearchCache.set(key, {
            value,
            expiresAt: now + this.assetSearchCacheTtlMs,
            staleUntil: now + this.assetSearchCacheTtlMs + this.assetSearchStaleGraceMs,
        });
    }
    async publishAssetSubmitSynchronously(ctx, items, composeRecipe = true) {
        const classified = classifySynchronousAssetSubmit(items);
        if (!classified.ok) {
            ctx.json(422, { error: classified.error, code: 'invalid_asset_submit' });
            return;
        }
        if (classified.kind === 'wire') {
            const envelope = this.createSynchronousAssetSubmitEnvelope(classified.bundle, undefined, ctx.now, composeRecipe);
            this.writeSynchronousAssetSubmitOutcome(ctx, await this.publishSynchronousBundle(envelope));
            return;
        }
        const results = [];
        for (const item of classified.items) {
            const converted = await convertLegacyLooseAsset(item);
            if (!converted.ok) {
                results.push({ ok: false, error: converted.error, statusCode: 422 });
                continue;
            }
            const envelope = this.createSynchronousAssetSubmitEnvelope(converted.bundle, 'v1_loose_asset_compat', ctx.now, composeRecipe);
            const outcome = await this.publishSynchronousBundle(envelope);
            if (outcome.kind === 'accepted') {
                const receipt = outcome.receipt;
                const publishedIds = submittedAssetIds(receipt, converted.bundle);
                results.push({
                    ok: true,
                    gene_asset_id: publishedIds[0],
                    capsule_asset_id: publishedIds[1],
                    response: receipt,
                });
            }
            else if (outcome.kind === 'failed') {
                results.push({
                    ok: false,
                    error: String(outcome.body['error']),
                    statusCode: outcome.statusCode,
                    ...(typeof outcome.body['reason'] === 'string' ? { reason: outcome.body['reason'] } : {}),
                });
            }
            else {
                results.push({
                    ok: false,
                    error: 'publish_pending',
                    statusCode: 202,
                    reason: `durable recovery pending (${outcome.messageId})`,
                });
            }
        }
        ctx.json(200, {
            published: results.filter((result) => result.ok).length,
            total: results.length,
            results,
        });
    }
    createSynchronousAssetSubmitEnvelope(bundle, source, now, composeRecipe = true) {
        const canonicalBundle = [...bundle].sort(compareSynchronousAssetSubmitAssets);
        const runtimeNamespace = this.deps.runtimeNamespace ?? 'default';
        const idempotencyKey = synchronousAssetSubmitKey(this.synchronousAssetSubmitScope, runtimeNamespace, this.currentHubMode(), canonicalBundle);
        return mailbox.createEnvelope({
            id: `compat:asset_submit:${idempotencyKey.slice(SYNC_ASSET_SUBMIT_PREFIX.length)}`,
            type: 'asset_submit',
            payload: {
                ...(source ? { source } : {}),
                assets: canonicalBundle,
                compose_recipe: composeRecipe,
                [OUTBOUND_HUB_MODE_FIELD]: this.currentHubMode(),
            },
            idempotencyKey,
            runtimeNamespace,
            now,
        });
    }
    composeRecipeAfterAcceptedSubmit(envelope) {
        if (envelope.type !== 'asset_submit')
            return;
        const key = envelope.idempotencyKey || envelope.id;
        if (this.recipeComposeStarted.has(key))
            return;
        this.recipeComposeStarted.add(key);
        void hubNs.composeRecipeAfterAssetPublish(this.hub, asRecord(envelope.payload)).catch(() => { });
    }
    currentHubMode() {
        return this.deps.hubMode ?? 'public';
    }
    handleHubModeBoundOutbound(envelope) {
        if (envelope.type !== 'asset_submit')
            return this.handleSynchronousProxyOutbound(envelope);
        const payload = asRecord(envelope.payload);
        const rawQueuedMode = payload[OUTBOUND_HUB_MODE_FIELD];
        const queuedMode = rawQueuedMode === undefined ? 'public' : String(rawQueuedMode);
        const currentMode = this.currentHubMode();
        if ((queuedMode !== 'public' && queuedMode !== 'private') || queuedMode !== currentMode) {
            throw new OutboundHubModeMismatchError(queuedMode, currentMode);
        }
        const outboundPayload = { ...payload };
        delete outboundPayload[OUTBOUND_HUB_MODE_FIELD];
        return this.handleSynchronousProxyOutbound({ ...envelope, payload: outboundPayload });
    }
    async publishSynchronousBundle(envelope) {
        const cached = this.readSynchronousAssetSubmitOutcome(envelope);
        if (cached)
            return cached;
        const inflight = this.synchronousAssetSubmitInflight.get(envelope.idempotencyKey);
        if (inflight)
            return this.waitForSynchronousAssetSubmit(inflight, envelope.id);
        const { stored } = this.store.send(envelope);
        const cachedAfterInsert = this.readSynchronousAssetSubmitOutcome(envelope);
        if (cachedAfterInsert)
            return cachedAfterInsert;
        if (!stored) {
            const existingInflight = this.synchronousAssetSubmitInflight.get(envelope.idempotencyKey);
            return existingInflight
                ? this.waitForSynchronousAssetSubmit(existingInflight, envelope.id)
                : { kind: 'pending', messageId: envelope.id };
        }
        this.store.defer(envelope.id, 'synchronous asset submit attempt in progress', this.now(), SYNC_ASSET_SUBMIT_DIRECT_RETRY_GRACE_MS);
        this.notifyNewOutbound();
        const request = this.executeSynchronousAssetSubmit(envelope);
        this.synchronousAssetSubmitInflight.set(envelope.idempotencyKey, request);
        void request.finally(() => {
            if (this.synchronousAssetSubmitInflight.get(envelope.idempotencyKey) === request) {
                this.synchronousAssetSubmitInflight.delete(envelope.idempotencyKey);
            }
        }).catch(() => { });
        return this.waitForSynchronousAssetSubmit(request, envelope.id);
    }
    waitForSynchronousAssetSubmit(request, messageId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                resolve({ kind: 'pending', messageId });
            }, this.assetSubmitResponseTimeoutMs);
            timeout.unref?.();
            void request.then((outcome) => {
                clearTimeout(timeout);
                resolve(outcome);
            }, (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    async executeSynchronousAssetSubmit(envelope) {
        try {
            const receipt = await this.proxyHandler(envelope);
            const firstObservation = this.cacheSynchronousAssetSubmitSuccess(envelope, receipt);
            if (firstObservation) {
                try {
                    this.publishRecallVerifier.observeAcceptedPublish(envelope, receipt);
                }
                catch { /* best-effort */ }
                this.composeRecipeAfterAcceptedSubmit(envelope);
            }
            if (this.store.getById(envelope.id)?.status !== 'in_flight')
                this.store.complete(envelope.id, this.now());
            return { kind: 'accepted', receipt };
        }
        catch (error) {
            const current = this.store.getById(envelope.id);
            const currentStatus = this.store.getStatus(envelope.id);
            const cached = this.readSynchronousAssetSubmitOutcome(envelope);
            // Once acceptance is durable, later publish or local-finalization errors cannot turn the external outcome
            // into a failure. A late acceptance may also need to recover an intent that a racing rejection put in DLQ.
            if (cached?.kind === 'accepted') {
                if (currentStatus?.dlq) {
                    try {
                        this.store.replayDlq(envelope.id, this.now());
                        this.notifyNewOutbound();
                    }
                    catch (recoveryError) {
                        this.recordTickError('outbound', recoveryError);
                    }
                }
                return cached;
            }
            const failure = mapSynchronousPublishFailure(error);
            const outcome = { kind: 'failed', ...failure, error };
            if (this.shadowMode)
                return outcome;
            if (current?.status !== 'in_flight') {
                const message = safeDaemonMessage(JSON.stringify(failure.body), MAX_PROXY_TICK_ERROR_LENGTH);
                const outcomeKey = synchronousAssetSubmitOutcomeKey(envelope.idempotencyKey);
                const acceptedKey = synchronousAssetSubmitAcceptanceKey(envelope.idempotencyKey);
                const transitionNow = this.now();
                const terminal = isTerminalSynchronousPublishFailure(error);
                const transitioned = terminal
                    ? this.store.failAndMarkProcessedUnlessProcessed(envelope.id, [acceptedKey], outcomeKey, { kind: 'failed', ...failure }, message, transitionNow, 1)
                    : isRetryableSynchronousPublishFailure(error)
                        ? this.store.deferUnlessProcessed(envelope.id, acceptedKey, message, transitionNow, synchronousPublishRetryAfterMs(error, failure))
                        : this.store.failUnlessProcessed(envelope.id, acceptedKey, message, transitionNow);
                if (!transitioned) {
                    const persisted = this.readSynchronousAssetSubmitOutcome(envelope);
                    if (persisted)
                        return persisted;
                }
                if (terminal) {
                    const persisted = this.readSynchronousAssetSubmitOutcome(envelope);
                    if (persisted?.kind === 'accepted')
                        return persisted;
                }
                this.notifyNewOutbound();
            }
            return outcome;
        }
    }
    async handleSynchronousProxyOutbound(envelope) {
        if (!isSynchronousAssetSubmitEnvelope(envelope))
            return this.proxyHandler(envelope);
        const cached = this.readSynchronousAssetSubmitOutcome(envelope);
        if (cached?.kind === 'accepted')
            return cached.receipt;
        if (cached?.kind === 'failed')
            throw cachedSynchronousAssetSubmitFailure(cached);
        const inflight = this.synchronousAssetSubmitInflight.get(envelope.idempotencyKey);
        if (inflight) {
            const outcome = await this.waitForSynchronousAssetSubmit(inflight, envelope.id);
            if (outcome.kind === 'accepted')
                return outcome.receipt;
            if (outcome.kind === 'failed')
                throw outcome.error ?? cachedSynchronousAssetSubmitFailure(outcome);
            if (this.synchronousAssetSubmitInflight.get(envelope.idempotencyKey) === inflight) {
                this.synchronousAssetSubmitInflight.delete(envelope.idempotencyKey);
            }
            throw new HubUnreachableError('synchronous asset submit is still pending');
        }
        try {
            const receipt = await this.proxyHandler(envelope);
            const firstObservation = this.cacheSynchronousAssetSubmitSuccess(envelope, receipt);
            if (firstObservation) {
                try {
                    this.publishRecallVerifier.observeAcceptedPublish(envelope, receipt);
                }
                catch { /* best-effort */ }
                this.composeRecipeAfterAcceptedSubmit(envelope);
            }
            return receipt;
        }
        catch (error) {
            const cached = this.readSynchronousAssetSubmitOutcome(envelope);
            if (cached?.kind === 'accepted')
                return cached.receipt;
            if (isTerminalSynchronousPublishFailure(error))
                this.cacheSynchronousAssetSubmitTerminal(envelope, error);
            throw error;
        }
    }
    readSynchronousAssetSubmitOutcome(envelope) {
        if (this.shadowMode || !isSynchronousAssetSubmitEnvelope(envelope))
            return undefined;
        const outcomeKey = synchronousAssetSubmitOutcomeKey(envelope.idempotencyKey);
        const value = asRecord(this.store.getProcessed(outcomeKey));
        if (value['kind'] === 'accepted' && Object.prototype.hasOwnProperty.call(value, 'receipt')) {
            const receipt = asRecord(value['receipt']);
            if (receipt['bundleId'] === 'shadow-bundle'
                && typeof receipt['receiptId'] === 'string'
                && receipt['receiptId'].startsWith('shadow-')) {
                this.store.deleteProcessed([
                    outcomeKey,
                    synchronousAssetSubmitAcceptanceKey(envelope.idempotencyKey),
                ]);
                return undefined;
            }
            const backfilled = this.store.markProcessedIf(outcomeKey, synchronousAssetSubmitAcceptanceKey(envelope.idempotencyKey), { accepted: true }, this.now(), (current) => {
                const record = asRecord(current);
                return record['kind'] === 'accepted' && Object.prototype.hasOwnProperty.call(record, 'receipt');
            });
            if (!backfilled)
                return this.readSynchronousAssetSubmitOutcome(envelope);
            return { kind: 'accepted', receipt: value['receipt'] };
        }
        if (value['kind'] === 'failed') {
            const statusCode = positiveFiniteNumber(value['statusCode']);
            if (statusCode !== undefined && isRecordValue(value['body'])) {
                return { kind: 'failed', statusCode, body: value['body'] };
            }
        }
        return undefined;
    }
    cacheSynchronousAssetSubmitSuccess(envelope, receipt) {
        if (this.shadowMode || !isSynchronousAssetSubmitEnvelope(envelope))
            return undefined;
        const key = synchronousAssetSubmitOutcomeKey(envelope.idempotencyKey);
        const acceptedKey = synchronousAssetSubmitAcceptanceKey(envelope.idempotencyKey);
        const cached = this.readSynchronousAssetSubmitOutcome(envelope);
        if (cached?.kind === 'accepted')
            return false;
        // Acceptance is monotonic: a concurrent attempt may reject after another request reached the Hub, but a
        // real acceptance must supersede an earlier rejection so replay reflects the economic side effect.
        this.store.replaceProcessedWithMarker(key, { kind: 'accepted', receipt }, acceptedKey, { accepted: true }, this.now());
        return true;
    }
    cacheSynchronousAssetSubmitTerminal(envelope, error) {
        if (this.shadowMode || !isSynchronousAssetSubmitEnvelope(envelope))
            return;
        if (this.store.isProcessed(synchronousAssetSubmitAcceptanceKey(envelope.idempotencyKey)))
            return;
        if (this.readSynchronousAssetSubmitOutcome(envelope)?.kind === 'accepted')
            return;
        const failure = mapSynchronousPublishFailure(error);
        this.store.markProcessed(synchronousAssetSubmitOutcomeKey(envelope.idempotencyKey), {
            kind: 'failed',
            ...failure,
        }, this.now());
    }
    writeSynchronousAssetSubmitOutcome(ctx, outcome) {
        if (outcome.kind === 'accepted') {
            ctx.json(200, outcome.receipt);
        }
        else if (outcome.kind === 'failed') {
            ctx.json(outcome.statusCode, outcome.body);
        }
        else {
            ctx.json(202, { status: 'pending', message_id: outcome.messageId, durable: true });
        }
    }
    async handleAtpRoute(ctx) {
        if (!ctx.url.pathname.startsWith('/atp/'))
            return false;
        if (!this.atp) {
            ctx.json(503, { ok: false, error: 'atp_not_configured' });
            return true;
        }
        const body = ctx.req.method === 'GET' ? {} : asRecord(await ctx.readJson());
        if (ctx.route === 'POST /atp/order') {
            const consent = this.deps.atpOrderConsent;
            if (!consent) {
                ctx.json(403, { ok: false, status: 403, error: 'atp_spend_consent_required', message: 'ATP order refused: spend consent gate is not configured' });
                return true;
            }
            try {
                consent.assertAllowed();
            }
            catch (err) {
                ctx.json(403, {
                    ok: false,
                    status: 403,
                    error: 'atp_spend_consent_required',
                    message: err instanceof Error ? err.message : 'ATP order refused: auto-spend consent is disabled',
                });
                return true;
            }
            const capabilities = Array.isArray(body['capabilities']) ? body['capabilities'].filter((s) => typeof s === 'string') : [];
            this.writeAtpJson(ctx, await this.atp.placeOrder({
                capabilities,
                budget: numberBody(body, 'budget'),
                routingMode: stringBody(body, 'routingMode') ?? stringBody(body, 'routing_mode'),
                verifyMode: stringBody(body, 'verifyMode') ?? stringBody(body, 'verify_mode'),
                question: stringBody(body, 'question'),
                signals: Array.isArray(body['signals']) ? body['signals'].filter((s) => typeof s === 'string') : undefined,
                minReputation: numberBody(body, 'minReputation') ?? numberBody(body, 'min_reputation'),
            }));
            return true;
        }
        if (ctx.route === 'POST /atp/deliver') {
            const orderId = stringBody(body, 'orderId') ?? stringBody(body, 'order_id') ?? '';
            this.writeAtpJson(ctx, await this.atp.submitDelivery(orderId, body['proofPayload'] ?? body['proof_payload'] ?? {}));
            return true;
        }
        if (ctx.route === 'POST /atp/verify') {
            const orderId = stringBody(body, 'orderId') ?? stringBody(body, 'order_id') ?? '';
            this.writeAtpJson(ctx, await this.atp.verifyDelivery(orderId, stringBody(body, 'action') ?? 'confirm'));
            return true;
        }
        if (ctx.route === 'POST /atp/settle') {
            const orderId = stringBody(body, 'orderId') ?? stringBody(body, 'order_id') ?? '';
            this.writeAtpJson(ctx, await this.atp.settleOrder(orderId));
            return true;
        }
        if (ctx.route === 'POST /atp/dispute') {
            const orderId = stringBody(body, 'orderId') ?? stringBody(body, 'order_id') ?? '';
            this.writeAtpJson(ctx, await this.atp.disputeOrder(orderId, stringBody(body, 'reason') ?? ''));
            return true;
        }
        if (ctx.route === 'GET /atp/merchant/tier') {
            this.writeAtpJson(ctx, await this.atp.getMerchantTier(ctx.url.searchParams.get('node_id') ?? undefined));
            return true;
        }
        if (ctx.req.method === 'GET' && ctx.url.pathname.startsWith('/atp/order/')) {
            const orderId = decodeURIComponent(ctx.url.pathname.slice('/atp/order/'.length));
            this.writeAtpJson(ctx, await this.atp.getOrderStatus(orderId));
            return true;
        }
        if (ctx.route === 'GET /atp/proofs') {
            this.writeAtpJson(ctx, await this.atp.listProofs({
                nodeId: this.lifecycle.nodeId,
                role: ctx.url.searchParams.get('role') ?? undefined,
                status: ctx.url.searchParams.get('status') ?? undefined,
                limit: numberQuery(ctx.url, 'limit'),
            }));
            return true;
        }
        if (ctx.route === 'GET /atp/policy') {
            this.writeAtpJson(ctx, await this.atp.getAtpPolicy());
            return true;
        }
        ctx.json(404, { ok: false, error: 'unknown_atp_route' });
        return true;
    }
    writeAtpJson(ctx, body) {
        const rec = asRecord(body);
        const status = rec['ok'] === false && typeof rec['status'] === 'number' ? rec['status'] : 200;
        ctx.json(status, body);
    }
}
function isAssetByIdFetcher(value) {
    return Boolean(value && typeof value === 'object' && typeof value.fetchAssetById === 'function');
}
function isReuseResultReporter(value) {
    return Boolean(value && typeof value === 'object' && typeof value.recordReuseResult === 'function');
}
function isValidator(value) {
    return Boolean(value && typeof value === 'object' && typeof value.validate === 'function');
}
function assetMatchesId(asset, assetId) {
    if (!asset)
        return false;
    return assetId.startsWith('sha256:')
        ? asset.asset_id === assetId
        : asset.asset_id === assetId || asset['id'] === assetId;
}
function hubModeMismatch(expected, actual) {
    return expected !== undefined && expected !== (actual ?? 'public');
}
function singleHeader(value) {
    return Array.isArray(value) ? value[0] : value;
}
function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
function assetSearchCacheKey(runtimeNamespace, query, limit) {
    return JSON.stringify({
        runtimeNamespace: runtimeNamespace ?? 'default',
        kind: query.kind ?? null,
        signalsAny: uniqueStrings(query.signalsAny ?? []).sort(),
        category: query.category ?? null,
        gene: query.gene ?? null,
        text: query.text ?? null,
        limit,
    });
}
function assetSearchRetryAfterMs(error, fallbackMs) {
    const structured = asRecord(error);
    const details = asRecord(structured['details']);
    const structuredStatus = structured['statusCode']
        ?? structured['status']
        ?? details['statusCode']
        ?? details['status'];
    const status = error instanceof HubClientError
        ? error.status
        : (typeof structuredStatus === 'number'
            ? structuredStatus
            : (typeof structuredStatus === 'string' ? Number(structuredStatus) : NaN));
    if (status !== 429)
        return undefined;
    const body = asRecord(error instanceof HubClientError ? error.body : structured['body']);
    const retryAfterMs = positiveFiniteNumber(error instanceof HubClientError
        ? error.retryAfterMs
        : structured['retryAfterMs'] ?? details['retryAfterMs']) ?? positiveFiniteNumber(body['retry_after_ms'] ?? body['retryAfterMs']);
    const retryAfterSeconds = positiveFiniteNumber(body['retry_after'] ?? body['retryAfter']);
    return Math.floor(Math.min(retryAfterMs ?? (retryAfterSeconds !== undefined ? retryAfterSeconds * 1_000 : fallbackMs), MAX_TIMER_DELAY_MS));
}
function positiveFiniteNumber(value) {
    const parsed = typeof value === 'number'
        ? value
        : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : NaN);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function positiveIntegerOr(value, fallback) {
    const parsed = positiveFiniteNumber(value);
    return parsed === undefined ? fallback : Math.max(1, Math.floor(parsed));
}
function boundedRequestLimit(value, fallback, maximum) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        return undefined;
    return Math.min(value, maximum);
}
function legacyMailboxRuntimeNamespace(requestedChannel, runtimeNamespace) {
    if (requestedChannel === undefined || requestedChannel === 'evomap-hub' || requestedChannel === runtimeNamespace) {
        return runtimeNamespace;
    }
    return undefined;
}
function mailboxDirection(value) {
    return value === 'inbound' || value === 'outbound' || value === 'local' ? value : undefined;
}
function assetKind(value) {
    return value === 'Gene' || value === 'Capsule' || value === 'EvolutionEvent' || value === 'AntiGene' ? value : undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function normalizeAssetSubmitBundle(body) {
    if (Object.prototype.hasOwnProperty.call(body, 'assets')) {
        const assets = body['assets'];
        return Array.isArray(assets) && assets.length > 0 && assets.every(isNonEmptyAssetRecord)
            ? assets
            : null;
    }
    return isNonEmptyAssetRecord(body['asset']) ? [body['asset']] : null;
}
function isNonEmptyAssetRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}
function classifySynchronousAssetSubmit(items) {
    const wireLooking = items.map(isWireLookingAsset);
    const legacyLoose = items.map(isClearlyLegacyLooseAsset);
    if (wireLooking.every(Boolean)) {
        const bundle = [];
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if (!wire.validateWire(item).ok) {
                return { ok: false, error: `asset ${index}: malformed V2 wire asset` };
            }
            try {
                const normalized = assetstore.normalizeForPut(item);
                if (!normalized.verified) {
                    return { ok: false, error: `asset ${index}: a verified content-addressed asset_id is required` };
                }
                bundle.push(normalized.record);
            }
            catch {
                return { ok: false, error: `asset ${index}: asset_id does not match its content` };
            }
        }
        return { ok: true, kind: 'wire', bundle };
    }
    if (legacyLoose.every(Boolean))
        return { ok: true, kind: 'legacy', items };
    if (wireLooking.some(Boolean) && legacyLoose.some(Boolean)) {
        return { ok: false, error: 'wire assets and legacy loose assets cannot be mixed in one request' };
    }
    if (wireLooking.some(Boolean)) {
        return { ok: false, error: 'all wire-looking items must be valid content-addressed V2 assets' };
    }
    return { ok: false, error: 'unsupported asset input; provide V2 wire assets or legacy content/summary/strategy' };
}
function isWireLookingAsset(value) {
    return Object.prototype.hasOwnProperty.call(value, 'schema_version')
        || Object.prototype.hasOwnProperty.call(value, 'asset_id');
}
function isClearlyLegacyLooseAsset(value) {
    if (Object.prototype.hasOwnProperty.call(value, 'schema_version')
        || Object.prototype.hasOwnProperty.call(value, 'asset_id'))
        return false;
    return ['content', 'summary', 'strategy'].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}
async function convertLegacyLooseAsset(value) {
    const normalized = legacyLooseDistillInput(value);
    if (!normalized.ok)
        return normalized;
    try {
        const distilled = await hubNs.distillConversation(normalized.input, { persist: false });
        if (!distilled.ok) {
            return { ok: false, error: `legacy_distill_${safeIdentifier(distilled.reason)}` };
        }
        const gene = {
            ...distilled.gene,
            ...(normalized.constraints
                ? { constraints: mergeLegacyConstraints(distilled.gene['constraints'], normalized.constraints) }
                : {}),
            ...(normalized.category ? { category: normalized.category } : {}),
        };
        const bundle = [gene, distilled.capsule].map(deterministicDistilledAsset);
        if (!bundle.every((asset) => wire.validateWire(asset).ok)) {
            return { ok: false, error: 'legacy_distill_invalid_wire_output' };
        }
        return { ok: true, bundle };
    }
    catch {
        return { ok: false, error: 'legacy_distill_failed' };
    }
}
function legacyLooseDistillInput(value) {
    const content = strictOptionalString(value, 'content');
    const summary = strictOptionalString(value, 'summary');
    if (!content.ok || !summary.ok)
        return { ok: false, error: 'legacy content and summary must be strings' };
    const strategy = strictOptionalStringList(value, 'strategy', 10, 220);
    if (!strategy.ok)
        return { ok: false, error: 'legacy strategy must be an array of strings' };
    if (strategy.value && (strategy.value.length < 2 || strategy.value.some((step) => step.length < 15))) {
        return { ok: false, error: 'legacy strategy requires at least two steps of 15 characters each' };
    }
    const text = [content.value, summary.value].filter(Boolean).join('\n').trim();
    const suppliedSubstance = [text, ...(strategy.value ?? [])].join(' ').trim();
    if (!strategy.value && text.length < 50) {
        return { ok: false, error: 'legacy content or summary must contain at least 50 characters' };
    }
    if (suppliedSubstance.length < 50) {
        return { ok: false, error: 'legacy input does not contain enough substantive content' };
    }
    const signals = strictOptionalStringList(value, 'signals', 12, 64);
    const signalsMatch = strictOptionalStringList(value, 'signals_match', 12, 64);
    const validation = strictOptionalStringList(value, 'validation', 8, 180);
    const verification = strictOptionalStringList(value, 'verification', 8, 180);
    const artifacts = strictOptionalStringList(value, 'artifacts', 12, 240);
    if (!signals.ok || !signalsMatch.ok || !validation.ok || !verification.ok || !artifacts.ok) {
        return { ok: false, error: 'legacy list fields must contain strings only' };
    }
    const constraints = parseLegacyConstraints(value['constraints']);
    if (!constraints.ok)
        return constraints;
    const category = parseLegacyCategory(value['category']);
    if (!category.ok)
        return category;
    const derivedSummary = summary.value
        || content.value?.slice(0, 300)
        || strategy.value?.join('; ').slice(0, 300)
        || '';
    const input = {
        summary: derivedSummary,
        transcript: content.value ?? derivedSummary,
        ...(strategy.value ? { strategy: strategy.value } : {}),
        ...((signals.value ?? signalsMatch.value) ? { signals: signals.value ?? signalsMatch.value } : {}),
        ...((validation.value ?? verification.value) ? { validation: validation.value ?? verification.value } : {}),
        ...(artifacts.value ? { artifacts: artifacts.value } : {}),
        ...strictForwardString(value, 'title'),
        ...strictForwardString(value, 'name'),
        ...strictForwardString(value, 'platform'),
        ...strictForwardString(value, 'model'),
        ...strictForwardString(value, 'thread_id'),
        ...(isRecordValue(value['execution']) ? { execution: value['execution'] } : {}),
        ...(isRecordValue(value['blast_radius']) ? { blast_radius: value['blast_radius'] } : {}),
        // Compatibility callers may not lower the V2 quality gate.
        min_score: 5,
        persist: false,
    };
    return {
        ok: true,
        input,
        ...(constraints.value ? { constraints: constraints.value } : {}),
        ...(category.value ? { category: category.value } : {}),
    };
}
function parseLegacyConstraints(value) {
    if (value === undefined)
        return { ok: true };
    if (!isRecordValue(value))
        return { ok: false, error: 'legacy constraints must be an object' };
    if (Object.keys(value).some((key) => key !== 'max_files' && key !== 'forbidden_paths')) {
        return { ok: false, error: 'legacy constraints contains unsupported fields' };
    }
    const maxFiles = value['max_files'];
    if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || Number(maxFiles) < 1 || Number(maxFiles) > 10_000)) {
        return { ok: false, error: 'legacy constraints.max_files must be an integer from 1 to 10000' };
    }
    const forbiddenPaths = value['forbidden_paths'];
    if (forbiddenPaths !== undefined && (!Array.isArray(forbiddenPaths)
        || forbiddenPaths.length > 50
        || forbiddenPaths.some((path) => typeof path !== 'string' || path.trim().length === 0 || path.trim().length > 200))) {
        return { ok: false, error: 'legacy constraints.forbidden_paths must be a bounded string array' };
    }
    const normalizedPaths = Array.isArray(forbiddenPaths)
        ? uniqueStrings(forbiddenPaths.map((path) => String(path).trim()))
        : undefined;
    return {
        ok: true,
        value: {
            ...(typeof maxFiles === 'number' ? { max_files: maxFiles } : {}),
            ...(normalizedPaths ? { forbidden_paths: normalizedPaths } : {}),
        },
    };
}
function mergeLegacyConstraints(base, legacy) {
    const current = isRecordValue(base) ? base : {};
    const currentMax = Number.isInteger(current['max_files']) && Number(current['max_files']) > 0
        ? Number(current['max_files'])
        : 20;
    const currentPaths = Array.isArray(current['forbidden_paths'])
        ? current['forbidden_paths'].filter((path) => typeof path === 'string')
        : [];
    return {
        max_files: Math.min(currentMax, legacy.max_files ?? currentMax),
        forbidden_paths: uniqueStrings([...currentPaths, ...(legacy.forbidden_paths ?? [])]),
    };
}
function parseLegacyCategory(value) {
    if (value === undefined)
        return { ok: true };
    if (value === 'repair' || value === 'optimize' || value === 'innovate' || value === 'explore') {
        return { ok: true, value };
    }
    return { ok: false, error: 'legacy category is invalid' };
}
function deterministicDistilledAsset(asset) {
    const draft = { ...asset, asset_id: '' };
    // `_source` is local distiller provenance and is not part of the current GEP Gene schema.
    // It also contains a wall-clock timestamp, so it must not influence compatibility asset ids.
    delete draft['_source'];
    return assetstore.normalizeForPut(draft).record;
}
function strictOptionalString(value, key) {
    if (!Object.prototype.hasOwnProperty.call(value, key))
        return { ok: true };
    const raw = value[key];
    if (typeof raw !== 'string')
        return { ok: false };
    const trimmed = raw.trim();
    return { ok: true, ...(trimmed ? { value: trimmed } : {}) };
}
function strictOptionalStringList(value, key, maxItems, maxLength) {
    if (!Object.prototype.hasOwnProperty.call(value, key))
        return { ok: true };
    const raw = value[key];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string'))
        return { ok: false };
    const normalized = raw.map((item) => item.trim()).filter(Boolean).slice(0, maxItems);
    if (normalized.some((item) => item.length > maxLength))
        return { ok: false };
    return { ok: true, ...(normalized.length > 0 ? { value: normalized } : {}) };
}
function strictForwardString(value, key) {
    const parsed = strictOptionalString(value, key);
    return parsed.ok && parsed.value ? { [key]: parsed.value } : {};
}
function isRecordValue(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function safeIdentifier(value) {
    return value.replace(/[^a-z0-9_]+/gi, '_').slice(0, 80) || 'rejected';
}
function synchronousAssetSubmitKey(scope, runtimeNamespace, hubMode, bundle) {
    const assetIds = bundle.map((asset) => asset.asset_id).sort();
    const digestInput = hubMode === 'private'
        ? [scope, runtimeNamespace, hubMode, assetIds]
        : [scope, runtimeNamespace, assetIds];
    const digest = createHash('sha256')
        .update(JSON.stringify(digestInput))
        .digest('hex');
    return `${SYNC_ASSET_SUBMIT_PREFIX}${digest}`;
}
function asyncAssetSubmitEnvelopeId(runtimeNamespace, requestId) {
    const digest = createHash('sha256')
        .update(JSON.stringify([runtimeNamespace, requestId]))
        .digest('hex');
    return `${ASYNC_ASSET_SUBMIT_PREFIX}${digest}`;
}
function compareSynchronousAssetSubmitAssets(left, right) {
    const typeOrder = SYNC_ASSET_SUBMIT_TYPE_RANK[left.type] - SYNC_ASSET_SUBMIT_TYPE_RANK[right.type];
    if (typeOrder !== 0)
        return typeOrder;
    if (left.asset_id < right.asset_id)
        return -1;
    if (left.asset_id > right.asset_id)
        return 1;
    return 0;
}
function synchronousAssetSubmitOutcomeKey(idempotencyKey) {
    return `${idempotencyKey}:outcome`;
}
function synchronousAssetSubmitAcceptanceKey(idempotencyKey) {
    return `${idempotencyKey}:accepted`;
}
function cachedSynchronousAssetSubmitFailure(outcome) {
    const retryAfterMs = positiveFiniteNumber(outcome.body['retry_after_ms']);
    return new hubNs.PublishRejectedError(typeof outcome.body['status'] === 'string'
        ? outcome.body['status']
        : String(outcome.body['error'] ?? 'rejected'), true, typeof outcome.body['reason'] === 'string' ? outcome.body['reason'] : undefined, retryAfterMs, false);
}
function isSynchronousAssetSubmitEnvelope(envelope) {
    return envelope.type === 'asset_submit'
        && envelope.idempotencyKey.startsWith(SYNC_ASSET_SUBMIT_PREFIX);
}
function isTerminalSynchronousPublishFailure(error) {
    return error instanceof hubNs.PublishRejectedError && error.terminal;
}
function isRetryableSynchronousPublishFailure(error) {
    if (error instanceof AuthError || errorName(error) === 'AuthError')
        return true;
    if (error instanceof HubUnreachableError || errorName(error) === 'HubUnreachableError')
        return true;
    if (error instanceof hubNs.PublishRejectedError) {
        return !error.terminal && (error.retryable === true || error.retryAfterMs !== undefined);
    }
    if (error instanceof HubClientError || errorName(error) === 'HubClientError') {
        const status = error instanceof HubClientError ? error.status : Number(asRecord(error)['status']);
        return status === 429 || (status >= 500 && status <= 599);
    }
    return false;
}
function synchronousPublishRetryAfterMs(error, failure) {
    const fromBody = positiveFiniteNumber(failure.body['retry_after_ms']);
    if (fromBody !== undefined)
        return Math.max(1_000, fromBody);
    if (error instanceof hubNs.PublishRejectedError && error.retryAfterMs !== undefined) {
        return Math.max(1_000, error.retryAfterMs);
    }
    if (error instanceof HubUnreachableError)
        return Math.max(1_000, error.retryAfterMs);
    if (error instanceof HubClientError && error.retryAfterMs !== undefined) {
        return Math.max(1_000, error.retryAfterMs);
    }
    return 60_000;
}
function submittedAssetIds(result, fallback) {
    const record = asRecord(result);
    for (const key of ['submittedAssetIds', 'assetIds']) {
        const value = record[key];
        if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
            return value;
    }
    return fallback.map((asset) => asset.asset_id);
}
function mapSynchronousPublishFailure(error) {
    if (error instanceof hubNs.PublishRejectedError) {
        const status = publishRejectionStatus(error.status);
        if (status === 'cooldown') {
            return {
                statusCode: 429,
                body: {
                    error: 'hub_rate_limited',
                    ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
                },
            };
        }
        if (status === 'credit_shortage') {
            return { statusCode: 402, body: { error: 'hub_payment_required' } };
        }
        return {
            statusCode: error.terminal ? 422 : 503,
            body: {
                error: 'publish_rejected',
                status,
                terminal: error.terminal,
                reason: status === 'leak_blocked'
                    ? 'sensitive data detected before publish'
                    : 'Hub did not accept the publish',
                ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
            },
        };
    }
    if (error instanceof AuthError || errorName(error) === 'AuthError') {
        return { statusCode: 502, body: { error: 'hub_auth_failed' } };
    }
    if (error instanceof HubUnreachableError || errorName(error) === 'HubUnreachableError') {
        const retryAfterMs = error instanceof HubUnreachableError ? error.retryAfterMs : positiveFiniteNumber(asRecord(error)['retryAfterMs']);
        return {
            statusCode: 503,
            body: { error: 'hub_unreachable', ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}) },
        };
    }
    if (error instanceof HubClientError || errorName(error) === 'HubClientError') {
        const status = error instanceof HubClientError ? error.status : Number(asRecord(error)['status']);
        if (status === 429) {
            const retryAfterMs = error instanceof HubClientError ? error.retryAfterMs : positiveFiniteNumber(asRecord(error)['retryAfterMs']);
            return {
                statusCode: 429,
                body: { error: 'hub_rate_limited', ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}) },
            };
        }
        if (status === 402)
            return { statusCode: 402, body: { error: 'hub_payment_required' } };
        return { statusCode: status >= 500 ? 503 : 502, body: { error: 'hub_publish_failed' } };
    }
    return { statusCode: 502, body: { error: 'hub_publish_failed' } };
}
function errorName(value) {
    return typeof asRecord(value)['name'] === 'string' ? String(asRecord(value)['name']) : undefined;
}
function publishRejectionStatus(value) {
    return value === 'quarantine'
        || value === 'leak_blocked'
        || value === 'cooldown'
        || value === 'credit_shortage'
        ? value
        : 'rejected';
}
function respondAgentDirectory(ctx, result) {
    if (result.ok) {
        ctx.json(200, result);
        return;
    }
    const status = {
        invalid_request: 400,
        permission_denied: 403,
        capability_unavailable: 501,
        invalid_response: 502,
        hub_unavailable: 503,
        timeout: 504,
    }[result.error.code];
    ctx.json(status, result);
}
function parseAgentSearchRequest(body) {
    try {
        return { ok: true, value: hubNs.normalizeAgentSearchRequest({
                ...(typeof body['query'] === 'string' ? { query: body['query'] } : {}),
                ...(Array.isArray(body['signals']) ? { signals: body['signals'] } : {}),
                ...(typeof body['availability'] === 'string' ? { availability: body['availability'] } : {}),
                ...(typeof body['sort'] === 'string' ? { sort: body['sort'] } : {}),
                ...(typeof body['order'] === 'string' ? { order: body['order'] } : {}),
                ...(typeof body['cursor'] === 'string' ? { cursor: body['cursor'] } : {}),
                ...(typeof body['limit'] === 'number' ? { limit: body['limit'] } : {}),
                ...(typeof body['timeout_ms'] === 'number' ? { timeoutMs: body['timeout_ms'] } : {}),
            }) };
    }
    catch (error) {
        return invalidAgentDirectoryRequest(error);
    }
}
function invalidAgentDirectoryRequest(error) {
    return {
        ok: false,
        error: {
            code: 'invalid_request',
            retryable: false,
            message: error instanceof Error ? error.message.slice(0, 120) : 'invalid_request',
        },
    };
}
function stringBody(body, key) {
    const v = body[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function numberBody(body, key) {
    const raw = body[key];
    const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
    return Number.isFinite(n) ? n : undefined;
}
function optionalNonNegativeNumberBody(body, keys, error) {
    let value;
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(body, key))
            continue;
        const raw = body[key];
        const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : NaN);
        if (!Number.isFinite(n) || n < 0)
            return { error };
        value ??= n;
    }
    return { value };
}
const REUSE_RESULT_OUTCOMES = new Set(['success', 'failed', 'mismatched', 'stale', 'unsafe']);
function parseReuseResultReport(value) {
    const body = asRecord(value);
    const assetId = stringBody(body, 'assetId') ?? stringBody(body, 'asset_id');
    if (!assetId)
        return { error: 'asset_id_required' };
    const outcome = stringBody(body, 'outcome');
    if (!isReuseResultOutcome(outcome))
        return { error: 'invalid_outcome' };
    const taskId = stringBody(body, 'taskId') ?? stringBody(body, 'task_id');
    const traceId = stringBody(body, 'traceId') ?? stringBody(body, 'trace_id');
    const tokensSavedParsed = optionalNonNegativeNumberBody(body, ['tokensSaved', 'tokens_saved'], 'invalid_tokens_saved');
    if ('error' in tokensSavedParsed)
        return { error: tokensSavedParsed.error };
    const timeSavedSecondsParsed = optionalNonNegativeNumberBody(body, ['timeSavedSeconds', 'time_saved_seconds'], 'invalid_time_saved_seconds');
    if ('error' in timeSavedSecondsParsed)
        return { error: timeSavedSecondsParsed.error };
    const reason = stringBody(body, 'reason');
    return {
        report: {
            assetId,
            outcome,
            ...(taskId ? { taskId } : {}),
            ...(traceId ? { traceId } : {}),
            ...(timeSavedSecondsParsed.value !== undefined ? { timeSavedSeconds: timeSavedSecondsParsed.value } : {}),
            ...(reason ? { reason: reason.slice(0, 1000) } : {}),
        },
    };
}
function isReuseResultOutcome(value) {
    return typeof value === 'string' && REUSE_RESULT_OUTCOMES.has(value);
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function safeDaemonMessage(message, maxLength) {
    try {
        return hubNs.redactString(message).slice(0, maxLength);
    }
    catch {
        return '[REDACTED]';
    }
}
function safeDaemonErrorMessage(err, maxLength) {
    return safeDaemonMessage(errorMessage(err), maxLength);
}
function isAuthLikeError(err) {
    const name = err?.name;
    return name === 'AuthError' || /\b(401|403|unauthorized|forbidden|auth)\b/i.test(errorMessage(err));
}
function emptyOutboundResult() {
    return { sent: 0, failed: 0, terminal: 0, deferred: 0 };
}
function emptyInboundResult() {
    return { received: 0, enqueued: 0, hasMore: false };
}
function uniqueTickPhases(phases) {
    return Array.from(new Set(phases));
}
function isFatalTickCandidate(outbound, inbound, failedPhases) {
    const failed = new Set(failedPhases);
    return failed.has('core')
        && failed.has('outbound')
        && failed.has('inbound')
        && !hasTickSyncProgress(outbound, inbound);
}
function hasTickSyncProgress(outbound, inbound) {
    return outbound.sent > 0
        || outbound.terminal > 0
        || inbound.received > 0
        || inbound.enqueued > 0
        || inbound.hasMore;
}
function safeHeartbeatTickErrorMessage(err) {
    return safeDaemonErrorMessage(err, MAX_HEARTBEAT_TICK_ERROR_LENGTH);
}
function numberQuery(url, key) {
    const raw = url.searchParams.get(key);
    if (raw === null)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}
function forceUpdateRetryCooldownMs(env) {
    const raw = env['EVOLVER_FORCE_UPDATE_RETRY_COOLDOWN_MS'];
    if (raw === undefined || raw.trim() === '')
        return 60_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 60_000;
}
function forceUpdateScheduleDelayMs(directive, random) {
    const staggerWindowMs = nonNegativeFiniteNumber(directive.stagger_window_ms);
    if (staggerWindowMs === undefined || staggerWindowMs <= 0)
        return 0;
    const deadlineMs = nonNegativeFiniteNumber(directive.deadline_ms);
    const ratio = safeRandomRatio(random);
    const sampledDelayMs = ratio * staggerWindowMs;
    const maxDelayMs = Math.min(staggerWindowMs, deadlineMs ?? staggerWindowMs, MAX_TIMER_DELAY_MS);
    return Math.max(0, Math.min(sampledDelayMs, maxDelayMs));
}
function nonNegativeFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function safeRandomRatio(random) {
    try {
        return clampedRandom(random());
    }
    catch {
        return 0;
    }
}
function clampedRandom(value) {
    if (typeof value !== 'number')
        return 0;
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(value, 1));
}
function forceUpdateDirectiveKey(directive) {
    const manifest = directive.manifest;
    const manifestVersion = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        ? manifest.version
        : undefined;
    return [
        directive.directive_id ?? '',
        directive.required_version ?? '',
        typeof manifestVersion === 'string' ? manifestVersion : '',
    ].join('\x1f');
}