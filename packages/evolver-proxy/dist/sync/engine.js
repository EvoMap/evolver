import { mailbox, hub as hubNs } from '@evomap/evolver-core';
import { normalizeProxyTraceOutboundPayload } from '../llm/traceBackfill.js';
import { applyTraceCollectionConfig } from '../llm/traceControl.js';
import { hubAuthFailureHint } from '../daemon/selectHub.js';
/** 双线程轮询节奏(沿用 v1 常量). */
export const SYNC_INTERVALS = { outboundIdle: 5_000, outboundPending: 1_000, inboundActive: 10_000, inboundIdle: 60_000 };
export const MAX_BATCH = 50;
export const IDLE_THRESHOLD_MS = 5 * 60_000;
const MAX_SYNC_ERROR_LENGTH = 2_000;
const CURSOR_KEY = 'sync:inbound_cursor';
const BATCHABLE_PROXY_TYPES = new Set(['proxy_trace']);
const TRACE_CONFIG_TYPES = new Set(['trace_collection_config', 'proxy_trace_config']);
const STATE = {
    lastSyncAt: 'sync:last_sync_at',
    lastError: 'sync:last_error',
    authStatus: 'hub:auth_status',
};
function isTerminal(err) {
    return err instanceof hubNs.PublishRejectedError && err.terminal === true;
}
function isRetryableRejection(err) {
    return err instanceof hubNs.PublishRejectedError
        && err.terminal === false
        && (err.retryable === true || (typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs)));
}
function isHubUnreachable(err) {
    const e = err;
    return e?.name === 'HubUnreachableError' || e?.code === 'HUB_UNREACHABLE';
}
function retryAfterMs(err) {
    const retry = err?.retryAfterMs
        ?? err?.details?.retryAfterMs;
    return Math.max(1_000, typeof retry === 'number' && Number.isFinite(retry) ? retry : 60_000);
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function redactAndTruncate(message) {
    try {
        return hubNs.redactString(message).slice(0, MAX_SYNC_ERROR_LENGTH);
    }
    catch {
        return '[REDACTED]';
    }
}
function safeErrorMessage(err) {
    return redactAndTruncate(errorMessage(err));
}
function isAuthError(err) {
    // 与 proxyDaemon 的 isAuthLikeError 对齐: 先认 typed AuthError(name), 再退到 message 正则。
    // 否则带通用 message 的 typed AuthError(如 'credential rejected') 会漏判, 令 hub:auth_status telemetry 与 daemon 层不一致。
    return err?.name === 'AuthError'
        || /\b(401|403|unauthorized|forbidden|auth)\b/i.test(errorMessage(err));
}
function canBatchMailboxPush(e) {
    return BATCHABLE_PROXY_TYPES.has(e.type);
}
function isMailboxPushManyResult(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.outcomes));
}
function envelopeToAgentEvent(e) {
    const stableId = e.type === 'proxy_trace' && e.idempotencyKey ? e.idempotencyKey : e.id;
    return {
        id: stableId,
        type: e.type,
        payload: e.payload,
        priority: 'medium',
        createdAt: e.createdAt,
        ...(e.type === 'proxy_trace' && e.idempotencyKey ? { refId: e.idempotencyKey } : {}),
    };
}
/**
 * SyncEngine(M6-2): proxy↔hub 双向同步. 移植 v1 sync/{engine,outbound,inbound} 到 TS,
 * hub I/O 全走 HubCapability.mailbox(非裸 hubFetch). tick 方法纯逻辑(注入 now), 可对 FakeHubCapability 确定性测;
 * 定时器循环(start/stop)是薄包装, 由 M6-4 daemon 装配驱动.
 */
export class SyncEngine {
    deps;
    lastActivityAt;
    constructor(deps) {
        this.deps = deps;
        this.lastActivityAt = deps.now();
    }
    /** 出站: claim proxy 消息 → 经 proxyHandler 推 hub → complete; 终态(publish reject)直进 DLQ 不重试(money-safety). */
    async syncOutbound(limit = MAX_BATCH) {
        const now = this.deps.now();
        const batch = this.deps.store.claim('proxy', limit, this.deps.leaseMs ?? 30_000, now, this.deps.runtimeNamespace);
        let sent = 0, failed = 0, terminal = 0, deferred = 0, completedDuplicates = 0;
        let authFailed = false;
        let authErrorMessage; // first auth-failure detail, carried up so the daemon surfaces the real code (#314)
        for (let i = 0; i < batch.length; i += 1) {
            const e = batch[i];
            if (this.deps.hub.mailbox.pushMany && canBatchMailboxPush(e)) {
                const group = [];
                const groupByDedupKey = new Map();
                let j = i;
                for (; j < batch.length; j += 1) {
                    const current = batch[j];
                    if (!canBatchMailboxPush(current))
                        break;
                    const outboundDedupKey = this.outboundDedupKey(current);
                    if (outboundDedupKey && this.deps.store.isProcessed(outboundDedupKey)) {
                        this.deps.store.complete(current.id, this.deps.now());
                        completedDuplicates += 1;
                        continue;
                    }
                    const existing = outboundDedupKey ? groupByDedupKey.get(outboundDedupKey) : undefined;
                    if (existing) {
                        existing.duplicates.push(current);
                        continue;
                    }
                    const guard = this.normalizeOutbound(current);
                    if (!guard.ok) {
                        this.deps.store.fail(current.id, guard.reason, this.deps.now(), 1);
                        terminal += 1;
                        continue;
                    }
                    const entry = {
                        original: current,
                        envelope: guard.envelope,
                        event: envelopeToAgentEvent(guard.envelope),
                        dedupKey: outboundDedupKey,
                        duplicates: [],
                    };
                    group.push(entry);
                    if (outboundDedupKey)
                        groupByDedupKey.set(outboundDedupKey, entry);
                }
                if (group.length === 0) {
                    i = j - 1;
                    continue;
                }
                try {
                    const result = await this.deps.hub.mailbox.pushMany(group.map((entry) => entry.event));
                    if (isMailboxPushManyResult(result)) {
                        const byId = new Map(result.outcomes.map((outcome) => [outcome.id, outcome]));
                        let firstFailure;
                        let deferredFailure;
                        for (const pushed of group) {
                            const outcome = byId.get(pushed.event.id) ?? byId.get(pushed.original.id);
                            if (outcome?.status === 'failed') {
                                const msg = redactAndTruncate(outcome.reason ?? 'mailbox_push_rejected');
                                const authLike = isAuthError(msg);
                                firstFailure ??= msg;
                                const retryable = outcome.terminal !== true
                                    && (outcome.retryable === true || (typeof outcome.retryAfterMs === 'number' && Number.isFinite(outcome.retryAfterMs)));
                                if (authLike || retryable) {
                                    const nowAfterFailure = this.deps.now();
                                    const retry = Math.max(1_000, typeof outcome.retryAfterMs === 'number' && Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs : 60_000);
                                    deferredFailure ??= { msg, retryAfterMs: retry };
                                    if (authLike) {
                                        authFailed = true;
                                        authErrorMessage ??= msg;
                                    }
                                    this.deps.store.defer(pushed.original.id, msg, nowAfterFailure, retry);
                                    for (const duplicate of pushed.duplicates)
                                        this.deps.store.defer(duplicate.id, msg, nowAfterFailure, retry);
                                    deferred += 1 + pushed.duplicates.length;
                                }
                                else {
                                    const maxAttempts = outcome.terminal ? 1 : undefined;
                                    this.deps.store.fail(pushed.original.id, msg, this.deps.now(), maxAttempts);
                                    for (const duplicate of pushed.duplicates)
                                        this.deps.store.fail(duplicate.id, msg, this.deps.now(), maxAttempts);
                                    if (outcome.terminal)
                                        terminal += 1 + pushed.duplicates.length;
                                    else
                                        failed += 1 + pushed.duplicates.length;
                                }
                            }
                            else {
                                this.deps.store.complete(pushed.original.id, this.deps.now());
                                for (const duplicate of pushed.duplicates)
                                    this.deps.store.complete(duplicate.id, this.deps.now());
                                if (pushed.dedupKey)
                                    this.deps.store.markProcessed(pushed.dedupKey, { type: pushed.original.type }, this.deps.now());
                                sent += 1;
                                completedDuplicates += pushed.duplicates.length;
                            }
                        }
                        if (firstFailure)
                            this.markError(`outbound: ${firstFailure}`, isAuthError(firstFailure));
                        if (deferredFailure) {
                            const nowAfterFailure = this.deps.now();
                            for (const pending of batch.slice(j)) {
                                this.deps.store.defer(pending.id, deferredFailure.msg, nowAfterFailure, deferredFailure.retryAfterMs);
                                deferred += 1;
                            }
                            break;
                        }
                    }
                    else {
                        for (const pushed of group) {
                            this.deps.store.complete(pushed.original.id, this.deps.now());
                            for (const duplicate of pushed.duplicates)
                                this.deps.store.complete(duplicate.id, this.deps.now());
                            if (pushed.dedupKey)
                                this.deps.store.markProcessed(pushed.dedupKey, { type: pushed.original.type }, this.deps.now());
                            completedDuplicates += pushed.duplicates.length;
                        }
                        sent += group.length;
                    }
                    i = j - 1;
                    continue;
                }
                catch (err) {
                    const msg = safeErrorMessage(err);
                    const authLike = isAuthError(err);
                    this.markError(`outbound: ${msg}`, authLike);
                    if (authLike) {
                        const nowAfterFailure = this.deps.now();
                        const retry = retryAfterMs(err);
                        for (const pushed of group) {
                            this.deps.store.defer(pushed.original.id, msg, nowAfterFailure, retry);
                            for (const duplicate of pushed.duplicates)
                                this.deps.store.defer(duplicate.id, msg, nowAfterFailure, retry);
                            deferred += 1 + pushed.duplicates.length;
                        }
                        for (const pending of batch.slice(j)) {
                            this.deps.store.defer(pending.id, msg, nowAfterFailure, retry);
                            deferred += 1;
                        }
                        authFailed = true;
                        authErrorMessage ??= msg;
                        break;
                    }
                    else if (isTerminal(err)) {
                        for (const pushed of group) {
                            this.deps.store.fail(pushed.original.id, msg, this.deps.now(), 1);
                            for (const duplicate of pushed.duplicates)
                                this.deps.store.fail(duplicate.id, msg, this.deps.now(), 1);
                            terminal += 1 + pushed.duplicates.length;
                        }
                        i = j - 1;
                    }
                    else if (isRetryableRejection(err) || isHubUnreachable(err)) {
                        const nowAfterFailure = this.deps.now();
                        const retry = retryAfterMs(err);
                        for (const pushed of group) {
                            this.deps.store.defer(pushed.original.id, msg, nowAfterFailure, retry);
                            for (const duplicate of pushed.duplicates)
                                this.deps.store.defer(duplicate.id, msg, nowAfterFailure, retry);
                            deferred += 1 + pushed.duplicates.length;
                        }
                        for (const pending of batch.slice(j)) {
                            this.deps.store.defer(pending.id, msg, nowAfterFailure, retry);
                            deferred += 1;
                        }
                        break;
                    }
                    else {
                        for (const pushed of group) {
                            this.deps.store.fail(pushed.original.id, msg, this.deps.now());
                            for (const duplicate of pushed.duplicates)
                                this.deps.store.fail(duplicate.id, msg, this.deps.now());
                            failed += 1 + pushed.duplicates.length;
                        }
                        i = j - 1;
                    }
                    continue;
                }
            }
            const outboundDedupKey = this.outboundDedupKey(e);
            if (outboundDedupKey && this.deps.store.isProcessed(outboundDedupKey)) {
                this.deps.store.complete(e.id, this.deps.now());
                completedDuplicates += 1;
                continue;
            }
            const guard = this.normalizeOutbound(e);
            if (!guard.ok) {
                this.deps.store.fail(e.id, redactAndTruncate(guard.reason), this.deps.now(), 1);
                terminal += 1;
                continue;
            }
            try {
                await this.deps.proxyHandler(guard.envelope);
                this.deps.store.complete(e.id, this.deps.now());
                if (outboundDedupKey)
                    this.deps.store.markProcessed(outboundDedupKey, { type: e.type }, this.deps.now());
                sent += 1;
            }
            catch (err) {
                const msg = safeErrorMessage(err);
                const authLike = isAuthError(err);
                this.markError(`outbound: ${msg}`, authLike);
                if (authLike) {
                    const nowAfterFailure = this.deps.now();
                    const retry = retryAfterMs(err);
                    for (const pending of batch.slice(i)) {
                        this.deps.store.defer(pending.id, msg, nowAfterFailure, retry); // Auth recovery owns retries; mailbox attempts stay intact.
                        deferred += 1;
                    }
                    authFailed = true;
                    authErrorMessage ??= msg;
                    break;
                }
                else if (isTerminal(err)) {
                    this.deps.store.fail(e.id, msg, this.deps.now(), 1); // maxAttempts=1 → 直进 DLQ, 不反复打经济端点
                    terminal += 1;
                }
                else if (isRetryableRejection(err) || isHubUnreachable(err)) {
                    const nowAfterFailure = this.deps.now();
                    const retry = retryAfterMs(err);
                    for (const pending of batch.slice(i)) {
                        this.deps.store.defer(pending.id, msg, nowAfterFailure, retry); // Hub outage 不消耗 attempts
                        deferred += 1;
                    }
                    break;
                }
                else {
                    this.deps.store.fail(e.id, msg, this.deps.now()); // 退避重试
                    failed += 1;
                }
            }
        }
        if (sent > 0)
            this.lastActivityAt = now;
        if (failed === 0 && terminal === 0 && deferred === 0)
            this.markOk();
        if (sent > 0 || terminal > 0 || completedDuplicates > 0) {
            await this.notifyOutboundFlushed({ sent, failed, terminal, deferred });
        }
        return {
            sent,
            failed,
            terminal,
            deferred,
            ...(authFailed ? { authFailed: true, ...(authErrorMessage ? { authErrorMessage } : {}) } : {}),
        };
    }
    /** 入站: poll hub → 去重 enqueue 到 MailboxStore → ack; 游标存 kv. 遵守 #1195 nextPollAfterMs. */
    async syncInbound() {
        try {
            const res = await this.deps.hub.mailbox.poll();
            let enqueued = 0;
            for (const ev of res.events) {
                const dedupKey = `inbound:${ev.id}`;
                if (this.deps.store.isProcessed(dedupKey)) {
                    await this.safeAck(ev.id);
                    continue;
                }
                if (TRACE_CONFIG_TYPES.has(ev.type)) {
                    applyTraceCollectionConfig(ev.payload, this.deps.store, this.deps.env ?? process.env);
                    this.deps.store.markProcessed(dedupKey, { type: ev.type }, this.deps.now());
                    await this.safeAck(ev.id);
                    if (ev.cursor)
                        this.deps.store.setState(CURSOR_KEY, ev.cursor);
                    continue;
                }
                const env = this.toEnvelope(ev);
                if (env) {
                    this.deps.store.send(env);
                    this.deps.store.markProcessed(dedupKey, { type: ev.type }, this.deps.now());
                    enqueued += 1;
                }
                await this.safeAck(ev.id);
                if (ev.cursor)
                    this.deps.store.setState(CURSOR_KEY, ev.cursor);
            }
            if (res.events.length > 0)
                this.lastActivityAt = this.deps.now();
            this.markOk();
            return {
                received: res.events.length, enqueued, hasMore: res.hasMore ?? false,
                ...(res.nextPollAfterMs !== undefined ? { nextPollAfterMs: res.nextPollAfterMs } : {}),
            };
        }
        catch (err) {
            if (isHubUnreachable(err)) {
                const msg = `inbound: ${safeErrorMessage(err)}`;
                this.markError(msg, false);
                return { received: 0, enqueued: 0, hasMore: false, nextPollAfterMs: retryAfterMs(err) };
            }
            this.markError(`inbound: ${safeErrorMessage(err)}`, isAuthError(err));
            throw err;
        }
    }
    /** #1195 背压: hub 给 nextPollAfterMs 优先(有 backlog→drain 立即, 否则遵守); 缺省回退 idle/active. */
    nextInboundDelay(last) {
        if (last.hasMore)
            return 0; // drain backlog, 别 idle
        if (last.nextPollAfterMs !== undefined)
            return Math.max(0, last.nextPollAfterMs);
        try {
            return this.isIdle() ? SYNC_INTERVALS.inboundIdle : SYNC_INTERVALS.inboundActive;
        }
        catch (err) {
            this.markError(`inbound_delay: ${safeErrorMessage(err)}`, false);
            return SYNC_INTERVALS.inboundActive;
        }
    }
    nextOutboundDelay() {
        try {
            return this.deps.store.countClaimable('proxy', this.deps.now(), this.deps.runtimeNamespace) > 0
                ? SYNC_INTERVALS.outboundPending : SYNC_INTERVALS.outboundIdle;
        }
        catch (err) {
            this.markError(`outbound_delay: ${safeErrorMessage(err)}`, false);
            return SYNC_INTERVALS.outboundIdle;
        }
    }
    isIdle() { return this.deps.now() - this.lastActivityAt > IDLE_THRESHOLD_MS; }
    markOk() {
        this.deps.store.setState(STATE.lastSyncAt, String(this.deps.now()));
        this.deps.store.setState(STATE.lastError, '');
        this.deps.store.setState(STATE.authStatus, 'ok');
    }
    markError(message, authError) {
        // #314: on an auth failure append an actionable hint keyed off the hub error code in `message` (which carries
        // the typed AuthError text, e.g. "a2a_auth_required") so a public-mode 401 is not silent and not misdirected.
        let full = message;
        if (authError) {
            const hint = hubAuthFailureHint(this.deps.env ?? process.env, message);
            if (hint)
                full = `${message}. ${hint}`;
        }
        this.deps.store.setState(STATE.lastError, redactAndTruncate(full));
        if (authError)
            this.deps.store.setState(STATE.authStatus, 'auth_failed');
    }
    async notifyOutboundFlushed(result) {
        try {
            await this.deps.onOutboundFlushed?.(result);
        }
        catch (err) {
            this.markError(`outbound_flush_callback: ${safeErrorMessage(err)}`, false);
        }
    }
    normalizeOutbound(e) {
        if (e.type !== 'proxy_trace')
            return { ok: true, envelope: e };
        const normalized = normalizeProxyTraceOutboundPayload(e.payload, this.deps.env ?? process.env, this.deps.store);
        if (!normalized.ok)
            return normalized;
        return { ok: true, envelope: { ...e, payload: normalized.payload } };
    }
    outboundDedupKey(e) {
        if (e.type !== 'proxy_trace')
            return null;
        return e.idempotencyKey ? `outbound:${e.idempotencyKey}` : null;
    }
    async safeAck(id) {
        try {
            await this.deps.hub.mailbox.ack(id);
        }
        catch { /* ack 失败不阻塞 poll(分离, #1195 review 点) */ }
    }
    /** AgentEvent → core Envelope; 未知类型(不在目录)跳过. */
    toEnvelope(ev) {
        try {
            return mailbox.createEnvelope({
                type: ev.type, payload: ev.payload, idempotencyKey: `inbound:${ev.id}`,
                ...(this.deps.runtimeNamespace ? { runtimeNamespace: this.deps.runtimeNamespace } : {}),
                now: this.deps.now(),
            });
        }
        catch {
            return null;
        } // UnknownMessageTypeError → 跳过
    }
}