import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
export const HUB_ERROR_TEXT_MAX_BYTES = 8 * 1024;
export const HUB_JSON_TEXT_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_UNREACHABLE_BACKOFF_BASE_MS = 60_000;
export const HUB_UNREACHABLE_BACKOFF_MAX_MS = 10 * 60_000;
export const HUB_GENERAL_TIMEOUT_MS = 15_000;
export const HUB_SEARCH_TIMEOUT_MS = 8_000;
export const HUB_HEARTBEAT_TIMEOUT_MS = 10_000;
export const HUB_EVENT_POLL_TIMEOUT_MS = 60_000;
export const HUB_HELLO_TIMEOUT_MS = 15_000;
const HUB_OPERATION_TIMEOUT_KEYS = {
    general: 'generalMs',
    search: 'searchMs',
    heartbeat: 'heartbeatMs',
    poll: 'pollMs',
    hello: 'helloMs',
};
const DEFAULT_AUTH_TIMEOUT_MS = 20_000;
const DEFAULT_DEADLINE_SCHEDULER = {
    set(callback, delayMs) {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
    },
    clear(handle) {
        clearTimeout(handle);
    },
};
export class AuthError extends Error {
    status;
    body;
    errorCode;
    constructor(status, body) {
        const errorCode = hubErrorCode(body);
        super(`hub auth error ${status}${errorCode ? `: ${errorCode}` : ''}`);
        this.status = status;
        this.body = body;
        this.name = 'AuthError';
        this.errorCode = errorCode;
    }
}
export class HubClientError extends Error {
    status;
    body;
    retryAfterMs;
    constructor(status, body, retryAfterMs) {
        super(`hub ${status}`);
        this.status = status;
        this.body = body;
        this.retryAfterMs = retryAfterMs;
        this.name = 'HubClientError';
    }
}
export class HubUnreachableError extends Error {
    details;
    code = 'HUB_UNREACHABLE';
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = 'HubUnreachableError';
    }
    get retryAfterMs() {
        return this.details.retryAfterMs ?? HUB_UNREACHABLE_BACKOFF_BASE_MS;
    }
}
const PROTECTED_REQUEST_HEADERS = new Set([
    'authorization',
    'content-type',
    'x-evomap-node-secret-version',
    'x-evomap-signature',
    'x-node-secret',
]);
function mergeRequestHeaders(requestHeaders, signedHeaders) {
    const signedNames = new Set(Object.keys(signedHeaders ?? {}).map((name) => name.toLowerCase()));
    const headers = {};
    for (const [name, value] of Object.entries(requestHeaders ?? {})) {
        const normalized = name.toLowerCase();
        if (PROTECTED_REQUEST_HEADERS.has(normalized) || signedNames.has(normalized))
            continue;
        if (normalized === 'idempotency-key') {
            const trimmed = value.trim();
            if (!trimmed)
                throw new Error('idempotency-key must be non-empty');
            headers[normalized] = trimmed;
        }
        else {
            headers[normalized] = value;
        }
    }
    headers['content-type'] = 'application/json';
    return { ...headers, ...signedHeaders };
}
/**
 * 公版 hub HTTP 客户端(M6-6). 每请求经 AuthProvider 取凭证: POST 通常注入 body; GET 与 strict hello envelope
 * 走 **Authorization: Bearer <node_secret>** 头(hub 只从 header/body 读 node_secret, 绝不从 query — #8);
 * sender_id 是标识非凭证, 留 query/body.
 * 401/403→AuthError(reauth), 4xx→HubClientError(终态), 5xx→重试.
 * 非 JSON Hub 响应(WAF/HTML/captive portal/gateway text)→HubUnreachableError, 不触发 auth recovery.
 */
export class HubFetch {
    deps;
    operationTimeouts;
    deadlineScheduler;
    constructor(deps) {
        this.deps = deps;
        this.operationTimeouts = resolveHubOperationTimeouts(deps.env ?? process.env, deps.operationTimeouts);
        this.deadlineScheduler = deps.deadlineScheduler ?? DEFAULT_DEADLINE_SCHEDULER;
    }
    async call(method, path, bodyObj, query, requestHeaders) {
        const operation = hubOperationForRequest(path, bodyObj);
        const draft = bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
        const authDeadline = createHubDeadline(this.deadlineScheduler, method, path, operation, this.deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
        let signed;
        try {
            signed = await awaitWithAbort(this.deps.auth.authenticate({ method, path, ...(draft ? { body: draft } : {}), signal: authDeadline.signal }), authDeadline.signal);
        }
        catch (error) {
            if (isAuthTransportTimeout(error)) {
                throw new HubUnreachableError('hub authentication timed out', {
                    context: `${method} ${path}`,
                    retryAfterMs: HUB_UNREACHABLE_BACKOFF_BASE_MS,
                    operation,
                });
            }
            throw error;
        }
        finally {
            authDeadline.dispose();
        }
        const timeoutMs = this.operationTimeouts[HUB_OPERATION_TIMEOUT_KEYS[operation]];
        const deadline = createHubDeadline(this.deadlineScheduler, method, path, operation, timeoutMs);
        try {
            const sender = this.deps.senderId();
            const creds = signed.bodyFields ?? {};
            let url = `${this.deps.baseUrl}${path}`;
            assertHubUrlSecure(url); // request-level scheme guard (defense in depth): even a misconfigured injected fetchFn cannot egress in plaintext
            let body;
            const headers = mergeRequestHeaders(requestHeaders, signed.headers);
            if (method === 'GET') {
                const qs = new URLSearchParams();
                if (sender)
                    qs.set('sender_id', sender); // identifier, not a credential — query is fine
                if (query)
                    for (const [k, v] of Object.entries(query))
                        if (v !== undefined)
                            qs.set(k, String(v)); // non-credential GET params (e.g. semantic-search q)
                // #8: credentials must NOT go in the query (leaks to access logs / proxies even over https).
                // node_secret travels via Authorization: Bearer; the hub reads it there, never from the query.
                const nodeSecret = creds['node_secret'];
                if (nodeSecret !== undefined && headers['authorization'] === undefined)
                    headers['authorization'] = `Bearer ${String(nodeSecret)}`;
                const q = qs.toString();
                if (q)
                    url += `?${q}`;
            }
            else {
                const postCreds = { ...creds };
                const nodeSecret = postCreds['node_secret'];
                if ((path === '/a2a/hello' || path === '/a2a/mailbox/outbound') && nodeSecret !== undefined) {
                    if (headers['authorization'] === undefined)
                        headers['authorization'] = `Bearer ${String(nodeSecret)}`;
                    delete postCreds['node_secret'];
                }
                if (path === '/a2a/mailbox/outbound' && sender) {
                    const qs = new URLSearchParams({ sender_id: sender });
                    url += `?${qs.toString()}`;
                }
                body = JSON.stringify({ ...(sender ? { sender_id: sender } : {}), ...postCreds, ...(bodyObj ?? {}) });
            }
            let res;
            try {
                res = await awaitWithAbort(this.deps.fetchFn(url, {
                    method,
                    headers,
                    ...(body ? { body } : {}),
                    signal: deadline.signal,
                    redirect: 'manual',
                }), deadline.signal);
            }
            catch (err) {
                if (deadline.signal.aborted)
                    throw deadline.error;
                if (isHubUnreachableError(err)) {
                    throw new HubUnreachableError(`${method} ${path} failed before a Hub API response arrived`, { context: `${method} ${path}`, retryAfterMs: HUB_UNREACHABLE_BACKOFF_BASE_MS });
                }
                throw err;
            }
            if (deadline.signal.aborted)
                throw deadline.error;
            const retryAfterMs = parseRetryAfterMs(headerValue(res.headers, 'retry-after'), this.deps.now?.() ?? Date.now());
            if (res.status >= 300 && res.status < 400) {
                await drainHubResponse(res, { signal: deadline.signal });
                if (deadline.signal.aborted)
                    throw deadline.error;
                throw new HubUnreachableError(`${method} ${path} refused an unexpected Hub redirect`, { status: res.status, context: `${method} ${path}`, retryAfterMs: retryAfterMs ?? HUB_UNREACHABLE_BACKOFF_BASE_MS });
            }
            const parsed = await readHubResponseJsonForClassification(res, deadline.signal);
            if (deadline.signal.aborted)
                throw deadline.error;
            throwIfParsedHubUnreachableResponse(res, parsed, `${method} ${path}`, retryAfterMs);
            if (res.status === 401 || res.status === 403)
                throw new AuthError(res.status, parsed.body);
            if (res.status >= 400 && res.status < 500) {
                throw new HubClientError(res.status, parsed.ok ? parsed.body : {}, retryAfterMs);
            }
            if (res.status >= 500)
                throw new Error(`hub ${res.status}`);
            return parsed.body;
        }
        finally {
            deadline.dispose();
        }
    }
}
function positiveTimeoutMs(value, fallback) {
    if (value === undefined || value === '')
        return fallback;
    const raw = String(value);
    if (!/^\d+$/.test(raw))
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed < 2 ** 31 ? parsed : fallback;
}
export function resolveHubOperationTimeouts(env = process.env, overrides = {}) {
    const fromEnv = {
        generalMs: positiveTimeoutMs(env['EVOLVER_HTTP_TRANSPORT_TIMEOUT_MS'], HUB_GENERAL_TIMEOUT_MS),
        searchMs: positiveTimeoutMs(env['EVOLVER_HUB_SEARCH_TIMEOUT_MS'], HUB_SEARCH_TIMEOUT_MS),
        heartbeatMs: positiveTimeoutMs(env['EVOLVER_HEARTBEAT_TIMEOUT_MS'], HUB_HEARTBEAT_TIMEOUT_MS),
        pollMs: positiveTimeoutMs(env['EVOLVER_EVENT_POLL_TIMEOUT_MS'], HUB_EVENT_POLL_TIMEOUT_MS),
        helloMs: positiveTimeoutMs(env['EVOLVER_HELLO_TIMEOUT_MS'], HUB_HELLO_TIMEOUT_MS),
    };
    return {
        generalMs: positiveTimeoutMs(overrides.generalMs, fromEnv.generalMs),
        searchMs: positiveTimeoutMs(overrides.searchMs, fromEnv.searchMs),
        heartbeatMs: positiveTimeoutMs(overrides.heartbeatMs, fromEnv.heartbeatMs),
        pollMs: positiveTimeoutMs(overrides.pollMs, fromEnv.pollMs),
        helloMs: positiveTimeoutMs(overrides.helloMs, fromEnv.helloMs),
    };
}
function hubOperationForRequest(path, bodyObj) {
    if (path === '/a2a/fetch') {
        const payload = bodyObj?.['payload'];
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            && payload['search_only'] === true)
            return 'search';
    }
    if (path === '/a2a/assets/semantic-search' || path === '/a2a/directory/search')
        return 'search';
    if (path === '/a2a/heartbeat')
        return 'heartbeat';
    if (path === '/a2a/events/poll')
        return 'poll';
    if (path === '/a2a/hello')
        return 'hello';
    return 'general';
}
function createHubDeadline(scheduler, method, path, operation, timeoutMs) {
    const controller = new AbortController();
    const error = new HubUnreachableError(`${method} ${path} timed out after ${timeoutMs}ms`, {
        context: `${method} ${path}`,
        retryAfterMs: HUB_UNREACHABLE_BACKOFF_BASE_MS,
        operation,
        timeoutMs,
    });
    const handle = scheduler.set(() => controller.abort(error), timeoutMs);
    return {
        signal: controller.signal,
        error,
        dispose: () => scheduler.clear(handle),
    };
}
function abortReason(signal) {
    if (signal.reason instanceof Error)
        return signal.reason;
    const error = new Error('Hub request aborted');
    error.name = 'AbortError';
    return error;
}
async function awaitWithAbort(promise, signal) {
    const pending = Promise.resolve(promise);
    if (!signal)
        return await pending;
    if (signal.aborted) {
        void pending.catch(() => { });
        throw abortReason(signal);
    }
    return await new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(abortReason(signal));
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        void pending.then((value) => {
            cleanup();
            resolve(value);
        }, (error) => {
            cleanup();
            reject(error);
        });
    });
}
function hubErrorCode(body) {
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
    if (!record)
        return undefined;
    const payload = record['payload'] && typeof record['payload'] === 'object' && !Array.isArray(record['payload'])
        ? record['payload']
        : undefined;
    for (const source of [record, payload]) {
        if (!source)
            continue;
        for (const key of ['error', 'code', 'error_code', 'errorCode', 'reason']) {
            const value = source[key];
            if (typeof value === 'string' && value.trim())
                return value.trim();
        }
    }
    return undefined;
}
function headerValue(headers, name) {
    if (!headers)
        return '';
    try {
        if (typeof headers.get === 'function') {
            return String(headers.get(name) ?? '');
        }
        const lower = name.toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === lower)
                return String(v ?? '');
        }
        return '';
    }
    catch {
        return '';
    }
}
function parseRetryAfterMs(value, now) {
    const raw = value.trim();
    if (!raw || !Number.isFinite(now))
        return undefined;
    if (/^\d+$/.test(raw)) {
        const milliseconds = Number(raw) * 1_000;
        return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(raw))
        return undefined;
    const retryAt = Date.parse(raw);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined;
}
export function hubResponseContentType(res) {
    return headerValue(res?.headers, 'content-type').toLowerCase();
}
export function isHubApiResponse(res) {
    const contentType = hubResponseContentType(res);
    return contentType.length === 0 || contentType.includes('json');
}
export function hubUnreachableBackoffMs(failureCount) {
    const n = Math.max(1, Number.isFinite(failureCount) ? failureCount : 1);
    return Math.min(HUB_UNREACHABLE_BACKOFF_BASE_MS * 2 ** (n - 1), HUB_UNREACHABLE_BACKOFF_MAX_MS);
}
const NETWORK_DISRUPTION_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETDOWN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ENOTCONN',
    'ETIMEDOUT',
    'ABORT_ERR',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
function isAuthTransportTimeout(error) {
    return error instanceof Error
        && (error.message === 'oauth_refresh_timeout' || error.message === 'device_flow_timeout');
}
export function isHubUnreachableError(err) {
    const e = err;
    if (!e)
        return false;
    if (err instanceof HubUnreachableError || e.code === 'HUB_UNREACHABLE')
        return true;
    if (typeof e.code === 'string' && NETWORK_DISRUPTION_CODES.has(e.code))
        return true;
    if (e.name === 'AbortError' || e.name === 'TimeoutError')
        return true;
    const c = e.cause;
    return c?.name === 'AbortError'
        || c?.name === 'TimeoutError'
        || (typeof c?.code === 'string' && NETWORK_DISRUPTION_CODES.has(c.code));
}
export function isHubUnreachableResponse(res) {
    return hubResponseContentType(res).length > 0 && !isHubApiResponse(res);
}
function bodyReader(body) {
    if (body && typeof body.getReader === 'function') {
        return body.getReader();
    }
    return null;
}
function toBytes(value) {
    if (value instanceof Uint8Array)
        return value;
    if (typeof value === 'string')
        return Buffer.from(value, 'utf8');
    return Buffer.from(String(value ?? ''), 'utf8');
}
export async function drainHubResponse(res, opts = {}) {
    const body = res?.body;
    try {
        if (body && typeof body.cancel === 'function') {
            await awaitWithAbort(Promise.resolve(body.cancel()), opts.signal);
        }
    }
    catch {
        // Best-effort pool hygiene only.
    }
}
export async function readHubResponseText(res, opts = {}) {
    const maxBytes = Math.max(0, opts.maxBytes ?? HUB_ERROR_TEXT_MAX_BYTES);
    const reader = bodyReader(res.body);
    if (reader) {
        const decoder = new TextDecoder();
        const chunks = [];
        let total = 0;
        let truncated = false;
        try {
            for (;;) {
                const part = await awaitWithAbort(reader.read(), opts.signal);
                if (part.done)
                    break;
                const bytes = toBytes(part.value);
                const remaining = maxBytes - total;
                if (bytes.byteLength > remaining) {
                    if (remaining > 0) {
                        chunks.push(bytes.subarray(0, remaining));
                        total += remaining;
                    }
                    truncated = true;
                    await cancelReader(reader, opts.signal);
                    break;
                }
                chunks.push(bytes);
                total += bytes.byteLength;
            }
        }
        catch (err) {
            await cancelReader(reader, opts.signal);
            throw err;
        }
        finally {
            reader.releaseLock?.();
        }
        const text = decoder.decode(Buffer.concat(chunks, total));
        return truncated ? `${text}\n...[truncated]` : text;
    }
    if (res.body === null)
        return '';
    throw new Error('hub response body stream missing');
}
async function cancelReader(reader, signal) {
    try {
        if (reader.cancel)
            await awaitWithAbort(Promise.resolve(reader.cancel()), signal);
    }
    catch {
        // Cancellation is best-effort; preserve the read/timeout error.
    }
}
export async function readHubResponseJson(res, opts = {}) {
    const text = await readHubResponseText(res, {
        maxBytes: opts.maxBytes ?? HUB_JSON_TEXT_MAX_BYTES,
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return JSON.parse(text);
}
export async function throwIfHubUnreachableResponse(res, context = 'hub') {
    const retryAfterMs = parseRetryAfterMs(headerValue(res.headers, 'retry-after'), Date.now());
    if (!isHubUnreachableResponse(res)) {
        const parsed = await readHubResponseJsonForClassification(res);
        throwIfParsedHubUnreachableResponse(res, parsed, context, retryAfterMs);
        return;
    }
    const status = Number(res.status) || undefined;
    const contentType = hubResponseContentType(res) || 'unknown content-type';
    try {
        await drainHubResponse(res);
    }
    catch {
        // Best-effort pool hygiene only.
    }
    throw new HubUnreachableError(`${context} returned a non-API Hub response (${status ?? 'unknown status'}, ${contentType})`, {
        ...(status !== undefined ? { status } : {}),
        contentType,
        context,
        retryAfterMs: retryAfterMs ?? HUB_UNREACHABLE_BACKOFF_BASE_MS,
    });
}
async function readHubResponseJsonForClassification(res, signal) {
    if (isHubUnreachableResponse(res)) {
        await drainHubResponse(res, { ...(signal ? { signal } : {}) });
        return { ok: false, reason: 'non_api_content_type' };
    }
    try {
        const text = await readHubResponseText(res, {
            maxBytes: HUB_JSON_TEXT_MAX_BYTES,
            ...(signal ? { signal } : {}),
        });
        return { ok: true, body: JSON.parse(text) };
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
function throwIfParsedHubUnreachableResponse(res, parsed, context, retryAfterMs) {
    const status = Number(res.status) || undefined;
    const contentType = hubResponseContentType(res);
    if (!isHubApiResponse(res) || !parsed.ok) {
        throw new HubUnreachableError(`${context} returned a non-API Hub response (${status ?? 'unknown status'}, ${contentType || 'unknown content-type'})`, {
            ...(status !== undefined ? { status } : {}),
            contentType: contentType || 'unknown content-type',
            context,
            retryAfterMs: retryAfterMs ?? HUB_UNREACHABLE_BACKOFF_BASE_MS,
        });
    }
}
/**
 * Hub egress security chokepoint (ported from v1 src/gep/hubFetch.js):
 *  1. https-only scheme guard — reject non-https to prevent plaintext egress leaking token/asset/sender_id;
 *  2. TLS enforcement — an undici Agent dispatcher (connect.rejectUnauthorized:true) overrides a global
 *     NODE_TLS_REJECT_UNAUTHORIZED=0 (note: this forces cert verification against the system trust store,
 *     it is NOT CA/SPKI pinning).
 *  3. Hub egress defaults to IPv4-first, then dual-stack fallback, so VPN/TUN setups do not leak Hub calls
 *     over local IPv6 and trip Cloudflare country/ASN rules. Set EVOMAP_HUB_IP_FAMILY=auto to restore
 *     dual-stack as primary, or ipv4-only to disable fallback.
 * Escape hatch EVOMAP_HUB_ALLOW_INSECURE==='1' (exact string) disables BOTH, for local dev / mock hub
 * (http / self-signed) only. See feedback_public_repo_no_internal_leak.
 */
function insecureAllowed(env) {
    return env['EVOMAP_HUB_ALLOW_INSECURE'] === '1';
}
/** https-only scheme guard: throws on invalid URL or non-https (unless the escape hatch is set). Called at both request and transport layers (defense in depth). */
export function assertHubUrlSecure(url, env = process.env) {
    if (insecureAllowed(env))
        return;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`[hubFetch] Hub URL is not a valid URL: ${JSON.stringify(url)}. Set EVOMAP_HUB_ALLOW_INSECURE=1 to bypass (local dev / mock hub only).`);
    }
    if (parsed.protocol !== 'https:') {
        throw new Error(`[hubFetch] Hub URL must use https:// — got ${JSON.stringify(url)}. Set EVOMAP_HUB_ALLOW_INSECURE=1 to bypass (local dev / mock hub only).`);
    }
}
export const HUB_CONNECT_TIMEOUT_MS = 10_000;
export const HUB_IPV4FIRST_PRIMARY_CONNECT_TIMEOUT_MS = 2_500;
export const HUB_TCP_KEEPALIVE_IDLE_MS = 15_000;
export function resolveHubIpFamily(env = process.env) {
    const raw = String(env['EVOMAP_HUB_IP_FAMILY'] ?? 'ipv4first').trim().toLowerCase();
    if (raw === 'ipv4' || raw === 'v4' || raw === '4' || raw === 'ipv4first' || raw === 'ipv4-first')
        return 'ipv4first';
    if (raw === 'ipv4only' || raw === 'ipv4-only')
        return 'ipv4only';
    if (raw === 'auto' || raw === 'dualstack' || raw === 'dual-stack')
        return 'auto';
    throw new Error(`[hubFetch] EVOMAP_HUB_IP_FAMILY must be "ipv4", "ipv4-only", or "auto" — got ${JSON.stringify(env['EVOMAP_HUB_IP_FAMILY'])}`);
}
function makeHubFetchTransportConfig(env = process.env) {
    const hubIpFamily = resolveHubIpFamily(env);
    const baseConnectOpts = {
        rejectUnauthorized: true,
        timeout: HUB_CONNECT_TIMEOUT_MS,
    };
    const ipv4OnlyConnectOpts = {
        ...baseConnectOpts,
        family: 4,
        autoSelectFamily: false,
    };
    const ipv4FirstPrimaryConnectOpts = {
        ...ipv4OnlyConnectOpts,
        timeout: HUB_IPV4FIRST_PRIMARY_CONNECT_TIMEOUT_MS,
    };
    const autoConnectOpts = {
        ...baseConnectOpts,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 250,
    };
    const primaryConnectOpts = hubIpFamily === 'auto'
        ? autoConnectOpts
        : hubIpFamily === 'ipv4only'
            ? ipv4OnlyConnectOpts
            : ipv4FirstPrimaryConnectOpts;
    return {
        hubIpFamily,
        connectTimeoutMs: HUB_CONNECT_TIMEOUT_MS,
        ipv4FirstPrimaryConnectTimeoutMs: HUB_IPV4FIRST_PRIMARY_CONNECT_TIMEOUT_MS,
        connectOpts: { ...primaryConnectOpts },
        primaryConnectOpts: { ...primaryConnectOpts },
        fallbackConnectOpts: hubIpFamily === 'ipv4first' ? { ...autoConnectOpts } : null,
    };
}
const IPV4_FALLBACK_CODES = new Set([
    'EADDRNOTAVAIL',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
]);
function errorCode(err) {
    const e = err;
    if (typeof e?.code === 'string')
        return e.code;
    const cause = e?.cause;
    return typeof cause?.code === 'string' ? cause.code : undefined;
}
function shouldFallbackFromIpv4(err, hubIpFamily) {
    return hubIpFamily === 'ipv4first' && IPV4_FALLBACK_CODES.has(errorCode(err) ?? '');
}
function configureHubSocket(socket) {
    if (socket === null || typeof socket !== 'object')
        return;
    const setKeepAlive = socket.setKeepAlive;
    if (typeof setKeepAlive !== 'function')
        return;
    try {
        setKeepAlive.call(socket, true, HUB_TCP_KEEPALIVE_IDLE_MS);
    }
    catch {
        // Kernel/socket support varies. A keepalive tuning failure must never turn a valid TLS connection into an outage.
    }
}
function makeHubConnector(config) {
    const primaryConnect = buildConnector(config.primaryConnectOpts);
    const fallbackConnect = config.fallbackConnectOpts ? buildConnector(config.fallbackConnectOpts) : null;
    const connector = (opts, cb) => {
        const finish = (err, socket) => {
            if (err) {
                cb(err, null);
                return;
            }
            if (!socket) {
                cb(new Error('[hubFetch] undici connector returned no socket'), null);
                return;
            }
            configureHubSocket(socket);
            cb(null, socket);
        };
        primaryConnect(opts, (err, socket) => {
            if (err && fallbackConnect && shouldFallbackFromIpv4(err, config.hubIpFamily)) {
                fallbackConnect(opts, finish);
                return;
            }
            finish(err, socket);
        });
    };
    const marked = connector;
    marked.rejectUnauthorized = true;
    return marked;
}
const HUB_FETCH_CONFIG = makeHubFetchTransportConfig(process.env);
// Singleton TLS-enforcing dispatcher: overrides a global NODE_TLS_REJECT_UNAUTHORIZED=0. The Agent and
// fetch MUST come from the same undici package (mixing an npm-undici Agent with Node's built-in global.fetch
// throws UND_ERR_INVALID_ARG). The connector applies TLS verification plus the selected Hub IP-family policy.
const STRICT_TLS_AGENT = new Agent({
    connect: makeHubConnector(HUB_FETCH_CONFIG),
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
    pipelining: 1,
});
export function _getHubFetchConfigForTest(env) {
    return env ? makeHubFetchTransportConfig(env) : {
        ...HUB_FETCH_CONFIG,
        connectOpts: { ...HUB_FETCH_CONFIG.connectOpts },
        primaryConnectOpts: { ...HUB_FETCH_CONFIG.primaryConnectOpts },
        fallbackConnectOpts: HUB_FETCH_CONFIG.fallbackConnectOpts ? { ...HUB_FETCH_CONFIG.fallbackConnectOpts } : null,
    };
}
export function _shouldFallbackFromIpv4ForTest(err, hubIpFamily = HUB_FETCH_CONFIG.hubIpFamily) {
    return shouldFallbackFromIpv4(err, hubIpFamily);
}
export function _configureHubSocketForTest(socket) {
    configureHubSocket(socket);
}
// Test seam: lets unit tests swap the underlying fetch without forking the call path; production must never reassign it from outside.
let _fetchImpl = undiciFetch;
export function _setFetchImplForTest(fn) { _fetchImpl = fn ?? undiciFetch; }
// One-time loud warning when the escape hatch is active, so a misconfigured staging/prod
// (e.g. a leaked EVOMAP_HUB_ALLOW_INSECURE in a CI var / copied .env) does not SILENTLY downgrade
// egress security. Turns a silent downgrade into an observable one.
let _insecureWarned = false;
function warnInsecureOnce() {
    if (_insecureWarned)
        return;
    _insecureWarned = true;
    process.stderr.write('[hubFetch] WARNING: EVOMAP_HUB_ALLOW_INSECURE=1 — https guard and TLS enforcement are DISABLED. Hub egress may be plaintext/unverified. Local dev / mock hub only, never production.\n');
}
/** Test seam: reset the one-time insecure-warning latch. */
export function _resetInsecureWarningForTest() { _insecureWarned = false; }
/** Default production transport: secure mode = https guard + forced TLS dispatcher; escape-hatch mode = skip both (local dev). */
export const globalFetchLike = async (url, init) => {
    const raw = { ...init, redirect: 'manual' };
    if (insecureAllowed(process.env)) {
        warnInsecureOnce();
        return (await _fetchImpl(url, raw));
    }
    assertHubUrlSecure(url);
    // last-wins dispatcher: forces TLS, a caller cannot override it (leak/mitm-safety).
    return (await _fetchImpl(url, { ...raw, dispatcher: STRICT_TLS_AGENT }));
};