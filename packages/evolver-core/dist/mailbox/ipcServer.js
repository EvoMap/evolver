import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createEnvelope } from './envelope.js';
const MAX_BODY = 256 * 1024; // 256KB 上限(防本机注入超大体)
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** 定长常量时间比较(防 token 计时侧信道). */
function tokenEq(a, b) {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    if (ba.length !== bb.length)
        return false;
    return timingSafeEqual(ba, bb);
}
/**
 * 本地 HTTP IPC(M2-6): runtime adapter ↔ mailbox 的进程间通道.
 * 仅绑 127.0.0.1 + Bearer token; runtimeNamespace 分区, 不同 runtime 实例互不串信箱.
 */
export class MailboxIpcServer {
    server;
    store;
    token;
    host;
    now;
    extraRoutes;
    onSend;
    onAuthFailure;
    constructor(opts) {
        this.store = opts.store;
        this.token = opts.token;
        this.host = opts.host ?? '127.0.0.1';
        this.now = opts.now ?? (() => Date.now());
        this.extraRoutes = opts.extraRoutes ?? [];
        this.onSend = opts.onSend;
        this.onAuthFailure = opts.onAuthFailure;
        this.server = createServer((req, res) => { void this.handle(req, res); });
    }
    listen(port = 0) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.server.off('error', onError);
                this.server.off('listening', onListening);
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const onListening = () => {
                cleanup();
                const addr = this.server.address();
                resolve(addr && typeof addr === 'object' ? addr.port : port);
            };
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(port, this.host);
        });
    }
    close() {
        return new Promise((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
    }
    async handle(req, res) {
        try {
            const ra = req.socket.remoteAddress ?? '';
            if (!LOOPBACK.has(ra))
                return this.json(res, 403, { error: 'non-loopback' });
            const auth = req.headers['authorization'] ?? '';
            // Fail closed on an empty configured token: tokenEq('', '') is true, so without this guard a blank token
            // would authenticate any `Authorization: Bearer ` request. An empty token never authenticates anyone.
            if (!this.token || !auth.startsWith('Bearer ') || !tokenEq(auth.slice(7), this.token)) {
                try {
                    this.onAuthFailure?.();
                }
                catch { /* auth failure handling must never weaken fail-closed IPC auth */ }
                return this.json(res, 401, { error: 'Unauthorized', code: 'unauthorized' });
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const route = `${req.method} ${url.pathname}`;
            const now = this.now();
            for (const extra of this.extraRoutes) {
                const handled = await extra({
                    req,
                    res,
                    url,
                    route,
                    now,
                    store: this.store,
                    readJson: () => this.readJson(req),
                    json: (code, body) => this.json(res, code, body),
                });
                if (handled)
                    return;
            }
            if (route === 'POST /mailbox/send') {
                const body = (await this.readJson(req));
                const env = createEnvelope({ ...body, now });
                const r = this.store.send(env);
                if (r.stored)
                    this.onSend?.(env, r);
                return this.json(res, 200, { id: env.id, receiptId: r.receiptId, stored: r.stored, correlationId: env.correlationId });
            }
            if (route === 'POST /mailbox/claim') {
                const b = (await this.readJson(req));
                const got = this.store.claim(b.handler, b.limit ?? 16, b.leaseMs ?? 30_000, now, b.runtimeNamespace);
                return this.json(res, 200, { messages: got });
            }
            if (route === 'POST /mailbox/complete') {
                const b = (await this.readJson(req));
                this.store.complete(b.id, now);
                return this.json(res, 200, { ok: true });
            }
            if (route === 'POST /mailbox/fail') {
                const b = (await this.readJson(req));
                this.store.fail(b.id, b.error ?? 'ipc fail', now);
                return this.json(res, 200, { ok: true });
            }
            if (req.method === 'GET' && url.pathname === '/mailbox/status') {
                const id = url.searchParams.get('id') ?? '';
                const s = this.store.getStatus(id);
                return s ? this.json(res, 200, s) : this.json(res, 404, { error: 'not found' });
            }
            if (req.method === 'GET' && url.pathname === '/mailbox/list') {
                const status = url.searchParams.get('status') ?? undefined;
                const got = this.store.list({
                    status: status,
                    handler: url.searchParams.get('handler') ?? undefined,
                    runtimeNamespace: url.searchParams.get('runtimeNamespace') ?? undefined,
                    limit: Number(url.searchParams.get('limit') ?? 200),
                });
                return this.json(res, 200, { messages: got });
            }
            return this.json(res, 404, { error: 'unknown route' });
        }
        catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e), code: 'invalid_request' });
        }
    }
    readJson(req) {
        return new Promise((resolve, reject) => {
            let size = 0;
            let overflow = false;
            const chunks = [];
            req.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY) {
                    overflow = true;
                    return;
                } // 不 destroy socket: 继续 drain 以保证能回 400
                if (!overflow)
                    chunks.push(c);
            });
            req.on('end', () => {
                if (overflow) {
                    reject(new Error('body too large'));
                    return;
                }
                try {
                    resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
                }
                catch {
                    reject(new Error('invalid json'));
                }
            });
            req.on('error', reject);
        });
    }
    json(res, code, body) {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    }
}