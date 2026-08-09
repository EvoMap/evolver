import { createHash } from 'node:crypto';
import { hub, mailbox } from '@evomap/evolver-core';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const SUBSCRIPTION_STATE_KEY = 'compat:v1:task_subscription';
const TASK_METRICS_STATE_KEY = 'compat:v1:task_metrics';
const TASK_CLAIM_PREFIX = 'compat:v1:task_claim:';
const TASK_COMPLETE_PREFIX = 'compat:v1:task_complete:';
const DM_SEND_PREFIX = 'compat:v1:dm_send:';
const LOCAL_ACK_TYPES = new Set(['dm', 'task_available', 'task_claim_result', 'task_complete_result']);
const TASK_RESULT_TYPES = new Set(['task_claim_result', 'task_complete_result']);
const DIRECT_ATTEMPT_RETRY_GRACE_MS = 1_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const UNSUPPORTED_ENDPOINTS = new Set([
    'POST /session/create',
    'POST /session/join',
    'POST /session/leave',
    'POST /session/message',
    'POST /session/delegate',
    'POST /session/submit',
    'POST /session/invites/poll',
    'GET /session/list',
]);
export class CollaborationFacade {
    deps;
    pendingClaims = new Map();
    pendingCompletes = new Map();
    pendingDmSends = new Map();
    pendingSubscriptions = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    async handle(ctx) {
        if (UNSUPPORTED_ENDPOINTS.has(ctx.route)) {
            ctx.json(501, {
                error: 'unsupported endpoint',
                code: 'unsupported_endpoint',
                endpoint: ctx.url.pathname,
                category: 'session',
            });
            return true;
        }
        switch (ctx.route) {
            case 'POST /task/subscribe': return this.taskSubscribe(ctx);
            case 'POST /task/unsubscribe': return this.taskUnsubscribe(ctx);
            case 'GET /task/list': return this.taskList(ctx);
            case 'POST /task/claim': return this.taskClaim(ctx);
            case 'POST /task/complete': return this.taskComplete(ctx);
            case 'GET /task/metrics': return this.taskMetrics(ctx);
            case 'POST /dm/send': return this.dmSend(ctx);
            case 'POST /dm/poll': return this.dmPoll(ctx);
            case 'GET /dm/list': return this.dmList(ctx);
            case 'POST /mailbox/poll': return this.mailboxPoll(ctx);
            case 'POST /mailbox/ack': return this.mailboxAck(ctx);
            default: return false;
        }
    }
    /** Completes V1 durable task intents replayed by SyncEngine after a restart or transient Hub failure. */
    handleOutboundSucceeded(envelope, handlerResult) {
        if (envelope.runtimeNamespace !== (this.deps.runtimeNamespace ?? 'default'))
            return;
        if (envelope.type === 'task_claim' && envelope.idempotencyKey.startsWith(TASK_CLAIM_PREFIX)) {
            const payload = asRecord(envelope.payload);
            const taskId = requiredValue(payload, 'taskId', 'task_id');
            const claimId = requiredValue(asRecord(handlerResult), 'claimId', 'claim_id');
            if (!taskId || !claimId)
                throw new FacadeProtocolError('Hub returned an invalid task claim result');
            this.finalizeClaim(envelope, envelope.idempotencyKey, taskId, claimId, this.deps.now());
            return;
        }
        if (envelope.type === 'task_complete' && envelope.idempotencyKey.startsWith(TASK_COMPLETE_PREFIX)) {
            const payload = asRecord(envelope.payload);
            const taskId = requiredValue(payload, 'taskId', 'task_id');
            const claimId = requiredValue(payload, 'claimId', 'claim_id');
            if (!taskId || !claimId)
                throw new FacadeProtocolError('Durable task completion intent is invalid');
            this.finalizeComplete(envelope, completeSuccessKey(claimId), taskId, claimId, numberValue(payload['startedAt']), this.deps.now());
        }
    }
    /** Maps a Public Hub task result echo onto the same durable row as the facade-generated result. */
    normalizeInboundEnvelope(envelope) {
        if (!TASK_RESULT_TYPES.has(envelope.type)
            || envelope.runtimeNamespace !== (this.deps.runtimeNamespace ?? 'default'))
            return envelope;
        const intent = this.facadeIntentForResult(envelope);
        if (!intent)
            return envelope;
        const intentPayload = asRecord(intent.payload);
        const taskId = requiredValue(intentPayload, 'taskId', 'task_id');
        if (!taskId)
            return envelope;
        if (envelope.type === 'task_claim_result') {
            const resultRef = taskResultRef(envelope);
            const claimId = requiredValue(asRecord(envelope.payload), 'claimId', 'claim_id')
                ?? processed(this.deps.store, TASK_CLAIM_PREFIX + taskId)?.claim_id
                ?? (resultRef === `claim-${taskId}` ? resultRef : undefined);
            if (!claimId)
                return envelope;
            return canonicalTaskResultEnvelope(envelope.type, {
                task_id: taskId,
                claim_id: claimId,
                message_id: intent.id,
                status: 'pending',
                claim_status: 'claimed',
            }, intent, envelope.createdAt);
        }
        const claimId = requiredValue(intentPayload, 'claimId', 'claim_id');
        if (!claimId)
            return envelope;
        return canonicalTaskResultEnvelope('task_complete_result', {
            task_id: taskId,
            claim_id: claimId,
            message_id: intent.id,
            status: 'pending',
            completion_status: 'completed',
        }, intent, envelope.createdAt);
    }
    /** Caches a sanitized terminal result for durable task intents failed by SyncEngine. */
    handleOutboundTerminal(envelope, error) {
        if (envelope.runtimeNamespace !== (this.deps.runtimeNamespace ?? 'default'))
            return;
        if (envelope.type === 'task_claim' && envelope.idempotencyKey.startsWith(TASK_CLAIM_PREFIX)) {
            this.cacheTerminalIntentFailure(envelope, envelope.idempotencyKey, error);
            return;
        }
        if (envelope.type === 'task_complete' && envelope.idempotencyKey.startsWith(TASK_COMPLETE_PREFIX)) {
            this.cacheTerminalIntentFailure(envelope, envelope.idempotencyKey, error);
        }
    }
    async taskSubscribe(ctx) {
        const body = asRecord(await ctx.readJson());
        const filter = Array.isArray(body['capability_filter'])
            ? body['capability_filter']
            : Array.isArray(body['filters']) ? body['filters'] : [];
        const filterHash = stableHash(filter);
        const operation = this.getOrStart(this.pendingSubscriptions, filterHash, async () => {
            const previous = asRecord(parseJson(this.deps.store.getState(SUBSCRIPTION_STATE_KEY)));
            const previousId = typeof previous['message_id'] === 'string' ? previous['message_id'] : '';
            const previousMessage = previousId ? this.deps.store.getById(previousId) : undefined;
            if (previous['enabled'] === true
                && previous['filter_hash'] === filterHash
                && previousMessage
                && (previousMessage.status === 'pending' || previousMessage.status === 'in_flight' || previousMessage.status === 'done')) {
                return { message_id: previousId, status: 'pending' };
            }
            const result = this.enqueue('task_subscribe', { capability_filter: filter }, ctx.now, `task-subscribe:${filterHash}`);
            this.deps.store.setState(SUBSCRIPTION_STATE_KEY, JSON.stringify({
                enabled: true,
                filters: filter,
                filter_hash: filterHash,
                message_id: result.message_id,
                subscribed_at: new Date(ctx.now).toISOString(),
            }));
            return result;
        });
        ctx.json(200, await operation);
        return true;
    }
    async taskUnsubscribe(ctx) {
        await ctx.readJson();
        this.deps.store.setState(SUBSCRIPTION_STATE_KEY, JSON.stringify({
            enabled: false,
            unsubscribed_at: new Date(ctx.now).toISOString(),
        }));
        ctx.json(200, this.enqueue('task_unsubscribe', {}, ctx.now, 'task-unsubscribe'));
        return true;
    }
    taskList(ctx) {
        this.observeReceivedTasks();
        const tasks = this.messages('task_available', 'inbound', { status: 'pending' })
            .slice(0, boundedLimit(ctx.url.searchParams.get('limit')))
            .map(v1Message);
        ctx.json(200, { tasks, count: tasks.length });
        return true;
    }
    async taskClaim(ctx) {
        const body = asRecord(await ctx.readJson());
        const taskId = requiredIdentifier(body, 'task_id');
        if (!taskId.ok)
            return badRequest(ctx, taskId.error);
        const key = TASK_CLAIM_PREFIX + taskId.value;
        const existing = processed(this.deps.store, key);
        if (existing) {
            ctx.json(200, existing);
            return true;
        }
        const terminal = processed(this.deps.store, terminalKey(key));
        if (terminal) {
            writeOperationClassification(ctx, terminal);
            return true;
        }
        const intent = this.ensureTaskIntent('task_claim', { taskId: taskId.value }, key, ctx.now);
        const operation = this.pendingClaims.get(key)
            ?? (intent.created ? this.getOrStart(this.pendingClaims, key, () => this.executeClaim(intent.envelope, key, taskId.value)) : undefined);
        if (!operation) {
            ctx.json(200, pendingClaim(intent.envelope.id, taskId.value));
            return true;
        }
        try {
            ctx.json(200, await withTimeout(operation, this.timeoutMs()));
        }
        catch (error) {
            const classification = classifyOperationError(error);
            if (classification.retryable)
                ctx.json(200, pendingClaim(intent.envelope.id, taskId.value));
            else
                writeOperationError(ctx, error);
        }
        return true;
    }
    async taskComplete(ctx) {
        const body = asRecord(await ctx.readJson());
        const taskId = requiredIdentifier(body, 'task_id');
        if (!taskId.ok)
            return badRequest(ctx, taskId.error);
        const assetId = requiredIdentifier(body, 'asset_id');
        if (!assetId.ok)
            return badRequest(ctx, assetId.error);
        const claim = processed(this.deps.store, TASK_CLAIM_PREFIX + taskId.value);
        if (!claim)
            return forbidden(ctx, 'task must be claimed through the facade before completion');
        const claimId = optionalString(body['claim_id']) ?? claim.claim_id;
        if (claim.claim_id !== claimId)
            return forbidden(ctx, 'claim does not belong to task_id');
        const successKey = completeSuccessKey(claimId);
        const existing = processed(this.deps.store, successKey);
        if (existing) {
            ctx.json(200, existing);
            return true;
        }
        const resultPayload = Object.hasOwn(body, 'result')
            ? body['result']
            : Object.hasOwn(body, 'payload') ? body['payload'] : {};
        const startedAt = numberValue(body['started_at']);
        const attemptKey = completeAttemptKey(taskId.value, claimId, assetId.value, resultPayload);
        const terminal = processed(this.deps.store, terminalKey(attemptKey));
        if (terminal) {
            writeOperationClassification(ctx, terminal);
            return true;
        }
        const active = this.activeCompleteIntent(claimId);
        const activeOperation = this.pendingCompletes.get(successKey);
        if (active) {
            if (!activeOperation) {
                ctx.json(200, pendingComplete(active.id, taskId.value, claimId));
                return true;
            }
            try {
                ctx.json(200, await withTimeout(activeOperation, this.timeoutMs()));
            }
            catch (error) {
                const classification = classifyOperationError(error);
                if (classification.retryable)
                    ctx.json(200, pendingComplete(active.id, taskId.value, claimId));
                else
                    writeOperationError(ctx, error);
            }
            return true;
        }
        const intent = this.ensureTaskIntent('task_complete', {
            claimId,
            taskId: taskId.value,
            assetId: assetId.value,
            result: resultPayload,
            ...(startedAt !== undefined ? { startedAt } : {}),
        }, attemptKey, ctx.now);
        const operation = this.pendingCompletes.get(successKey)
            ?? (intent.created
                ? this.getOrStart(this.pendingCompletes, successKey, () => this.executeComplete(intent.envelope, successKey, taskId.value, claimId, assetId.value, resultPayload, startedAt))
                : undefined);
        if (!operation) {
            ctx.json(200, pendingComplete(intent.envelope.id, taskId.value, claimId));
            return true;
        }
        try {
            ctx.json(200, await withTimeout(operation, this.timeoutMs()));
        }
        catch (error) {
            const classification = classifyOperationError(error);
            if (classification.retryable)
                ctx.json(200, pendingComplete(intent.envelope.id, taskId.value, claimId));
            else
                writeOperationError(ctx, error);
        }
        return true;
    }
    taskMetrics(ctx) {
        const metrics = this.observeReceivedTasks();
        const tasksPending = this.deps.store.countMessages({
            type: 'task_available', direction: 'inbound', status: 'pending',
            runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
        });
        ctx.json(200, {
            subscribed: Boolean(asRecord(parseJson(this.deps.store.getState(SUBSCRIPTION_STATE_KEY)))['enabled']),
            tasks_received: metrics.tasks_received,
            tasks_claimed: metrics.tasks_claimed,
            tasks_completed: metrics.tasks_completed,
            tasks_failed: metrics.tasks_failed,
            tasks_pending: tasksPending,
            last_claim_at: metrics.last_claim_at,
            last_complete_at: metrics.last_complete_at,
            avg_completion_ms: metrics.avg_completion_ms,
        });
        return true;
    }
    async dmSend(ctx) {
        const body = asRecord(await ctx.readJson());
        const recipient = requiredIdentifier(body, 'recipient_node_id');
        if (!recipient.ok)
            return badRequest(ctx, recipient.error);
        const content = requiredDmContent(body['content']);
        if (!content.ok)
            return badRequest(ctx, content.error);
        const metadata = asRecord(body['metadata']);
        const requestKey = boundedOptionalString(ctx.req.headers['idempotency-key'], MAX_IDEMPOTENCY_KEY_LENGTH)
            ?? boundedOptionalString(body['idempotency_key'], MAX_IDEMPOTENCY_KEY_LENGTH);
        const payload = {
            recipient_node_id: recipient.value,
            content: content.value,
            metadata,
            sent_at: new Date(ctx.now).toISOString(),
        };
        if (requestKey === undefined) {
            ctx.json(200, this.enqueue('dm_outbound', payload, ctx.now));
            return true;
        }
        const key = DM_SEND_PREFIX + requestKey;
        const existing = processed(this.deps.store, key);
        if (existing) {
            ctx.json(200, existing);
            return true;
        }
        const operation = this.getOrStart(this.pendingDmSends, key, async () => {
            const replay = processed(this.deps.store, key);
            if (replay)
                return replay;
            const result = this.enqueue('dm_outbound', payload, ctx.now, key, true);
            this.deps.store.markProcessed(key, result, ctx.now);
            return result;
        });
        ctx.json(200, await operation);
        return true;
    }
    async dmPoll(ctx) {
        const body = asRecord(await ctx.readJson());
        const messages = this.dmMessages({ status: 'pending' })
            .slice(0, boundedLimit(body['limit']))
            .map(v1Message);
        ctx.json(200, { messages, count: messages.length });
        return true;
    }
    async mailboxPoll(ctx) {
        const body = asRecord(await ctx.readJson());
        const type = optionalString(body['type']);
        const channel = optionalString(body['channel']);
        const direction = optionalDirection(body['direction']) ?? 'inbound';
        const limit = boundedMailboxPollLimit(body['limit']);
        const runtimeNamespace = legacyMailboxRuntimeNamespace(channel, this.deps.runtimeNamespace ?? 'default');
        const messages = runtimeNamespace === undefined
            ? []
            : this.deps.store.list({
                status: 'pending',
                runtimeNamespace,
                ...(type ? { type } : {}),
                direction,
                limit,
            }).map(v1Message);
        ctx.json(200, { messages, count: messages.length });
        return true;
    }
    async mailboxAck(ctx) {
        const body = asRecord(await ctx.readJson());
        const rawMessageIds = body['message_ids'];
        if (!Array.isArray(rawMessageIds))
            return badRequest(ctx, 'message_ids must be an array');
        const messageIds = [];
        for (const [index, value] of rawMessageIds.entries()) {
            const messageId = optionalString(value);
            if (!messageId)
                return badRequest(ctx, `message_ids[${index}] must be a non-empty string`);
            if (messageId.length > 512)
                return badRequest(ctx, `message_ids[${index}] is too long`);
            messageIds.push(messageId);
        }
        const runtimeNamespace = this.deps.runtimeNamespace ?? 'default';
        let acknowledged = 0;
        for (const messageId of messageIds) {
            const message = this.deps.store.getById(messageId);
            if (message?.direction !== 'inbound'
                || (!LOCAL_ACK_TYPES.has(message.type) && !isDirectDialogMessage(message))
                || message.status !== 'pending'
                || message.runtimeNamespace !== runtimeNamespace)
                continue;
            this.deps.store.complete(messageId, ctx.now);
            acknowledged += 1;
        }
        ctx.json(200, { acknowledged });
        return true;
    }
    dmList(ctx) {
        const limit = boundedLimit(ctx.url.searchParams.get('limit'));
        const offset = boundedOffset(ctx.url.searchParams.get('offset'));
        const messages = this.dmMessages({ newestFirst: true, includeOutbound: true })
            .slice(offset, offset + limit)
            .map(v1Message);
        ctx.json(200, { messages, count: messages.length });
        return true;
    }
    ensureTaskIntent(type, payload, key, now) {
        const candidate = mailbox.createEnvelope({
            id: facadeMessageId(type, key),
            type,
            payload,
            idempotencyKey: key,
            runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
            now,
        });
        const { stored } = this.deps.store.send(candidate);
        if (stored) {
            this.deps.store.defer(candidate.id, 'facade synchronous attempt in progress', now, this.timeoutMs() + DIRECT_ATTEMPT_RETRY_GRACE_MS);
            this.deps.notifyOutbound();
        }
        return { envelope: this.deps.store.getById(candidate.id) ?? candidate, created: stored };
    }
    async executeClaim(intent, key, taskId) {
        try {
            const claim = await this.deps.hub.task.claim(taskId);
            const claimId = optionalString(claim.claimId);
            if (!claimId)
                throw new FacadeProtocolError('Hub returned an invalid task claim result');
            return this.finalizeClaim(intent, key, taskId, claimId, this.deps.now());
        }
        catch (error) {
            this.recordTerminalIntentFailure(intent, key, error);
            throw error;
        }
    }
    async executeComplete(intent, successKey, taskId, claimId, assetId, resultPayload, startedAt) {
        try {
            await this.deps.hub.task.complete(claimId, resultPayload, { taskId, assetId });
            return this.finalizeComplete(intent, successKey, taskId, claimId, startedAt, this.deps.now());
        }
        catch (error) {
            this.recordTerminalIntentFailure(intent, intent.idempotencyKey, error);
            throw error;
        }
    }
    activeCompleteIntent(claimId) {
        return this.deps.store.list({
            type: 'task_complete',
            direction: 'outbound',
            runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
            newestFirst: true,
            limit: 10_000,
        }).find((message) => {
            const payload = asRecord(message.payload);
            return requiredValue(payload, 'claimId', 'claim_id') === claimId
                && (message.status === 'pending' || message.status === 'in_flight');
        });
    }
    facadeIntentForResult(result) {
        const intentType = result.type === 'task_claim_result' ? 'task_claim' : 'task_complete';
        const resultRef = taskResultRef(result);
        if (!resultRef)
            return undefined;
        return this.deps.store.list({
            type: intentType,
            direction: 'outbound',
            runtimeNamespace: result.runtimeNamespace,
            newestFirst: true,
            limit: 10_000,
        }).find((intent) => {
            if (!intent.idempotencyKey.startsWith(intentType === 'task_claim' ? TASK_CLAIM_PREFIX : TASK_COMPLETE_PREFIX))
                return false;
            const payload = asRecord(intent.payload);
            const taskId = requiredValue(payload, 'taskId', 'task_id');
            if (!taskId)
                return false;
            if (intentType === 'task_claim')
                return resultRef === `claim-${taskId}`;
            const claimId = requiredValue(payload, 'claimId', 'claim_id');
            return Boolean(claimId && resultRef === `complete-${claimId}`);
        });
    }
    finalizeClaim(intent, key, taskId, claimId, now) {
        const existing = processed(this.deps.store, key);
        if (existing) {
            this.completeIntent(intent.id, now);
            return existing;
        }
        const result = {
            task_id: taskId,
            claim_id: claimId,
            message_id: intent.id,
            status: 'pending',
            claim_status: 'claimed',
        };
        this.enqueueTaskResult('task_claim_result', result, intent, now);
        this.recordMetricOnce(`${key}:metrics`, now, () => {
            this.updateMetrics((metrics) => ({ ...metrics, tasks_claimed: metrics.tasks_claimed + 1, last_claim_at: now }));
        });
        this.deps.store.markProcessed(key, result, now);
        this.completeIntent(intent.id, now);
        return result;
    }
    finalizeComplete(intent, key, taskId, claimId, startedAt, now) {
        const existing = processed(this.deps.store, key);
        if (existing) {
            this.completeIntent(intent.id, now);
            return existing;
        }
        const result = {
            task_id: taskId,
            claim_id: claimId,
            message_id: intent.id,
            status: 'pending',
            completion_status: 'completed',
        };
        this.enqueueTaskResult('task_complete_result', result, intent, now);
        this.recordMetricOnce(`${key}:metrics`, now, () => this.recordCompletion(now, startedAt));
        this.deps.store.markProcessed(key, result, now);
        this.completeIntent(intent.id, now);
        return result;
    }
    enqueueTaskResult(type, payload, intent, now) {
        this.deps.store.send(mailbox.createEnvelope({
            id: facadeMessageId(type, intent.id),
            type,
            payload,
            correlationId: intent.id,
            replyTo: intent.id,
            idempotencyKey: `${intent.id}:result`,
            runtimeNamespace: intent.runtimeNamespace,
            now,
        }));
    }
    recordMetricOnce(key, now, record) {
        if (this.deps.store.isProcessed(key))
            return;
        record();
        this.deps.store.markProcessed(key, { recorded: true }, now);
    }
    recordTerminalIntentFailure(intent, key, error) {
        const classification = this.cacheTerminalIntentFailure(intent, key, error);
        if (!classification)
            return;
        const now = this.deps.now();
        this.deps.store.fail(intent.id, classification.message, now, 1);
    }
    cacheTerminalIntentFailure(intent, key, error) {
        const classification = classifyOperationError(error);
        if (classification.retryable || isDurablyRecoverableAuthError(error))
            return undefined;
        const current = this.deps.store.getById(intent.id);
        if (this.deps.store.isProcessed(key) || current?.status === 'done')
            return undefined;
        const now = this.deps.now();
        this.deps.store.markProcessed(terminalKey(key), classification, now);
        if (intent.type === 'task_complete') {
            this.recordMetricOnce(`${key}:failure_metrics`, now, () => {
                this.updateMetrics((metrics) => ({ ...metrics, tasks_failed: metrics.tasks_failed + 1 }));
            });
        }
        return classification;
    }
    completeIntent(id, now) {
        if (this.deps.store.getById(id)?.status === 'failed')
            this.deps.store.replayDlq(id, now);
        this.deps.store.complete(id, now);
    }
    enqueue(type, payload, now, idempotencyKey, stableMessageId = false) {
        const env = mailbox.createEnvelope({
            ...(stableMessageId && idempotencyKey !== undefined ? { id: facadeMessageId(type, idempotencyKey) } : {}),
            type,
            payload,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
            now,
        });
        const stored = this.deps.store.send(env).stored;
        if (stored && env.handler === 'proxy')
            this.deps.notifyOutbound();
        return { message_id: env.id, status: 'pending' };
    }
    getOrStart(pending, key, start) {
        const existing = pending.get(key);
        if (existing)
            return existing;
        const operation = start().finally(() => pending.delete(key));
        pending.set(key, operation);
        return operation;
    }
    messages(type, direction, opts = {}) {
        return this.deps.store.list({
            runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
            type,
            direction,
            ...(opts.status ? { status: opts.status } : {}),
            ...(opts.newestFirst ? { newestFirst: true } : {}),
            limit: 10_000,
        });
    }
    dmMessages(opts = {}) {
        return this.deps.store.list({
            runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
            typeDirections: [
                { type: 'dm', direction: 'inbound' },
                { type: 'dialog_message', direction: 'inbound' },
                ...(opts.includeOutbound ? [{ type: 'dm_outbound', direction: 'outbound' }] : []),
            ],
            ...(opts.status ? { status: opts.status } : {}),
            ...(opts.newestFirst ? { newestFirst: true } : {}),
            limit: 10_000,
        }).filter((message) => message.type !== 'dialog_message' || isDirectDialogMessage(message));
    }
    timeoutMs() {
        return this.deps.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    }
    loadMetrics() {
        const raw = asRecord(parseJson(this.deps.store.getState(TASK_METRICS_STATE_KEY)));
        return {
            tasks_received: finiteNonNegative(raw['tasks_received']),
            tasks_claimed: finiteNonNegative(raw['tasks_claimed']),
            tasks_completed: finiteNonNegative(raw['tasks_completed']),
            tasks_failed: finiteNonNegative(raw['tasks_failed']),
            last_claim_at: nullableNumber(raw['last_claim_at']),
            last_complete_at: nullableNumber(raw['last_complete_at']),
            avg_completion_ms: finiteNonNegative(raw['avg_completion_ms']),
            completion_times: Array.isArray(raw['completion_times'])
                ? raw['completion_times'].map(numberValue).filter((value) => value !== undefined).slice(-100)
                : [],
        };
    }
    updateMetrics(update) {
        this.deps.store.setState(TASK_METRICS_STATE_KEY, JSON.stringify(update(this.loadMetrics())));
    }
    observeReceivedTasks() {
        const metrics = this.loadMetrics();
        const observed = this.deps.store.countMessages({
            type: 'task_available', direction: 'inbound', runtimeNamespace: this.deps.runtimeNamespace ?? 'default',
        });
        if (observed <= metrics.tasks_received)
            return metrics;
        const updated = { ...metrics, tasks_received: observed };
        this.deps.store.setState(TASK_METRICS_STATE_KEY, JSON.stringify(updated));
        return updated;
    }
    recordCompletion(now, startedAt) {
        this.updateMetrics((metrics) => {
            const completionTimes = startedAt === undefined
                ? metrics.completion_times
                : [...metrics.completion_times, Math.max(0, now - startedAt)].slice(-100);
            const average = completionTimes.length === 0
                ? metrics.avg_completion_ms
                : Math.round(completionTimes.reduce((sum, value) => sum + value, 0) / completionTimes.length);
            return {
                ...metrics,
                tasks_completed: metrics.tasks_completed + 1,
                last_complete_at: now,
                avg_completion_ms: average,
                completion_times: completionTimes,
            };
        });
    }
}
function processed(store, key) {
    if (!store.isProcessed(key))
        return undefined;
    const value = store.getProcessed(key);
    return value && typeof value === 'object' ? value : undefined;
}
function v1Message(message) {
    return {
        id: message.id,
        message_id: message.id,
        channel: message.runtimeNamespace === 'default' ? 'evomap-hub' : message.runtimeNamespace,
        direction: message.direction,
        type: message.type === 'dm_outbound' || isDirectDialogMessage(message) ? 'dm' : message.type,
        status: message.status === 'done' ? (message.direction === 'inbound' ? 'delivered' : 'synced') : message.status,
        payload: message.payload,
        priority: message.priority,
        ref_id: message.replyTo ?? message.correlationId,
        created_at: message.createdAt,
        synced_at: message.status === 'done' ? message.updatedAt : null,
        expires_at: message.ttlAt,
        retry_count: message.attempts,
        next_retry_at: message.nextRetryAt,
        error: message.lastError,
    };
}
function writeOperationError(ctx, error) {
    writeOperationClassification(ctx, classifyOperationError(error));
}
function writeOperationClassification(ctx, classification) {
    ctx.json(classification.status, {
        error: classification.message,
        code: classification.code,
        retryable: classification.retryable,
    });
}
function classifyOperationError(error) {
    if (error instanceof FacadeTimeoutError)
        return { status: 504, code: 'timeout', message: 'Hub operation timed out', retryable: true };
    if (error instanceof FacadeProtocolError)
        return { status: 502, code: 'hub_error', message: error.message, retryable: false };
    if (error instanceof hub.PublishRejectedError) {
        const signature = `${error.status} ${error.message}`;
        if (/auth/i.test(signature))
            return { status: 401, code: 'unauthorized', message: 'Hub authentication failed', retryable: false };
        if (/forbidden|permission/i.test(signature))
            return { status: 403, code: 'forbidden', message: 'Hub permission denied', retryable: false };
        if (/not[_ -]?found|expired/i.test(signature))
            return { status: 404, code: 'not_found', message: 'Task or claim not found', retryable: false };
        if (/conflict|already[_ -]?claimed/i.test(signature))
            return { status: 409, code: 'conflict', message: 'Task state conflicts with this request', retryable: false };
        if (/rate[_ -]?limit|overload|too[_ -]?many/i.test(signature)) {
            return { status: 429, code: 'rate_limited', message: 'Hub rate limited the request', retryable: true };
        }
        const retryable = error.retryable === true
            || error.terminal === false
            || /\b5\d\d\b|temporar|unavailable|timeout|overload/i.test(signature);
        return { status: 502, code: 'hub_error', message: 'Hub collaboration operation failed', retryable };
    }
    const candidate = error;
    const status = numberValue(candidate?.statusCode) ?? numberValue(candidate?.status);
    const signature = `${String(candidate?.name ?? '')} ${String(candidate?.code ?? '')}`;
    if (status === 403 || /forbidden|permission/i.test(signature))
        return { status: 403, code: 'forbidden', message: 'Hub permission denied', retryable: false };
    if (status === 401 || /auth/i.test(signature))
        return { status: 401, code: 'unauthorized', message: 'Hub authentication failed', retryable: false };
    if (status === 404)
        return { status: 404, code: 'not_found', message: 'Task or claim not found', retryable: false };
    if (status === 409 || /conflict|already_claimed/i.test(signature))
        return { status: 409, code: 'conflict', message: 'Task state conflicts with this request', retryable: false };
    if (status === 429)
        return { status: 429, code: 'rate_limited', message: 'Hub rate limited the request', retryable: true };
    if ((status !== undefined && status >= 500) || candidate?.retryable === true
        || /HubUnreachable|HUB_UNREACHABLE|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch/i.test(signature)) {
        return { status: 502, code: 'hub_error', message: 'Hub collaboration operation failed', retryable: true };
    }
    // Unknown transport failures are retried from the durable intent; known authz/conflict failures returned above are terminal.
    return { status: 502, code: 'hub_error', message: 'Hub collaboration operation failed', retryable: true };
}
function isDurablyRecoverableAuthError(error) {
    const candidate = error;
    const status = numberValue(candidate?.statusCode) ?? numberValue(candidate?.status);
    return status === 401;
}
class FacadeTimeoutError extends Error {
}
class FacadeProtocolError extends Error {
}
async function withTimeout(operation, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new FacadeTimeoutError()), timeoutMs); }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function badRequest(ctx, error) {
    ctx.json(400, { error, code: 'invalid_request' });
    return true;
}
function forbidden(ctx, error) {
    ctx.json(403, { error, code: 'forbidden' });
    return true;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function requiredString(record, key) {
    const value = optionalString(record[key]);
    return value ? { ok: true, value } : { ok: false, error: `${key} is required` };
}
function requiredDmContent(value) {
    if (typeof value === 'string' && value.trim())
        return { ok: true, value };
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return { ok: true, value: value };
    return { ok: false, error: 'content is required' };
}
function requiredIdentifier(record, key) {
    const result = requiredString(record, key);
    if (!result.ok)
        return result;
    return result.value.length <= 512 ? result : { ok: false, error: `${key} is too long` };
}
function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function optionalDirection(value) {
    return value === 'inbound' || value === 'outbound' || value === 'local' ? value : undefined;
}
function legacyMailboxRuntimeNamespace(requestedChannel, runtimeNamespace) {
    if (requestedChannel === undefined || requestedChannel === 'evomap-hub' || requestedChannel === runtimeNamespace) {
        return runtimeNamespace;
    }
    return undefined;
}
function requiredValue(record, ...keys) {
    for (const key of keys) {
        const value = optionalString(record[key]);
        if (value)
            return value;
    }
    return undefined;
}
function isDirectDialogMessage(message) {
    return message.type === 'dialog_message' && asRecord(message.payload)['dialog_type'] === 'direct_message';
}
function pendingClaim(messageId, taskId) {
    return { task_id: taskId, message_id: messageId, status: 'pending', claim_status: 'pending' };
}
function pendingComplete(messageId, taskId, claimId) {
    return { task_id: taskId, claim_id: claimId, message_id: messageId, status: 'pending', completion_status: 'pending' };
}
function taskResultRef(envelope) {
    return optionalString(envelope.replyTo)
        ?? requiredValue(asRecord(envelope.payload), 'ref_id', 'refId');
}
function completeSuccessKey(claimId) {
    return TASK_COMPLETE_PREFIX + claimId;
}
function completeAttemptKey(taskId, claimId, assetId, result) {
    return `${completeSuccessKey(claimId)}:attempt:${stableHash({ taskId, claimId, assetId, result })}`;
}
function canonicalTaskResultEnvelope(type, payload, intent, now) {
    return mailbox.createEnvelope({
        id: facadeMessageId(type, intent.id),
        type,
        payload,
        correlationId: intent.id,
        replyTo: intent.id,
        idempotencyKey: `${intent.id}:result`,
        runtimeNamespace: intent.runtimeNamespace,
        now,
    });
}
function boundedOptionalString(value, maxLength) {
    const parsed = optionalString(value);
    return parsed?.slice(0, maxLength);
}
function boundedLimit(value) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(numberValue(value) ?? DEFAULT_LIMIT)));
}
function boundedMailboxPollLimit(value) {
    return Math.max(1, Math.min(50, Math.floor(numberValue(value) ?? 10)));
}
function boundedOffset(value) {
    return Math.max(0, Math.min(10_000, Math.floor(numberValue(value) ?? 0)));
}
function numberValue(value) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}
function finiteNonNegative(value) {
    return Math.max(0, Math.floor(numberValue(value) ?? 0));
}
function nullableNumber(value) {
    return numberValue(value) ?? null;
}
function parseJson(value) {
    if (!value)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function stableHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}
function facadeMessageId(type, idempotencyKey) {
    return `compat:${type}:${stableHash(idempotencyKey)}`;
}
function terminalKey(key) {
    return `${key}:terminal`;
}