import { captureTraceMetadata, extractThinkingEffort } from './messagesRoute.js';
import { randomUUID } from 'node:crypto';
import { teeStreamForScan } from './sseScan.js';
import { bodyMaxChars, captureBodiesEnabled, captureBody, REDACTION_VERSION, positiveIntegerFromEnv, redactText, stableUserIdHash } from '../llm/bodyCapture.js';
import { rewriteModel } from './cachePassthrough.js';
import { PLAN_RE, SIMPLE_LOOKUP_MAX_CHARS } from './features.js';
import { pickForTurn } from './modelRouter.js';
export const OPENAI_RESPONSE_HEADER_ALLOWLIST = new Set([
    'openai-processing-ms',
    'openai-version',
    'retry-after',
    'x-request-id',
]);
export const GEMINI_RESPONSE_HEADER_ALLOWLIST = new Set([
    'content-type',
    'retry-after',
    'x-request-id',
]);
const CREDENTIAL_QUERY_PARAMS = new Set([
    'key',
    'api_key',
    'apikey',
    'access_token',
    'token',
    'authorization',
    'auth',
    'client_secret',
    'refresh_token',
    'id_token',
    'signature',
    'sig',
]);
const GEMINI_VERTEX_ACTIONS = new Set([
    'generateContent',
    'streamGenerateContent',
    'countTokens',
    'embedContent',
    'batchEmbedContents',
]);
const DEFAULT_PROVIDER_STREAM_MAX_EVENTS = 100_000;
const DEFAULT_PROVIDER_STREAM_SEMANTIC_TAIL_EVENTS = 100_000;
const MAX_PROVIDER_STREAM_LINE_SCAN_TAIL_BYTES = 128 * 1024;
// FIX-11: a single streamed SSE event can legitimately exceed the per-FIELD body cap (a big tool-call argument
// blob, a long reasoning event). When the whole line overflows we can no longer JSON-parse it and fall back to a
// lossy regex tail scan that drops tool calls / semantic events. Give the line scanner a higher floor than the
// body-field cap so far more events stay fully parseable; the captured body is still size-capped downstream by
// captureBody(), so this only widens what we can structurally extract, it does not bloat stored bodies.
const DEFAULT_PROVIDER_STREAM_LINE_MAX_BYTES = 2 * 1024 * 1024;
function providerStreamCaptureLimits(env = process.env) {
    const bodyMax = bodyMaxChars(env);
    return {
        lineMaxBytes: positiveIntegerFromEnv(env, [
            'EVOLVER_LLM_TRACE_PROVIDER_STREAM_LINE_MAX_BYTES',
            'EVOMAP_PROXY_TRACE_PROVIDER_STREAM_LINE_MAX_BYTES',
            'EVOLVER_LLM_TRACE_STREAM_LINE_MAX_BYTES',
            'EVOMAP_PROXY_TRACE_STREAM_LINE_MAX_BYTES',
        ], Math.max(bodyMax, DEFAULT_PROVIDER_STREAM_LINE_MAX_BYTES)),
        chunkMaxEvents: positiveIntegerFromEnv(env, [
            'EVOLVER_LLM_TRACE_PROVIDER_STREAM_MAX_EVENTS',
            'EVOMAP_PROXY_TRACE_PROVIDER_STREAM_MAX_EVENTS',
            'EVOLVER_LLM_TRACE_STREAM_MAX_EVENTS',
            'EVOMAP_PROXY_TRACE_STREAM_MAX_EVENTS',
        ], DEFAULT_PROVIDER_STREAM_MAX_EVENTS),
        chunkMaxBytes: positiveIntegerFromEnv(env, [
            'EVOLVER_LLM_TRACE_PROVIDER_STREAM_MAX_BYTES',
            'EVOMAP_PROXY_TRACE_PROVIDER_STREAM_MAX_BYTES',
            'EVOLVER_LLM_TRACE_STREAM_MAX_BYTES',
            'EVOMAP_PROXY_TRACE_STREAM_MAX_BYTES',
        ], bodyMax),
        rawStreamMaxChars: positiveIntegerFromEnv(env, [
            'EVOLVER_LLM_TRACE_PROVIDER_RAW_STREAM_MAX_CHARS',
            'EVOMAP_PROXY_TRACE_PROVIDER_RAW_STREAM_MAX_CHARS',
            'EVOLVER_LLM_TRACE_STREAM_RAW_MAX_CHARS',
            'EVOMAP_PROXY_TRACE_STREAM_RAW_MAX_CHARS',
        ], bodyMax),
        semanticTailMaxEvents: positiveIntegerFromEnv(env, [
            'EVOLVER_LLM_TRACE_PROVIDER_STREAM_SEMANTIC_TAIL_MAX_EVENTS',
            'EVOMAP_PROXY_TRACE_PROVIDER_STREAM_SEMANTIC_TAIL_MAX_EVENTS',
            'EVOLVER_LLM_TRACE_STREAM_SEMANTIC_TAIL_MAX_EVENTS',
            'EVOMAP_PROXY_TRACE_STREAM_SEMANTIC_TAIL_MAX_EVENTS',
        ], DEFAULT_PROVIDER_STREAM_SEMANTIC_TAIL_EVENTS),
        semanticTailMaxBytes: positiveIntegerFromEnv(env, [
            'EVOLVER_LLM_TRACE_PROVIDER_STREAM_SEMANTIC_TAIL_MAX_BYTES',
            'EVOMAP_PROXY_TRACE_PROVIDER_STREAM_SEMANTIC_TAIL_MAX_BYTES',
            'EVOLVER_LLM_TRACE_STREAM_SEMANTIC_TAIL_MAX_BYTES',
            'EVOMAP_PROXY_TRACE_STREAM_SEMANTIC_TAIL_MAX_BYTES',
        ], bodyMax),
    };
}
const OPENAI_ROUTER_ENABLED_KEYS = ['EVOLVER_LLM_OPENAI_ROUTER_ENABLED', 'EVOMAP_OPENAI_ROUTER_ENABLED'];
const OPENAI_ROUTE_THREADED_KEYS = ['EVOLVER_LLM_OPENAI_ROUTE_THREADED', 'EVOMAP_OPENAI_ROUTE_THREADED'];
const OPENAI_ROUTED_RETRY_STATUSES = new Set([400, 404, 422]);
const ROUTER_FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'none']);
function jsonStringify(o) {
    return JSON.stringify(o);
}
function copyResponseHeaders(headers = {}, allow) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (!allow(lower) || value === undefined || value === null)
            continue;
        if (/[\r\n]/.test(value))
            continue;
        out[lower] = value;
    }
    return out;
}
export function copyOpenAIResponseHeaders(headers = {}) {
    return copyResponseHeaders(headers, (lower) => OPENAI_RESPONSE_HEADER_ALLOWLIST.has(lower) || lower.startsWith('x-ratelimit-'));
}
export function copyGeminiResponseHeaders(headers = {}) {
    return copyResponseHeaders(headers, (lower) => GEMINI_RESPONSE_HEADER_ALLOWLIST.has(lower) || lower.startsWith('x-goog-'));
}
function responseToBody(raw, status, headers, log, event) {
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        log.warn?.(jsonStringify({
            event,
            reason: 'upstream_non_json',
            upstream_status: status,
            content_type: headers?.['content-type'] || '',
            response_bytes: Buffer.byteLength(raw),
        }));
        return { error: raw };
    }
}
function attemptResponseToBody(raw) {
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return { error: raw };
    }
}
function asUpstreamError(provider, err, fallback = 502) {
    const sc = err && typeof err === 'object' && 'statusCode' in err ? Number(err.statusCode) : NaN;
    return Object.assign(new Error(`${provider} upstream request failed`), {
        statusCode: Number.isFinite(sc) ? sc : fallback,
        cause: err,
    });
}
function badRequest(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function envEnabled(env, keys) {
    for (const key of keys) {
        const raw = env[key];
        if (raw === undefined)
            continue;
        const normalized = String(raw).trim().toLowerCase();
        if (!normalized || ROUTER_FALSE_VALUES.has(normalized))
            return false;
        return true;
    }
    return false;
}
function routeSpecificOpenAIModelKeys(route, tier) {
    if (route === '/v1/responses')
        return [`EVOLVER_LLM_OPENAI_RESPONSES_MODEL_${tier}`, `EVOMAP_OPENAI_RESPONSES_MODEL_${tier}`];
    return [`EVOLVER_LLM_OPENAI_CHAT_MODEL_${tier}`, `EVOMAP_OPENAI_CHAT_MODEL_${tier}`];
}
export function resolveOpenAITierModels(env = process.env, route) {
    const out = {};
    const first = (keys) => {
        for (const key of keys) {
            const value = env[key];
            if (typeof value === 'string' && value.trim())
                return value.trim();
        }
        return undefined;
    };
    const tierKeys = (tier) => [
        ...(route ? routeSpecificOpenAIModelKeys(route, tier) : []),
        `EVOLVER_LLM_OPENAI_MODEL_${tier}`,
        `EVOMAP_OPENAI_MODEL_${tier}`,
    ];
    const cheap = first(tierKeys('CHEAP'));
    const mid = first(tierKeys('MID'));
    const expensive = first(tierKeys('EXPENSIVE'));
    if (cheap)
        out.cheap = cheap;
    if (mid)
        out.mid = mid;
    if (expensive)
        out.expensive = expensive;
    return out;
}
function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.map((part) => {
        if (typeof part === 'string')
            return part;
        if (!isRecord(part))
            return '';
        for (const key of ['text', 'input_text', 'output_text', 'content']) {
            const value = part[key];
            if (typeof value === 'string')
                return value;
        }
        return '';
    }).filter(Boolean).join('\n');
}
function isOpenAIToolOutput(value) {
    if (!isRecord(value))
        return false;
    const type = typeof value['type'] === 'string' ? value['type'] : '';
    const role = typeof value['role'] === 'string' ? value['role'] : '';
    return type === 'function_call_output' || type === 'tool_result' || role === 'tool';
}
function openAIResponsesInputText(input) {
    if (typeof input === 'string')
        return input;
    if (!Array.isArray(input))
        return '';
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (!isRecord(item) || isOpenAIToolOutput(item))
            continue;
        const role = typeof item['role'] === 'string' ? item['role'] : '';
        if (role && role !== 'user')
            continue;
        const direct = textFromContent(item['content']);
        if (direct)
            return direct;
        const text = textFromContent(item['text']);
        if (text)
            return text;
    }
    return '';
}
function openAIChatLastUserText(messages) {
    if (!Array.isArray(messages))
        return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!isRecord(msg) || msg['role'] !== 'user')
            continue;
        return textFromContent(msg['content']);
    }
    return '';
}
function openAIChatLastToolCallCount(messages) {
    if (!Array.isArray(messages))
        return 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!isRecord(msg) || msg['role'] !== 'assistant')
            continue;
        const toolCalls = msg['tool_calls'];
        return Array.isArray(toolCalls) ? toolCalls.length : 0;
    }
    return 0;
}
function featuresFromText(userText, toolOnly, toolCallCount) {
    const trimmed = userText.trim();
    const userRequestedPlanning = trimmed.length > 0 && PLAN_RE.test(trimmed);
    return {
        last_assistant_tool_call_count: toolCallCount,
        last_assistant_had_tool_call: toolCallCount > 0,
        last_user_is_tool_result_only: toolOnly,
        user_requested_planning: userRequestedPlanning,
        user_simple_lookup: trimmed.length > 0 && !toolOnly && !userRequestedPlanning && trimmed.length <= SIMPLE_LOOKUP_MAX_CHARS,
        last_assistant_output_tokens: 0,
        last_assistant_stop_reason: toolOnly || toolCallCount > 0 ? 'ToolUse' : null,
    };
}
function extractOpenAIFeatures(route, body) {
    if (route === '/v1/chat/completions') {
        const messages = body['messages'];
        const tail = Array.isArray(messages) ? messages[messages.length - 1] : null;
        const toolOnly = isOpenAIToolOutput(tail);
        return featuresFromText(openAIChatLastUserText(messages), toolOnly, openAIChatLastToolCallCount(messages));
    }
    const input = body['input'];
    const toolOnly = Array.isArray(input) && input.length > 0 && input.every(isOpenAIToolOutput);
    const functionCallCount = Array.isArray(input)
        ? input.filter((item) => isRecord(item) && item['type'] === 'function_call').length
        : 0;
    return featuresFromText(openAIResponsesInputText(input), toolOnly, functionCallCount);
}
function hasOpenAIResponsesThreadState(body) {
    return body['previous_response_id'] !== undefined || body['conversation'] !== undefined;
}
function shouldRetryRoutedOpenAI(upstream, opts) {
    if (upstream.stream || opts.provider !== 'openai')
        return false;
    if (!opts.retryBody || !opts.chosenModel || opts.chosenModel === opts.model)
        return false;
    return upstream.status >= 500 || OPENAI_ROUTED_RETRY_STATUSES.has(upstream.status);
}
function routeOpenAIRequest(route, body, env, log) {
    const originalModel = typeof body.model === 'string' ? body.model : null;
    let chosenModel = originalModel;
    let tier = null;
    let reason = null;
    let fallback = null;
    let features;
    const routerEnabled = envEnabled(env, OPENAI_ROUTER_ENABLED_KEYS);
    if (!routerEnabled)
        return { body, originalModel, chosenModel, tier, reason, fallback, routerEnabled };
    if (route === '/v1/responses' && hasOpenAIResponsesThreadState(body) && !envEnabled(env, OPENAI_ROUTE_THREADED_KEYS)) {
        return { body, originalModel, chosenModel, tier, reason, fallback: 'threaded_passthrough', routerEnabled };
    }
    if (!originalModel) {
        return { body, originalModel, chosenModel, tier, reason, fallback: 'missing_model', routerEnabled };
    }
    try {
        features = extractOpenAIFeatures(route, body);
        const decision = pickForTurn({
            features,
            router_state: { history: [], pinned: null },
            config: { default_tier: 'mid', disable: false, hard_pin_after_plan: false },
        });
        tier = decision.tier;
        reason = decision.reason;
        const tierModel = resolveOpenAITierModels(env, route)[decision.tier];
        if (tierModel)
            chosenModel = tierModel;
    }
    catch (err) {
        fallback = 'classifier_error';
        log.warn?.(jsonStringify({ event: 'router_fallback', route, reason: fallback, original_model: originalModel, error: err instanceof Error ? err.message : String(err) }));
    }
    let routedBody = body;
    if (chosenModel && chosenModel !== originalModel) {
        try {
            routedBody = rewriteModel(body, chosenModel);
        }
        catch (err) {
            fallback = fallback ?? 'rewrite_error';
            chosenModel = originalModel;
            routedBody = body;
            log.warn?.(jsonStringify({ event: 'router_fallback', route, reason: fallback, original_model: originalModel, error: err instanceof Error ? err.message : String(err) }));
        }
    }
    log.log?.(jsonStringify({ event: 'router_decision', route, tier, reason, original_model: originalModel, chosen_model: chosenModel, fallback }));
    return { body: routedBody, originalModel, chosenModel, tier, reason, fallback, routerEnabled, ...(features ? { features } : {}) };
}
function setUsageNumber(usage, key, value) {
    if (typeof value === 'number' && Number.isFinite(value))
        usage[key] = value;
}
function usageOrUndefined(usage) {
    return Object.keys(usage).length > 0 ? usage : undefined;
}
function mergeTraceMeta(into, next) {
    if (next.usage)
        into.usage = { ...(into.usage ?? {}), ...next.usage };
    if (next.stop_reason !== undefined)
        into.stop_reason = next.stop_reason;
    if (next.response_id !== undefined)
        into.response_id = next.response_id;
    if (next.error !== undefined)
        into.error = next.error;
}
function responseIdFromBody(body) {
    if (!isRecord(body))
        return undefined;
    const id = body['id'];
    if (typeof id === 'string' && id.length > 0)
        return id;
    const response = body['response'];
    if (isRecord(response) && typeof response['id'] === 'string' && response['id'].length > 0)
        return response['id'];
    return undefined;
}
function openAIResponsesMeta(body) {
    const o = isRecord(body) && isRecord(body['response']) ? body['response'] : body;
    if (!isRecord(o))
        return {};
    const out = {};
    if (isRecord(o['usage'])) {
        const u = o['usage'];
        const usage = {};
        setUsageNumber(usage, 'input_tokens', u['input_tokens']);
        setUsageNumber(usage, 'output_tokens', u['output_tokens']);
        setUsageNumber(usage, 'cache_creation_input_tokens', u['cache_creation_input_tokens']);
        setUsageNumber(usage, 'cache_read_input_tokens', u['cache_read_input_tokens']);
        const mapped = usageOrUndefined(usage);
        if (mapped)
            out.usage = mapped;
    }
    const incomplete = isRecord(o['incomplete_details']) ? o['incomplete_details']['reason'] : undefined;
    if (typeof incomplete === 'string')
        out.stop_reason = incomplete;
    else if (typeof o['status'] === 'string')
        out.stop_reason = o['status'];
    if ((o['status'] === 'failed' || o['status'] === 'cancelled') && isRecord(o['error'])) {
        const message = o['error']['message'];
        if (typeof message === 'string' && message.trim())
            out.error = message;
    }
    const responseId = responseIdFromBody(body) ?? responseIdFromBody(o);
    if (responseId)
        out.response_id = responseId;
    return out;
}
function openAIChatMeta(body) {
    if (!isRecord(body))
        return {};
    const out = {};
    if (isRecord(body['usage'])) {
        const u = body['usage'];
        const usage = {};
        setUsageNumber(usage, 'input_tokens', u['prompt_tokens']);
        setUsageNumber(usage, 'output_tokens', u['completion_tokens']);
        const mapped = usageOrUndefined(usage);
        if (mapped)
            out.usage = mapped;
    }
    const choices = body['choices'];
    const first = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null;
    if (first && (typeof first['finish_reason'] === 'string' || first['finish_reason'] === null)) {
        out.stop_reason = first['finish_reason'];
    }
    const responseId = responseIdFromBody(body);
    if (responseId)
        out.response_id = responseId;
    return out;
}
function geminiMeta(body) {
    if (!isRecord(body))
        return {};
    const out = {};
    if (isRecord(body['usageMetadata'])) {
        const u = body['usageMetadata'];
        const usage = {};
        setUsageNumber(usage, 'input_tokens', u['promptTokenCount']);
        setUsageNumber(usage, 'output_tokens', u['candidatesTokenCount']);
        setUsageNumber(usage, 'cache_read_input_tokens', u['cachedContentTokenCount']);
        const mapped = usageOrUndefined(usage);
        if (mapped)
            out.usage = mapped;
    }
    const candidates = body['candidates'];
    const first = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : null;
    if (first && typeof first['finishReason'] === 'string')
        out.stop_reason = first['finishReason'];
    return out;
}
function ollamaMeta(body) {
    if (!isRecord(body))
        return {};
    const out = {};
    const usage = {};
    setUsageNumber(usage, 'input_tokens', body['prompt_eval_count']);
    setUsageNumber(usage, 'output_tokens', body['eval_count']);
    const mapped = usageOrUndefined(usage);
    if (mapped)
        out.usage = mapped;
    if (typeof body['done_reason'] === 'string')
        out.stop_reason = body['done_reason'];
    return out;
}
function providerMeta(route, body) {
    if (route.provider === 'openai' && route.upstreamPath === '/responses')
        return openAIResponsesMeta(body);
    if (route.provider === 'openai' && route.upstreamPath === '/chat/completions')
        return openAIChatMeta(body);
    if (route.provider === 'gemini' || route.provider === 'vertex')
        return geminiMeta(body);
    if (route.provider === 'ollama')
        return ollamaMeta(body);
    return {};
}
function setProviderTextUsage(into, key, match) {
    if (!match?.[1])
        return;
    const n = Number(match[1]);
    if (!Number.isFinite(n))
        return;
    const usage = into.usage ?? {};
    usage[key] = n;
    into.usage = usage;
}
function scanProviderTextMetadata(into, text) {
    const id = /"id"\s*:\s*"((?:resp_|chatcmpl-|msg_)[^"]+)"/.exec(text);
    if (id?.[1])
        into.response_id = id[1];
    const status = /"status"\s*:\s*"(completed|failed|incomplete|cancelled)"/.exec(text);
    if (status?.[1])
        into.stop_reason = status[1];
    const finish = /"finish_reason"\s*:\s*("(?:[^"]+)"|null)/.exec(text);
    if (finish?.[1])
        into.stop_reason = finish[1] === 'null' ? null : finish[1].slice(1, -1);
    setProviderTextUsage(into, 'input_tokens', /"input_tokens"\s*:\s*(\d+)/.exec(text));
    setProviderTextUsage(into, 'output_tokens', /"output_tokens"\s*:\s*(\d+)/.exec(text));
    setProviderTextUsage(into, 'input_tokens', /"prompt_tokens"\s*:\s*(\d+)/.exec(text));
    setProviderTextUsage(into, 'output_tokens', /"completion_tokens"\s*:\s*(\d+)/.exec(text));
}
function responseBodyIndicatesTruncation(value) {
    return isRecord(value) && (value['provider_stream_truncated'] === true
        || value['raw_stream_truncated'] === true
        || value['truncated'] === true);
}
function copyDefinedFields(source, keys) {
    const out = {};
    for (const key of keys)
        if (source[key] !== undefined)
            out[key] = source[key];
    return out;
}
function semanticToolItem(item) {
    if (!isRecord(item))
        return undefined;
    const type = typeof item['type'] === 'string' ? item['type'] : '';
    const role = typeof item['role'] === 'string' ? item['role'] : '';
    const fn = isRecord(item['function']) ? item['function'] : undefined;
    const isSemantic = type === 'function_call'
        || type === 'tool_use'
        || type === 'function_call_output'
        || type === 'tool_result'
        || role === 'tool'
        || Array.isArray(item['tool_calls'])
        || fn !== undefined;
    if (!isSemantic)
        return undefined;
    const out = copyDefinedFields(item, [
        'id',
        'type',
        'role',
        'call_id',
        'tool_call_id',
        'tool_use_id',
        'name',
        'arguments',
        'input',
        'output',
        'content',
        'status',
        'index',
        'output_index',
    ]);
    if (Array.isArray(item['tool_calls']))
        out['tool_calls'] = item['tool_calls'];
    if (fn)
        out['function'] = copyDefinedFields(fn, ['name', 'arguments']);
    return Object.keys(out).length > 0 ? out : undefined;
}
function semanticResponse(response) {
    if (!isRecord(response))
        return undefined;
    const out = copyDefinedFields(response, ['id', 'status', 'usage', 'incomplete_details']);
    const output = Array.isArray(response['output'])
        ? response['output'].map((item) => semanticToolItem(item)).filter((item) => item !== undefined)
        : [];
    if (output.length > 0)
        out['output'] = output;
    if (isRecord(response['error']))
        out['error'] = copyDefinedFields(response['error'], ['message', 'type', 'code']);
    return Object.keys(out).length > 0 ? out : undefined;
}
function semanticOpenAIChatEvent(evt) {
    const choices = Array.isArray(evt['choices'])
        ? evt['choices'].map((choice) => {
            if (!isRecord(choice))
                return undefined;
            const out = copyDefinedFields(choice, ['index']);
            if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null)
                out['finish_reason'] = choice['finish_reason'];
            const delta = isRecord(choice['delta']) ? choice['delta'] : undefined;
            const message = isRecord(choice['message']) ? choice['message'] : undefined;
            if (delta && Array.isArray(delta['tool_calls']))
                out['delta'] = { tool_calls: delta['tool_calls'] };
            if (message && Array.isArray(message['tool_calls']))
                out['message'] = { tool_calls: message['tool_calls'] };
            if (message && isRecord(message['function_call']))
                out['message'] = { ...(isRecord(out['message']) ? out['message'] : {}), function_call: message['function_call'] };
            return Object.keys(out).some((key) => key !== 'index') ? out : undefined;
        }).filter((choice) => choice !== undefined)
        : [];
    const out = copyDefinedFields(evt, ['id', 'usage']);
    if (choices.length > 0)
        out['choices'] = choices;
    return Object.keys(out).length > 0 ? out : undefined;
}
function semanticOpenAIResponsesEvent(evt) {
    const type = typeof evt['type'] === 'string' ? evt['type'] : '';
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        return copyDefinedFields(evt, ['type', 'item_id', 'output_index', 'call_id', 'id', 'delta', 'arguments']);
    }
    const item = semanticToolItem(evt['item']);
    if (item) {
        const out = copyDefinedFields(evt, ['type', 'output_index', 'item_id']);
        out['item'] = item;
        return out;
    }
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete' || type === 'response.cancelled') {
        const response = semanticResponse(evt['response']);
        if (response)
            return { type, response };
    }
    return undefined;
}
function semanticAnthropicEvent(evt) {
    const type = typeof evt['type'] === 'string' ? evt['type'] : '';
    if (type === 'content_block_start') {
        const contentBlock = semanticToolItem(evt['content_block']);
        if (contentBlock)
            return { ...copyDefinedFields(evt, ['type', 'index']), content_block: contentBlock };
    }
    if (type === 'content_block_delta' && isRecord(evt['delta']) && evt['delta']['type'] === 'input_json_delta') {
        return { ...copyDefinedFields(evt, ['type', 'index']), delta: copyDefinedFields(evt['delta'], ['type', 'partial_json']) };
    }
    if (type === 'message_delta') {
        const out = copyDefinedFields(evt, ['type', 'usage']);
        if (isRecord(evt['delta'])) {
            const delta = copyDefinedFields(evt['delta'], ['stop_reason', 'stop_sequence']);
            if (Object.keys(delta).length > 0)
                out['delta'] = delta;
        }
        return out['usage'] !== undefined || out['delta'] !== undefined ? out : undefined;
    }
    return undefined;
}
// Gemini/Vertex tool calls live in candidates[].content.parts[] as
// { functionCall: { name, args } } / { functionResponse: { name, response } }.
// Keep only those tool-bearing parts so downstream tool-call reconstruction can
// rebuild them while still dropping bulky free-text/thought parts.
function semanticGeminiContentParts(content) {
    if (!isRecord(content))
        return undefined;
    const parts = Array.isArray(content['parts']) ? content['parts'] : [];
    const kept = parts
        .map((part) => {
        if (!isRecord(part))
            return undefined;
        if (isRecord(part['functionCall']))
            return copyDefinedFields(part, ['functionCall']);
        if (isRecord(part['functionResponse']))
            return copyDefinedFields(part, ['functionResponse']);
        return undefined;
    })
        .filter((part) => part !== undefined);
    if (kept.length === 0)
        return undefined;
    const out = copyDefinedFields(content, ['role']);
    out['parts'] = kept;
    return out;
}
function semanticGenericEvent(evt) {
    const out = copyDefinedFields(evt, [
        'usage',
        'usageMetadata',
        'prompt_eval_count',
        'eval_count',
        'done',
        'done_reason',
    ]);
    const candidates = Array.isArray(evt['candidates'])
        ? evt['candidates'].map((candidate) => {
            if (!isRecord(candidate))
                return undefined;
            const candidateOut = copyDefinedFields(candidate, ['finishReason']);
            const content = semanticGeminiContentParts(candidate['content']);
            if (content)
                candidateOut['content'] = content;
            return candidateOut;
        })
            .filter((candidate) => candidate !== undefined && Object.keys(candidate).length > 0)
        : [];
    if (candidates.length > 0)
        out['candidates'] = candidates;
    if (out['done'] !== true)
        delete out['done'];
    return Object.keys(out).length > 0 ? out : undefined;
}
function semanticTailEvents(parsed) {
    if (Array.isArray(parsed))
        return parsed.flatMap((item) => semanticTailEvents(item));
    if (!isRecord(parsed))
        return [];
    const event = semanticOpenAIResponsesEvent(parsed)
        ?? semanticOpenAIChatEvent(parsed)
        ?? semanticAnthropicEvent(parsed)
        ?? semanticGenericEvent(parsed);
    return event ? [event] : [];
}
class ProviderStreamMetaScanner {
    route;
    env;
    result = {};
    responseChunks = [];
    semanticTailEvents = [];
    responseChunkBytes = 0;
    semanticTailBytes = 0;
    rawStreamBody = '';
    rawStreamChars = 0;
    responseChunksTruncated = false;
    rawStreamTruncated = false;
    semanticTailEventsTruncated = false;
    droppedSemanticTailEventCount = 0;
    buf = '';
    overflowedLine = false;
    overflowTail = '';
    truncatedLineCount = 0;
    droppedLineChars = 0;
    decoder = new TextDecoder();
    limits;
    constructor(route, env = process.env) {
        this.route = route;
        this.env = env;
        this.limits = providerStreamCaptureLimits(env);
    }
    push(chunk) {
        let text;
        if (typeof chunk === 'string')
            text = chunk;
        else if (chunk instanceof Uint8Array)
            text = this.decoder.decode(chunk, { stream: true });
        else
            return;
        if (captureBodiesEnabled(this.env))
            this.captureRawStreamText(text);
        this.pushText(text);
    }
    finish() {
        const tail = this.decoder.decode();
        if (tail) {
            if (captureBodiesEnabled(this.env))
                this.captureRawStreamText(tail);
            this.pushText(tail);
        }
        if (this.overflowedLine) {
            this.finishOverflowedLine();
            return;
        }
        const line = this.buf.trim();
        this.buf = '';
        if (line)
            this.scanLine(line);
    }
    responseBody() {
        if (this.responseChunks.length === 0
            && this.truncatedLineCount === 0
            && !this.responseChunksTruncated
            && !this.rawStreamBody
            && !this.rawStreamTruncated)
            return undefined;
        return {
            reconstructed: true,
            ...(this.responseChunks.length > 0 ? { chunks: this.responseChunks } : {}),
            ...(this.semanticTailEvents.length > 0 ? { semantic_tail_events: this.semanticTailEvents } : {}),
            ...(this.rawStreamBody ? { raw_stream_body: this.rawStreamBody } : {}),
            ...(this.responseChunksTruncated ? { truncated: true } : {}),
            ...(this.rawStreamTruncated ? { raw_stream_truncated: true } : {}),
            ...(this.semanticTailEventsTruncated
                ? {
                    semantic_tail_events_truncated: true,
                    dropped_semantic_tail_event_count: this.droppedSemanticTailEventCount,
                }
                : {}),
            ...(this.truncatedLineCount > 0
                ? {
                    provider_stream_truncated: true,
                    truncated_line_count: this.truncatedLineCount,
                    dropped_line_chars: this.droppedLineChars,
                }
                : {}),
        };
    }
    captureRawStreamText(text) {
        if (!text)
            return;
        const redacted = redactText(text);
        const available = Math.max(0, this.limits.rawStreamMaxChars - this.rawStreamChars);
        if (available > 0) {
            const piece = redacted.slice(0, available);
            this.rawStreamBody += piece;
            this.rawStreamChars += piece.length;
        }
        if (redacted.length > available)
            this.rawStreamTruncated = true;
    }
    pushText(text) {
        let remaining = text;
        while (remaining.length > 0) {
            if (this.overflowedLine) {
                const nl = remaining.indexOf('\n');
                const segment = nl >= 0 ? remaining.slice(0, nl) : remaining;
                this.scanOverflowText(segment);
                this.droppedLineChars += segment.length;
                if (nl < 0)
                    return;
                this.finishOverflowedLine();
                remaining = remaining.slice(nl + 1);
                continue;
            }
            const nl = remaining.indexOf('\n');
            const segment = nl >= 0 ? remaining.slice(0, nl) : remaining;
            if (this.buf.length + segment.length > this.limits.lineMaxBytes) {
                this.startOverflowedLine(this.buf + segment);
                this.buf = '';
                if (nl < 0)
                    return;
                this.finishOverflowedLine();
                remaining = remaining.slice(nl + 1);
                continue;
            }
            this.buf += segment;
            if (nl < 0)
                return;
            const line = this.buf.trim();
            this.buf = '';
            if (line)
                this.scanLine(line);
            remaining = remaining.slice(nl + 1);
        }
    }
    startOverflowedLine(text) {
        this.overflowedLine = true;
        this.truncatedLineCount += 1;
        this.scanOverflowText(text);
        this.droppedLineChars += text.length;
    }
    finishOverflowedLine() {
        if (this.overflowTail)
            scanProviderTextMetadata(this.result, this.overflowTail);
        this.overflowedLine = false;
        this.overflowTail = '';
    }
    scanOverflowText(text) {
        this.overflowTail = (this.overflowTail + text).slice(-MAX_PROVIDER_STREAM_LINE_SCAN_TAIL_BYTES);
        scanProviderTextMetadata(this.result, text);
    }
    scanLine(line) {
        let payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!line.startsWith('data:')) {
            payload = payload
                .replace(/^\[\s*/, '')
                .replace(/^,\s*/, '')
                .replace(/\s*,?\s*\]\s*$/, '')
                .replace(/,\s*$/, '')
                .trim();
        }
        if (!payload || payload === '[DONE]')
            return;
        let parsed;
        try {
            parsed = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (captureBodiesEnabled(this.env)) {
            this.captureParsedBodyChunk(parsed);
            this.captureParsedSemanticTail(parsed);
        }
        this.scanParsed(parsed);
    }
    captureParsedBodyChunk(parsed) {
        if (this.responseChunksTruncated)
            return;
        let bytes = 0;
        try {
            bytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
        }
        catch {
            return;
        }
        if (this.responseChunks.length >= this.limits.chunkMaxEvents
            || this.responseChunkBytes + bytes > this.limits.chunkMaxBytes) {
            this.responseChunksTruncated = true;
            return;
        }
        this.responseChunks.push(parsed);
        this.responseChunkBytes += bytes;
    }
    captureParsedSemanticTail(parsed) {
        if (!this.responseChunksTruncated)
            return;
        for (const event of semanticTailEvents(parsed))
            this.pushSemanticTailEvent(event);
    }
    pushSemanticTailEvent(event) {
        const captured = captureBody(event, this.env);
        if (!captured)
            return;
        let redactedEvent;
        try {
            redactedEvent = JSON.parse(captured.body);
        }
        catch {
            redactedEvent = captured.body;
        }
        let bytes = 0;
        try {
            bytes = Buffer.byteLength(JSON.stringify(redactedEvent), 'utf8');
        }
        catch {
            return;
        }
        if (bytes > this.limits.semanticTailMaxBytes) {
            this.semanticTailEventsTruncated = true;
            this.droppedSemanticTailEventCount += 1;
            return;
        }
        while (this.semanticTailEvents.length >= this.limits.semanticTailMaxEvents
            || this.semanticTailBytes + bytes > this.limits.semanticTailMaxBytes) {
            const dropped = this.semanticTailEvents.shift();
            if (dropped === undefined)
                break;
            this.semanticTailEventsTruncated = true;
            this.droppedSemanticTailEventCount += 1;
            try {
                this.semanticTailBytes -= Buffer.byteLength(JSON.stringify(dropped), 'utf8');
            }
            catch {
                this.semanticTailBytes = 0;
            }
        }
        this.semanticTailEvents.push(redactedEvent);
        this.semanticTailBytes += bytes;
    }
    scanParsed(parsed) {
        if (Array.isArray(parsed)) {
            for (const item of parsed)
                this.scanParsed(item);
            return;
        }
        mergeTraceMeta(this.result, providerMeta(this.route, parsed));
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
        // Accept both spellings — see the matching note in messagesRoute.ts. The
        // archive-side session key reads `session_id ?? sessionId` from this field, so
        // dropping camelCase here costs a join, not just a field.
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
    if (isRecord(metadata)) {
        const sid = sessionIdFromUserField(metadata['user_id']) || sessionIdFromPlainField(metadata['session_id']);
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
    if (isRecord(metadata)) {
        const userId = metadata['user_id'];
        if (typeof userId === 'string' || typeof userId === 'number')
            return stableUserIdHash(userId);
    }
    const user = body['user'];
    if (typeof user === 'string' || typeof user === 'number')
        return stableUserIdHash(user);
    return undefined;
}
function extractPreviousResponseId(body) {
    const value = body['previous_response_id'];
    return typeof value === 'string' && value.length > 0 ? clip(value) : null;
}
function retryHeadersForMutatedOpenAIRequest(headers) {
    const out = { ...headers };
    for (const name of Object.keys(out)) {
        const lower = name.toLowerCase();
        if (lower === 'idempotency-key' || lower.startsWith('x-stainless-retry-'))
            delete out[name];
    }
    return out;
}
function detectClient(headers) {
    const ua = getHeader(headers, 'user-agent').toLowerCase();
    if (ua.includes('claude'))
        return 'claude-code';
    if (ua.includes('cursor'))
        return 'cursor';
    if (ua.includes('codex'))
        return 'codex';
    return 'unknown';
}
function wireApiForTrace(opts) {
    if (opts.provider === 'openai' && opts.upstreamPath === '/responses')
        return 'openai_responses';
    if (opts.provider === 'openai' && opts.upstreamPath === '/chat/completions')
        return 'openai_chat_completions';
    if (opts.provider === 'gemini')
        return 'gemini_generate_content';
    if (opts.provider === 'vertex')
        return 'vertex_gemini';
    if (opts.provider === 'ollama')
        return 'ollama_api';
    return 'anthropic_messages';
}
function captureTraceAttempts(attempts, captureBodies, env) {
    return attempts.map((attempt) => {
        const record = {
            attempt_index: attempt.attempt_index,
            model: attempt.model,
            provider: attempt.provider,
            upstream_mode: attempt.upstream_mode,
            status: attempt.status,
            ...(attempt.error !== undefined ? { error: safeTraceError(attempt.error) } : {}),
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
}
function emitTrace(opts, t0, ttfb, last, bodyCaptureAllowed) {
    if (!opts.onTrace)
        return;
    const clock = opts.clock ?? (() => Date.now());
    const requestId = getHeader(opts.headers, 'x-request-id');
    const sessionId = extractSessionId(opts.headers, opts.body);
    const previousResponseId = extractPreviousResponseId(opts.body);
    const captureBodies = bodyCaptureAllowed && captureBodiesEnabled(opts.env ?? process.env);
    const record = {
        ts: new Date(t0).toISOString(),
        event: 'llm_turn',
        id: `llm_${randomUUID()}`,
        request_id: requestId ? clip(requestId) : null,
        route: opts.route ?? opts.upstreamPath,
        provider: opts.provider,
        wire_api: wireApiForTrace(opts),
        client: detectClient(opts.headers),
        ...(getHeader(opts.headers, 'user-agent') ? { user_agent: clip(getHeader(opts.headers, 'user-agent')) } : {}),
        ...(() => {
            try {
                const hash = extractTopLevelUserIdHash(opts.body);
                return hash ? { user_id_hash: hash } : {};
            }
            catch {
                return {};
            }
        })(),
        ...(() => {
            try {
                const effort = extractThinkingEffort(opts.body);
                return effort ? { thinking_effort: effort } : {};
            }
            catch {
                return {};
            }
        })(),
        session_id: sessionId,
        original_model: opts.model,
        chosen_model: opts.chosenModel ?? opts.model,
        tier: opts.tier ?? null,
        reason: opts.reason ?? null,
        fallback: opts.fallback ?? null,
        router_enabled: opts.routerEnabled ?? false,
        upstream_mode: opts.provider,
        status: last.status,
        stream: last.stream,
        ttfb_ms: ttfb,
        latency_ms: clock() - t0,
        ...(opts.features ? { features: opts.features } : {}),
        ...(last.usage ? { usage: last.usage } : {}),
        ...(last.stop_reason !== undefined ? { stop_reason: last.stop_reason } : {}),
        ...(last.response_id ? { response_id: clip(last.response_id) } : {}),
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...(last.error !== undefined ? { error: safeTraceError(last.error) } : {}),
        ...(captureBodies ? { request_headers: captureTraceMetadata(opts.headers, opts.env ?? process.env) } : {}),
        ...(captureBodies && last.responseHeaders ? { response_headers: captureTraceMetadata(last.responseHeaders, opts.env ?? process.env) } : {}),
        ...(captureBodies && last.transportMetadata !== undefined ? { transport_metadata: captureTraceMetadata(last.transportMetadata, opts.env ?? process.env) } : {}),
    };
    if (opts.attempts && opts.attempts.length > 0) {
        try {
            record.attempts = captureTraceAttempts(opts.attempts, captureBodies, opts.env ?? process.env);
        }
        catch { /* attempt capture must never break trace emission */ }
    }
    // Native body capture (v1-compatible default full; see bodyCapture.ts). Redacted + size-capped. Only place
    // content can enter a provider trace. Non-streaming rows carry full parsed response JSON;
    // streaming rows carry best-effort reconstructed native event / NDJSON chunks from the transparent stream tee.
    if (captureBodies) {
        try {
            const reqCap = captureBody(opts.body, opts.env ?? process.env);
            const respCap = last.responseBody !== undefined ? captureBody(last.responseBody, opts.env ?? process.env) : undefined;
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
    catch { /* trace must never break serving */ }
}
function streamResponse(upstream, headers) {
    const ct = upstream.headers?.['content-type'];
    return { status: upstream.status, stream: upstream.stream, headers: ct ? { ...headers, 'Content-Type': ct } : headers };
}
async function passthrough(opts) {
    const clock = opts.clock ?? (() => Date.now());
    const t0 = clock();
    let upstream;
    let traceOpts = opts;
    const attempts = [];
    let ttfb = null;
    let bodyCaptureAllowed = false;
    try {
        upstream = await opts.proxy(opts.upstreamPath, opts.body, {
            inboundHeaders: opts.headers,
            upstreamMode: opts.provider,
            ...(opts.method ? { method: opts.method } : {}),
            ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        });
        bodyCaptureAllowed = true;
        ttfb = clock() - t0;
    }
    catch (err) {
        const wrapped = asUpstreamError(opts.provider, err);
        emitTrace(opts, t0, ttfb, { status: wrapped.statusCode, stream: false, error: wrapped.message }, bodyCaptureAllowed);
        throw wrapped;
    }
    if (shouldRetryRoutedOpenAI(upstream, opts) && opts.retryBody) {
        const retryBody = opts.retryBody;
        const retryFallback = `upstream_${upstream.status}_retry`;
        const retryFailedFallback = `upstream_${upstream.status}_retry_failed`;
        opts.logger.warn?.(jsonStringify({
            event: 'router_fallback',
            route: opts.route ?? opts.upstreamPath,
            reason: retryFallback,
            original_model: opts.model,
            would_have_been: opts.chosenModel,
            upstream_status: upstream.status,
        }));
        let drainedFirst = '';
        if (upstream.text) {
            try {
                drainedFirst = await Promise.resolve(upstream.text());
            }
            catch {
                drainedFirst = '';
            }
        }
        if (opts.onTrace) {
            attempts.push({
                attempt_index: 0,
                model: opts.chosenModel ?? opts.model,
                provider: opts.provider,
                upstream_mode: opts.provider,
                status: upstream.status,
                error: safeTraceError(`upstream ${upstream.status}`),
                requestBody: opts.body,
                responseBody: attemptResponseToBody(drainedFirst),
            });
        }
        try {
            const retryHeaders = retryHeadersForMutatedOpenAIRequest(opts.headers);
            upstream = await opts.proxy(opts.upstreamPath, retryBody, {
                inboundHeaders: retryHeaders,
                upstreamMode: opts.provider,
                ...(opts.method ? { method: opts.method } : {}),
                ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
            });
            traceOpts = {
                ...opts,
                body: retryBody,
                chosenModel: opts.model,
                fallback: retryFallback,
                headers: retryHeaders,
                attempts,
            };
            if (opts.onTrace) {
                attempts.push({
                    attempt_index: 1,
                    model: opts.model,
                    provider: opts.provider,
                    upstream_mode: opts.provider,
                    status: upstream.status,
                    requestBody: retryBody,
                });
            }
        }
        catch (err) {
            const wrapped = asUpstreamError(opts.provider, err);
            const retryError = err instanceof Error ? err.message : String(err);
            if (opts.onTrace) {
                attempts.push({
                    attempt_index: 1,
                    model: opts.model,
                    provider: opts.provider,
                    upstream_mode: opts.provider,
                    status: wrapped.statusCode,
                    error: retryError,
                    requestBody: retryBody,
                });
            }
            opts.logger.warn?.(jsonStringify({
                event: 'router_fallback',
                route: opts.route ?? opts.upstreamPath,
                reason: retryFailedFallback,
                original_model: opts.model,
                would_have_been: opts.chosenModel,
                error: retryError,
            }));
            upstream = {
                status: upstream.status,
                headers: upstream.headers,
                stream: null,
                text: () => drainedFirst,
            };
            traceOpts = { ...opts, fallback: retryFallback, attempts };
        }
    }
    const forwardHeaders = opts.responseHeaders ? opts.responseHeaders(upstream.headers ?? {}) : {};
    if (upstream.stream) {
        const scanner = traceOpts.onTrace ? new ProviderStreamMetaScanner(traceOpts, traceOpts.env ?? process.env) : null;
        const stream = scanner
            ? teeStreamForScan(upstream.stream, (chunk) => scanner.push(chunk), (info) => {
                scanner.finish();
                const streamError = scanner.result.error ?? info?.error ?? (info?.cancelled ? 'stream cancelled' : undefined);
                const responseBody = scanner.responseBody();
                const finalAttempt = attempts.find((attempt) => attempt.attempt_index === 1 && attempt.responseBody === undefined);
                if (finalAttempt && responseBody !== undefined) {
                    finalAttempt.responseBody = responseBody;
                    finalAttempt.body_truncated = responseBodyIndicatesTruncation(responseBody);
                }
                emitTrace(traceOpts, t0, ttfb, {
                    status: upstream.status,
                    stream: true,
                    ...scanner.result,
                    ...(streamError ? { error: streamError } : {}),
                    ...(responseBody !== undefined ? { responseBody } : {}),
                    ...(upstream.headers ? { responseHeaders: upstream.headers } : {}),
                    ...(upstream.transportMetadata !== undefined ? { transportMetadata: upstream.transportMetadata } : {}),
                }, bodyCaptureAllowed);
            })
            : upstream.stream;
        return streamResponse({ ...upstream, stream }, forwardHeaders);
    }
    let raw = '';
    if (upstream.text) {
        try {
            raw = await Promise.resolve(upstream.text());
        }
        catch (err) {
            const wrapped = asUpstreamError(opts.provider, err);
            emitTrace(traceOpts, t0, ttfb, { status: wrapped.statusCode, stream: false, error: wrapped.message }, bodyCaptureAllowed);
            throw wrapped;
        }
    }
    const body = responseToBody(raw, upstream.status, upstream.headers, opts.logger, `${opts.provider}_fallback`);
    const finalAttempt = attempts.find((attempt) => attempt.attempt_index === 1 && attempt.responseBody === undefined);
    if (finalAttempt)
        finalAttempt.responseBody = body;
    emitTrace(traceOpts, t0, ttfb, {
        status: upstream.status,
        stream: false,
        ...providerMeta(traceOpts, body),
        responseBody: body,
        ...(upstream.headers ? { responseHeaders: upstream.headers } : {}),
        ...(upstream.transportMetadata !== undefined ? { transportMetadata: upstream.transportMetadata } : {}),
    }, bodyCaptureAllowed);
    return { status: upstream.status, body, headers: forwardHeaders };
}
export function parseModelAction(modelAction) {
    const idx = modelAction.lastIndexOf(':');
    if (idx === -1)
        return { model: modelAction, action: '' };
    return { model: modelAction.slice(0, idx), action: modelAction.slice(idx + 1) };
}
function decodePathParam(raw, name) {
    try {
        return decodeURIComponent(raw);
    }
    catch {
        throw badRequest(`${name} contains invalid percent encoding`);
    }
}
function validateDecodedPathComponent(value, name) {
    if (!value)
        throw badRequest(`${name} is required`);
    if (value.includes('/') || value.includes('\\'))
        throw badRequest(`${name} must not contain path separators`);
    if (value === '.' || value === '..')
        throw badRequest(`${name} must not be a dot segment`);
    return value;
}
function validatedModelAction(raw) {
    const decoded = validateDecodedPathComponent(decodePathParam(raw, 'modelAction'), 'modelAction');
    const { model, action } = parseModelAction(decoded);
    validateDecodedPathComponent(model, 'model');
    if (!GEMINI_VERTEX_ACTIONS.has(action))
        throw badRequest(`unsupported model action: ${action || '(missing)'}`);
    return { model, action };
}
function validatedVertexProject(raw) {
    const decoded = validateDecodedPathComponent(decodePathParam(raw, 'project'), 'project');
    if (!/^[A-Za-z0-9_-]+$/.test(decoded))
        throw badRequest('project contains unsupported characters');
    return decoded;
}
function validatedVertexLocation(raw) {
    const decoded = validateDecodedPathComponent(decodePathParam(raw, 'location'), 'location');
    if (decoded !== 'global' && !/^[a-z][a-z0-9-]*$/.test(decoded))
        throw badRequest('location contains unsupported characters');
    return decoded;
}
function providerQueryString(query) {
    if (!query || Object.keys(query).length === 0)
        return '';
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
        if (CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase()))
            continue;
        params.append(name, value);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}
export function detectModelsProvider(headers = {}) {
    if (headers['anthropic-version'] || headers['anthropic-beta'])
        return 'anthropic';
    return 'openai';
}
export function vertexBaseUrl(location, env = process.env) {
    const override = (env['EVOMAP_VERTEX_BASE_URL'] || '').trim();
    if (override)
        return override.replace(/\/+$/, '');
    const raw = location.trim();
    if (!raw || raw === 'global')
        return 'https://aiplatform.googleapis.com';
    const loc = validatedVertexLocation(raw);
    return `https://${loc}-aiplatform.googleapis.com`;
}
export function buildOpenAIResponsesHandler(opts) {
    const log = opts.logger ?? console;
    const env = opts.env ?? process.env;
    return (req) => {
        const routed = routeOpenAIRequest('/v1/responses', req.body, env, log);
        return passthrough({
            proxy: opts.openAIProxy,
            provider: 'openai',
            route: '/v1/responses',
            upstreamPath: '/responses',
            model: routed.originalModel,
            chosenModel: routed.chosenModel,
            tier: routed.tier,
            reason: routed.reason,
            fallback: routed.fallback,
            routerEnabled: routed.routerEnabled,
            ...(routed.features ? { features: routed.features } : {}),
            body: routed.body,
            retryBody: req.body,
            headers: req.headers ?? {},
            logger: log,
            ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
            ...(opts.clock ? { clock: opts.clock } : {}),
            env,
            responseHeaders: copyOpenAIResponseHeaders,
        });
    };
}
export function buildOpenAIChatCompletionsHandler(opts) {
    const log = opts.logger ?? console;
    const env = opts.env ?? process.env;
    return (req) => {
        const routed = routeOpenAIRequest('/v1/chat/completions', req.body, env, log);
        return passthrough({
            proxy: opts.openAIProxy,
            provider: 'openai',
            route: '/v1/chat/completions',
            upstreamPath: '/chat/completions',
            model: routed.originalModel,
            chosenModel: routed.chosenModel,
            tier: routed.tier,
            reason: routed.reason,
            fallback: routed.fallback,
            routerEnabled: routed.routerEnabled,
            ...(routed.features ? { features: routed.features } : {}),
            body: routed.body,
            retryBody: req.body,
            headers: req.headers ?? {},
            logger: log,
            ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
            ...(opts.clock ? { clock: opts.clock } : {}),
            env,
            responseHeaders: copyOpenAIResponseHeaders,
        });
    };
}
export function buildGeminiHandler(opts) {
    const log = opts.logger ?? console;
    const env = opts.env ?? process.env;
    return async (req) => {
        const { model, action } = validatedModelAction(req.params?.['modelAction'] ?? '');
        const qs = providerQueryString(req.query);
        return passthrough({
            proxy: opts.geminiProxy,
            provider: 'gemini',
            route: `/v1beta/models/${model}:${action}`,
            upstreamPath: `/v1beta/models/${encodeURIComponent(model)}:${action}${qs}`,
            model,
            body: req.body,
            headers: req.headers ?? {},
            logger: log,
            ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
            ...(opts.clock ? { clock: opts.clock } : {}),
            env,
            responseHeaders: copyGeminiResponseHeaders,
        });
    };
}
export function buildOllamaHandler(opts) {
    const log = opts.logger ?? console;
    const env = opts.env ?? process.env;
    return (req) => passthrough({
        proxy: opts.ollamaProxy,
        provider: 'ollama',
        route: opts.apiPath,
        upstreamPath: opts.apiPath,
        model: typeof req.body.model === 'string' ? req.body.model : null,
        body: req.body,
        headers: req.headers ?? {},
        logger: log,
        ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
        ...(opts.clock ? { clock: opts.clock } : {}),
        env,
    });
}
export function buildVertexHandler(opts) {
    const log = opts.logger ?? console;
    const env = opts.env ?? process.env;
    return async (req) => {
        const project = validatedVertexProject(req.params?.['project'] ?? '');
        const location = validatedVertexLocation(req.params?.['location'] ?? '');
        const { model, action } = validatedModelAction(req.params?.['modelAction'] ?? '');
        const qs = providerQueryString(req.query);
        return passthrough({
            proxy: opts.vertexProxy,
            provider: 'vertex',
            route: `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${action}`,
            upstreamPath: `/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${action}${qs}`,
            model,
            body: req.body,
            headers: req.headers ?? {},
            logger: log,
            baseUrl: vertexBaseUrl(location, env),
            ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
            ...(opts.clock ? { clock: opts.clock } : {}),
            env,
        });
    };
}
export function buildModelsHandler(opts) {
    const log = opts.logger ?? console;
    return async (req) => {
        const headers = req.headers ?? {};
        const provider = detectModelsProvider(headers);
        const proxy = provider === 'anthropic' ? opts.anthropicProxy : opts.openAIProxy;
        const upstreamPath = provider === 'anthropic' ? '/v1/models' : '/models';
        const upstream = await proxy(upstreamPath, null, { method: 'GET', inboundHeaders: headers, upstreamMode: provider });
        let raw = '';
        if (upstream.text) {
            try {
                raw = await Promise.resolve(upstream.text());
            }
            catch {
                raw = '';
            }
        }
        const body = responseToBody(raw, upstream.status, upstream.headers, log, 'models_fallback');
        return { status: upstream.status, body };
    };
}
export function buildProviderRoutes(opts) {
    return {
        'POST /v1/responses': buildOpenAIResponsesHandler(opts),
        'POST /v1/chat/completions': buildOpenAIChatCompletionsHandler(opts),
        'GET /v1/models': buildModelsHandler(opts),
        'POST /v1beta/models/:modelAction': buildGeminiHandler(opts),
        'POST /api/chat': buildOllamaHandler({ ...opts, apiPath: '/api/chat' }),
        'POST /api/generate': buildOllamaHandler({ ...opts, apiPath: '/api/generate' }),
        'POST /v1/projects/:project/locations/:location/publishers/google/models/:modelAction': buildVertexHandler(opts),
    };
}