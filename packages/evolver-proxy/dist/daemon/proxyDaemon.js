import { dirname, join } from 'node:path';
import { mailbox, hub as hubNs, shadow as shadow_, assetstore } from '@evomap/evolver-core';
import { SyncEngine, SYNC_INTERVALS } from '../sync/engine.js';
import { LifecycleManager } from '../lifecycle/manager.js';
import { executeForceUpdate } from '../selfUpdate/executor.js';
import { reportPendingSelfUpdateLastUpdate, reportSelfUpdateLastUpdate } from '../selfUpdate/lastUpdate.js';
import { backfillProxyTraceUploads } from '../llm/traceBackfill.js';
import { hubAuthFailureHint } from './selectHub.js';
export const DEFAULT_IPC_PORT = 19820;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_PROXY_TICK_ERROR_LENGTH = 2_000;
const MAX_HEARTBEAT_TICK_ERROR_LENGTH = 1_000;
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
    ipc;
    now;
    random;
    nextHeartbeatAt;
    heartbeatFailures = 0;
    heartbeatGeneration = 0;
    /** Resolver for an in-flight runner sleep(); set while sleeping, called to wake early on poke. */
    wakeRunnerResolve;
    /** A poke that arrived between ticks (no sleep in flight) parks the wake here so it is not lost. */
    wakeRunnerPending = false;
    started = false;
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
        if (!deps.store && !deps.storePath)
            throw new Error('ProxyDaemon: 需 store 或 storePath 之一');
        const shadow = deps.shadowMode === 'shadow';
        if (shadow && !deps.shadowSink)
            throw new Error('ProxyDaemon: shadow 模式需 shadowSink');
        // M8 shadow 装配: 在边界包 decorator, 下游 makeHubBindings/Dispatcher/SyncEngine/MailboxDaemon 零改.
        this.store = deps.store
            ?? (shadow ? new shadow_.ShadowMailboxStore({ path: deps.storePath }, deps.shadowSink, 'shadow') : new mailbox.MailboxStore({ path: deps.storePath }));
        const assetStoreDir = deps.assetStoreDir ?? (deps.storePath ? join(dirname(deps.storePath), 'assets') : undefined);
        this.assetStore = deps.assetStore ?? (assetStoreDir ? new assetstore.LocalJsonlProvider(assetStoreDir) : undefined);
        this.atp = deps.atp;
        const hubToUse = shadow ? shadow_.shadowHubCapability(deps.hub, deps.shadowSink, 'shadow') : deps.hub;
        const hubBindings = hubNs.makeHubBindings(hubToUse);
        const proxyHandler = hubBindings.asProxyHandler();
        const assetByIdSource = isAssetByIdFetcher(deps.hub) ? deps.hub : (isAssetByIdFetcher(hubToUse) ? hubToUse : undefined);
        this.remoteAssetById = assetByIdSource
            ? async (assetId) => {
                const fetched = await assetByIdSource.fetchAssetById(assetId);
                return assetMatchesId(fetched, assetId) ? fetched : null;
            }
            : undefined;
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
        this.sync = new SyncEngine({
            store: this.store, hub: hubToUse, proxyHandler, now: this.now,
            ...(deps.runtimeNamespace ? { runtimeNamespace: deps.runtimeNamespace } : {}),
            ...(deps.traceBackfill ? { onOutboundFlushed: () => { this.drainProxyTraceBackfill(); } } : {}),
        });
        this.lifecycle = new LifecycleManager({
            store: this.store, auth: hubToUse.auth, hello: deps.hello, heartbeat: deps.heartbeat, now: this.now,
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
                ...(this.deps.ipcHost ? { host: this.deps.ipcHost } : {}), now: this.now,
                onSend: (env, result) => {
                    if (result.stored && env.handler === 'proxy')
                        this.notifyNewOutbound();
                },
                ...(this.deps.onIpcAuthFailure ? { onAuthFailure: this.deps.onIpcAuthFailure } : {}),
                extraRoutes: [(ctx) => this.handleProxyRoute(ctx)],
            });
            const port = await this.ipc.listen(this.deps.ipcPort ?? DEFAULT_IPC_PORT);
            try {
                this.deps.onIpcListen?.(port);
            }
            catch { /* local discovery publishing must not block daemon startup */ }
            await this.lifecycle.doHello();
            this.drainProxyTraceBackfill();
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
            throw err;
        }
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
        return {
            outbound,
            inbound,
            ...(heartbeat ? { heartbeat } : {}),
            ...(errors.length > 0 ? { errors, failedPhases, fatalCandidate: isFatalTickCandidate(outbound, inbound, failedPhases) } : { failedPhases: [], fatalCandidate: false }),
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
            ...(this.lifecycle.nodeId ? { nodeId: this.lifecycle.nodeId } : {}),
            lastWriteAt: this.daemon.lastWriteAt(),
        };
    }
    async stop() {
        if (this.forceUpdateTimer) {
            clearTimeout(this.forceUpdateTimer);
            this.forceUpdateTimer = undefined;
            this.scheduledForceUpdateKey = undefined;
        }
        // Release a runner blocked on sleep() so shutdown doesn't wait out a long delay.
        this.wakeRunnerPending = false;
        if (this.wakeRunnerResolve)
            this.wakeRunnerResolve();
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
        this.started = false;
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
        const handledAtp = await this.handleAtpRoute(ctx);
        if (handledAtp)
            return true;
        if (ctx.route === 'GET /proxy/status') {
            ctx.json(200, {
                running: true,
                node_id: this.lifecycle.nodeId ?? null,
                outbound_pending: this.store.countPending('proxy', this.deps.runtimeNamespace),
                inbound_pending: this.store.countPending('agent', this.deps.runtimeNamespace) + this.store.countPending('core', this.deps.runtimeNamespace),
                last_sync_at: this.store.getState('sync:last_sync_at') ?? null,
                last_sync_error: this.store.getState('sync:last_error') || null,
                hub_auth_status: this.store.getState('hub:auth_status') || null,
                reauth_backoff_until: this.stateNumber('lifecycle:reauth_until'),
                hello_rate_limit_until: this.stateNumber('lifecycle:hello_rl_until'),
            });
            return true;
        }
        if (ctx.route === 'POST /mailbox/poll') {
            const body = (await ctx.readJson());
            const limit = Math.max(1, Math.min(Number(body.limit ?? 10), 50));
            const messages = this.store.list({ status: 'pending', limit: 500 })
                .filter((m) => (body.type ? m.type === body.type : true))
                .filter((m) => (body.direction ? m.direction === body.direction : true))
                .slice(0, limit);
            ctx.json(200, { messages, count: messages.length });
            return true;
        }
        if (ctx.route === 'POST /asset/search') {
            const body = (await ctx.readJson());
            const limit = Math.max(1, Math.min(Number(body.limit ?? 5), 25));
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
        if (ctx.route === 'POST /asset/fetch') {
            const body = (await ctx.readJson());
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
            const body = (await ctx.readJson());
            if (!body.assets && !body.asset_id) {
                ctx.json(400, { error: 'assets or asset_id is required' });
                return true;
            }
            const env = mailbox.createEnvelope({ type: 'asset_submit', payload: body, now: ctx.now });
            const r = this.store.send(env);
            if (r.stored)
                this.notifyNewOutbound();
            ctx.json(200, { id: env.id, message_id: env.id, receiptId: r.receiptId, status: 'pending', stored: r.stored });
            return true;
        }
        if (ctx.route === 'POST /asset/validate') {
            // Pre-publish dry-run against the hub's quality + content-safety gate (nothing stored, no credits).
            // Same {assets:[…]} bundle shape as /asset/submit; the adapter wraps it in a GEP-A2A envelope.
            const body = (await ctx.readJson());
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
            const parsed = parseReuseResultReport(await ctx.readJson());
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
            const distill = await hubNs.distillConversation(body, { persist: body.persist === true, store: this.assetStore });
            if (!distill.ok) {
                ctx.json(200, { ...distill, queued: false, submission: null });
                return true;
            }
            let submission = null;
            if (body['publish'] === true) {
                const env = mailbox.createEnvelope({
                    type: 'asset_submit',
                    payload: { source: 'conversation_distillation', distill_id: distill.distill_id, assets: [distill.gene, distill.capsule] },
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
    }
    async searchAssets(query) {
        const limit = Math.max(1, Math.min(Number(query.limit ?? 5), 25));
        const local = this.assetStore ? await this.assetStore.search(query) : [];
        if (query.kind === 'AntiGene')
            return local.slice(0, limit);
        const localSafe = local.filter((asset) => asset.type !== 'AntiGene');
        let remote;
        try {
            remote = (await this.deps.hub.search(query)).filter((asset) => asset.type !== 'AntiGene');
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
    return Boolean(asset && asset.asset_id === assetId);
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
function assetKind(value) {
    return value === 'Gene' || value === 'Capsule' || value === 'EvolutionEvent' || value === 'AntiGene' ? value : undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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