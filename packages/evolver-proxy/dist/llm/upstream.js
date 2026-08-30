// Real upstream for the LLM proxy handlers. Anthropic /v1/messages keeps the v1 token-mediation behavior;
// OpenAI-compatible routes use daemon-owned OpenAI credentials so the local proxy bearer token never goes
// upstream as provider auth.
//
// Header policy (token mediation, same as v1): forward ONLY x-api-key, anthropic-version and anthropic-*
// from the inbound request. Everything else — host, cookie, content-length and crucially `authorization`
// (consumed by the local server as proxy self-auth) — is dropped so the proxy token never leaks upstream.
// When the client sent no x-api-key, the proxy substitutes its own env credential per request (hot-swappable
// without restart): EVOMAP_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY → x-api-key, else an upstream auth token.
import { ReadableStream } from 'node:stream/web';
import { canonicalizeForBedrock, resolveBedrockAliases, supportsAdaptiveThinking } from '../router/messagesRoute.js';
export const DEFAULT_UPSTREAM_URL = 'https://api.anthropic.com';
export const DEFAULT_OPENAI_UPSTREAM_URL = 'https://api.openai.com/v1';
export const DEFAULT_GEMINI_UPSTREAM_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_OLLAMA_UPSTREAM_URL = 'http://127.0.0.1:11434';
/** Time allowed for upstream RESPONSE HEADERS to arrive. Never applied to the body: a healthy SSE stream
 * routinely outlives any fixed deadline, so an AbortSignal.timeout-style cap on the whole fetch would kill
 * long generations mid-stream (a real v1 hazard). Body lifetime is bounded by the client connection instead. */
export const DEFAULT_HEADERS_TIMEOUT_MS = 120_000;
let defaultBedrockRuntime = null;
async function loadDefaultBedrockRuntime() {
    if (!defaultBedrockRuntime) {
        const mod = await import('@aws-sdk/client-bedrock-runtime');
        defaultBedrockRuntime = {
            createClient: (args) => new mod.BedrockRuntimeClient(args),
            createInvokeModelCommand: (input) => new mod.InvokeModelCommand(input),
            createInvokeModelWithResponseStreamCommand: (input) => new mod.InvokeModelWithResponseStreamCommand(input),
        };
    }
    return defaultBedrockRuntime;
}
function isOpenAiMode(upstreamMode) {
    return upstreamMode === 'openai';
}
/**
 * Detect deprecated OPENAI_COMPATIBLE_BASE_URLS env var (#671).
 * V1 multi-base lists are ignored for routing; V2 OpenAI base must pass *.api.openai.com/v1 allowlist
 * via EVOLVER_LLM_OPENAI_BASE_URL / EVOMAP_OPENAI_BASE_URL / OPENAI_BASE_URL.
 * Warn once per process to avoid per-request spam.
 */
let warnedDeprecatedOpenAICompatible = false;
function hasDeprecatedOpenAICompatibleConfig(env) {
    return [
        env['EVOLVER_OPENAI_COMPATIBLE_BASE_URLS'],
        env['EVOMAP_OPENAI_COMPATIBLE_BASE_URLS'],
    ].some((value) => typeof value === 'string' && value.trim() !== '');
}
function explicitOpenAIBaseUrl(env) {
    return env['EVOLVER_LLM_OPENAI_BASE_URL'] || env['EVOMAP_OPENAI_BASE_URL'] || env['OPENAI_BASE_URL'];
}
function hasCanonicalOpenAIMigrationPair(env) {
    const baseUrl = env['EVOLVER_LLM_OPENAI_BASE_URL']?.trim();
    if (!baseUrl || !env['EVOLVER_LLM_OPENAI_API_KEY']?.trim())
        return false;
    try {
        normalizeOpenAIBaseUrl(baseUrl);
        return true;
    }
    catch {
        return false;
    }
}
function warnDeprecatedOpenAICompatible(env) {
    if (!hasDeprecatedOpenAICompatibleConfig(env) || warnedDeprecatedOpenAICompatible)
        return;
    warnedDeprecatedOpenAICompatible = true;
    console.warn('[proxy] DEPRECATED: EVOMAP_OPENAI_COMPATIBLE_BASE_URLS / EVOLVER_OPENAI_COMPATIBLE_BASE_URLS is ignored for routing. ' +
        'Manual migration is required: explicitly bind one official https://*.api.openai.com/v1 endpoint and its credential ' +
        'with EVOLVER_LLM_OPENAI_BASE_URL and EVOLVER_LLM_OPENAI_API_KEY. ' +
        'LiteLLM, OpenRouter, Azure OpenAI, MiniMax, DeepSeek, Moonshot, and other custom OpenAI-compatible hosts have no drop-in V2 route. ' +
        'Do not reuse their credentials as an OpenAI credential; keep that workload outside this proxy until a supported provider-specific route exists.');
}
function assertDeprecatedOpenAICompatibleMigrated(env) {
    warnDeprecatedOpenAICompatible(env);
    if (hasDeprecatedOpenAICompatibleConfig(env) && !hasCanonicalOpenAIMigrationPair(env)) {
        throw new Error('[proxy] manual migration of deprecated OpenAI-compatible base URLs requires an explicit '
            + 'EVOLVER_LLM_OPENAI_BASE_URL and '
            + 'EVOLVER_LLM_OPENAI_API_KEY migration pair before the OpenAI route can start');
    }
}
/** Test helper: reset once-warn latch (unit tests only). */
function resetDeprecatedOpenAICompatibleWarning() {
    warnedDeprecatedOpenAICompatible = false;
}
function isAllowedOpenAIHostname(hostname) {
    const h = hostname.toLowerCase();
    return h === 'api.openai.com' || h.endsWith('.api.openai.com');
}
function normalizeOpenAIBaseUrl(raw) {
    const value = raw.replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error('[proxy] OpenAI base URL is not a valid URL');
    }
    if (parsed.protocol !== 'https:'
        || !isAllowedOpenAIHostname(parsed.hostname)
        || parsed.pathname !== '/v1'
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash) {
        throw new Error('[proxy] OpenAI base URL must be an OpenAI https://*.api.openai.com/v1 endpoint');
    }
    return value;
}
function openAIBaseUrlIdentity(raw) {
    return new URL(normalizeOpenAIBaseUrl(raw)).href;
}
function assertDeprecatedOpenAIRequestBaseBound(env, requestBaseUrl) {
    if (!requestBaseUrl || !hasDeprecatedOpenAICompatibleConfig(env))
        return;
    const canonicalBaseUrl = env['EVOLVER_LLM_OPENAI_BASE_URL'];
    if (typeof canonicalBaseUrl !== 'string'
        || openAIBaseUrlIdentity(requestBaseUrl) !== openAIBaseUrlIdentity(canonicalBaseUrl)) {
        throw new Error('[proxy] request-scoped OpenAI base URL must match EVOLVER_LLM_OPENAI_BASE_URL '
            + 'while deprecated OpenAI-compatible routing remains configured');
    }
}
export function resolveOpenAIUpstreamUrl(env = process.env) {
    assertDeprecatedOpenAICompatibleMigrated(env);
    const explicitBaseUrl = explicitOpenAIBaseUrl(env);
    return normalizeOpenAIBaseUrl(explicitBaseUrl || DEFAULT_OPENAI_UPSTREAM_URL);
}
function pathForOpenAIBase(path) {
    if (path === '/v1')
        return '';
    if (path.startsWith('/v1/'))
        return path.slice('/v1'.length);
    return path.startsWith('/') ? path : `/${path}`;
}
/**
 * Validate an operator-configured upstream URL (#197): must parse as an http(s) URL with no embedded credentials.
 * Scheme-only on purpose — NO host allowlist — so legit localhost (ollama) and internal gateways keep working,
 * while file:/gopher:/data: schemes and userinfo-based SSRF tricks (user:pass@host) are refused. Returns trimmed.
 */
function assertHttpUrl(raw, label) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error(`[proxy] ${label} is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error(`[proxy] ${label} must use http(s)`);
    if (parsed.username || parsed.password)
        throw new Error(`[proxy] ${label} must not embed credentials`);
    return raw.replace(/\/+$/, '');
}
/** Resolve the upstream base URL. OpenAI-compatible routes never inherit the Anthropic-wide override. */
export function resolveUpstreamUrl(env = process.env, upstreamMode = 'anthropic') {
    if (isOpenAiMode(upstreamMode))
        return resolveOpenAIUpstreamUrl(env);
    const raw = env['EVOLVER_LLM_UPSTREAM_URL'] || env['ANTHROPIC_BASE_URL'] || DEFAULT_UPSTREAM_URL;
    return assertHttpUrl(raw, 'Anthropic upstream URL');
}
export function resolveGeminiUpstreamUrl(env = process.env) {
    const raw = env['EVOMAP_GEMINI_BASE_URL'] || DEFAULT_GEMINI_UPSTREAM_URL;
    return assertHttpUrl(raw, 'Gemini base URL');
}
export function resolveOllamaUpstreamUrl(env = process.env) {
    const raw = env['EVOMAP_OLLAMA_BASE_URL'] || DEFAULT_OLLAMA_UPSTREAM_URL;
    return assertHttpUrl(raw, 'Ollama base URL');
}
export function buildForwardHeaders(inbound, env, upstreamMode = 'anthropic') {
    const fwd = { 'content-type': 'application/json' };
    if (isOpenAiMode(upstreamMode)) {
        for (const [k, v] of Object.entries(inbound)) {
            if (v === undefined || v === null)
                continue;
            const lk = k.toLowerCase();
            if (lk === 'openai-organization' || lk === 'openai-project' || lk === 'openai-beta' || lk.startsWith('x-stainless-') || lk === 'idempotency-key') {
                fwd[lk] = String(v);
            }
        }
        const apiKey = env['EVOLVER_LLM_OPENAI_API_KEY'] || env['EVOMAP_OPENAI_API_KEY'] || env['OPENAI_API_KEY'];
        if (apiKey)
            fwd['authorization'] = `Bearer ${apiKey}`;
    }
    else {
        for (const [k, v] of Object.entries(inbound)) {
            if (v === undefined || v === null)
                continue;
            const lk = k.toLowerCase();
            if (lk === 'x-api-key' || lk === 'anthropic-version' || lk.startsWith('anthropic-'))
                fwd[lk] = String(v);
        }
        if (!fwd['x-api-key']) {
            if (env['EVOMAP_ANTHROPIC_API_KEY'])
                fwd['x-api-key'] = env['EVOMAP_ANTHROPIC_API_KEY'];
            else if (env['ANTHROPIC_API_KEY'])
                fwd['x-api-key'] = env['ANTHROPIC_API_KEY'];
            else if (env['EVOMAP_ANTHROPIC_AUTH_TOKEN'])
                fwd['authorization'] = `Bearer ${env['EVOMAP_ANTHROPIC_AUTH_TOKEN']}`;
            else if (env['EVOMAP_PROXY_AUTO_INJECTED'] !== '1' && env['ANTHROPIC_AUTH_TOKEN']) {
                fwd['authorization'] = `Bearer ${env['ANTHROPIC_AUTH_TOKEN']}`;
            }
        }
    }
    return fwd;
}
function safeHeaderValue(value) {
    if (value === undefined || value === null)
        return null;
    const s = String(value);
    if (/[\r\n]/.test(s))
        return null;
    return s;
}
export function buildOpenAIHeaders(inbound, env) {
    const fwd = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(inbound)) {
        const lk = k.toLowerCase();
        if (lk !== 'openai-organization' && lk !== 'openai-project' && lk !== 'openai-beta' && !lk.startsWith('x-stainless-'))
            continue;
        const hv = safeHeaderValue(v);
        if (hv !== null)
            fwd[lk] = hv;
    }
    const upstreamKey = env['EVOLVER_LLM_OPENAI_API_KEY'] || env['EVOMAP_OPENAI_API_KEY'] || env['OPENAI_API_KEY'];
    if (!upstreamKey)
        throw Object.assign(new Error('openai api key required'), { statusCode: 401 });
    fwd.authorization = `Bearer ${upstreamKey}`;
    return fwd;
}
export function buildGeminiHeaders(inbound, env) {
    const fwd = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(inbound)) {
        const lk = k.toLowerCase();
        if (lk !== 'x-goog-user-project' && lk !== 'x-goog-api-client' && !lk.startsWith('x-goog-request-'))
            continue;
        const hv = safeHeaderValue(v);
        if (hv !== null)
            fwd[lk] = hv;
    }
    const upstreamKey = env['EVOMAP_GEMINI_API_KEY'] || env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY'];
    if (!upstreamKey)
        throw Object.assign(new Error('gemini api key required'), { statusCode: 401 });
    fwd['x-goog-api-key'] = upstreamKey;
    return fwd;
}
export function buildOllamaHeaders(env) {
    const fwd = { 'content-type': 'application/json' };
    const upstreamKey = env['EVOMAP_OLLAMA_API_KEY'];
    if (upstreamKey)
        fwd.authorization = `Bearer ${upstreamKey}`;
    return fwd;
}
export function buildVertexHeaders(env) {
    const token = env['EVOMAP_VERTEX_ACCESS_TOKEN'];
    if (!token)
        throw Object.assign(new Error('vertex access token required'), { statusCode: 401 });
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}
function providerGatewayError(provider, err, fallbackStatus = 502) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    return Object.assign(new Error(isTimeout ? `${provider} upstream timed out` : `${provider} upstream request failed`), {
        statusCode: isTimeout ? 504 : fallbackStatus,
        cause: err,
    });
}
async function fetchUpstream(endpoint, body, opts, headers, fetchImpl, headersTimeoutMs, provider, streamDetector) {
    const method = (opts.method || 'POST').toUpperCase();
    const controller = new AbortController();
    const timeoutErr = new Error(`${provider} upstream timed out`);
    timeoutErr.name = 'TimeoutError';
    const timer = setTimeout(() => controller.abort(timeoutErr), headersTimeoutMs);
    let res;
    try {
        const init = { method, headers, signal: controller.signal };
        if (method !== 'GET' && method !== 'HEAD')
            init.body = JSON.stringify(body ?? {});
        res = await fetchImpl(endpoint, init);
    }
    catch (err) {
        clearTimeout(timer);
        throw providerGatewayError(provider, err);
    }
    finally {
        clearTimeout(timer);
    }
    const resHeaders = {};
    for (const [k, v] of res.headers.entries())
        resHeaders[k.toLowerCase()] = v;
    const isStream = streamDetector(resHeaders, endpoint, body);
    return {
        status: res.status,
        headers: resHeaders,
        stream: isStream ? res.body : null,
        text: isStream ? undefined : () => res.text().catch((err) => { throw providerGatewayError(provider, err); }),
    };
}
const contentTypeIncludes = (headers, token) => (headers['content-type'] || '').toLowerCase().includes(token);
function jsonResult(status, body) {
    const text = JSON.stringify(body);
    return {
        status,
        headers: { 'content-type': 'application/json' },
        stream: null,
        text: () => text,
    };
}
function bodyRecord(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return {};
    return body;
}
function textFromBytes(value) {
    if (typeof value === 'string')
        return value;
    if (value instanceof Uint8Array)
        return Buffer.from(value).toString('utf8');
    if (value instanceof ArrayBuffer)
        return Buffer.from(value).toString('utf8');
    return '';
}
function bedrockErrorResult(err) {
    const e = err && typeof err === 'object' ? err : {};
    const metadata = e['$metadata'] && typeof e['$metadata'] === 'object' ? e['$metadata'] : {};
    const name = typeof e['name'] === 'string' ? e['name'] : 'upstream_error';
    const message = typeof e['message'] === 'string' ? e['message'] : String(err);
    const httpStatus = typeof metadata['httpStatusCode'] === 'number' ? metadata['httpStatusCode'] : undefined;
    const status = name === 'TimeoutError' || name === 'AbortError' ? 504 : httpStatus ?? 500;
    return jsonResult(status, { type: 'error', error: { type: name, message } });
}
function normalizeBedrockBody(body, env) {
    const source = bodyRecord(body);
    const rawModel = typeof source['model'] === 'string' ? source['model'] : null;
    const canonicalModel = rawModel ? canonicalizeForBedrock(rawModel, resolveBedrockAliases(env)) : null;
    const modelId = typeof canonicalModel === 'string' && canonicalModel.length > 0 ? canonicalModel : null;
    if (!modelId) {
        return jsonResult(400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'body.model required for Bedrock upstream' },
        });
    }
    const upstreamBody = { ...source };
    delete upstreamBody['model'];
    if (!upstreamBody['anthropic_version'])
        upstreamBody['anthropic_version'] = 'bedrock-2023-05-31';
    const wantsStream = upstreamBody['stream'] === true;
    delete upstreamBody['stream'];
    const modelSupportsAdaptiveThinking = supportsAdaptiveThinking(modelId);
    const thinking = upstreamBody['thinking'];
    if (!modelSupportsAdaptiveThinking && thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
        const thinkingRecord = thinking;
        if (thinkingRecord['type'] === 'adaptive') {
            const maxTokens = typeof upstreamBody['max_tokens'] === 'number' ? upstreamBody['max_tokens'] : 8192;
            const budget = thinkingRecord['budget_tokens'];
            // Legacy `enabled` thinking requires 1024 <= budget_tokens < max_tokens (Bedrock rejects anything else).
            // If max_tokens leaves no room for a >=1024 budget, thinking cannot be enabled at all → disable, even when an
            // inbound budget_tokens is present. Otherwise CLAMP the requested (or a derived) budget into [1024, maxTokens-1]
            // so a sub-1024 or too-large inbound budget can't reach Bedrock verbatim and fail strict validation (Bugbot).
            if (maxTokens <= 1024) {
                upstreamBody['thinking'] = { type: 'disabled' };
            }
            else {
                const desired = typeof budget === 'number' ? budget : Math.floor(maxTokens / 2);
                const clamped = Math.min(Math.max(1024, desired), maxTokens - 1);
                upstreamBody['thinking'] = { ...thinkingRecord, type: 'enabled', budget_tokens: clamped };
            }
        }
    }
    delete upstreamBody['context_management'];
    if (!modelSupportsAdaptiveThinking)
        delete upstreamBody['output_config'];
    return { modelId, upstreamBody, wantsStream };
}
function bedrockException(event) {
    return event.internalServerException
        ?? event.modelStreamErrorException
        ?? event.throttlingException
        ?? event.validationException
        ?? event.modelTimeoutException
        ?? event.serviceUnavailableException
        ?? null;
}
function bedrockChunkFrame(bytes) {
    const data = textFromBytes(bytes);
    if (!data)
        return '';
    try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const type = parsed['type'];
            if (typeof type === 'string' && /^[A-Za-z0-9_.:-]+$/.test(type))
                return `event: ${type}\ndata: ${data}\n\n`;
        }
    }
    catch {
        /* non-JSON chunks are still valid data-only SSE frames */
    }
    return `data: ${data}\n\n`;
}
function bedrockStreamToSse(body) {
    const events = body && typeof body[Symbol.asyncIterator] === 'function'
        ? body
        : null;
    return new ReadableStream({
        async start(controller) {
            if (!events) {
                controller.close();
                return;
            }
            try {
                for await (const event of events) {
                    const bytes = event.chunk?.bytes;
                    if (bytes) {
                        controller.enqueue(Buffer.from(bedrockChunkFrame(bytes)));
                        continue;
                    }
                    const ex = bedrockException(event);
                    if (ex) {
                        const errFrame = JSON.stringify({
                            type: 'error',
                            error: {
                                type: typeof ex.name === 'string' ? ex.name : 'upstream_error',
                                message: typeof ex.message === 'string' ? ex.message : String(ex),
                            },
                        });
                        controller.enqueue(Buffer.from(`event: error\ndata: ${errFrame}\n\n`));
                    }
                }
                controller.close();
            }
            catch (err) {
                controller.error(err);
            }
        },
        cancel() {
            try {
                void events?.return?.();
            }
            catch {
                /* async iterable already closed */
            }
        },
    });
}
async function invokeBedrock(body, env, runtime, client, headersTimeoutMs) {
    const normalized = normalizeBedrockBody(body, env);
    if ('status' in normalized)
        return normalized;
    const input = {
        modelId: normalized.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(normalized.upstreamBody),
    };
    const timeoutErr = new Error('bedrock upstream timed out');
    timeoutErr.name = 'TimeoutError';
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(timeoutErr), headersTimeoutMs);
    try {
        if (normalized.wantsStream) {
            const out = await client.send(runtime.createInvokeModelWithResponseStreamCommand(input), { abortSignal: abortController.signal });
            clearTimeout(abortTimer);
            const outRecord = out && typeof out === 'object' ? out : {};
            return {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                stream: bedrockStreamToSse(outRecord['body']),
                traceRequestBody: normalized.upstreamBody,
            };
        }
        const out = await client.send(runtime.createInvokeModelCommand(input), { abortSignal: abortController.signal });
        clearTimeout(abortTimer);
        const outRecord = out && typeof out === 'object' ? out : {};
        const text = textFromBytes(outRecord['body']);
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            stream: null,
            text: () => text,
            traceRequestBody: normalized.upstreamBody,
        };
    }
    catch (err) {
        clearTimeout(abortTimer);
        return { ...bedrockErrorResult(err), traceRequestBody: normalized.upstreamBody };
    }
}
/** Build the production AnthropicProxy. Streaming is detected from the upstream content-type
 * (text/event-stream → expose the response body stream; anything else → buffered text()). */
export function makeAnthropicUpstream(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    let bedrockClient = null;
    let bedrockClientKey = '';
    let bedrockClientRuntime = null;
    const getBedrockClient = (env, runtime) => {
        const args = {
            region: env['AWS_REGION'] || env['AWS_DEFAULT_REGION'] || 'us-east-1',
            ...(env['EVOMAP_BEDROCK_ENDPOINT'] ? { endpoint: assertHttpUrl(env['EVOMAP_BEDROCK_ENDPOINT'], 'Bedrock endpoint') } : {}),
        };
        const key = JSON.stringify(args);
        if (!bedrockClient || bedrockClientKey !== key || bedrockClientRuntime !== runtime) {
            bedrockClient = runtime.createClient(args);
            bedrockClientKey = key;
            bedrockClientRuntime = runtime;
        }
        return bedrockClient;
    };
    return async (path, body, callOpts) => {
        const { inboundHeaders, upstreamMode } = callOpts;
        if (upstreamMode === 'bedrock') {
            const runtime = opts.bedrockRuntime ?? await loadDefaultBedrockRuntime();
            const env = opts.env ?? process.env;
            return invokeBedrock(body, env, runtime, getBedrockClient(env, runtime), headersTimeoutMs);
        }
        const env = opts.env ?? process.env;
        return fetchUpstream(`${resolveUpstreamUrl(env, upstreamMode)}${isOpenAiMode(upstreamMode) ? pathForOpenAIBase(path) : path}`, body, callOpts, buildForwardHeaders(inboundHeaders, env, upstreamMode), fetchImpl, headersTimeoutMs, isOpenAiMode(upstreamMode) ? 'openai' : 'anthropic', (headers) => contentTypeIncludes(headers, 'text/event-stream'));
    };
}
export function makeOpenAIUpstream(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    return async (path, body, callOpts) => {
        const env = opts.env ?? process.env;
        // A request-scoped base override is routing data, not evidence that the daemon's
        // legacy provider credential/base pair was deliberately migrated.
        assertDeprecatedOpenAICompatibleMigrated(env);
        assertDeprecatedOpenAIRequestBaseBound(env, callOpts.baseUrl);
        const baseUrl = callOpts.baseUrl ? normalizeOpenAIBaseUrl(callOpts.baseUrl) : resolveOpenAIUpstreamUrl(env);
        return fetchUpstream(`${baseUrl}${path}`, body, callOpts, buildOpenAIHeaders(callOpts.inboundHeaders, env), fetchImpl, headersTimeoutMs, 'openai', (headers) => contentTypeIncludes(headers, 'text/event-stream'));
    };
}
export function makeGeminiUpstream(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    return async (path, body, callOpts) => {
        const env = opts.env ?? process.env;
        const baseUrl = (callOpts.baseUrl || resolveGeminiUpstreamUrl(env)).replace(/\/+$/, '');
        return fetchUpstream(`${baseUrl}${path}`, body, callOpts, buildGeminiHeaders(callOpts.inboundHeaders, env), fetchImpl, headersTimeoutMs, 'gemini', (headers, endpoint) => contentTypeIncludes(headers, 'text/event-stream') || /:streamGenerateContent(\b|\?|$)/.test(endpoint));
    };
}
export function makeOllamaUpstream(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    return async (path, body, callOpts) => {
        const env = opts.env ?? process.env;
        const baseUrl = (callOpts.baseUrl || resolveOllamaUpstreamUrl(env)).replace(/\/+$/, '');
        return fetchUpstream(`${baseUrl}${path}`, body, callOpts, buildOllamaHeaders(env), fetchImpl, headersTimeoutMs, 'ollama', (_headers, _endpoint, outboundBody) => !(outboundBody && typeof outboundBody === 'object' && outboundBody['stream'] === false));
    };
}
export function makeVertexUpstream(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    return async (path, body, callOpts) => {
        const baseUrl = (callOpts.baseUrl || '').replace(/\/+$/, '');
        if (!baseUrl)
            throw Object.assign(new Error('vertex base url required'), { statusCode: 500 });
        const env = opts.env ?? process.env;
        return fetchUpstream(`${baseUrl}${path}`, body, callOpts, buildVertexHeaders(env), fetchImpl, headersTimeoutMs, 'vertex', (headers, endpoint) => contentTypeIncludes(headers, 'text/event-stream') || /:streamGenerateContent(\b|\?|$)/.test(endpoint));
    };
}
export { warnDeprecatedOpenAICompatible, resetDeprecatedOpenAICompatibleWarning };