import { mailbox, hub as hubNs } from '@evomap/evolver-core';
import { HubClientError } from '@evomap/evolver-adapter-public';
import { normalizeProxyTraceOutboundPayload } from '../llm/traceBackfill.js';
import { applyTraceCollectionConfig } from '../llm/traceControl.js';
import { hubAuthFailureHint } from '../daemon/selectHub.js';
/** 双线程轮询节奏(沿用 v1 常量). */
export const SYNC_INTERVALS = { outboundIdle: 5_000, outboundPending: 1_000, inboundActive: 10_000, inboundIdle: 60_000 };
export const MAX_BATCH = 50;
export const IDLE_THRESHOLD_MS = 5 * 60_000;
const MAX_SYNC_ERROR_LENGTH = 2_000;
const CURSOR_KEY = 'sync:inbound_cursor';
const ACCEPTED_TASK_OUTBOUND_PREFIX = 'sync:accepted_task_outbound:';
const ACCEPTED_TASK_JOURNAL_WRITE_ATTEMPTS = 2;
const LOCAL_FINALIZE_RETRY_MS = 1_000;
const BATCHABLE_PROXY_TYPES = new Set(['proxy_trace']);
const TRACE_CONFIG_TYPES = new Set(['trace_collection_config', 'proxy_trace_config']);
const STATE = {
    lastSyncAt: 'sync:last_sync_at',
    lastError: 'sync:last_error',
    authStatus: 'hub:auth_status',
};
function isTerminal(err, envelopeType) {
    if (err instanceof hubNs.PublishRejectedError && err.terminal === true)
        return true;
    return (envelopeType === 'task_claim' || envelopeType === 'task_complete')
        && err instanceof HubClientError
        && (err.status === 404 || err.status === 409);
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
function isRetryableTransportError(err) {
    if (isRetryableRejection(err) || isHubUnreachable(err)
        || (err instanceof HubClientError && err.status === 429))
        return true;
    const e = err;
    const rawStatus = e?.statusCode ?? e?.status;
    const status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
    if (Number.isFinite(status) && status >= 500 && status <= 599)
        return true;
    if (e?.retryable === true)
        return true;
    const signature = `${String(e?.name ?? '')} ${String(e?.code ?? '')} ${err instanceof Error ? err.message : ''}`;
    return /\b5\d\d\b|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch/i.test(signature);
}
function retryAfterMs(err) {
    const body = err instanceof HubClientError && err.body && typeof err.body === 'object' && !Array.isArray(err.body)
        ? err.body
        : undefined;
    const bodyRetryMs = Number(body?.['retry_after_ms'] ?? body?.['retryAfterMs']);
    const bodyRetrySeconds = Number(body?.['retry_after'] ?? body?.['retryAfter']);
    const retry = err?.retryAfterMs
        ?? err?.details?.retryAfterMs
        ?? (Number.isFinite(bodyRetryMs) ? bodyRetryMs : undefined)
        ?? (Number.isFinite(bodyRetrySeconds) ? bodyRetrySeconds * 1_000 : undefined);
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
function requiredClaimOwner(envelope) {
    const claimOwner = mailbox.mailboxClaimOwner(envelope);
    if (!claimOwner)
        throw new Error(`mailbox_claim_owner_missing:${envelope.id}`);
    return claimOwner;
}
/**
 * SyncEngine(M6-2): proxy↔hub 双向同步. 移植 v1 sync/{engine,outbound,inbound} 到 TS,
 * hub I/O 全走 HubCapability.mailbox(非裸 hubFetch). tick 方法纯逻辑(注入 now), 可对 FakeHubCapability 确定性测;
 * 定时器循环(start/stop)是薄包装, 由 M6-4 daemon 装配驱动.
 */
function applyMailboxPushManyOutcomes(group, outcomes, deps) {
    const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
    const result = { sent: 0, failed: 0, terminal: 0, deferred: 0, completedDuplicates: 0 };
    for (const pushed of group) {
        const outcome = byId.get(pushed.event.id) ?? byId.get(pushed.original.id) ?? {
            id: pushed.event.id,
            status: 'failed',
            reason: 'mailbox_response_incomplete',
            retryable: true,
            terminal: false,
        };
        if (outcome?.status === 'failed') {
            const msg = redactAndTruncate(outcome.reason ?? 'mailbox_push_rejected');
            const authLike = isAuthError(msg);
            result.firstFailure ??= msg;
            const retryable = outcome.terminal !== true
                && (outcome.retryable === true || (typeof outcome.retryAfterMs === 'number' && Number.isFinite(outcome.retryAfterMs)));
            if (authLike || retryable) {
                const nowAfterFailure = deps.now();
                const retry = Math.max(1_000, typeof outcome.retryAfterMs === 'number' && Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs : 60_000);
                result.deferredFailure ??= { msg, retryAfterMs: retry };
                if (authLike) {
                    result.authFailed = true;
                    result.authErrorMessage ??= msg;
                }
                if (deps.store.deferClaimed(pushed.original.id, msg, nowAfterFailure, retry, requiredClaimOwner(pushed.original)))
                    result.deferred += 1;
                for (const duplicate of pushed.duplicates) {
                    if (deps.store.deferClaimed(duplicate.id, msg, nowAfterFailure, retry, requiredClaimOwner(duplicate))) {
                        result.deferred += 1;
                    }
                }
            }
            else {
                const maxAttempts = outcome.terminal ? 1 : undefined;
                let transitioned = deps.store.failClaimed(pushed.original.id, msg, deps.now(), requiredClaimOwner(pushed.original), maxAttempts) ? 1 : 0;
                for (const duplicate of pushed.duplicates) {
                    if (deps.store.failClaimed(duplicate.id, msg, deps.now(), requiredClaimOwner(duplicate), maxAttempts)) {
                        transitioned += 1;
                    }
                }
                if (outcome.terminal)
                    result.terminal += transitioned;
                else
                    result.failed += transitioned;
            }
        }
        else {
            const completedOriginal = deps.store.completeClaimed(pushed.original.id, deps.now(), requiredClaimOwner(pushed.original));
            let completedDuplicates = 0;
            for (const duplicate of pushed.duplicates) {
                if (deps.store.completeClaimed(duplicate.id, deps.now(), requiredClaimOwner(duplicate)))
                    completedDuplicates += 1;
            }
            if (pushed.dedupKey)
                deps.store.markProcessed(pushed.dedupKey, { type: pushed.original.type }, deps.now());
            if (completedOriginal)
                result.sent += 1;
            result.completedDuplicates += completedDuplicates;
        }
    }
    return result;
}
export class SyncEngine {
    deps;
    acceptedTaskOutboundMemory = new Map();
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
        let localPersistenceFailed = false;
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
                        if (this.deps.store.completeClaimed(current.id, this.deps.now(), requiredClaimOwner(current))) {
                            completedDuplicates += 1;
                        }
                        continue;
                    }
                    const existing = outboundDedupKey ? groupByDedupKey.get(outboundDedupKey) : undefined;
                    if (existing) {
                        existing.duplicates.push(current);
                        continue;
                    }
                    const guard = this.normalizeOutbound(current);
                    if (!guard.ok) {
                        if (this.deps.store.failClaimed(current.id, guard.reason, this.deps.now(), requiredClaimOwner(current), 1)) {
                            terminal += 1;
                        }
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
                        const applied = applyMailboxPushManyOutcomes(group, result.outcomes, this.deps);
                        sent += applied.sent;
                        failed += applied.failed;
                        terminal += applied.terminal;
                        deferred += applied.deferred;
                        completedDuplicates += applied.completedDuplicates;
                        if (applied.authFailed)
                            authFailed = true;
                        authErrorMessage ??= applied.authErrorMessage;
                        if (applied.firstFailure)
                            this.markError(`outbound: ${applied.firstFailure}`, isAuthError(applied.firstFailure));
                        if (applied.deferredFailure) {
                            const nowAfterFailure = this.deps.now();
                            for (const pending of batch.slice(j)) {
                                if (this.deps.store.deferClaimed(pending.id, applied.deferredFailure.msg, nowAfterFailure, applied.deferredFailure.retryAfterMs, requiredClaimOwner(pending)))
                                    deferred += 1;
                            }
                            break;
                        }
                    }
                    else {
                        for (const pushed of group) {
                            if (this.deps.store.completeClaimed(pushed.original.id, this.deps.now(), requiredClaimOwner(pushed.original)))
                                sent += 1;
                            for (const duplicate of pushed.duplicates) {
                                if (this.deps.store.completeClaimed(duplicate.id, this.deps.now(), requiredClaimOwner(duplicate))) {
                                    completedDuplicates += 1;
                                }
                            }
                            if (pushed.dedupKey)
                                this.deps.store.markProcessed(pushed.dedupKey, { type: pushed.original.type }, this.deps.now());
                        }
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
                            if (this.deps.store.deferClaimed(pushed.original.id, msg, nowAfterFailure, retry, requiredClaimOwner(pushed.original)))
                                deferred += 1;
                            for (const duplicate of pushed.duplicates) {
                                if (this.deps.store.deferClaimed(duplicate.id, msg, nowAfterFailure, retry, requiredClaimOwner(duplicate)))
                                    deferred += 1;
                            }
                        }
                        for (const pending of batch.slice(j)) {
                            if (this.deps.store.deferClaimed(pending.id, msg, nowAfterFailure, retry, requiredClaimOwner(pending))) {
                                deferred += 1;
                            }
                        }
                        authFailed = true;
                        authErrorMessage ??= msg;
                        break;
                    }
                    else if (isTerminal(err, group[0].original.type)) {
                        for (const pushed of group) {
                            if (this.deps.store.failClaimed(pushed.original.id, msg, this.deps.now(), requiredClaimOwner(pushed.original), 1))
                                terminal += 1;
                            for (const duplicate of pushed.duplicates) {
                                if (this.deps.store.failClaimed(duplicate.id, msg, this.deps.now(), requiredClaimOwner(duplicate), 1))
                                    terminal += 1;
                            }
                        }
                        i = j - 1;
                    }
                    else if (isRetryableTransportError(err)) {
                        const nowAfterFailure = this.deps.now();
                        const retry = retryAfterMs(err);
                        for (const pushed of group) {
                            if (this.deps.store.deferClaimed(pushed.original.id, msg, nowAfterFailure, retry, requiredClaimOwner(pushed.original)))
                                deferred += 1;
                            for (const duplicate of pushed.duplicates) {
                                if (this.deps.store.deferClaimed(duplicate.id, msg, nowAfterFailure, retry, requiredClaimOwner(duplicate)))
                                    deferred += 1;
                            }
                        }
                        for (const pending of batch.slice(j)) {
                            if (this.deps.store.deferClaimed(pending.id, msg, nowAfterFailure, retry, requiredClaimOwner(pending)))
                                deferred += 1;
                        }
                        break;
                    }
                    else {
                        for (const pushed of group) {
                            if (this.deps.store.failClaimed(pushed.original.id, msg, this.deps.now(), requiredClaimOwner(pushed.original)))
                                failed += 1;
                            for (const duplicate of pushed.duplicates) {
                                if (this.deps.store.failClaimed(duplicate.id, msg, this.deps.now(), requiredClaimOwner(duplicate)))
                                    failed += 1;
                            }
                        }
                        i = j - 1;
                    }
                    continue;
                }
            }
            const outboundDedupKey = this.outboundDedupKey(e);
            if (outboundDedupKey && this.deps.store.isProcessed(outboundDedupKey)) {
                if (this.deps.store.completeClaimed(e.id, this.deps.now(), requiredClaimOwner(e)))
                    completedDuplicates += 1;
                continue;
            }
            const guard = this.normalizeOutbound(e);
            if (!guard.ok) {
                if (this.deps.store.failClaimed(e.id, redactAndTruncate(guard.reason), this.deps.now(), requiredClaimOwner(e), 1))
                    terminal += 1;
                continue;
            }
            const claimOwner = requiredClaimOwner(e);
            let handlerResult;
            let hubAccepted = false;
            try {
                const accepted = this.acceptedTaskOutbound(e);
                handlerResult = accepted ? accepted.result : await this.deps.proxyHandler(guard.envelope);
                hubAccepted = true;
                let journalError;
                try {
                    this.rememberAcceptedTaskOutbound(e, handlerResult);
                }
                catch (err) {
                    journalError = `accepted_journal: ${safeErrorMessage(err)}`;
                }
                if (!this.deps.store.renewClaim(e.id, this.deps.now(), this.deps.leaseMs ?? 30_000, claimOwner))
                    continue;
                try {
                    await this.deps.onOutboundSucceeded?.(e, handlerResult);
                }
                catch (err) {
                    const msg = `local_finalize: ${safeErrorMessage(err)}`;
                    localPersistenceFailed = true;
                    if (journalError && !this.durableAcceptedTaskOutbound(e)) {
                        try {
                            this.rememberAcceptedTaskOutbound(e, handlerResult);
                            journalError = undefined;
                        }
                        catch (retryError) {
                            journalError = `accepted_journal_retry: ${safeErrorMessage(retryError)}`;
                            this.markError(journalError, false);
                        }
                    }
                    this.markError(msg, false);
                    if (this.durableAcceptedTaskOutbound(e)) {
                        if (this.deps.store.deferClaimed(e.id, msg, this.deps.now(), LOCAL_FINALIZE_RETRY_MS, claimOwner)) {
                            deferred += 1;
                        }
                        continue;
                    }
                    // The Hub has already accepted this envelope. A local observer must not cause a second external action.
                }
                if (!this.deps.store.completeClaimed(e.id, this.deps.now(), claimOwner))
                    continue;
                this.acceptedTaskOutboundMemory.delete(e.id);
                if (outboundDedupKey)
                    this.deps.store.markProcessed(outboundDedupKey, { type: e.type }, this.deps.now());
                if (journalError)
                    this.markError(journalError, false);
                if (journalError)
                    localPersistenceFailed = true;
                sent += 1;
            }
            catch (err) {
                if (hubAccepted) {
                    if (this.deps.store.getById(e.id)?.status === 'done') {
                        this.acceptedTaskOutboundMemory.delete(e.id);
                        sent += 1;
                        continue;
                    }
                    const msg = `local_finalize: ${safeErrorMessage(err)}`;
                    localPersistenceFailed = true;
                    if (!this.durableAcceptedTaskOutbound(e)) {
                        try {
                            this.rememberAcceptedTaskOutbound(e, handlerResult);
                        }
                        catch (journalRetryError) {
                            this.markError(`accepted_journal_retry: ${safeErrorMessage(journalRetryError)}`, false);
                        }
                    }
                    this.markError(msg, false);
                    if (this.durableAcceptedTaskOutbound(e)) {
                        if (this.deps.store.deferClaimed(e.id, msg, this.deps.now(), LOCAL_FINALIZE_RETRY_MS, claimOwner)) {
                            deferred += 1;
                        }
                    }
                    else {
                        // No durable local replay is possible for this callback, but the external action is already complete.
                        if (this.deps.store.completeClaimed(e.id, this.deps.now(), claimOwner))
                            sent += 1;
                        this.acceptedTaskOutboundMemory.delete(e.id);
                    }
                    continue;
                }
                const msg = safeErrorMessage(err);
                const authLike = isAuthError(err);
                this.markError(`outbound: ${msg}`, authLike);
                if (authLike) {
                    const nowAfterFailure = this.deps.now();
                    const retry = retryAfterMs(err);
                    for (const pending of batch.slice(i)) {
                        const acceptedKey = this.deps.acceptedOutcomeKey?.(pending);
                        const pendingClaimOwner = requiredClaimOwner(pending);
                        const transitioned = acceptedKey
                            ? this.deps.store.deferClaimedUnlessProcessed(pending.id, acceptedKey, msg, nowAfterFailure, retry, pendingClaimOwner)
                            : this.deps.store.deferClaimed(pending.id, msg, nowAfterFailure, retry, pendingClaimOwner);
                        if (transitioned)
                            deferred += 1;
                        else if (this.completeAcceptedOutcome(pending))
                            sent += 1;
                    }
                    authFailed = true;
                    authErrorMessage ??= msg;
                    break;
                }
                else if (isTerminal(err, e.type)) {
                    const transitionNow = this.deps.now();
                    const acceptedKey = this.deps.acceptedOutcomeKey?.(e);
                    const terminalOutcome = this.deps.terminalOutcome?.(e, err);
                    const transitioned = acceptedKey && terminalOutcome
                        ? this.deps.store.failClaimedAndMarkProcessedUnlessProcessed(e.id, [acceptedKey], terminalOutcome.key, terminalOutcome.result, msg, transitionNow, claimOwner, 1)
                        : acceptedKey
                            ? this.deps.store.failClaimedUnlessProcessed(e.id, acceptedKey, msg, transitionNow, claimOwner, 1)
                            : this.deps.store.failClaimed(e.id, msg, transitionNow, claimOwner, 1);
                    if (!transitioned) {
                        if (this.completeAcceptedOutcome(e))
                            sent += 1;
                        continue;
                    }
                    await this.deps.onOutboundTerminal?.(e, err);
                    terminal += 1;
                }
                else if (isRetryableTransportError(err)) {
                    const nowAfterFailure = this.deps.now();
                    const retry = retryAfterMs(err);
                    for (const pending of batch.slice(i)) {
                        const acceptedKey = this.deps.acceptedOutcomeKey?.(pending);
                        const pendingClaimOwner = requiredClaimOwner(pending);
                        const transitioned = acceptedKey
                            ? this.deps.store.deferClaimedUnlessProcessed(pending.id, acceptedKey, msg, nowAfterFailure, retry, pendingClaimOwner)
                            : this.deps.store.deferClaimed(pending.id, msg, nowAfterFailure, retry, pendingClaimOwner);
                        if (transitioned)
                            deferred += 1;
                        else if (this.completeAcceptedOutcome(pending))
                            sent += 1;
                    }
                    break;
                }
                else {
                    const transitionNow = this.deps.now();
                    const acceptedKey = this.deps.acceptedOutcomeKey?.(e);
                    const transitioned = acceptedKey
                        ? this.deps.store.failClaimedUnlessProcessed(e.id, acceptedKey, msg, transitionNow, claimOwner)
                        : this.deps.store.failClaimed(e.id, msg, transitionNow, claimOwner);
                    if (transitioned)
                        failed += 1;
                    else if (this.completeAcceptedOutcome(e))
                        sent += 1;
                }
            }
        }
        if (sent > 0)
            this.lastActivityAt = now;
        if (failed === 0 && terminal === 0 && deferred === 0 && !localPersistenceFailed)
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
                const rawEnvelope = this.toEnvelope(ev);
                const env = rawEnvelope ? (this.deps.normalizeInboundEnvelope?.(rawEnvelope) ?? rawEnvelope) : null;
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
            if (isHubUnreachable(err) || (err instanceof HubClientError && err.status === 429)) {
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
    acceptedTaskOutbound(e) {
        if (e.type !== 'task_claim' && e.type !== 'task_complete')
            return undefined;
        return this.durableAcceptedTaskOutbound(e) ?? this.acceptedTaskOutboundMemory.get(e.id);
    }
    durableAcceptedTaskOutbound(e) {
        if (e.type !== 'task_claim' && e.type !== 'task_complete')
            return undefined;
        const value = this.deps.store.getProcessed(`${ACCEPTED_TASK_OUTBOUND_PREFIX}${e.id}`);
        if (value && typeof value === 'object' && value.accepted === true) {
            return value;
        }
        const checkpoint = this.deps.store.getClaimedCheckpoint(e.id);
        if (checkpoint && typeof checkpoint === 'object'
            && checkpoint.accepted === true) {
            return checkpoint;
        }
        return undefined;
    }
    completeAcceptedOutcome(e) {
        const acceptedKey = this.deps.acceptedOutcomeKey?.(e);
        if (!acceptedKey || !this.deps.store.isProcessed(acceptedKey))
            return false;
        return this.deps.store.completeClaimed(e.id, this.deps.now(), requiredClaimOwner(e));
    }
    rememberAcceptedTaskOutbound(e, result) {
        if (e.type !== 'task_claim' && e.type !== 'task_complete')
            return;
        const accepted = { accepted: true, result };
        this.acceptedTaskOutboundMemory.set(e.id, accepted);
        let lastError;
        for (let attempt = 0; attempt < ACCEPTED_TASK_JOURNAL_WRITE_ATTEMPTS; attempt += 1) {
            try {
                this.deps.store.markProcessed(`${ACCEPTED_TASK_OUTBOUND_PREFIX}${e.id}`, accepted, this.deps.now());
                this.acceptedTaskOutboundMemory.delete(e.id);
                return;
            }
            catch (error) {
                lastError = error;
            }
        }
        if (this.deps.store.setClaimedCheckpoint(e.id, accepted, this.deps.now(), requiredClaimOwner(e))) {
            this.acceptedTaskOutboundMemory.delete(e.id);
            return;
        }
        throw lastError;
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
                ...(ev.refId ? { replyTo: ev.refId } : {}),
                ...(this.deps.runtimeNamespace ? { runtimeNamespace: this.deps.runtimeNamespace } : {}),
                now: this.deps.now(),
            });
        }
        catch {
            return null;
        } // UnknownMessageTypeError → 跳过
    }
}