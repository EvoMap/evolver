// The local HTTP shell that puts the /v1/messages handler on the wire (the listen half v1 kept in
// proxy/server/http.js). Binding model: loopback only, bearer-token self-auth (token mediation — the client
// exports ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and ANTHROPIC_AUTH_TOKEN=<proxy token>; the upstream
// factory strips that header and substitutes real credentials). Loopback is NOT a trust boundary on a shared
// host (other local users, container neighbors, postinstall scripts), hence the mandatory token.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { util } from '@evomap/evolver-core';
export const DEFAULT_LLM_PORT = 19821; // one above the mailbox IPC default — the two daemons co-exist
const MAX_PORT_ATTEMPTS = 100;
const MAX_EPHEMERAL_LLM_LISTEN_ATTEMPTS = 5;
/** /v1/messages bodies legitimately reach tens of MiB (long contexts); the 1 MiB IPC-style cap would break
 * real clients. Still bounded — an unauthenticated local writer must not be able to balloon memory. */
export const DEFAULT_LLM_MAX_BODY_BYTES = 32 * 1024 * 1024;
const SENSITIVE_QUERY_PARAMS = new Set([
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
function resolveMaxBodyBytes(opts, env) {
    if (typeof opts.maxBodyBytes === 'number' && opts.maxBodyBytes > 0)
        return Math.floor(opts.maxBodyBytes);
    const raw = Number(env['EVOLVER_LLM_MAX_BODY_BYTES']);
    if (Number.isFinite(raw) && raw > 0)
        return Math.floor(raw);
    return DEFAULT_LLM_MAX_BODY_BYTES;
}
function safeExtraHeaders(extraHeaders = {}) {
    const out = {};
    for (const [name, value] of Object.entries(extraHeaders)) {
        if (value === undefined || value === null)
            continue;
        const lower = name.toLowerCase();
        if (lower === 'content-length' || lower === 'content-type' || lower === 'transfer-encoding' || lower === 'connection')
            continue;
        if (/[\r\n]/.test(value))
            continue;
        out[name] = value;
    }
    return out;
}
function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        ...safeExtraHeaders(extraHeaders),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}
function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
            reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
            return;
        }
        const chunks = [];
        let received = 0;
        let settled = false;
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            try {
                req.destroy();
            }
            catch { /* already gone */ }
            reject(err);
        };
        req.on('data', (c) => {
            if (settled)
                return;
            received += c.length;
            if (received > maxBytes) {
                fail(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            const raw = Buffer.concat(chunks).toString();
            if (!raw) {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    resolve(parsed);
                else
                    reject(Object.assign(new Error('Body must be a JSON object'), { statusCode: 400 }));
            }
            catch {
                reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
            }
        });
        req.on('error', fail);
    });
}
function lowerHeaders(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers))
        out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    return out;
}
function redactedRequestTarget(rawUrl, actualPort) {
    try {
        const url = new URL(rawUrl ?? '/', `http://127.0.0.1:${actualPort ?? 0}`);
        const query = new URLSearchParams();
        for (const [name, value] of url.searchParams.entries()) {
            query.append(name, SENSITIVE_QUERY_PARAMS.has(name.toLowerCase()) ? 'REDACTED' : value);
        }
        const qs = query.toString();
        return `${url.pathname}${qs ? `?${qs}` : ''}`;
    }
    catch {
        return '?';
    }
}
function routeTable(opts) {
    return {
        'POST /v1/messages': opts.handler,
        ...(opts.routes ?? {}),
    };
}
function matchRoute(routes, method, pathname) {
    const direct = routes[`${method} ${pathname}`];
    if (direct)
        return { handler: direct, params: {} };
    const actual = pathname.split('/').filter(Boolean);
    for (const [key, handler] of Object.entries(routes)) {
        const [routeMethod, pattern] = key.split(' ', 2);
        if (routeMethod !== method || !pattern)
            continue;
        const expected = pattern.split('/').filter(Boolean);
        if (expected.length !== actual.length)
            continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < expected.length; i++) {
            const part = expected[i];
            const got = actual[i];
            if (part.startsWith(':')) {
                params[part.slice(1)] = got;
            }
            else if (part !== got) {
                ok = false;
                break;
            }
        }
        if (ok)
            return { handler, params };
    }
    return null;
}
export class LlmProxyServer {
    opts;
    server;
    actualPort = null;
    log;
    env;
    maxBodyBytes;
    constructor(opts) {
        this.opts = opts;
        if (!opts.token)
            throw new Error('LlmProxyServer requires a non-empty token');
        this.log = opts.logger ?? console;
        this.env = opts.env ?? process.env;
        this.maxBodyBytes = resolveMaxBodyBytes(opts, this.env);
    }
    authed(req) {
        const header = req.headers['authorization'] ?? '';
        const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
        const a = Buffer.from(provided, 'utf8');
        const b = Buffer.from(this.opts.token, 'utf8');
        return a.length === b.length && timingSafeEqual(a, b);
    }
    async start() {
        if (this.server)
            throw new Error('LlmProxyServer already started');
        const host = this.opts.host ?? '127.0.0.1';
        const basePort = this.opts.port ?? Number(this.env['EVOLVER_LLM_PORT'] || DEFAULT_LLM_PORT);
        const server = createServer((req, res) => { void this.handle(req, res); });
        const tryListen = (port) => new Promise((resolve, reject) => {
            const onError = (err) => {
                if (err.code === 'EADDRINUSE')
                    resolve(false);
                else
                    reject(err);
            };
            server.once('error', onError);
            server.listen(port, host, () => {
                server.removeListener('error', onError);
                resolve(true);
            });
        });
        const closeListener = () => new Promise((resolve, reject) => {
            server.close((err) => { if (err)
                reject(err);
            else
                resolve(); });
        });
        let port = basePort;
        const maxAttempts = basePort === 0 ? MAX_EPHEMERAL_LLM_LISTEN_ATTEMPTS : MAX_PORT_ATTEMPTS;
        for (let i = 0; i < maxAttempts; i++) {
            if (await tryListen(port)) {
                const addr = server.address();
                const actualPort = typeof addr === 'object' && addr ? addr.port : port;
                if (basePort === 0 && util.isFetchForbiddenPort(actualPort)) {
                    await closeListener();
                    continue;
                }
                this.actualPort = actualPort;
                this.server = server;
                const url = `http://${host}:${this.actualPort}`;
                this.log.log?.(`[evolver-llm-proxy] listening on ${url}`);
                return { port: this.actualPort, url };
            }
            if (basePort === 0)
                break; // kernel-assigned can't collide; a failure here is real
            port++;
        }
        if (basePort === 0)
            throw new Error('llm_proxy_safe_port_unavailable');
        throw new Error(`LlmProxyServer: no free port after ${MAX_PORT_ATTEMPTS} attempts from ${basePort}`);
    }
    async stop() {
        if (!this.server)
            return;
        const s = this.server;
        this.server = undefined;
        // close() alone waits for keep-alive sockets (undici/fetch pools them), which can park shutdown
        // indefinitely; drop them so stop() always completes.
        s.closeAllConnections();
        await new Promise((resolve) => { s.close(() => resolve()); });
    }
    async handle(req, res) {
        try {
            const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.actualPort}`);
            if (req.method === 'GET' && url.pathname === '/healthz') {
                sendJson(res, 200, { ok: true });
                return;
            }
            if (!this.authed(req)) {
                sendJson(res, 401, { error: 'Unauthorized' });
                return;
            }
            const method = req.method ?? 'GET';
            const matched = matchRoute(routeTable(this.opts), method, url.pathname);
            if (!matched) {
                sendJson(res, 404, { error: 'Not found', path: url.pathname });
                return;
            }
            const body = method === 'POST' || method === 'PUT' || method === 'PATCH'
                ? await readBody(req, this.maxBodyBytes)
                : {};
            const request = {
                body,
                headers: lowerHeaders(req),
                params: matched.params,
                query: Object.fromEntries(url.searchParams.entries()),
            };
            const result = await matched.handler(request);
            if (result.stream) {
                await this.relayStream(res, result);
                return;
            }
            sendJson(res, result.status || 200, result.body ?? {}, result.headers);
        }
        catch (err) {
            const sc = err.statusCode;
            const status = typeof sc === 'number' ? sc : 500;
            this.log.warn?.(`[evolver-llm-proxy] ${req.method ?? '?'} ${redactedRequestTarget(req.url, this.actualPort)} → ${status}: ${err instanceof Error ? err.message : String(err)}`);
            if (res.headersSent) {
                try {
                    res.end();
                }
                catch { /* socket already gone */ }
            }
            else {
                sendJson(res, status, { error: err instanceof Error ? err.message : 'Internal error' });
            }
        }
    }
    // SSE / passthrough relay (port of v1 ProxyHttpServer._streamResponse). The client closing mid-stream is
    // routine (Ctrl-C, network blip); without watching `close`, awaiting `drain` on a destroyed socket hangs
    // this coroutine forever AND pins the upstream fetch body open — a real upstream socket leak. Web
    // ReadableStream upstreams are read via an explicit reader so cancellation propagates; async iterables
    // (incl. the trace tee) fall back to for-await.
    async relayStream(res, result) {
        const headers = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(result.headers ?? {}),
        };
        res.writeHead(result.status || 200, headers);
        const stream = result.stream;
        const reader = stream && typeof stream.getReader === 'function'
            ? stream.getReader()
            : null;
        let clientGone = false;
        const onClose = () => {
            clientGone = true;
            if (reader) {
                reader.cancel().catch(() => { });
            }
            else if (stream && typeof stream.return === 'function') {
                void stream.return(undefined).catch(() => undefined);
            }
        };
        res.once('close', onClose);
        const awaitBackpressure = () => new Promise((resolve) => {
            let settled = false;
            const onDrain = () => {
                if (settled)
                    return;
                settled = true;
                res.off('close', onCloseInner);
                resolve();
            };
            const onCloseInner = () => {
                if (settled)
                    return;
                settled = true;
                res.off('drain', onDrain);
                resolve();
            };
            res.once('drain', onDrain);
            res.once('close', onCloseInner);
        });
        const write = (chunk) => res.write(typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk : String(chunk));
        try {
            if (reader) {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done || clientGone)
                        break;
                    if (!write(value)) {
                        await awaitBackpressure();
                        if (clientGone)
                            break;
                    }
                }
            }
            else if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
                for await (const chunk of stream) {
                    if (clientGone)
                        break;
                    if (!write(chunk)) {
                        await awaitBackpressure();
                        if (clientGone)
                            break;
                    }
                }
            }
        }
        finally {
            res.off('close', onClose);
            try {
                res.end();
            }
            catch { /* socket may already be destroyed */ }
        }
    }
}