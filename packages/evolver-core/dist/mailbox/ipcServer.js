import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createEnvelope } from './envelope.js';
import { mailboxClaimOwner } from './store.js';
const MAX_BODY = 256 * 1024; // 256KB 上限(防本机注入超大体)
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const STATUSES = new Set(['pending', 'in_flight', 'done', 'failed', 'expired']);
const DIRECTIONS = new Set(['outbound', 'inbound', 'local']);
const PRIORITIES = new Set(['high', 'normal', 'low']);
function serializeClaimedMessage(message) {
    const claimToken = mailboxClaimOwner(message);
    if (!claimToken)
        throw new Error('claimed mailbox message is missing its claim token');
    return { ...message, claimToken };
}
function requiredClaimToken(value) {
    if (typeof value !== 'string' || value.length === 0)
        throw new Error('claimToken must be a non-empty string');
    return value;
}
function optionalQueryInteger(url, name) {
    const raw = url.searchParams.get(name);
    if (raw === null)
        return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
}
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
    runtimeNamespace;
    extraRoutes;
    onSend;
    onAuthFailure;
    constructor(opts) {
        this.store = opts.store;
        this.token = opts.token;
        this.host = opts.host ?? '127.0.0.1';
        this.now = opts.now ?? (() => Date.now());
        this.runtimeNamespace = opts.runtimeNamespace;
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
                if (body.priority !== undefined && !PRIORITIES.has(body.priority)) {
                    throw new Error('priority must be high, normal, or low');
                }
                const legacyRef = typeof body.ref_id === 'string' && body.ref_id ? body.ref_id : undefined;
                const runtimeNamespace = this.resolveSendNamespace(body);
                let env = createEnvelope({
                    ...body,
                    runtimeNamespace,
                    correlationId: body.correlationId ?? legacyRef,
                    now,
                });
                if (body.expires_at !== undefined) {
                    if (typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at)) {
                        throw new Error('expires_at must be a finite epoch-millisecond number');
                    }
                    env = { ...env, ttlAt: body.expires_at };
                }
                const r = this.store.send(env);
                if (r.stored)
                    this.onSend?.(env, r);
                return this.json(res, 200, {
                    id: env.id,
                    receiptId: r.receiptId,
                    stored: r.stored,
                    correlationId: env.correlationId,
                    message_id: env.id,
                    status: env.status,
                });
            }
            if (route === 'POST /mailbox/claim') {
                const b = (await this.readJson(req));
                const runtimeNamespace = this.resolveRuntimeNamespace(b.runtimeNamespace);
                const got = this.store.claim(b.handler, b.limit ?? 16, b.leaseMs ?? 30_000, now, runtimeNamespace);
                return this.json(res, 200, { messages: got.map(serializeClaimedMessage) });
            }
            if (route === 'POST /mailbox/complete') {
                const b = (await this.readJson(req));
                if (!this.canMutateMessage(b.id))
                    return this.json(res, 404, { error: 'not found' });
                const claimToken = requiredClaimToken(b.claimToken);
                if (!this.store.completeClaimed(b.id, now, claimToken)) {
                    return this.json(res, 409, { error: 'mailbox claim is no longer owned by this worker', code: 'claim_conflict' });
                }
                return this.json(res, 200, { ok: true });
            }
            if (route === 'POST /mailbox/fail') {
                const b = (await this.readJson(req));
                if (!this.canMutateMessage(b.id))
                    return this.json(res, 404, { error: 'not found' });
                const claimToken = requiredClaimToken(b.claimToken);
                if (!this.store.failClaimed(b.id, b.error ?? 'ipc fail', now, claimToken)) {
                    return this.json(res, 409, { error: 'mailbox claim is no longer owned by this worker', code: 'claim_conflict' });
                }
                return this.json(res, 200, { ok: true });
            }
            const statusPathMatch = req.method === 'GET' ? /^\/mailbox\/status\/([^/]+)$/.exec(url.pathname) : null;
            if (req.method === 'GET' && (url.pathname === '/mailbox/status' || statusPathMatch)) {
                const id = statusPathMatch ? decodeURIComponent(statusPathMatch[1] ?? '') : url.searchParams.get('id') ?? '';
                const message = this.messageInRuntime(id);
                if (!message)
                    return this.json(res, 404, { error: 'not found' });
                if (statusPathMatch) {
                    return this.json(res, 200, legacyMailboxMessage(message));
                }
                const s = this.store.getStatus(id);
                return s ? this.json(res, 200, s) : this.json(res, 404, { error: 'not found' });
            }
            if (req.method === 'GET' && url.pathname === '/mailbox/list') {
                const type = url.searchParams.get('type') ?? undefined;
                const legacy = type !== undefined;
                const rawStatus = url.searchParams.get('status') ?? undefined;
                const statusValue = legacyMailboxStatus(rawStatus);
                if (rawStatus !== undefined && statusValue === undefined)
                    throw new Error('invalid status');
                const directionValue = url.searchParams.get('direction') ?? undefined;
                if (directionValue !== undefined && !DIRECTIONS.has(directionValue)) {
                    throw new Error('invalid direction');
                }
                const got = this.store.list({
                    status: statusValue,
                    handler: url.searchParams.get('handler') ?? undefined,
                    runtimeNamespace: this.resolveRuntimeNamespace(url.searchParams.get('runtimeNamespace') ?? undefined),
                    type,
                    direction: directionValue,
                    newestFirst: legacy,
                    offset: optionalQueryInteger(url, 'offset'),
                    limit: optionalQueryInteger(url, 'limit') ?? 200,
                });
                return this.json(res, 200, {
                    messages: legacy ? got.map(legacyMailboxMessage) : got,
                    count: got.length,
                });
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
    resolveSendNamespace(body) {
        const bound = this.runtimeNamespace;
        if (bound === undefined)
            return body.runtimeNamespace;
        const requested = body.runtimeNamespace;
        if (requested !== undefined && (typeof requested !== 'string' || requested !== bound)) {
            throw new Error('runtimeNamespace does not match the IPC server namespace');
        }
        const channel = body.channel;
        if (channel !== undefined && (typeof channel !== 'string'
            || (channel !== 'evomap-hub' && channel !== bound))) {
            throw new Error('channel does not match the IPC server namespace');
        }
        return bound;
    }
    resolveRuntimeNamespace(requested) {
        if (requested !== undefined && typeof requested !== 'string') {
            throw new Error('runtimeNamespace must be a string');
        }
        const bound = this.runtimeNamespace;
        if (bound === undefined)
            return requested;
        if (requested !== undefined && requested !== bound) {
            throw new Error('runtimeNamespace does not match the IPC server namespace');
        }
        return bound;
    }
    messageInRuntime(id) {
        const message = this.store.getById(id);
        if (this.runtimeNamespace !== undefined && message?.runtimeNamespace !== this.runtimeNamespace)
            return undefined;
        return message;
    }
    canMutateMessage(id) {
        return this.messageInRuntime(id) !== undefined;
    }
    json(res, code, body) {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    }
}
export function legacyMailboxMessage(message) {
    return {
        id: message.id,
        message_id: message.id,
        channel: message.runtimeNamespace === 'default' ? 'evomap-hub' : message.runtimeNamespace,
        direction: message.direction,
        type: message.type,
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
function legacyMailboxStatus(value) {
    if (value === undefined)
        return undefined;
    if (STATUSES.has(value))
        return value;
    if (value === 'delivered' || value === 'synced' || value === 'acked')
        return 'done';
    if (value === 'rejected')
        return 'failed';
    return undefined;
}