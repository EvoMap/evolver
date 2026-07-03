import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { events as ev, assetstore, mailbox as mb, ops } from '@evomap/evolver-core';
import { CONSOLE_HTML } from './console.js';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** The empty value summary (zero entries) — the shape /api/value returns when no provider is wired, so the card
 *  always gets a valid ValueSummary to render. Derived from core's aggregator to stay shape-identical. */
const EMPTY_VALUE_SUMMARY = ops.valueSummary([]);
/** Constant-time token compare (avoids leaking the token via timing). */
function tokenEq(a, b) {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function positiveIntParam(value) {
    if (value === null || value.trim() === '')
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
const HUMAN_ACTIONS = {
    observe: 'actor.human.observe', nudge: 'actor.human.nudge', intervene: 'actor.human.intervene', teach: 'actor.human.teach',
};
/**
 * WebUI 控台(M7): 可观测 + 保活. node:http + 自包含 HTML, 仅绑 loopback.
 * 复用 core events/reports 报表 + assetstore + mailbox; 人工操作 Observe/Nudge/Intervene/Teach 走 ingest(actor.kind=human).
 */
export class WebUIServer {
    deps;
    server;
    ingestor;
    host;
    now;
    actorId;
    /** Review ledger backing the human-review queue. Undefined when no LocalJsonlProvider store is available. */
    review;
    /** Token guarding /api/*; printed by the launcher, supplied by the browser via ?token= or Bearer. */
    token;
    constructor(deps) {
        this.deps = deps;
        this.host = deps.host ?? '127.0.0.1';
        this.now = deps.now ?? (() => Date.now());
        this.actorId = deps.actorId ?? 'console';
        this.token = deps.token ?? randomBytes(16).toString('hex');
        this.ingestor = deps.ingestor ?? new ev.Ingestor({ path: deps.eventsPath });
        // Co-locate the review ledger with the store so the queue reads the same review.jsonl the CLI writes.
        this.review = deps.review ?? (deps.store instanceof assetstore.LocalJsonlProvider ? new assetstore.ReviewLedger(deps.store.baseDir) : undefined);
        this.server = createServer((req, res) => { void this.handle(req, res); });
    }
    listen(port = 0) {
        return new Promise((resolve) => this.server.listen(port, this.host, () => {
            const a = this.server.address();
            resolve(a && typeof a === 'object' ? a.port : port);
        }));
    }
    close() { return new Promise((res, rej) => this.server.close((e) => (e ? rej(e) : res()))); }
    async handle(req, res) {
        try {
            if (!LOOPBACK.has(req.socket.remoteAddress ?? ''))
                return this.send(res, 403, 'text/plain', 'non-loopback');
            const url = new URL(req.url ?? '/', 'http://localhost');
            const p = url.pathname;
            // Root HTML is a static shell (no data) → served freely; it reads ?token= and authenticates the /api calls.
            if (p === '/' || p === '/index.html')
                return this.send(res, 200, 'text/html; charset=utf-8', CONSOLE_HTML);
            // Everything else (all /api/*) requires the token — accepted via Bearer header or ?token= (browser convenience).
            const auth = req.headers['authorization'] ?? '';
            const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') ?? '');
            if (!tokenEq(supplied, this.token))
                return this.send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
            if (p === '/api/status')
                return this.json(res, ev.statusReport(ev.readEvents(this.deps.eventsPath)));
            if (p === '/api/cycles')
                return this.json(res, ev.listCycles(ev.readEvents(this.deps.eventsPath)));
            if (p === '/api/cycle')
                return this.json(res, ev.showCycle(ev.readEvents(this.deps.eventsPath), url.searchParams.get('id') ?? ''));
            if (p === '/api/narrative') {
                return this.json(res, ev.buildNarrativeSnapshot(ev.readEvents(this.deps.eventsPath), { limit: positiveIntParam(url.searchParams.get('limit')) }));
            }
            if (p === '/api/triggers')
                return this.json(res, ev.listTriggers(ev.readEvents(this.deps.eventsPath)));
            if (p === '/api/daily-summary') {
                const day = url.searchParams.get('day') ?? new Date(this.now()).toISOString().slice(0, 10);
                return this.json(res, ev.dailySummary(ev.readEvents(this.deps.eventsPath), day));
            }
            if (p === '/api/value') {
                // Thin pass-through: the provider (composition layer) owns prices + traces; the server only scopes the
                // window and serializes. No provider wired → an empty summary so the card renders "no savings yet".
                const window = ops.windowFromSpec(url.searchParams.get('window') ?? undefined, this.now());
                const summary = this.deps.valueSummary ? this.deps.valueSummary(window) : EMPTY_VALUE_SUMMARY;
                return this.json(res, summary);
            }
            if (p === '/api/mailbox') {
                if (!this.deps.mailbox)
                    return this.json(res, { pending: 0, dlq: 0, messages: [] });
                return this.json(res, {
                    pending: this.deps.mailbox.countByStatus('pending'),
                    dlq: this.deps.mailbox.dlq().length,
                    messages: this.deps.mailbox.list({ limit: 50 }).map((m) => ({ id: m.id, type: m.type, status: m.status, handler: m.handler })),
                });
            }
            if (p === '/api/assets') {
                if (!this.deps.store)
                    return this.json(res, []);
                const kind = url.searchParams.get('kind');
                return this.json(res, (await this.deps.store.list(kind ?? undefined, 100)).map((a) => ({ asset_id: a.asset_id, type: a.type, summary: a.summary })));
            }
            if (p === '/api/review' && req.method === 'POST') {
                // Approve/reject a quarantined draft from the console: the SAME gate the CLI uses — flip the ReviewLedger
                // state + record an audited actor.human.review.* event. Loopback + bearer already guard the route; actor is
                // the console operator. Resolve the target by asset_id directly (no list, never truncated), or by logical id.
                if (!this.deps.store || !this.review)
                    return this.send(res, 400, 'application/json', JSON.stringify({ error: 'no review store wired' }));
                const b = (await this.readJson(req));
                if (b.action !== 'approve' && b.action !== 'reject')
                    return this.send(res, 400, 'application/json', JSON.stringify({ error: 'action must be approve or reject' }));
                const target = String(b.gene ?? '');
                const g = (await this.deps.store.get(target)) ?? (await this.deps.store.list('Gene', 1000)).find((x) => String(x['id']) === target) ?? null;
                // Only a Gene is reviewable: store.get resolves ANY asset by id, so guard the kind (a Capsule's asset_id
                // must not be approvable, which would emit a review event with a misleading geneId — matches CLI runReview).
                if (!g || g.type !== 'Gene')
                    return this.send(res, 404, 'application/json', JSON.stringify({ error: 'gene not found' }));
                const assetId = String(g.asset_id);
                const geneId = typeof g['id'] === 'string' ? String(g['id']) : assetId;
                const reason = (b.reason ?? '').trim() || `${b.action === 'approve' ? 'approved' : 'rejected'} via console`;
                if (b.action === 'approve')
                    this.review.approve(assetId, this.actorId, reason);
                else
                    this.review.reject(assetId, this.actorId, reason);
                const root = await this.ingestor.ingest({
                    type: b.action === 'approve' ? 'actor.human.review.approve' : 'actor.human.review.reject',
                    actor: { kind: 'human', id: this.actorId },
                    human: { title: `${b.action} gene ${geneId}`, severity: 'info' },
                    payload: { geneId, assetId, reason },
                });
                return this.json(res, { ok: true, geneId, assetId, state: b.action === 'approve' ? 'approved' : 'rejected', seq: root.seq });
            }
            if (p === '/api/review') {
                if (!this.deps.store)
                    return this.json(res, []);
                // The human-review queue. The set of REVIEWED (quarantined/approved/rejected) assets comes from the review
                // LEDGER — the authoritative, complete source — so a pending draft is never dropped behind a store.list
                // cutoff (Bugbot). Gene metadata is resolved per asset_id from the store. Default-eligible genes (no ledger
                // record) are appended as context from a bounded list. Pending (quarantined) sorts first. Read-only here.
                // Match the CLI's semantics exactly: only the unattended distill-observer counts as "auto-drafted"
                // (manual `ingest --distill` / skill2gep emit gene.distilled with a different source and are NOT auto).
                const autoDrafted = new Set(this.ingestor.readAll()
                    .filter((e) => e.type === 'gene.distilled' && e.payload?.['source'] === 'distill-observer')
                    .map((e) => String(e.payload?.['assetId'] ?? ''))
                    .filter(Boolean));
                const order = { quarantined: 0, rejected: 1, approved: 2, eligible: 3 };
                const toRow = (assetId, state, g) => ({
                    geneId: g && typeof g['id'] === 'string' ? String(g['id']) : assetId,
                    assetId, state,
                    category: g ? String(g['category'] ?? '') : '',
                    summary: g ? String(g.summary ?? '') : '',
                    autoDrafted: autoDrafted.has(assetId),
                });
                const records = this.review ? this.review.records() : [];
                const decided = new Set(records.map((r) => r.assetId));
                const reviewed = await Promise.all(records.map(async (r) => toRow(r.assetId, r.state, await this.deps.store.get(r.assetId))));
                const eligible = (await this.deps.store.list('Gene', 1000))
                    .filter((g) => !decided.has(String(g.asset_id)))
                    .map((g) => toRow(String(g.asset_id), 'eligible', g));
                const rows = [...reviewed, ...eligible].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
                return this.json(res, rows);
            }
            if (p === '/api/action' && req.method === 'POST') {
                const b = (await this.readJson(req));
                const type = HUMAN_ACTIONS[b.action ?? ''];
                if (!type)
                    return this.send(res, 400, 'application/json', JSON.stringify({ error: 'unknown action' }));
                const root = await this.ingestor.ingest({
                    type, actor: { kind: 'human', id: this.actorId },
                    human: { title: b.title ?? b.action ?? 'human action' },
                    payload: { note: b.note ?? '', ...(b.cycleId ? { cycleId: b.cycleId } : {}) },
                });
                return this.json(res, { ok: true, seq: root.seq });
            }
            return this.send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
        }
        catch (e) {
            return this.send(res, 500, 'application/json', JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
    }
    readJson(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => { size += c.length; if (size > 256 * 1024)
                reject(new Error('body too large'));
            else
                chunks.push(c); });
            req.on('end', () => { try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            }
            catch {
                reject(new Error('invalid json'));
            } });
            req.on('error', reject);
        });
    }
    json(res, body) { this.send(res, 200, 'application/json', JSON.stringify(body)); }
    send(res, code, ct, body) { res.writeHead(code, { 'content-type': ct }); res.end(body); }
}