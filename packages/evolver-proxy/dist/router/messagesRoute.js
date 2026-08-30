// /v1/messages handler (ported from v1 proxy/router/messages_route.js). Wraps an injected upstream callable
// with three stages — extract features → pick tier → cache-preserving model rewrite — each with its own
// fallback so a single bad input never breaks passthrough: classifier throw → forward unmodified; rewriter
// throw → forward unmodified; upstream 5xx on a rewritten request → one retry with the client's original model.
// The actual network call is the `anthropicProxy` seam, so the whole handler is unit-testable with a fake.
import { randomUUID } from 'node:crypto';
import { pickForTurn } from './modelRouter.js';
import { rewriteModel } from './cachePassthrough.js';
import { extractFeatures } from './features.js';
import { SseUsageScanner, teeStreamForScan } from './sseScan.js';
import { captureBodiesEnabled, captureBody, REDACTION_VERSION, redactText, stableUserIdHash } from '../llm/bodyCapture.js';
export function captureTraceMetadata(value, env = process.env) {
    const captured = captureBody(value, env);
    if (!captured)
        return undefined;
    try {
        return JSON.parse(captured.body);
    }
    catch {
        return captured.body;
    }
}
// Tier → concrete model is OPERATOR CONFIG, never hardcoded — model IDs go stale fast (opus-4-7 → 4-8 → …),
// so a baked-in default would silently route to a dead/old model. Each tier is read from env; an unset tier
// has NO model, and the handler then leaves the client's model untouched (transparent passthrough). The
// operator opts a tier into routing by setting EVOMAP_MODEL_{CHEAP,MID,EXPENSIVE}.
export function resolveTierModels(env = process.env) {
    const out = {};
    if (env['EVOMAP_MODEL_CHEAP'])
        out.cheap = env['EVOMAP_MODEL_CHEAP'];
    if (env['EVOMAP_MODEL_MID'])
        out.mid = env['EVOMAP_MODEL_MID'];
    if (env['EVOMAP_MODEL_EXPENSIVE'])
        out.expensive = env['EVOMAP_MODEL_EXPENSIVE'];
    return out;
}
const TIER_ORDER = ['cheap', 'mid', 'expensive'];
export function detectTierModelConfigWarnings(models) {
    const configuredTiers = TIER_ORDER.filter((tier) => {
        const model = models[tier];
        return typeof model === 'string' && model.length > 0;
    });
    if (configuredTiers.length === 0)
        return [];
    const warnings = [];
    const missingTiers = TIER_ORDER.filter((tier) => !configuredTiers.includes(tier));
    if (missingTiers.length > 0) {
        warnings.push({
            event: 'router_config_warning',
            reason: 'missing_tier_models',
            message: 'Router tier config is partial; unset tiers will pass the client model through.',
            configured_tiers: configuredTiers,
            missing_tiers: missingTiers,
        });
    }
    const byModel = new Map();
    for (const tier of configuredTiers) {
        const model = models[tier];
        if (!model)
            continue;
        byModel.set(model, [...(byModel.get(model) ?? []), tier]);
    }
    const duplicateModels = Array.from(byModel.entries())
        .filter(([, tiers]) => tiers.length > 1)
        .map(([model, tiers]) => ({ model, tiers }));
    const allSame = configuredTiers.length === TIER_ORDER.length
        && duplicateModels.length === 1
        && duplicateModels[0].tiers.length === TIER_ORDER.length;
    if (allSame) {
        warnings.push({
            event: 'router_config_warning',
            reason: 'all_tier_models_same',
            message: 'All router tiers resolve to the same model; routing will still run but cannot change cost/latency tiers.',
            configured_tiers: configuredTiers,
            duplicate_models: duplicateModels,
        });
    }
    else if (duplicateModels.length > 0) {
        warnings.push({
            event: 'router_config_warning',
            reason: 'duplicate_tier_models',
            message: 'Multiple router tiers resolve to the same model; routing will still run but tier separation is degraded.',
            configured_tiers: configuredTiers,
            duplicate_models: duplicateModels,
        });
    }
    return warnings;
}
export function parseClaudeId(modelId) {
    if (typeof modelId !== 'string')
        return null;
    const m = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(modelId);
    if (!m)
        return null;
    const major = Number(m[2]);
    const minor = Number(m[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor))
        return null;
    return { family: m[1].toLowerCase(), major, minor };
}
/** Block an intra-family generational DOWNGRADE (opus-4-7 → opus-4-1). Cross-family (opus→haiku) is allowed. */
export function isIntraFamilyDowngrade(chosen, original) {
    const c = parseClaudeId(chosen);
    const o = parseClaudeId(original);
    if (!c || !o || c.family !== o.family)
        return false;
    if (c.major !== o.major)
        return c.major < o.major;
    return c.minor < o.minor;
}
// Bedrock InvokeModel rejects bare short IDs and needs ARN-shaped aliases. Keep the v1 known-safe defaults so
// existing clients that send short Claude IDs keep working in bedrock mode, while still letting operators override
// any stale target with EVOMAP_BEDROCK_ALIASES.
const DEFAULT_BEDROCK_ALIASES = Object.freeze({
    'opus/4/7': 'global.anthropic.claude-opus-4-7',
    'haiku/4/5': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'sonnet/4/6': 'global.anthropic.claude-sonnet-4-6',
});
// EVOMAP_BEDROCK_ALIASES is a JSON object keyed by `family/major/minor`
// (e.g. {"haiku/4/5":"global.anthropic.claude-haiku-4-5-...-v1:0"}).
export function resolveBedrockAliases(env = process.env) {
    const out = { ...DEFAULT_BEDROCK_ALIASES };
    const raw = env['EVOMAP_BEDROCK_ALIASES'];
    if (!raw)
        return out;
    try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
            for (const [k, v] of Object.entries(o))
                if (typeof v === 'string')
                    out[k] = v;
            return out;
        }
    }
    catch { /* malformed → defaults only */ }
    return out;
}
/** Canonicalize a short Claude ID to its operator-configured Bedrock alias. Unmapped/unknown → unchanged. */
export function canonicalizeForBedrock(modelId, aliases) {
    const parsed = parseClaudeId(modelId);
    if (!parsed)
        return modelId;
    return aliases[`${parsed.family}/${parsed.major}/${parsed.minor}`] ?? modelId;
}
export function supportsAdaptiveThinking(modelId) {
    const parsed = parseClaudeId(modelId);
    if (!parsed)
        return false;
    if (parsed.major > 4)
        return true;
    return parsed.major === 4 && parsed.minor >= 7;
}
const j = (o) => JSON.stringify(o);
async function drain(text, log, ctx) {
    if (!text)
        return '';
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(text()),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('response drain timeout')), 10_000); }),
        ]);
    }
    catch (e) {
        if (e instanceof Error && e.message.includes('timeout'))
            log.warn?.(j({ event: 'router_fallback', reason: 'upstream_5xx_drain_timeout', ...ctx }));
        return '';
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function getHeader(headers, name) {
    const want = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === want && value)
            return value;
    }
    return '';
}
function clip(value, max = 128) {
    return value.length <= max ? value : value.slice(0, max);
}
function safeTraceError(value, max = 256) {
    return clip(redactText(value).replace(/\s+/g, ' ').trim(), max);
}
function safePlainSessionId(value) {
    const s = value.trim();
    if (s !== value)
        return '';
    if (s.length < 4 || s.length > 128)
        return '';
    if (s.includes('@') || /\s/.test(s))
        return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(s))
        return '';
    if (/^(?:bearer|basic|sk-|ghp_|github_pat_|gho_|ghu_|ghs_|glpat-|xox[baprs]-)/i.test(s))
        return '';
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s))
        return '';
    if (/(?:^|[-_.])(?:token|secret|apikey|api[_-]?key|password|passwd|credential|auth)(?:$|[-_.])/i.test(s))
        return '';
    if (/^[a-f0-9]{32,}$/i.test(s))
        return '';
    if (/^[A-Za-z0-9_-]{40,}$/.test(s) && !/[-_.]/.test(s))
        return '';
    if (/(?:session|sess)/i.test(s))
        return s;
    return /[-_.]/.test(s) ? s : '';
}
function sessionIdFromPlainField(value) {
    return typeof value === 'string' ? safePlainSessionId(value) : '';
}
function sessionIdFromClaudeUserId(value) {
    const marker = '__session_';
    const index = value.indexOf(marker);
    if (index < 0)
        return '';
    return safePlainSessionId(value.slice(index + marker.length));
}
function sessionIdFromUserField(value) {
    if (!value)
        return '';
    let parsed = value;
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s.startsWith('{'))
            return sessionIdFromClaudeUserId(s) || safePlainSessionId(s);
        try {
            parsed = JSON.parse(s);
        }
        catch {
            return '';
        }
    }
    if (parsed && typeof parsed === 'object') {
        // Accept both spellings. The archive-side session key (agentic-trace-pipeline
        // derive_session_key) reads `session_id ?? sessionId` from this same field, so a
        // camelCase producer yields a `cc::<sid>` key upstream while we recorded null —
        // the two datasets then silently fail to join. Both spellings still pass through
        // safePlainSessionId; this widens the accepted key name, never the value guard.
        const raw = parsed['session_id']
            ?? parsed['sessionId'];
        if (typeof raw === 'string' && raw.length > 0)
            return safePlainSessionId(raw);
    }
    return '';
}
function extractSessionId(headers, body) {
    for (const name of ['x-session-id', 'x-cursor-session-id', 'x-conversation-id']) {
        const value = getHeader(headers, name).trim();
        const sid = sessionIdFromPlainField(value);
        if (sid)
            return clip(sid);
    }
    const metadata = body['metadata'];
    if (metadata && typeof metadata === 'object') {
        const m = metadata;
        const sid = sessionIdFromUserField(m['user_id']) || sessionIdFromPlainField(m['session_id']);
        if (sid)
            return clip(sid);
    }
    const sid = sessionIdFromUserField(body['user']);
    if (sid)
        return clip(sid);
    return null;
}
function extractTopLevelUserIdHash(body) {
    const metadata = body['metadata'];
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const userId = metadata['user_id'];
        if (typeof userId === 'string' || typeof userId === 'number')
            return stableUserIdHash(userId);
    }
    const user = body['user'];
    if (typeof user === 'string' || typeof user === 'number')
        return stableUserIdHash(user);
    return undefined;
}
function isThinkingEffortRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
// FIX-9: normalize "how hard should the model think" across provider request shapes into one top-level field.
//   Anthropic:  body.thinking = { type:'enabled', budget_tokens:N }
//   OpenAI:     body.reasoning = { effort:'low'|'medium'|'high'|'minimal' }
//   OpenAI alt: body.output_config = { effort:'...' }  / body.reasoning_effort = '...'
//   Fallback:   body.metadata.{thinking_effort|reasoning_effort|effort}
// Returns undefined when no effort signal is present.
export function extractThinkingEffort(body) {
    if (!isThinkingEffortRecord(body))
        return undefined;
    const out = {};
    const thinking = body['thinking'];
    if (isThinkingEffortRecord(thinking)) {
        if (typeof thinking['type'] === 'string')
            out.type = thinking['type'];
        if (typeof thinking['budget_tokens'] === 'number' && Number.isFinite(thinking['budget_tokens']))
            out.budget_tokens = thinking['budget_tokens'];
        if (typeof thinking['effort'] === 'string')
            out.effort = thinking['effort'];
    }
    const reasoning = body['reasoning'];
    if (out.effort === undefined && isThinkingEffortRecord(reasoning) && typeof reasoning['effort'] === 'string') {
        out.effort = reasoning['effort'];
    }
    const outputConfig = body['output_config'];
    if (out.effort === undefined && isThinkingEffortRecord(outputConfig) && typeof outputConfig['effort'] === 'string') {
        out.effort = outputConfig['effort'];
    }
    if (out.effort === undefined && typeof body['reasoning_effort'] === 'string')
        out.effort = body['reasoning_effort'];
    const metadata = body['metadata'];
    if (out.effort === undefined && isThinkingEffortRecord(metadata)) {
        for (const key of ['thinking_effort', 'reasoning_effort', 'effort']) {
            if (typeof metadata[key] === 'string') {
                out.effort = metadata[key];
                break;
            }
        }
    }
    return out.effort !== undefined || out.budget_tokens !== undefined || out.type !== undefined ? out : undefined;
}
function detectClient(headers) {
    const text = [
        getHeader(headers, 'user-agent'),
        getHeader(headers, 'x-client-name'),
        getHeader(headers, 'x-stainless-package-version'),
        getHeader(headers, 'x-app'),
    ].filter(Boolean).join(' ').toLowerCase();
    if (text.includes('cursor'))
        return 'cursor';
    if (text.includes('codex'))
        return 'codex';
    if (text.includes('claude'))
        return 'claude-code';
    return 'unknown';
}
function wireApiForRoute(route) {
    if (route === '/v1/responses')
        return 'openai_responses';
    if (route === '/v1/chat/completions')
        return 'openai_chat_completions';
    return 'anthropic_messages';
}
function defaultUpstreamMode(route) {
    return route === '/v1/messages' ? 'anthropic' : 'openai';
}
function resolveUpstreamMode(route, env) {
    const routeSpecific = route === '/v1/messages' ? env['EVOMAP_UPSTREAM'] : undefined;
    return (routeSpecific || defaultUpstreamMode(route)).toLowerCase();
}
function providerForTrace(route, upstreamMode, env) {
    if (upstreamMode === 'bedrock')
        return 'aws-bedrock';
    if (route === '/v1/responses' || route === '/v1/chat/completions') {
        return (env['EVOLVER_LLM_OPENAI_UPSTREAM'] || env['EVOMAP_OPENAI_UPSTREAM'] || 'openai').toLowerCase();
    }
    return upstreamMode;
}
function streamResponse(up) {
    const headers = {};
    const ct = up.headers?.['content-type'];
    if (ct)
        headers['Content-Type'] = ct;
    return { status: up.status, stream: up.stream, headers };
}
/** Pull usage/stop_reason out of a parsed non-stream response body. Tolerant: anything malformed → {}. */
function extractResponseMeta(respBody) {
    if (!respBody || typeof respBody !== 'object')
        return {};
    const o = respBody;
    const out = {};
    const usageSource = o['usage']
        ?? (o['response'] && typeof o['response'] === 'object' ? o['response']['usage'] : undefined);
    if (usageSource && typeof usageSource === 'object') {
        const u = usageSource;
        const usage = {};
        for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
            if (typeof u[k] === 'number')
                usage[k] = u[k];
        }
        if (typeof u['prompt_tokens'] === 'number')
            usage.input_tokens = u['prompt_tokens'];
        if (typeof u['completion_tokens'] === 'number')
            usage.output_tokens = u['completion_tokens'];
        const tokenDetails = u['input_tokens_details'] ?? u['prompt_tokens_details'];
        if (tokenDetails && typeof tokenDetails === 'object') {
            const cached = tokenDetails['cached_tokens'];
            if (typeof cached === 'number')
                usage.cache_read_input_tokens = cached;
        }
        if (Object.keys(usage).length > 0)
            out.usage = usage;
    }
    let choiceFinish;
    if (Array.isArray(o['choices']) && o['choices'][0] && typeof o['choices'][0] === 'object') {
        const finish = o['choices'][0]['finish_reason'];
        if (typeof finish === 'string' || finish === null)
            choiceFinish = finish;
    }
    let incompleteReason;
    if (o['incomplete_details'] && typeof o['incomplete_details'] === 'object') {
        const reason = o['incomplete_details']['reason'];
        if (typeof reason === 'string')
            incompleteReason = reason;
    }
    if (typeof o['stop_reason'] === 'string' || o['stop_reason'] === null)
        out.stop_reason = o['stop_reason'];
    else if (typeof o['finish_reason'] === 'string' || o['finish_reason'] === null)
        out.stop_reason = o['finish_reason'];
    else if (choiceFinish !== undefined)
        out.stop_reason = choiceFinish;
    else if (incompleteReason)
        out.stop_reason = incompleteReason;
    else if (typeof o['status'] === 'string')
        out.stop_reason = o['status'];
    const response = o['response'];
    const rid = typeof o['id'] === 'string'
        ? o['id']
        : response && typeof response === 'object' && typeof response['id'] === 'string'
            ? String(response['id'])
            : '';
    if (rid)
        out.response_id = rid;
    return out;
}
function hasAnthropicProxyCredentials(env) {
    return !!(env['EVOMAP_ANTHROPIC_API_KEY']
        || env['ANTHROPIC_API_KEY']
        || env['EVOMAP_ANTHROPIC_AUTH_TOKEN']
        || (env['EVOMAP_PROXY_AUTO_INJECTED'] === '1' ? '' : env['ANTHROPIC_AUTH_TOKEN']));
}
function hasOpenAIProxyCredentials(env) {
    return !!(env['EVOLVER_LLM_OPENAI_API_KEY'] || env['EVOMAP_OPENAI_API_KEY'] || env['OPENAI_API_KEY']);
}
/**
 * Build the /v1/messages handler. `enabled` (env EVOMAP_ROUTER_ENABLED, or the explicit override) gates the
 * whole router — when off, the body forwards unmodified (a pure passthrough). Returns {status, body|stream}.
 */
export function buildMessagesHandler(opts) {
    if (typeof opts.anthropicProxy !== 'function')
        throw new Error('buildMessagesHandler requires anthropicProxy(path, body, opts)');
    const log = opts.logger ?? console;
    const env = opts.env ?? process.env;
    const enabled = typeof opts.routerEnabled === 'boolean' ? opts.routerEnabled : env['EVOMAP_ROUTER_ENABLED'] === '1';
    if (enabled) {
        for (const warning of detectTierModelConfigWarnings(resolveTierModels(env)))
            log.warn?.(j(warning));
    }
    // Native body capture defaults to v1-compatible full trace mode. Operators that need metadata-only rows must
    // explicitly disable it (a compliance decision; see bodyCapture.ts and docs/trace-body-capture.md).
    const captureBodies = captureBodiesEnabled(env);
    return async (req) => {
        const clock = opts.clock ?? (() => Date.now());
        const t0 = clock();
        const inboundHeaders = req.headers ?? {};
        const route = req.route ?? '/v1/messages';
        const body = req.body;
        const upstreamMode = resolveUpstreamMode(route, env);
        const sessionId = extractSessionId(inboundHeaders, body);
        const previousResponseId = typeof body['previous_response_id'] === 'string' && body['previous_response_id'].length > 0
            ? clip(body['previous_response_id'])
            : null;
        const routeAllowsRouting = route === '/v1/messages';
        // Model/decision fields live above the credential gate (all pure computation) so the trace closure can
        // read them on every exit path, including the 401 throw.
        const rawInboundModel = typeof body?.model === 'string' ? body.model : null;
        const originalModel = upstreamMode === 'bedrock' ? canonicalizeForBedrock(rawInboundModel, resolveBedrockAliases(env)) : rawInboundModel;
        let chosenModel = originalModel;
        let decisionTier = null;
        let decisionReason = null;
        let fallback = null;
        let ttfb = null;
        let traced = false;
        let traceRequestBody = body;
        let bodyCaptureAllowed = false;
        const attempts = [];
        const parseUpstreamBody = (raw, status) => {
            if (raw.length === 0)
                return {};
            try {
                return JSON.parse(raw);
            }
            catch {
                log.warn?.(j({
                    event: 'router_fallback',
                    reason: 'upstream_non_json',
                    upstream_status: status,
                    preview: redactText(raw).slice(0, 200),
                }));
                return { error: raw };
            }
        };
        const responseBodyIndicatesTruncation = (responseBody) => {
            const responseObject = responseBody && typeof responseBody === 'object'
                ? responseBody
                : undefined;
            return responseObject?.content_truncated === true
                || responseObject?.raw_stream_truncated === true
                || typeof responseObject?.dropped_event_count === 'number';
        };
        const captureAttemptBodies = () => {
            return attempts.map((attempt) => {
                const record = {
                    attempt_index: attempt.attempt_index,
                    model: attempt.model,
                    provider: attempt.provider,
                    upstream_mode: attempt.upstream_mode,
                    status: attempt.status,
                    ...(attempt.error !== undefined ? { error: attempt.error } : {}),
                    ...(attempt.body_truncated === true ? { body_truncated: true } : {}),
                };
                const reqCap = captureBodies ? captureBody(attempt.requestBody, env) : undefined;
                const respCap = captureBodies && attempt.responseBody !== undefined ? captureBody(attempt.responseBody, env) : undefined;
                if (reqCap)
                    record.requestBody = reqCap.body;
                if (respCap)
                    record.responseBody = respCap.body;
                if (reqCap?.truncated
                    || respCap?.truncated
                    || attempt.body_truncated === true
                    || responseBodyIndicatesTruncation(attempt.responseBody))
                    record.body_truncated = true;
                return record;
            });
        };
        const capturedStreamResponseBody = (scanner) => {
            return captureBodies && (scanner.result.content_events !== undefined
                || scanner.result.semantic_tail_events !== undefined
                || scanner.result.raw_stream_body !== undefined
                || scanner.result.content_text !== undefined
                || scanner.result.content_truncated === true
                || scanner.result.raw_stream_truncated === true
                || scanner.result.dropped_event_count !== undefined)
                ? {
                    reconstructed: true,
                    ...(scanner.result.content_events !== undefined ? { events: scanner.result.content_events } : {}),
                    ...(scanner.result.semantic_tail_events !== undefined ? { semantic_tail_events: scanner.result.semantic_tail_events } : {}),
                    ...(scanner.result.raw_stream_body !== undefined ? { raw_stream_body: scanner.result.raw_stream_body } : {}),
                    ...(scanner.result.content_text !== undefined ? { content_text: scanner.result.content_text } : {}),
                    ...(scanner.result.content_truncated ? { content_truncated: true } : {}),
                    ...(scanner.result.raw_stream_truncated ? { raw_stream_truncated: true } : {}),
                    ...(scanner.result.dropped_event_count ? { dropped_event_count: scanner.result.dropped_event_count } : {}),
                }
                : undefined;
        };
        const trace = (last) => {
            if (!opts.onTrace || traced)
                return;
            traced = true;
            let features;
            try {
                if (routeAllowsRouting)
                    features = extractFeatures(body);
            }
            catch { /* a malformed body must not break trace emission */ }
            const record = {
                ts: new Date(t0).toISOString(),
                event: 'llm_turn',
                id: `llm_${randomUUID()}`,
                request_id: getHeader(inboundHeaders, 'x-request-id') ? clip(getHeader(inboundHeaders, 'x-request-id')) : null,
                route,
                provider: providerForTrace(route, upstreamMode, env),
                wire_api: wireApiForRoute(route),
                client: detectClient(inboundHeaders),
                ...(getHeader(inboundHeaders, 'user-agent') ? { user_agent: clip(getHeader(inboundHeaders, 'user-agent')) } : {}),
                ...(() => {
                    try {
                        const hash = extractTopLevelUserIdHash(body);
                        return hash ? { user_id_hash: hash } : {};
                    }
                    catch {
                        return {};
                    }
                })(),
                ...(() => {
                    try {
                        const effort = extractThinkingEffort(body);
                        return effort ? { thinking_effort: effort } : {};
                    }
                    catch {
                        return {};
                    }
                })(),
                session_id: sessionId,
                original_model: typeof originalModel === 'string' ? originalModel : null,
                chosen_model: typeof chosenModel === 'string' ? chosenModel : null,
                tier: decisionTier,
                reason: decisionReason,
                fallback,
                router_enabled: enabled && routeAllowsRouting,
                upstream_mode: upstreamMode,
                status: last.status,
                stream: last.stream,
                ttfb_ms: ttfb,
                latency_ms: clock() - t0,
                ...(features ? { features } : {}),
                ...(last.usage ? { usage: last.usage } : {}),
                ...(last.stop_reason !== undefined ? { stop_reason: last.stop_reason } : {}),
                ...(last.response_id ? { response_id: last.response_id } : {}),
                ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
                // clip(): the trace is shipped as evolution material on the documented promise that NO prompt/completion
                // content enters it (see traceSink.ts). A raw upstream/exception error can echo request fragments and is
                // unbounded, so bound+truncate it here — the single choke point every error path flows through.
                ...(last.error !== undefined ? { error: safeTraceError(last.error) } : {}),
                ...(captureBodies && bodyCaptureAllowed ? { request_headers: captureTraceMetadata(inboundHeaders, env) } : {}),
                ...(captureBodies && bodyCaptureAllowed && last.responseHeaders ? { response_headers: captureTraceMetadata(last.responseHeaders, env) } : {}),
                ...(captureBodies && bodyCaptureAllowed && last.transportMetadata !== undefined ? { transport_metadata: captureTraceMetadata(last.transportMetadata, env) } : {}),
            };
            if (attempts.length > 0) {
                try {
                    record.attempts = captureAttemptBodies();
                }
                catch { /* attempt capture must never break trace emission */ }
            }
            // OPT-IN body capture: only when explicitly enabled. Redacted + size-capped. This is the ONLY place
            // prompt/completion content can enter a record, and only behind the flag — capture must never throw.
            if (captureBodies && bodyCaptureAllowed) {
                try {
                    const reqCap = captureBody(traceRequestBody, env);
                    const respCap = last.responseBody !== undefined ? captureBody(last.responseBody, env) : undefined;
                    if (reqCap)
                        record.requestBody = reqCap.body;
                    if (respCap)
                        record.responseBody = respCap.body;
                    record.redaction = REDACTION_VERSION;
                    if (reqCap?.truncated
                        || respCap?.truncated
                        || responseBodyIndicatesTruncation(last.responseBody)
                        || record.attempts?.some((attempt) => attempt.body_truncated === true))
                        record.body_truncated = true;
                }
                catch { /* capture must never break trace emission */ }
            }
            else if (record.attempts?.some((attempt) => attempt.body_truncated === true)) {
                record.body_truncated = true;
            }
            try {
                opts.onTrace(record);
            }
            catch { /* sink errors never break serving */ }
        };
        // Relay a streaming upstream; with a trace sink attached, tee the bytes through a passive SSE scanner and
        // emit the turn record when the stream finishes (or the client cancels).
        const relayStream = (up) => {
            if (opts.onTrace) {
                const scanner = new SseUsageScanner({ captureContent: captureBodies, env });
                const teed = teeStreamForScan(up.stream, (c) => scanner.push(c), (info) => {
                    scanner.finish();
                    const streamError = scanner.result.error ?? info?.error ?? (info?.cancelled ? 'stream cancelled' : undefined);
                    const responseBody = capturedStreamResponseBody(scanner);
                    const finalAttempt = attempts.find((attempt) => attempt.attempt_index === 1 && attempt.responseBody === undefined);
                    if (finalAttempt && responseBody !== undefined) {
                        finalAttempt.responseBody = responseBody;
                        finalAttempt.body_truncated = responseBodyIndicatesTruncation(responseBody);
                    }
                    trace({
                        status: up.status,
                        stream: true,
                        ...(scanner.result.usage ? { usage: scanner.result.usage } : {}),
                        ...(scanner.result.stop_reason !== undefined ? { stop_reason: scanner.result.stop_reason } : {}),
                        ...(scanner.result.response_id ? { response_id: scanner.result.response_id } : {}),
                        ...(streamError ? { error: streamError } : {}),
                        // Streamed completion is reconstructed from parsed SSE events only when body capture is on.
                        ...(responseBody !== undefined ? { responseBody } : {}),
                        ...(up.headers ? { responseHeaders: up.headers } : {}),
                        ...(up.transportMetadata !== undefined ? { transportMetadata: up.transportMetadata } : {}),
                    });
                });
                return streamResponse({ ...up, stream: teed });
            }
            return streamResponse(up);
        };
        try {
            if (route === '/v1/messages' && upstreamMode !== 'bedrock') {
                const hasInboundKey = !!inboundHeaders['x-api-key'];
                const hasProxyEnvCreds = hasAnthropicProxyCredentials(env);
                if (!hasInboundKey && !hasProxyEnvCreds)
                    throw Object.assign(new Error('x-api-key required'), { statusCode: 401 });
            }
            else if (route !== '/v1/messages') {
                const hasOpenAiCreds = hasOpenAIProxyCredentials(env);
                if (!hasOpenAiCreds)
                    throw Object.assign(new Error('OpenAI upstream API key required'), { statusCode: 401 });
            }
            if (enabled && routeAllowsRouting) {
                try {
                    const decision = pickForTurn({
                        features: extractFeatures(body),
                        router_state: { history: [], pinned: null },
                        config: { default_tier: 'mid', disable: false, hard_pin_after_plan: false },
                    });
                    decisionTier = decision.tier;
                    decisionReason = decision.reason;
                    const tierModel = resolveTierModels(env)[decision.tier];
                    if (tierModel) {
                        if (isIntraFamilyDowngrade(tierModel, originalModel)) {
                            fallback = 'downgrade_blocked';
                            log.warn?.(j({ event: 'router_fallback', reason: 'downgrade_blocked', original_model: originalModel, would_have_been: tierModel }));
                        }
                        else {
                            chosenModel = tierModel;
                        }
                    }
                }
                catch (err) {
                    fallback = 'classifier_error';
                    log.warn?.(j({ event: 'router_fallback', reason: 'classifier_error', original_model: originalModel, error: err instanceof Error ? err.message : String(err) }));
                }
            }
            let outboundBody = body;
            // Rewrite when chosenModel differs from what the CLIENT sent (rawInboundModel), so a bedrock short-ID
            // inbound that didn't change tier still gets canonicalized rather than leaking the short ID upstream.
            if (enabled && routeAllowsRouting && typeof chosenModel === 'string' && chosenModel !== rawInboundModel) {
                try {
                    outboundBody = rewriteModel(body, chosenModel);
                }
                catch (err) {
                    fallback = fallback ?? 'rewrite_error';
                    log.warn?.(j({ event: 'router_fallback', reason: 'rewrite_error', original_model: originalModel, would_have_been: chosenModel, error: err instanceof Error ? err.message : String(err) }));
                    outboundBody = body;
                    chosenModel = originalModel;
                }
            }
            if (enabled && routeAllowsRouting) {
                log.log?.(j({ event: 'router_decision', tier: decisionTier, reason: decisionReason, original_model: originalModel, chosen_model: chosenModel, fallback }));
            }
            traceRequestBody = outboundBody;
            bodyCaptureAllowed = true;
            const upstream = await opts.anthropicProxy(route, outboundBody, { inboundHeaders, upstreamMode });
            if (upstream.traceRequestBody !== undefined)
                traceRequestBody = upstream.traceRequestBody;
            ttfb = clock() - t0;
            if (upstream.stream)
                return relayStream(upstream);
            // 5xx on a router-rewritten request → retry once with the client's original model (a gateway may have no
            // channel for the tier-target model; a successful slightly-pricier response beats a hard 503).
            let finalUpstream = upstream;
            if (enabled && routeAllowsRouting && upstream.status >= 500 && typeof chosenModel === 'string' && chosenModel !== originalModel) {
                const ctx = { original_model: originalModel, would_have_been: chosenModel };
                log.warn?.(j({ event: 'router_fallback', reason: 'upstream_5xx_retry', ...ctx, upstream_status: upstream.status }));
                const drainedFirst = await drain(upstream.text, log, ctx); // release the socket before retrying
                const firstResponseBody = parseUpstreamBody(drainedFirst, upstream.status);
                const firstRequestBody = upstream.traceRequestBody !== undefined ? upstream.traceRequestBody : outboundBody;
                let retryBody = body;
                attempts.push({
                    attempt_index: 0,
                    model: chosenModel,
                    provider: providerForTrace(route, upstreamMode, env),
                    upstream_mode: upstreamMode,
                    status: upstream.status,
                    error: safeTraceError(`upstream ${upstream.status}`),
                    requestBody: firstRequestBody,
                    responseBody: firstResponseBody,
                });
                try {
                    retryBody = rewriteModel(body, String(originalModel));
                    finalUpstream = await opts.anthropicProxy(route, retryBody, { inboundHeaders, upstreamMode });
                    traceRequestBody = finalUpstream.traceRequestBody !== undefined ? finalUpstream.traceRequestBody : retryBody;
                    attempts.push({
                        attempt_index: 1,
                        model: typeof originalModel === 'string' ? originalModel : null,
                        provider: providerForTrace(route, upstreamMode, env),
                        upstream_mode: upstreamMode,
                        status: finalUpstream.status,
                        requestBody: traceRequestBody,
                    });
                }
                catch (err) {
                    attempts.push({
                        attempt_index: 1,
                        model: typeof originalModel === 'string' ? originalModel : null,
                        provider: providerForTrace(route, upstreamMode, env),
                        upstream_mode: upstreamMode,
                        status: 502,
                        error: safeTraceError(err instanceof Error ? err.message : String(err)),
                        requestBody: retryBody,
                    });
                    finalUpstream = { status: upstream.status, headers: upstream.headers, stream: null, text: () => drainedFirst };
                    log.warn?.(j({ event: 'router_fallback', reason: 'upstream_5xx_retry_failed', ...ctx, error: err instanceof Error ? err.message : String(err) }));
                }
            }
            if (finalUpstream.stream)
                return relayStream(finalUpstream);
            // Upstream is normally JSON, but a misconfigured gateway/CDN/LB can return text/HTML. Read once, parse
            // ourselves, and on failure wrap the raw text in an {error} envelope so the client sees the real status.
            let raw = '';
            if (finalUpstream.text) {
                try {
                    raw = await Promise.resolve(finalUpstream.text());
                }
                catch { /* ignore */ }
            }
            const respBody = parseUpstreamBody(raw, finalUpstream.status);
            const finalAttempt = attempts.find((attempt) => attempt.attempt_index === 1 && attempt.responseBody === undefined);
            if (finalAttempt)
                finalAttempt.responseBody = respBody;
            trace({
                status: finalUpstream.status,
                stream: false,
                ...extractResponseMeta(respBody),
                responseBody: respBody,
                ...(finalUpstream.headers ? { responseHeaders: finalUpstream.headers } : {}),
                ...(finalUpstream.transportMetadata !== undefined ? { transportMetadata: finalUpstream.transportMetadata } : {}),
            });
            return { status: finalUpstream.status, body: respBody };
        }
        catch (err) {
            const sc = err.statusCode;
            trace({ status: typeof sc === 'number' ? sc : null, stream: false, error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    };
}