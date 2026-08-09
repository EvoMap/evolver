import { createHash } from 'node:crypto';
import { bootstrap, hub as hubNs, signals } from '@evomap/evolver-core';
import { AuthError, HubFetch, HubClientError, isHubUnreachableError } from './hubFetch.js';
import { isNodeSecret, parseNodeSecretVersion } from './auth/legacyShim.js';
import { inboundToAgentEvent, agentEventToOutbound, publishRespToReceipt, searchQueryToFetchWire, searchQueryToSearchOnlyWire, } from './wireMap.js';
import { antiAbuseTelemetryMode, buildHeartbeatAntiAbuseTelemetry, } from './antiAbuseTelemetry.js';
import { getWorkspaceKeychainMode } from './auth/workspaceKeychain.js';
import { agentDirectoryFailure, parsePublicAgentPage, parsePublicAgentProfile, paginatePublicAgentPage, mergePublicAgentPages, publicAgentSearchQuery, publicTaskDiscoveryQuery, PUBLIC_TASK_DISCOVERY_MAX_CANDIDATES, unsupportedPublicAvailability, unsupportedPublicSort, withDirectoryTimeout, } from './agentDirectory.js';
import { assetMatchesId } from './hubReuse.js';
export const INBOUND_LIMIT = 100;
export const OUTBOUND_MAX_BATCH = 50;
export const OUTBOUND_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const PUBLIC_PROTOCOL_VERSION = 'gep-a2a/1.0.0';
export const PUBLIC_HUB_CAPABILITIES = ['publish', 'fetch', 'search', 'task', 'mailbox', 'auth', 'marketplace', 'economy', 'questions', 'recipes', 'agent_directory', 'learning_assets'];
const QUESTION_SUBMIT_FAST_PATH_BYPASS_CONTENT_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const DRY_RUN_RECIPE_ID = 'dry-run-recipe';
const HUB_DRY_RUN_VALUES = new Set(['1', 'true', 'yes', 'on']);
// Mirror the hub's /a2a/memory/record input bounds so an oversized claim list is
// trimmed client-side instead of being silently dropped server-side: what we SEND
// equals what the hub will KEEP.
export const USED_ASSET_IDS_MAX = 50;
export const USED_ASSET_ID_MAX_LEN = 200;
export const LEARNING_ASSET_IDS_MAX = 50;
export const LEARNING_ASSET_ID_MAX_LEN = 128;
/** 完整 GEP-A2A 信封(实测 dev: publish/fetch/validate 等协议消息端点必须全信封, 非仅 protocol+message_type). */
export function gepEnvelope(messageType, payload, options = {}) {
    return {
        protocol: 'gep-a2a', protocol_version: '1.0.0', message_type: messageType,
        message_id: options.messageId ?? `msg_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        timestamp: new Date().toISOString(), payload,
    };
}
function stablePublishMessageId(idempotencyKey) {
    const digest = createHash('sha256')
        .update(idempotencyKey.trim())
        .digest('hex')
        .slice(0, 40);
    return `msg_idem_${digest}`;
}
// v1 a2aProtocol.js L1999-2003: the three app-level rejection reasons that mean
// our cached node_secret has DIVERGED from the hub's record (hub-side reset,
// restored-from-backup machine, manual unlink) — not a transport/generic failure.
// Retrying with a diverged secret can never succeed; the only recovery is to drop
// the local secret and re-hello unauthenticated.
const NODE_SECRET_DIVERGENCE_REASONS = ['node_secret_invalid', 'rotation_requires_current_secret', 'invalid_secret'];
/**
 * Detect the hub's HTTP-200 app-level secret-divergence rejection. v1 keys on
 * status:"rejected" (top-level OR payload) AND a reason containing one of the
 * three divergence markers. Mirrors a2aProtocol.js L1993-2003.
 */
function isSecretDivergenceRejection(body, payload) {
    const rejected = body['status'] === 'rejected' || payload['status'] === 'rejected';
    if (!rejected)
        return false;
    const reason = String(payload['reason'] ?? body['reason'] ?? '').toLowerCase();
    return NODE_SECRET_DIVERGENCE_REASONS.some((marker) => reason.includes(marker));
}
export function isHubDryRunEnabled(env = process.env) {
    return HUB_DRY_RUN_VALUES.has(String(env['HUB_DRY_RUN'] ?? '').trim().toLowerCase());
}
export function outboundMaxBodyBytes(env = process.env) {
    for (const key of [
        'EVOLVER_HUB_MAILBOX_OUTBOUND_MAX_BODY_BYTES',
        'EVOMAP_OUTBOUND_SYNC_MAX_BODY_BYTES',
        'EVOMAP_MAILBOX_OUTBOUND_MAX_BODY_BYTES',
    ]) {
        const raw = Number(env[key]);
        if (Number.isSafeInteger(raw) && raw > 0)
            return raw;
    }
    return OUTBOUND_MAX_BODY_BYTES;
}
function traceOutboundMaxBodyBytes(env = process.env) {
    const mailboxLimit = outboundMaxBodyBytes(env);
    for (const key of [
        'EVOLVER_LLM_TRACE_MAX_UPLOAD_BYTES',
        'EVOMAP_PROXY_TRACE_MAX_UPLOAD_BYTES',
        'EVOLVER_LLM_TRACE_ENVELOPE_MAX_CHARS',
        'EVOMAP_PROXY_TRACE_ENVELOPE_MAX_BYTES',
    ]) {
        const raw = Number(env[key]);
        if (Number.isSafeInteger(raw) && raw > 0)
            return Math.min(raw, mailboxLimit);
    }
    return mailboxLimit;
}
/**
 * 公版 hub 的 HubCapability 实现(M6-6). 打 /a2a/{publish,fetch,mailbox/*,events/poll}.
 * 唯一懂公版 wire shape 的地方; 经 wireMap 规约成 core 类型. 真链路冒烟在 M6-7(dev.evomap.ai).
 */
export class PublicHubCapability {
    opts;
    http;
    auth;
    recipes = {
        create: async (request) => this.createRecipe(request),
        publish: async (recipeId, options) => this.publishRecipe(recipeId, options),
        get: async (recipeId) => this.getRecipe(recipeId),
        express: async (recipeId, request = {}) => this.expressRecipe(recipeId, request),
    };
    constructor(opts) {
        this.opts = opts;
        this.auth = opts.auth;
        this.http = new HubFetch({ baseUrl: opts.baseUrl, auth: opts.auth, fetchFn: opts.fetchFn, senderId: opts.senderId });
    }
    evolverVersionForWire(explicitVersion) {
        const antiAbuse = this.opts.antiAbuse;
        return bootstrap.normalizeEvolverVersion(explicitVersion !== undefined
            ? explicitVersion
            : antiAbuse?.evolverVersion ?? antiAbuse?.envFingerprint?.evolver_version);
    }
    envFingerprintForWire(evolverVersion) {
        const fingerprint = {
            ...(this.opts.antiAbuse?.envFingerprint
                ?? bootstrap.captureEnvFingerprint({ env: this.opts.antiAbuse?.env ?? process.env })),
        };
        if (evolverVersion)
            fingerprint.evolver_version = evolverVersion;
        else
            delete fingerprint.evolver_version;
        return fingerprint;
    }
    async hello(opts) {
        try {
            const sender = this.opts.senderId();
            const evolverVersion = this.evolverVersionForWire(opts.evolverVersion);
            const body = await this.http.call('POST', '/a2a/hello', gepEnvelope('hello', {
                rotate_secret: opts.rotate,
                capabilities: { supported_types: ['publish', 'fetch', 'mailbox', 'questions'] },
                agent_name: '@evomap/evolver-proxy',
                status: 'active',
                timestamp: new Date().toISOString(),
                ...(sender ? { node_id: sender } : {}),
                ...(evolverVersion ? { evolver_version: evolverVersion } : {}),
                // v1 parity (a2aProtocol.js buildHello): every hello carries the env fingerprint — it is how the
                // hub builds node/IP trust for its anti-abuse layer. v2 had moved it to heartbeat-only meta, which
                // one-shot CLI paths never send; the hub then answers heartbeats with resend_hello
                // `missing_env_fingerprint` and 403-antibodies /a2a/fetch (#555).
                env_fingerprint: this.envFingerprintForWire(evolverVersion),
            }));
            const payload = asRecord(body['payload']) ?? body;
            const retryAfterMs = numberField(payload, 'retry_after_ms') ?? numberField(payload, 'retryAfterMs');
            const rateLimitUntilMs = numberField(payload, 'rate_limit_until_ms') ?? numberField(payload, 'rateLimitUntilMs');
            // Secret-divergence recovery (v1 a2aProtocol.js L1983-2017). The hub HTTP-200'd an app-level
            // rejection of our cached node_secret (status:"rejected" + a divergence reason), meaning the
            // local secret has DRIFTED from the hub's record. Checked BEFORE the generic error early-return
            // because the hub may carry both `error` and `status:"rejected"`. Clearing the secret (in-memory
            // + durable via the auth handler) lets the next hello fall back to unauthenticated, which recovers
            // cleanly; retrying with the diverged secret never can. Signals the caller NOT to arm reauth
            // backoff. Only legacy node_secret auth exposes this hook — enterprise_token is a no-op.
            if (isSecretDivergenceRejection(body, payload)) {
                if (!opts.preserveCredentials) {
                    this.auth.notifyNodeSecretDiverged?.();
                }
                return {
                    ok: false,
                    error: opts.preserveCredentials ? 'secret_diverged' : 'secret_diverged_cleared',
                    secretDiverged: true,
                    ...(rateLimitUntilMs !== undefined ? { rateLimitUntilMs } : {}),
                    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                };
            }
            if (payload['error'])
                return { ok: false, error: String(payload['error']), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(rateLimitUntilMs !== undefined ? { rateLimitUntilMs } : {}) };
            const nodeId = stringField(payload, 'your_node_id')
                ?? stringField(payload, 'node_id')
                ?? stringField(payload, 'nodeId')
                ?? stringField(payload, 'id')
                ?? stringField(payload, 'senderId')
                ?? this.opts.senderId();
            const nodeSecret = stringField(payload, 'node_secret') ?? stringField(payload, 'nodeSecret');
            const nodeSecretVersion = parseNodeSecretVersion(payload['node_secret_version'] ?? payload['nodeSecretVersion']);
            const claimCode = stringField(payload, 'claim_code') ?? stringField(payload, 'claimCode');
            const claimUrl = stringField(payload, 'claim_url') ?? stringField(payload, 'claimUrl');
            if (!opts.preserveCredentials) {
                if (nodeSecret && isNodeSecret(nodeSecret)) {
                    this.auth.adoptNodeSecret?.(nodeSecret, nodeSecretVersion);
                }
                else {
                    this.auth.adoptNodeSecretVersion?.(nodeSecretVersion);
                }
            }
            return {
                ok: payload['ok'] !== false && Boolean(nodeId),
                ...(nodeId ? { nodeId } : {}),
                ...(claimCode ? { claimCode } : {}),
                ...(claimUrl ? { claimUrl } : {}),
                ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
                ...(rateLimitUntilMs !== undefined ? { rateLimitUntilMs } : {}),
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            };
        }
        catch (err) {
            if (err instanceof AuthError)
                return { ok: false, authError: true, error: `hub auth error ${err.status}`, httpStatus: err.status };
            if (err instanceof HubClientError)
                return helloResultFromBody(err.status, asRecord(err.body) ?? {});
            if (isHubUnreachableError(err))
                return { ok: false, error: 'hub_unreachable', retryAfterMs: hubUnreachableRetryAfterMs(err) };
            throw err;
        }
    }
    async heartbeat(opts = {}) {
        try {
            const nodeSecretVersion = this.auth.getNodeSecretVersion?.();
            const evolverVersion = this.evolverVersionForWire(opts.evolverVersion);
            const meta = this.heartbeatMeta(evolverVersion, nodeSecretVersion);
            const body = await this.http.call('POST', '/a2a/heartbeat', {
                ...(this.opts.senderId() ? { node_id: this.opts.senderId() } : {}),
                timestamp: new Date().toISOString(),
                status: 'active',
                ...(evolverVersion ? { evolver_version: evolverVersion } : {}),
                ...(opts.lastUpdate ? { last_update: opts.lastUpdate } : {}),
                ...(nodeSecretVersion !== undefined ? { node_secret_version: nodeSecretVersion } : {}),
                ...(meta ? { meta } : {}),
            });
            return heartbeatResultFromBody(200, body);
        }
        catch (err) {
            if (err instanceof AuthError)
                return { ok: false, authError: true, error: `hub auth error ${err.status}` };
            if (err instanceof HubClientError)
                return heartbeatResultFromBody(err.status, asRecord(err.body) ?? {});
            if (isHubUnreachableError(err))
                return { ok: false, error: 'hub_unreachable', retryAfterMs: hubUnreachableRetryAfterMs(err) };
            throw err;
        }
    }
    heartbeatMeta(evolverVersion, nodeSecretVersion) {
        const meta = {};
        if (nodeSecretVersion !== undefined)
            meta['node_secret_version'] = nodeSecretVersion;
        const antiAbuse = this.opts.antiAbuse ?? {};
        if (antiAbuseTelemetryMode(antiAbuse.env) === 'heartbeat') {
            try {
                meta['anti_abuse'] = buildHeartbeatAntiAbuseTelemetry({
                    ...antiAbuse,
                    nodeId: this.opts.senderId(),
                    evolverVersion,
                });
            }
            catch (err) {
                if (getWorkspaceKeychainMode(antiAbuse.env) === 'force')
                    throw err;
                process.stderr.write('[anti-abuse] failed to build heartbeat telemetry; continuing without heartbeat meta\n');
            }
        }
        return Object.keys(meta).length > 0 ? meta : undefined;
    }
    async publish(bundle, options = {}) {
        const normalizedIdempotencyKey = options.idempotencyKey?.trim();
        if (options.idempotencyKey !== undefined && !normalizedIdempotencyKey) {
            return {
                receiptId: 'local_invalid_idempotency_key',
                status: 'rejected',
                terminal: true,
                reason: 'publish idempotency key must not be blank',
            };
        }
        try {
            // 公版 /a2a/publish 收 payload.assets=[Gene,Capsule,(Event)] 捆绑(实测 dev).
            const idempotencyKey = normalizedIdempotencyKey;
            const messageId = idempotencyKey !== undefined
                ? stablePublishMessageId(idempotencyKey)
                : undefined;
            const body = await this.http.call('POST', '/a2a/publish', gepEnvelope('publish', { assets: bundle }, messageId ? { messageId } : {}));
            return publishRespToReceipt(200, body);
        }
        catch (e) {
            if (e instanceof HubClientError) {
                return publishRespToReceipt(e.status, e.body ?? {}, e.retryAfterMs);
            }
            throw e; // 5xx/网络 → 重试
        }
    }
    async fetch(query) {
        // #69: map camelCase SearchQuery → hub snake_case wire (signalsAny → signals) before sending.
        // /a2a/fetch responses are FULL GEP envelopes (buildResponse('fetch', …)); the rows live at payload.results,
        // NOT at the top level. Reading body.results here always yielded [] — every fetch silently returned nothing.
        const body = await this.http.call('POST', '/a2a/fetch', gepEnvelope('fetch', searchQueryToFetchWire(query)));
        return assetsFromBody(body);
    }
    async fetchAssetById(assetId) {
        const id = assetId.trim();
        if (!id)
            return null;
        const body = await this.http.call('POST', '/a2a/fetch', gepEnvelope('fetch', { asset_ids: [id] }));
        return assetsFromBody(body).find((asset) => fetchResultMatchesId(asset, id)) ?? null;
    }
    /**
     * #69: search != fetch. Free-text is the hub's vector endpoint (GET /a2a/assets/semantic-search?q=);
     * signal/id queries use the Hub's free search-only phase on /a2a/fetch. /a2a/fetch does NOT do semantic,
     * so text must not go there and paid/full fetch must remain an explicit follow-up.
     */
    async search(query) {
        if (query.text && query.text.trim()) {
            // GET /a2a/assets/semantic-search returns a FLAT object keyed `assets` (no GEP envelope), plus a
            // `search_status` (found / degraded(retryable) / low_confidence_only / no_match). Only an explicit
            // no_match is a verified empty result; degraded or malformed 200 responses must not trigger ATP spend.
            const body = await this.http.call('GET', '/a2a/assets/semantic-search', undefined, {
                q: query.text,
                ...(query.kind !== undefined ? { type: query.kind } : {}),
                ...(query.domain !== undefined ? { domain: query.domain } : {}),
                ...(query.limit !== undefined ? { limit: query.limit } : {}),
            });
            return semanticSearchAssets(body);
        }
        const body = await this.http.call('POST', '/a2a/fetch', gepEnvelope('fetch', searchQueryToSearchOnlyWire(query)));
        return signalSearchAssets(body);
    }
    agentDirectory = {
        search: async (request) => {
            try {
                const normalized = hubNs.normalizeAgentSearchRequest(request);
                const unsupported = unsupportedPublicAvailability(normalized.availability) ?? unsupportedPublicSort(normalized.sort);
                if (unsupported)
                    return unsupported;
                const body = await withDirectoryTimeout(this.http.call('GET', '/a2a/directory/search', undefined, publicAgentSearchQuery(normalized)), normalized.timeoutMs);
                return paginatePublicAgentPage(parsePublicAgentPage(body), normalized);
            }
            catch (error) {
                return agentDirectoryFailure(error);
            }
        },
        getProfile: async (agentId, options) => {
            try {
                const normalizedId = hubNs.normalizeAgentId(agentId);
                const timeoutMs = hubNs.normalizeAgentDirectoryTimeout(options?.timeoutMs);
                const body = await withDirectoryTimeout(this.http.call('GET', `/a2a/directory/profile/${encodeURIComponent(normalizedId)}`), timeoutMs);
                return parsePublicAgentProfile(body);
            }
            catch (error) {
                if (error instanceof HubClientError && error.status === 404)
                    return { ok: true, value: null };
                return agentDirectoryFailure(error);
            }
        },
        discoverForTask: async (request) => {
            try {
                const normalized = hubNs.normalizeAgentTaskDiscoveryRequest(request);
                const unsupported = unsupportedPublicAvailability(normalized.availability) ?? unsupportedPublicSort(normalized.sort);
                if (unsupported)
                    return unsupported;
                const taskQuery = [normalized.title, normalized.description].filter(Boolean).join('\n');
                const searches = [
                    this.http.call('GET', '/a2a/directory/search', undefined, publicAgentSearchQuery({
                        query: taskQuery,
                        ...(normalized.availability ? { availability: normalized.availability } : {}),
                    })),
                ];
                if (normalized.signals && normalized.signals.length > 0) {
                    searches.push(this.http.call('GET', '/a2a/directory/search', undefined, publicTaskDiscoveryQuery(normalized)));
                }
                const bodies = await withDirectoryTimeout(Promise.all(searches), normalized.timeoutMs);
                return paginatePublicAgentPage(mergePublicAgentPages(bodies.map(parsePublicAgentPage)), normalized, searches.length > 1 ? PUBLIC_TASK_DISCOVERY_MAX_CANDIDATES : hubNs.AGENT_DIRECTORY_MAX_LIMIT);
            }
            catch (error) {
                return agentDirectoryFailure(error);
            }
        },
    };
    async listAccountAssets(opts) {
        const path = opts.scope === 'purchased' ? '/a2a/assets/purchased' : '/a2a/assets/published-by-me';
        const query = {
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
            ...(opts.type ? { type: opts.type } : {}),
            ...(opts.scope === 'published' && opts.status && opts.status !== 'all' ? { status: opts.status } : {}),
        };
        const body = await this.http.call('GET', path, undefined, query);
        const payload = asRecord(body['payload']) ?? body;
        const assets = accountAssetsFromPayload(payload);
        const count = numberField(payload, 'count');
        const nextCursor = stringField(payload, 'next_cursor') ?? stringField(payload, 'nextCursor');
        const hasMore = booleanField(payload, 'has_more') ?? booleanField(payload, 'hasMore') ?? Boolean(nextCursor);
        return {
            assets,
            ...(count !== undefined ? { count } : {}),
            hasMore,
            ...(nextCursor ? { nextCursor } : {}),
        };
    }
    /**
     * Report a cycle outcome to the hub's memory graph (POST /a2a/memory/record).
     * Unlike the protocol-message endpoints (publish/fetch), memory/record takes a
     * FLAT body — no GEP envelope. Reporting is observability for the network's
     * attribution loop, never a dependency of the cycle itself, so this method
     * NEVER throws: auth/4xx/5xx/network failures all degrade to `recorded:false`.
     * Costs hub credits per the hub's memory pricing (caller gates on enablement).
     */
    async recordOutcome(report) {
        const signals = report.signals.map((s) => String(s).trim()).filter(Boolean);
        if (signals.length === 0)
            return { recorded: false, reason: 'no_signals' }; // hub rejects empty signals; skip the paid call
        const usedAssetIds = [...new Set((report.usedAssetIds ?? []).filter((x) => typeof x === 'string' && x.length > 0 && x.length <= USED_ASSET_ID_MAX_LEN))].slice(0, USED_ASSET_IDS_MAX);
        try {
            await this.http.call('POST', '/a2a/memory/record', {
                signals,
                status: report.status,
                ...(report.geneId ? { gene_id: report.geneId } : {}),
                ...(report.score !== undefined ? { score: report.score } : {}),
                ...(report.summary ? { summary: report.summary } : {}),
                ...(usedAssetIds.length > 0 ? { used_asset_ids: usedAssetIds } : {}),
            });
            return { recorded: true };
        }
        catch (e) {
            return { recorded: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
    async recordMemoryEvent(report) {
        const sender = this.opts.senderId()?.trim();
        if (!sender)
            return { recorded: false, reason: 'sender_id_required' };
        const event = asRecord(report.event);
        if (!event)
            return { recorded: false, reason: 'event_required' };
        try {
            await this.http.call('POST', '/a2a/memory/event', {
                sender_id: sender,
                event: { ...event, kind: report.kind },
            });
            return { recorded: true };
        }
        catch (e) {
            return { recorded: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
    async recordReuseResult(report) {
        const assetId = report.assetId.trim();
        if (!assetId)
            return { recorded: false, reason: 'asset_id_required' };
        const tokensSaved = optionalReuseMetric(report, 'tokensSaved', 'tokens_saved', 'invalid_tokens_saved');
        if ('reason' in tokensSaved)
            return { recorded: false, reason: tokensSaved.reason };
        const timeSavedSeconds = optionalReuseMetric(report, 'timeSavedSeconds', 'time_saved_seconds', 'invalid_time_saved_seconds');
        if ('reason' in timeSavedSeconds)
            return { recorded: false, reason: timeSavedSeconds.reason };
        try {
            const body = await this.http.call('POST', `/a2a/assets/${encodeURIComponent(assetId)}/reuse-result`, {
                asset_id: assetId,
                outcome: report.outcome,
                ...(report.taskId ? { task_id: report.taskId } : {}),
                ...(report.traceId ? { trace_id: report.traceId } : {}),
                ...(timeSavedSeconds.value !== undefined ? { time_saved_seconds: timeSavedSeconds.value } : {}),
                ...(report.reason ? { reason: report.reason } : {}),
            });
            const payload = asRecord(body['payload']) ?? body;
            return {
                recorded: payload['recorded'] !== false && payload['ok'] !== false,
                ...(stringField(payload, 'reason') ?? stringField(payload, 'error') ? { reason: stringField(payload, 'reason') ?? stringField(payload, 'error') } : {}),
                ...(stringField(payload, 'id') ?? stringField(payload, 'receipt_id') ? { id: stringField(payload, 'id') ?? stringField(payload, 'receipt_id') } : {}),
            };
        }
        catch (e) {
            return { recorded: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
    async listLearningAssets(options = {}) {
        const limit = normalizeLearningAssetLimit(options.limit);
        if (!this.opts.senderId()?.trim())
            return { assets: [], limit, reason: 'sender_id_required' };
        try {
            const body = await this.http.call('GET', '/a2a/learning-assets', undefined, learningAssetListQuery(options, limit));
            const payload = asRecord(body['payload']) ?? body;
            return {
                assets: learningAssetsFromPayload(payload),
                limit: numberField(payload, 'limit') ?? limit,
            };
        }
        catch (e) {
            return { assets: [], limit, reason: failureReason(e) };
        }
    }
    async recordLearningAssetUsage(report) {
        if (!this.opts.senderId()?.trim())
            return { recorded: false, reason: 'sender_id_required', results: [] };
        const sourceEventId = trimStringField(report.sourceEventId, 160);
        if (!sourceEventId)
            return { recorded: false, reason: 'source_event_id_required', results: [] };
        const assetIds = normalizeLearningAssetIds(report.usedAssetIds && report.usedAssetIds.length > 0 ? report.usedAssetIds : [report.assetId]);
        if (assetIds.length === 0)
            return { recorded: false, reason: 'asset_id_required', results: [] };
        const outcome = normalizeLearningAssetOutcome(report.outcome);
        if (!outcome)
            return { recorded: false, reason: 'invalid_learning_asset_outcome', results: [] };
        const score = optionalLearningAssetScore(report.score);
        if ('reason' in score)
            return { recorded: false, reason: score.reason, results: [] };
        const reason = trimStringField(report.reason, 2_000);
        try {
            const body = await this.http.call('POST', '/a2a/learning-assets/usage', {
                ...(assetIds.length === 1 ? { asset_id: assetIds[0] } : { used_asset_ids: assetIds }),
                outcome,
                source_event_id: sourceEventId,
                ...(score.value !== undefined ? { score: score.value } : {}),
                ...(reason ? { reason } : {}),
            });
            return learningAssetUsageReceiptFromBody(body);
        }
        catch (e) {
            return { recorded: false, reason: failureReason(e), results: [] };
        }
    }
    /**
     * Pre-publish dry-run (POST /a2a/validate). The hub runs the same hub-side quality +
     * content-safety gate as publish but stores nothing and charges no credits. This adapter is
     * the raw HubCapability; proxy-facing callers sanitize/leak-check before invoking it so the
     * public tool matches publish's local egress guard. Like publish, the payload is the
     * {assets:[…]} bundle wrapped in a FULL GEP-A2A envelope — /a2a/validate is a strict protocol endpoint
     * (validateProtocol(["validate","publish"])) and 400s on a bare body. A dry-run is never
     * a dependency of the cycle, so this NEVER throws: quality reject (400) / content-safety
     * reject (422) / 5xx / network all degrade to { valid:false, reason }.
     */
    async validate(bundle) {
        try {
            const body = await this.http.call('POST', '/a2a/validate', gepEnvelope('validate', { assets: bundle }));
            // Success is a GEP envelope: buildResponse('decision', { valid, reason, … }) — read payload.valid.
            const payload = asRecord(body['payload']) ?? body;
            const reason = stringField(payload, 'reason') ?? stringField(payload, 'error');
            return {
                valid: payload['valid'] !== false && payload['ok'] !== false,
                ...(reason ? { reason } : {}),
                raw: payload,
            };
        }
        catch (e) {
            // 400 quality_reject / 422 content_safety_rejected come back as HubClientError with the hub's JSON body.
            if (e instanceof HubClientError) {
                const errBody = asRecord(e.body) ?? {};
                const payload = asRecord(errBody['payload']) ?? errBody;
                const reason = stringField(payload, 'reason') ?? stringField(payload, 'error') ?? `hub ${e.status}`;
                return { valid: false, reason, raw: payload };
            }
            return { valid: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
    async createRecipe(request) {
        if (isHubDryRunEnabled()) {
            return dryRunRecipeReceipt('create_recipe', DRY_RUN_RECIPE_ID, {
                request: {
                    title: request.title,
                    steps: request.steps.map(recipeStepToWire),
                    ...(request.description ? { description: request.description } : {}),
                    ...(request.pricePerExecution !== undefined ? { price_per_execution: request.pricePerExecution } : {}),
                    ...(request.currency ? { currency: request.currency } : {}),
                    ...(request.maxConcurrent !== undefined ? { max_concurrent: request.maxConcurrent } : {}),
                },
            });
        }
        const sender = this.opts.senderId();
        const body = await this.http.call('POST', '/a2a/recipe', {
            ...(sender ? { node_id: sender } : {}),
            title: request.title,
            steps: request.steps.map(recipeStepToWire),
            ...(request.description ? { description: request.description } : {}),
            ...(request.pricePerExecution !== undefined ? { price_per_execution: request.pricePerExecution } : {}),
            ...(request.currency ? { currency: request.currency } : {}),
            ...(request.maxConcurrent !== undefined ? { max_concurrent: request.maxConcurrent } : {}),
        }, undefined, request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : undefined);
        return recipeReceiptFromBody(body);
    }
    async publishRecipe(recipeId, options) {
        if (isHubDryRunEnabled())
            return dryRunRecipeReceipt('publish_recipe', recipeId);
        const sender = this.opts.senderId();
        const body = await this.http.call('POST', `/a2a/recipe/${encodeURIComponent(recipeId)}/publish`, { ...(sender ? { node_id: sender } : {}) }, undefined, options?.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : undefined);
        return recipeReceiptFromBody(body);
    }
    async getRecipe(recipeId) {
        if (isHubDryRunEnabled()) {
            return {
                ...dryRunRecipeReceipt('get_recipe', recipeId),
                recipe: { id: recipeId, dry_run: true },
            };
        }
        const body = await this.http.call('GET', `/a2a/recipe/${encodeURIComponent(recipeId)}`);
        const recipe = recipeFromBody(body);
        return {
            ...recipeReceiptFromBody(body),
            ...(recipe !== undefined ? { recipe } : {}),
        };
    }
    async expressRecipe(recipeId, request = {}) {
        if (isHubDryRunEnabled()) {
            return dryRunRecipeReceipt('express_recipe', recipeId, { input_payload: request.inputPayload ?? {} });
        }
        const sender = this.opts.senderId();
        const body = await this.http.call('POST', `/a2a/recipe/${encodeURIComponent(recipeId)}/express`, {
            ...(sender ? { node_id: sender } : {}),
            input_payload: request.inputPayload ?? {},
        });
        const payload = recipePayload(body);
        const organismId = recipeOrganismIdFromPayload(payload);
        const receipt = recipeReceiptFromBody(body);
        return {
            ...receipt,
            recipeId: receipt.recipeId ?? recipeId,
            ...(organismId ? { organismId } : {}),
        };
    }
    task = {
        claim: async (taskId) => {
            const event = {
                id: `claim-${taskId}`,
                type: 'task_claim',
                payload: { task_id: taskId },
                priority: 'medium',
                createdAt: Date.now(),
            };
            const body = await this.http.call('POST', '/a2a/mailbox/outbound', { messages: [{ id: event.id, type: event.type, payload: event.payload }] });
            assertMailboxPushAccepted(mailboxPushResultFromBody(body, [event]).outcomes[0]);
            return { claimId: event.id };
        },
        complete: async (claimId, _result, context) => {
            if (typeof context?.taskId !== 'string' || !context.taskId.trim()
                || typeof context.assetId !== 'string' || !context.assetId.trim()) {
                throw new hubNs.PublishRejectedError('invalid_task_completion', true, 'task completion requires explicit taskId and assetId', undefined, false);
            }
            const event = {
                id: `complete-${claimId}`,
                type: 'task_complete',
                payload: { task_id: context.taskId, asset_id: context.assetId },
                priority: 'medium',
                createdAt: Date.now(),
            };
            const body = await this.http.call('POST', '/a2a/mailbox/outbound', { messages: [{ id: event.id, type: event.type, payload: event.payload }] });
            assertMailboxPushAccepted(mailboxPushResultFromBody(body, [event]).outcomes[0]);
            return { status: 'completed' };
        },
        subscribe: (filter) => this.subscribeTasks(filter),
    };
    questions = {
        submit: async (questions) => this.submitQuestions(questions),
    };
    async submitQuestions(questions) {
        const payloadQuestions = questions
            .map(normalizeQuestion)
            .filter((q) => q !== null);
        if (payloadQuestions.length === 0)
            return [];
        const body = await this.http.call('POST', '/a2a/fetch', gepEnvelope('fetch', {
            tasks_only: true,
            include_tasks: true,
            // Current Hub creates payload.questions only after the tasks_only fast path.
            // A nonexistent direct asset lookup bypasses that path while still returning
            // no fetch rows or reuse credit.
            content_hash: QUESTION_SUBMIT_FAST_PATH_BYPASS_CONTENT_HASH,
            questions: payloadQuestions,
        }));
        return questionReceiptsFromBody(body);
    }
    async *subscribeTasks(_filter) {
        // 公版只有 /a2a/events/poll(短/长轮询). 单次拉取转 TaskEvent; 节奏由调用方驱动.
        const body = await this.http.call('POST', '/a2a/events/poll', gepEnvelope('events_poll', { timeout_ms: 1000 }));
        for (const e of body.events ?? []) {
            if (String(e['type']).startsWith('task_')) {
                const payload = asRecord(e['payload']);
                const wireTaskId = payload?.['task_id'] ?? payload?.['taskId'];
                const taskId = typeof wireTaskId === 'string' && wireTaskId.length > 0 ? wireTaskId : String(e['id']);
                yield { taskId, type: String(e['type']), payload: e['payload'], priority: e['priority'] ?? 'medium', createdAt: Date.parse(String(e['created_at'] ?? '')) || 0 };
            }
        }
    }
    mailbox = {
        poll: async () => {
            const body = await this.http.call('POST', '/a2a/mailbox/inbound', { limit: INBOUND_LIMIT });
            const events = (body.messages ?? []).map((m) => ({ ...inboundToAgentEvent(m), ...(body.next_cursor ? { cursor: body.next_cursor } : {}) }));
            return {
                events,
                ...(body.next_poll_after_ms !== undefined ? { nextPollAfterMs: body.next_poll_after_ms } : {}), // #1195 选读
                hasMore: body.has_more ?? false,
            };
        },
        ack: async (eventId) => { await this.http.call('POST', '/a2a/mailbox/ack', { message_ids: [eventId] }); },
        push: async (event) => {
            const result = await this.mailbox.pushMany([event]);
            assertMailboxPushAccepted(result?.outcomes.find((item) => item.id === event.id));
        },
        pushMany: async (events) => {
            if (events.length === 0)
                return { outcomes: [] };
            const outcomes = [];
            for (const batch of splitMailboxOutboundBatches(events)) {
                if (batch.tooLarge) {
                    outcomes.push({
                        id: batch.event.id,
                        status: 'failed',
                        reason: 'mailbox_payload_too_large',
                        terminal: true,
                    });
                    continue;
                }
                try {
                    const body = await this.http.call('POST', '/a2a/mailbox/outbound', { messages: batch.events.map(agentEventToOutbound) });
                    outcomes.push(...mailboxPushResultFromBody(body, batch.events).outcomes);
                }
                catch (err) {
                    if (hubErrorStatus(err) === 413) {
                        if (batch.events.length === 1) {
                            outcomes.push({
                                id: batch.events[0].id,
                                status: 'failed',
                                reason: 'mailbox_payload_too_large',
                                terminal: true,
                            });
                            continue;
                        }
                        for (const single of batch.events) {
                            try {
                                const body = await this.http.call('POST', '/a2a/mailbox/outbound', { messages: [agentEventToOutbound(single)] });
                                outcomes.push(...mailboxPushResultFromBody(body, [single]).outcomes);
                            }
                            catch (singleErr) {
                                if (hubErrorStatus(singleErr) === 413) {
                                    outcomes.push({
                                        id: single.id,
                                        status: 'failed',
                                        reason: 'mailbox_payload_too_large',
                                        terminal: true,
                                    });
                                    continue;
                                }
                                if (outcomes.length === 0 && hubErrorStatus(singleErr) !== 429)
                                    throw singleErr;
                                outcomes.push(...mailboxPushFailureOutcomes(events, outcomes, singleErr, new Set([single.id])));
                                return { outcomes };
                            }
                        }
                        continue;
                    }
                    if (outcomes.length === 0 && hubErrorStatus(err) !== 429)
                        throw err;
                    outcomes.push(...mailboxPushFailureOutcomes(events, outcomes, err, new Set(batch.events.map((e) => e.id))));
                    return { outcomes };
                }
            }
            return { outcomes };
        },
        status: async () => {
            const body = await this.http.call('GET', '/a2a/mailbox/status');
            return { pending: body.pending ?? 0 };
        },
    };
    async capabilities() {
        return {
            capabilities: PUBLIC_HUB_CAPABILITIES,
            protocolVersion: PUBLIC_PROTOCOL_VERSION,
            economyEnabled: true,
            authKinds: ['oauth_device_token', 'keypair'],
            auditEnabled: false,
            airGap: false,
            tenantIsolation: false,
            marketplaceAccess: true,
        };
    }
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function searchAssets(value, source) {
    if (!Array.isArray(value))
        throw new Error(`${source}_results_invalid`);
    return value.map((candidate) => {
        const record = asRecord(candidate);
        if (!record)
            throw new Error(`${source}_asset_invalid`);
        const asset = unwrapFetchDeliveryRow(record);
        const assetId = stringField(asset, 'asset_id') ?? stringField(asset, 'assetId');
        if (!assetId)
            throw new Error(`${source}_asset_invalid`);
        return asset;
    });
}
function semanticSearchAssets(body) {
    const status = stringField(body, 'search_status');
    if (status === 'degraded' || body['retryable'] === true)
        throw new Error('semantic_search_degraded');
    const assets = searchAssets(body['assets'], 'semantic_search');
    if (status === 'no_match') {
        if (assets.length !== 0)
            throw new Error('semantic_search_status_invalid');
        return assets;
    }
    if (status === 'found' || status === 'low_confidence_only') {
        if (assets.length === 0)
            throw new Error('semantic_search_status_invalid');
        return assets;
    }
    // Older successful Hub responses are usable only when they carry a concrete candidate.
    if (status === undefined && assets.length > 0)
        return assets;
    throw new Error('semantic_search_status_invalid');
}
function signalSearchAssets(body) {
    const payload = asRecord(body['payload']);
    return searchAssets(payload?.['results'], 'signal_search');
}
function recipeStepToWire(step) {
    return {
        asset_id: step.assetId,
        asset_type: step.assetType,
        ...(step.position !== undefined ? { position: step.position } : {}),
    };
}
function recipePayload(body) {
    return asRecord(body['payload']) ?? body;
}
function recipeFromBody(body) {
    const payload = recipePayload(body);
    if (payload['recipe'] !== undefined)
        return payload['recipe'];
    return isRecipeLikeRecord(payload) ? payload : undefined;
}
function isRecipeLikeRecord(value) {
    return Boolean(stringField(value, 'id')
        ?? stringField(value, 'recipe_id')
        ?? stringField(value, 'recipeId'));
}
function recipeOrganismIdFromPayload(payload) {
    const flatId = stringField(payload, 'organism_id') ?? stringField(payload, 'organismId');
    if (flatId)
        return flatId;
    const organism = asRecord(payload['organism']);
    return organism
        ? stringField(organism, 'id') ?? stringField(organism, 'organism_id') ?? stringField(organism, 'organismId')
        : undefined;
}
function recipeReceiptFromBody(body) {
    const payload = recipePayload(body);
    const recipe = asRecord(payload['recipe']);
    const source = recipe ?? payload;
    return {
        ...(stringField(source, 'id') ?? stringField(source, 'recipe_id') ?? stringField(source, 'recipeId')
            ? { recipeId: stringField(source, 'id') ?? stringField(source, 'recipe_id') ?? stringField(source, 'recipeId') }
            : {}),
        ...(stringField(source, 'status') ? { status: stringField(source, 'status') } : {}),
        raw: body,
    };
}
function dryRunRecipeReceipt(action, recipeId, extra = {}) {
    return {
        recipeId,
        status: 'dry-run',
        raw: {
            dry_run: true,
            would: action,
            recipe_id: recipeId,
            ...extra,
        },
    };
}
function assetsFromBody(body) {
    const payload = asRecord(body['payload']);
    const candidates = [
        body['asset'],
        payload?.['asset'],
        ...(Array.isArray(body['assets']) ? body['assets'] : []),
        ...(Array.isArray(body['results']) ? body['results'] : []),
        ...(Array.isArray(payload?.['assets']) ? payload['assets'] : []),
        ...(Array.isArray(payload?.['results']) ? payload['results'] : []),
    ];
    return candidates
        .filter((candidate) => Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate)))
        .map(unwrapFetchDeliveryRow);
}
// Delivery-row metadata carried over onto the unwrapped GEP record. Ranking fields are consumed by
// hubReuse and stripped before canonical storage. `payload_backfill_reason` must also survive this
// boundary so integrity consumers can report that the Hub synthesized the payload (#570). Do not
// carry `confidence`: it is transport metadata on Gene rows but canonical content on Capsules, so
// overloading it can either poison a Gene hash or overwrite Capsule content (#565).
const FETCH_ROW_CARRYOVER_KEYS = ['gdi_score', 'success_rate', 'reuse_count', 'source_node_id', 'payload_backfill_reason'];
/**
 * The live hub's /a2a/fetch results are DELIVERY ROWS, not raw GEP records (#565, observed on
 * evomap.ai 2026-07-22): the record itself nests under `payload`, while the row's own keys are
 * delivery metadata (asset_type, bundle_id, confidence, gdi_score_mean, callable, …). Treating the
 * row as the asset made reuse's integrity check (computeAssetId over the row) fail on every
 * delivered asset. A GEP record always carries a string `type`; delivery rows carry `asset_type`
 * instead — so unwrap exactly when the row has no `type` and nests an object payload that looks
 * like a GEP record. Rows that already ARE raw records (older hubs, tests) pass through unchanged.
 */
function unwrapFetchDeliveryRow(row) {
    const record = row;
    if (typeof record['type'] === 'string')
        return row;
    const inner = asRecord(record['payload']);
    if (!inner || typeof inner['type'] !== 'string' || typeof inner['asset_id'] !== 'string')
        return row;
    const carryover = {};
    for (const key of FETCH_ROW_CARRYOVER_KEYS) {
        if (record[key] !== undefined && inner[key] === undefined)
            carryover[key] = record[key];
    }
    return { ...inner, ...carryover };
}
function accountAssetsFromPayload(payload) {
    const candidates = [
        payload['assets'],
        payload['results'],
        payload['items'],
    ];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate))
            continue;
        return candidate
            .filter((asset) => Boolean(asset && typeof asset === 'object' && !Array.isArray(asset)))
            .map(unwrapFetchDeliveryRow);
    }
    return [];
}
function learningAssetsFromPayload(payload) {
    const candidates = [
        payload['assets'],
        payload['results'],
        payload['items'],
    ];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate))
            continue;
        return candidate.filter((asset) => isLearningAssetRecord(asset));
    }
    return [];
}
function isLearningAssetRecord(value) {
    const record = asRecord(value);
    return Boolean(record && typeof record['asset_id'] === 'string' && typeof record['type'] === 'string');
}
function normalizeLearningAssetLimit(value) {
    if (!Number.isFinite(value))
        return 20;
    return Math.min(100, Math.max(1, Math.floor(value)));
}
function learningAssetListQuery(options, limit) {
    const status = normalizeLearningAssetStatusParam(options.status);
    const query = {
        limit,
        runtime: options.includeExpired === true ? undefined : 'true',
        include_expired: options.includeExpired === true ? 'true' : undefined,
        include_payload: options.includePayload === true ? 'true' : undefined,
        ...(options.type ? { type: options.type } : {}),
        ...(status ? { status } : options.includeExpired === true ? { status: 'active' } : {}),
    };
    const scope = compactLearningAssetParam(options.scope);
    if (scope)
        query['scope'] = scope;
    return query;
}
function normalizeLearningAssetStatusParam(status) {
    if (Array.isArray(status))
        return compactLearningAssetParam(status);
    return typeof status === 'string' && status.trim() ? status.trim() : undefined;
}
function compactLearningAssetParam(values) {
    if (!values)
        return undefined;
    const out = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
    return out.length > 0 ? out.join(',') : undefined;
}
function trimStringField(value, maxLen) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLen) : undefined;
}
function normalizeLearningAssetIds(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > LEARNING_ASSET_ID_MAX_LEN || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= LEARNING_ASSET_IDS_MAX)
            break;
    }
    return out;
}
function normalizeLearningAssetOutcome(value) {
    if (value === 'success' || value === 'failed' || value === 'mismatched' || value === 'stale' || value === 'unsafe')
        return value;
    return undefined;
}
function optionalLearningAssetScore(value) {
    if (value === undefined)
        return { value: undefined };
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
        return { reason: 'invalid_score' };
    return { value };
}
function learningAssetUsageReceiptFromBody(body) {
    const payload = asRecord(body['payload']) ?? body;
    const rows = Array.isArray(payload['results'])
        ? payload['results'].filter((row) => Boolean(asRecord(row)))
        : [];
    const reason = stringField(payload, 'reason') ?? stringField(payload, 'error');
    return {
        recorded: rows.length > 0 && rows.some((row) => row.recorded === true),
        ...(reason ? { reason } : {}),
        results: rows,
    };
}
function failureReason(error) {
    if (error instanceof HubClientError) {
        const body = asRecord(error.body) ?? {};
        const payload = asRecord(body['payload']) ?? body;
        return stringField(payload, 'reason') ?? stringField(payload, 'error') ?? `hub ${error.status}`;
    }
    return error instanceof Error ? error.message : String(error);
}
function fetchResultMatchesId(asset, requestedId) {
    if (assetMatchesId(asset, requestedId))
        return true;
    return !requestedId.startsWith('sha256:') && Boolean(asset && stringField(asset, 'id') === requestedId);
}
function stringField(value, key) {
    return typeof value[key] === 'string' && value[key].length > 0 ? value[key] : undefined;
}
function numberField(value, key) {
    const raw = value[key];
    const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
    return Number.isFinite(n) ? n : undefined;
}
function booleanField(value, key) {
    const raw = value[key];
    if (typeof raw === 'boolean')
        return raw;
    if (raw === 'true' || raw === '1')
        return true;
    if (raw === 'false' || raw === '0')
        return false;
    return undefined;
}
function mailboxResultRows(body) {
    const payload = asRecord(body['payload']);
    const candidates = [body['results'], body['messages'], payload?.['results'], payload?.['messages']];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate))
            continue;
        return candidate.filter((item) => Boolean(asRecord(item)));
    }
    return [];
}
function mailboxOutboundBodyBytes(events) {
    return Buffer.byteLength(JSON.stringify({ messages: events.map(agentEventToOutbound) }), 'utf8');
}
function eventOutboundMaxBodyBytes(event) {
    return event.type === 'proxy_trace' ? traceOutboundMaxBodyBytes() : outboundMaxBodyBytes();
}
function batchOutboundMaxBodyBytes(events) {
    return Math.min(...events.map(eventOutboundMaxBodyBytes));
}
function splitMailboxOutboundBatches(events) {
    const out = [];
    let batch = [];
    for (const event of events) {
        if (mailboxOutboundBodyBytes([event]) > eventOutboundMaxBodyBytes(event)) {
            if (batch.length > 0) {
                out.push({ events: batch });
                batch = [];
            }
            out.push({ event, tooLarge: true });
            continue;
        }
        const next = [...batch, event];
        if (batch.length > 0 && (batch.length >= OUTBOUND_MAX_BATCH || mailboxOutboundBodyBytes(next) > batchOutboundMaxBodyBytes(next))) {
            out.push({ events: batch });
            batch = [event];
        }
        else {
            batch = next;
        }
    }
    if (batch.length > 0)
        out.push({ events: batch });
    return out;
}
function assertMailboxPushAccepted(outcome) {
    if (outcome?.status !== 'failed')
        return;
    throw new hubNs.PublishRejectedError('mailbox_push_rejected', outcome.terminal ?? outcome.retryable !== true, outcome.reason ?? 'mailbox_push_rejected', outcome.retryAfterMs, outcome.retryable);
}
function mailboxPushResultFromBody(body, events) {
    const results = mailboxResultRows(body);
    if (results.length === 0) {
        return { outcomes: events.map((event) => ({ id: event.id, status: 'accepted' })) };
    }
    const resultIds = results.map(mailboxPushResultId);
    const hasCompletePositions = results.length === events.length;
    return {
        outcomes: events.map((event, index) => {
            const matches = results.filter((_, resultIndex) => resultIds[resultIndex] === event.id);
            if (matches.length === 1)
                return mailboxPushOutcomeFromRow(event.id, matches[0]);
            const positionalMatch = matches.length === 0
                && hasCompletePositions
                && resultIds[index] === undefined
                ? results[index]
                : undefined;
            return mailboxPushOutcomeFromRow(event.id, positionalMatch);
        }),
    };
}
function mailboxPushResultId(row) {
    const value = row['id'] ?? row['message_id'];
    if (typeof value !== 'string' && typeof value !== 'number')
        return undefined;
    const id = String(value);
    return id.length > 0 ? id : undefined;
}
function mailboxPushOutcomeFromRow(eventId, match) {
    if (!match) {
        return {
            id: eventId,
            status: 'failed',
            reason: 'mailbox_response_incomplete',
            retryable: true,
            terminal: false,
        };
    }
    const reason = mailboxPushFailureReason(match);
    if (!reason)
        return { id: eventId, status: 'accepted', raw: match };
    const retryAfterMs = numberField(match, 'retryAfterMs')
        ?? numberField(match, 'retry_after_ms')
        ?? (() => {
            const retryAfterSeconds = numberField(match, 'retry_after') ?? numberField(match, 'retryAfter');
            return retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : undefined;
        })();
    const retryable = booleanField(match, 'retryable');
    const terminal = booleanField(match, 'terminal');
    const inferredTerminal = retryable === undefined && terminal === undefined
        ? isKnownTerminalMailboxFailure(match, reason)
        : undefined;
    return {
        id: eventId,
        status: 'failed',
        reason,
        ...(retryable !== undefined ? { retryable } : inferredTerminal === false ? { retryable: true } : {}),
        ...(terminal !== undefined ? { terminal } : inferredTerminal !== undefined ? { terminal: inferredTerminal } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        raw: match,
    };
}
function isKnownTerminalMailboxFailure(row, reason) {
    const status = stringField(row, 'status')?.toLowerCase() ?? '';
    if (status.includes('reject') || status.includes('invalid') || status === 'quarantine')
        return true;
    const normalizedReason = reason.toLowerCase();
    const alreadySubmittedCode = 'already_submitted_for_task';
    if (normalizedReason === alreadySubmittedCode
        || normalizedReason.startsWith(`${alreadySubmittedCode}:`)
        || normalizedReason === 'orphan_node_not_allowed_for_bounty')
        return true;
    return /\binvalid[_ -]|validation[_ -]?error|payload[_ -]?too[_ -]?large|not[_ -]?found|expired|already[_ -]?(claimed|completed)|duplicate|conflict|not[_ -]?(task[_ -]?(owner|claimer)|asset[_ -]?owner|open|active|claimed|eligible)|asset[_ -]?(orphaned|not[_ -]?promoted)|task[_ -]?full|node[_ -]?(suspended|merging|dead)|insufficient[_ -]?(reputation|model[_ -]?tier)|task[_ -]?reserved[_ -]?for[_ -]?preferred[_ -]?merchant|atp[_ -]?requires[_ -]?evolver[_ -]?version|self[_ -]?funded[_ -]?bounty[_ -]?self[_ -]?claim/i
        .test(reason);
}
// A 413 (payload too large) or 429 (rate-limited) can surface either as a JSON
// HubClientError, OR — when an ingress/gateway (Envoy/nginx) emits a non-JSON
// body — as a HubUnreachableError carrying the HTTP status in `details.status`
// (hubFetch classifies non-API responses as unreachable BEFORE the 4xx branch).
// Read the status from both shapes so a gateway 413/429 isn't misrouted into the
// "defer forever" path.
function hubErrorStatus(err) {
    if (err instanceof HubClientError)
        return err.status;
    if (isHubUnreachableError(err)) {
        const status = err.details?.status;
        return typeof status === 'number' ? status : undefined;
    }
    return undefined;
}
// Prefer the standardized Retry-After header carried by HubClientError, then
// preserve the existing JSON body hints as a compatibility fallback.
function clientErrorRetryAfterMs(err) {
    if (err instanceof HubClientError && typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs)) {
        return err.retryAfterMs;
    }
    const body = err instanceof HubClientError ? asRecord(err.body) : undefined;
    if (!body)
        return undefined;
    const ms = numberField(body, 'retry_after_ms') ?? numberField(body, 'retryAfterMs');
    if (ms !== undefined)
        return ms;
    const sec = numberField(body, 'retry_after') ?? numberField(body, 'retryAfter');
    return sec !== undefined ? sec * 1000 : undefined;
}
function mailboxPushFailureOutcomes(events, outcomes, err, attemptedIds) {
    const completed = new Set(outcomes.map((outcome) => outcome.id));
    const reason = err instanceof Error ? err.message : String(err);
    // 429 → defer with the hub's Retry-After (no attempt burn). Hub-unreachable →
    // existing backoff. Everything else → plain failed (normal retry).
    const cooldownMs = hubErrorStatus(err) === 429
        ? Math.max(1_000, clientErrorRetryAfterMs(err) ?? 60_000)
        : isHubUnreachableError(err) ? hubUnreachableRetryAfterMs(err) : undefined;
    return events
        .filter((event) => !completed.has(event.id))
        .map((event) => {
        // Messages past the failing batch were never put on the wire — defer them
        // (no attempt burn) rather than charging a failed attempt for a send that
        // never happened. The batch that actually failed keeps normal failed/backoff
        // semantics (or the cooldown defer above for 429 / hub-unreachable).
        const attempted = attemptedIds === undefined || attemptedIds.has(event.id);
        const retryAfterMs = cooldownMs ?? (attempted ? undefined : 1_000);
        return {
            id: event.id,
            status: 'failed',
            reason,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
    });
}
// Mailbox push success/failure is decided SOLELY by the per-message TOP-LEVEL
// `status`, mirroring v1 (src/proxy/sync/outbound.js:127, which only reads
// `r.status`). The hub's processOutbound (src/services/mailboxService.js)
// returns exactly three top-level statuses — `ok` (deduplicated), `accepted`
// (dispatched), `failed` (dispatch threw) — and NEVER puts `ok`/`accepted` as
// top-level fields. Critically, a proxy_trace whose node has trace collection
// disabled still comes back top-level `status:"accepted"` with a nested
// `response:{accepted:false,...}` (it just isn't deduped, mailboxService.js:31-33);
// that is NOT a transport failure. So we must judge ONLY `status` here: treating
// `response.accepted===false` as failure (as the old code did) made store.fail
// back off and resend forever, since the hub keeps returning accepted:false.
function mailboxPushFailureReason(row) {
    const status = stringField(row, 'status')?.toLowerCase();
    const error = stringField(row, 'error') ?? stringField(row, 'reason');
    if (status
        && (status.includes('fail')
            || status.includes('reject')
            || status.includes('error')
            || status.includes('invalid')
            || status === 'quarantine')) {
        return error ?? status;
    }
    return undefined;
}
function optionalReuseMetric(report, camelKey, snakeKey, reason) {
    const rawReport = report;
    let value;
    for (const key of [camelKey, snakeKey]) {
        if (!Object.prototype.hasOwnProperty.call(rawReport, key))
            continue;
        const raw = rawReport[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
            return { reason };
        value ??= raw;
    }
    return { value };
}
function normalizeQuestion(question) {
    const text = String(question.question ?? '').trim();
    if (!text)
        return null;
    const signals = Array.isArray(question.signals)
        ? question.signals.map((s) => String(s).trim()).filter(Boolean)
        : [];
    return {
        question: text,
        ...(question.amount !== undefined ? { amount: question.amount } : {}),
        ...(signals.length > 0 ? { signals } : {}),
    };
}
function questionReceiptsFromBody(body) {
    const payload = asRecord(body['payload']) ?? body;
    const rows = payload['questions_created'] ?? payload['questionsCreated'] ?? payload['questions'];
    if (!Array.isArray(rows))
        return [];
    return rows.map(questionReceiptFromRow);
}
function questionReceiptFromRow(row) {
    const rec = asRecord(row);
    if (!rec)
        return { raw: row };
    const question = stringField(rec, 'question') ?? stringField(rec, 'title');
    const taskId = stringField(rec, 'task_id') ?? stringField(rec, 'taskId') ?? stringField(rec, 'id');
    const bountyId = stringField(rec, 'bounty_id') ?? stringField(rec, 'bountyId');
    const error = stringField(rec, 'error') ?? stringField(rec, 'reason');
    return {
        ...(question ? { question } : {}),
        ...(taskId ? { taskId } : {}),
        ...(bountyId ? { bountyId } : {}),
        ...(error ? { error } : {}),
        raw: row,
    };
}
function nonNegativeFiniteNumberField(value, key) {
    const raw = value[key];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}
function helloResultFromBody(httpStatus, body) {
    const payload = asRecord(body['payload']) ?? body;
    const retryAfterMs = numberField(payload, 'retry_after_ms') ?? numberField(payload, 'retryAfterMs');
    const rateLimitUntilMs = numberField(payload, 'rate_limit_until_ms') ?? numberField(payload, 'rateLimitUntilMs');
    const status = stringField(payload, 'status');
    const error = stringField(payload, 'error') ?? stringField(payload, 'reason') ?? (httpStatus >= 400 ? `http_${httpStatus}` : undefined);
    const details = payload['details'] ?? body['details'];
    const authError = httpStatus === 401 || httpStatus === 403 || status === 'auth_failed' || status === 'invalid_secret';
    return {
        ok: false,
        ...(authError ? { authError: true } : {}),
        ...(httpStatus >= 400 ? { httpStatus } : {}),
        ...(error ? { error } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(rateLimitUntilMs !== undefined ? { rateLimitUntilMs } : {}),
        ...(status ? { status } : {}),
    };
}
function hubUnreachableRetryAfterMs(err) {
    const retryAfterMs = err?.retryAfterMs
        ?? err?.details?.retryAfterMs;
    return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000;
}
function heartbeatResultFromBody(httpStatus, body) {
    const payload = asRecord(body['payload']) ?? body;
    const retryAfterMs = numberField(payload, 'retry_after_ms') ?? numberField(payload, 'retryAfterMs');
    const status = stringField(payload, 'status');
    const error = stringField(payload, 'error') ?? (httpStatus >= 400 ? `http_${httpStatus}` : undefined);
    const details = payload['details'] ?? body['details'];
    const ack = asRecord(payload['last_update_ack']);
    const forceUpdate = forceUpdateFromRecord(asRecord(payload['force_update']));
    const rawCapabilityGaps = payload['capability_gaps'] ?? payload['capabilityGaps'];
    const capabilityGaps = Array.isArray(rawCapabilityGaps)
        ? signals.normalizeCapabilityGaps(rawCapabilityGaps)
        : undefined;
    const ok = httpStatus >= 200
        && httpStatus < 300
        && payload['ok'] !== false
        && status !== 'unknown_node'
        && !error;
    return {
        ok,
        ...(httpStatus >= 400 ? { httpStatus } : {}),
        ...(error ? { error } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(status ? { status } : {}),
        ...(ack ? { lastUpdateAck: {
                ...(typeof ack['ok'] === 'boolean' ? { ok: ack['ok'] } : {}),
                ...(typeof ack['reason'] === 'string' ? { reason: ack['reason'] } : {}),
            } } : {}),
        ...(forceUpdate ? { forceUpdate } : {}),
        ...(capabilityGaps !== undefined ? { capabilityGaps } : {}),
    };
}
function forceUpdateFromRecord(value) {
    if (!value)
        return undefined;
    const deadlineMs = nonNegativeFiniteNumberField(value, 'deadline_ms');
    const staggerWindowMs = nonNegativeFiniteNumberField(value, 'stagger_window_ms');
    const directive = {
        ...(typeof value['required_version'] === 'string' ? { required_version: value['required_version'] } : {}),
        ...('manifest' in value ? { manifest: value['manifest'] } : {}),
        ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
        ...(typeof value['release_url'] === 'string' ? { release_url: value['release_url'] } : {}),
        ...(Array.isArray(value['update_channels']) ? { update_channels: value['update_channels'].filter((x) => typeof x === 'string') } : {}),
        ...(typeof value['directive_id'] === 'string' ? { directive_id: value['directive_id'] } : {}),
        ...(deadlineMs !== undefined ? { deadline_ms: deadlineMs } : {}),
        ...(staggerWindowMs !== undefined ? { stagger_window_ms: staggerWindowMs } : {}),
    };
    return directive.required_version || directive.manifest !== undefined ? directive : undefined;
}