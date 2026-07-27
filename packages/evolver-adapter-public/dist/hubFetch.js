import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
export const HUB_ERROR_TEXT_MAX_BYTES = 8 * 1024;
export const HUB_JSON_TEXT_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_UNREACHABLE_BACKOFF_BASE_MS = 60_000;
export const HUB_UNREACHABLE_BACKOFF_MAX_MS = 10 * 60_000;
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
    constructor(status, body) {
        super(`hub ${status}`);
        this.status = status;
        this.body = body;
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
        if (!PROTECTED_REQUEST_HEADERS.has(normalized) && !signedNames.has(normalized))
            headers[normalized] = value;
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
    constructor(deps) {
        this.deps = deps;
    }
    async call(method, path, bodyObj, query, requestHeaders) {
        const draft = bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
        const signed = await this.deps.auth.authenticate({ method, path, ...(draft ? { body: draft } : {}) });
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
            res = await this.deps.fetchFn(url, { method, headers, ...(body ? { body } : {}) });
        }
        catch (err) {
            if (isHubUnreachableError(err)) {
                throw new HubUnreachableError(`${method} ${path} failed before a Hub API response arrived`, { context: `${method} ${path}`, retryAfterMs: HUB_UNREACHABLE_BACKOFF_BASE_MS });
            }
            throw err;
        }
        const parsed = await readHubResponseJsonForClassification(res);
        throwIfParsedHubUnreachableResponse(res, parsed, `${method} ${path}`);
        if (res.status === 401 || res.status === 403)
            throw new AuthError(res.status, parsed.body);
        if (res.status >= 400 && res.status < 500)
            throw new HubClientError(res.status, parsed.ok ? parsed.body : {});
        if (res.status >= 500)
            throw new Error(`hub ${res.status}`);
        return parsed.body;
    }
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
export async function drainHubResponse(res) {
    const body = res?.body;
    try {
        if (body && typeof body.cancel === 'function') {
            await body.cancel();
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
                const part = await reader.read();
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
                    await reader.cancel?.();
                    break;
                }
                chunks.push(bytes);
                total += bytes.byteLength;
            }
        }
        catch (err) {
            await reader.cancel?.();
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
export async function readHubResponseJson(res, opts = {}) {
    const text = await readHubResponseText(res, { maxBytes: opts.maxBytes ?? HUB_JSON_TEXT_MAX_BYTES });
    return JSON.parse(text);
}
export async function throwIfHubUnreachableResponse(res, context = 'hub') {
    if (!isHubUnreachableResponse(res)) {
        const parsed = await readHubResponseJsonForClassification(res);
        throwIfParsedHubUnreachableResponse(res, parsed, context);
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
    throw new HubUnreachableError(`${context} returned a non-API Hub response (${status ?? 'unknown status'}, ${contentType})`, { ...(status !== undefined ? { status } : {}), contentType, context, retryAfterMs: HUB_UNREACHABLE_BACKOFF_BASE_MS });
}
async function readHubResponseJsonForClassification(res) {
    if (isHubUnreachableResponse(res)) {
        await drainHubResponse(res);
        return { ok: false, reason: 'non_api_content_type' };
    }
    try {
        const text = await readHubResponseText(res, { maxBytes: HUB_JSON_TEXT_MAX_BYTES });
        return { ok: true, body: JSON.parse(text) };
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
function throwIfParsedHubUnreachableResponse(res, parsed, context) {
    const status = Number(res.status) || undefined;
    const contentType = hubResponseContentType(res);
    if (!isHubApiResponse(res) || !parsed.ok) {
        throw new HubUnreachableError(`${context} returned a non-API Hub response (${status ?? 'unknown status'}, ${contentType || 'unknown content-type'})`, {
            ...(status !== undefined ? { status } : {}),
            contentType: contentType || 'unknown content-type',
            context,
            retryAfterMs: HUB_UNREACHABLE_BACKOFF_BASE_MS,
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
function makeHubConnector(config) {
    const primaryConnect = buildConnector(config.primaryConnectOpts);
    const fallbackConnect = config.fallbackConnectOpts ? buildConnector(config.fallbackConnectOpts) : null;
    const connector = (opts, cb) => {
        primaryConnect(opts, (err, socket) => {
            if (err && fallbackConnect && shouldFallbackFromIpv4(err, config.hubIpFamily)) {
                fallbackConnect(opts, cb);
                return;
            }
            if (err) {
                cb(err, null);
                return;
            }
            if (socket) {
                cb(null, socket);
                return;
            }
            cb(new Error('[hubFetch] undici connector returned no socket'), null);
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
const STRICT_TLS_AGENT = new Agent({ connect: makeHubConnector(HUB_FETCH_CONFIG) });
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
    const raw = init;
    if (insecureAllowed(process.env)) {
        warnInsecureOnce();
        return (await _fetchImpl(url, raw));
    }
    assertHubUrlSecure(url);
    // last-wins dispatcher: forces TLS, a caller cannot override it (leak/mitm-safety).
    return (await _fetchImpl(url, { ...raw, dispatcher: STRICT_TLS_AGENT }));
};