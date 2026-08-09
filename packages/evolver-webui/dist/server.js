import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { events as ev, assetstore, mailbox as mb, ops, util } from '@evomap/evolver-core';
import { CONSOLE_HTML } from './console.js';
import { EventSnapshotCache, fileEventSnapshotSource } from './eventSnapshot.js';
import { listLineageAssets, loadAssetLineage } from './assetLineage.js';
import { eventListRelations } from './observabilityRelations.js';
import { redactDiagnosticText, sanitizeDiagnosticValue } from './diagnosticSanitize.js';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DASHBOARD_COOKIE = 'evolver_dashboard';
/** The empty value summary (zero entries) — the shape /api/value returns when no provider is wired, so the card
 *  always gets a valid ValueSummary to render. Derived from core's aggregator to stay shape-identical. */
const EMPTY_VALUE_SUMMARY = ops.valueSummary([]);
const MEMORY_GRAPH_REASON_PATTERN = /scoped memory-graph outcome ([+-]\d+\.\d{3}) \(boost=([+-]?\d+\.\d{2})\)/;
const MEMORY_GRAPH_RECOVERY_STATES = new Set(['healthy', 'degraded', 'recovered', 'empty']);
function boundedMemoryGraphCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.min(1_000_000, Math.floor(count)) : 0;
}
function sanitizeMemoryGraphReason(value) {
    if (typeof value !== 'string')
        return undefined;
    const match = MEMORY_GRAPH_REASON_PATTERN.exec(value);
    if (!match?.[1] || !match[2])
        return undefined;
    const outcome = Number(match[1]);
    const boost = Number(match[2]);
    if (!Number.isFinite(outcome) || !Number.isFinite(boost) || Math.abs(outcome) > 1 || Math.abs(boost) > 1)
        return undefined;
    return `scoped memory-graph outcome ${match[1]} (boost=${match[2]})`;
}
function sanitizeMemoryGraphStatus(value) {
    const raw = value;
    const recovery = MEMORY_GRAPH_RECOVERY_STATES.has(raw['recovery'])
        ? raw['recovery']
        : 'degraded';
    const selectionReason = sanitizeMemoryGraphReason(raw['selectionReason']);
    return {
        recovery,
        compactedRecords: boundedMemoryGraphCount(raw['compactedRecords']),
        activeRecords: boundedMemoryGraphCount(raw['activeRecords']),
        corruptLines: boundedMemoryGraphCount(raw['corruptLines']),
        oversizedLines: boundedMemoryGraphCount(raw['oversizedLines']),
        oversizedFiles: boundedMemoryGraphCount(raw['oversizedFiles']),
        archives: boundedMemoryGraphCount(raw['archives']),
        ...(selectionReason ? { selectionReason } : {}),
    };
}
/** Constant-time token compare (avoids leaking the token via timing). */
function tokenEq(a, b) {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function cookieValue(header, name) {
    for (const part of (header ?? '').split(';')) {
        const at = part.indexOf('=');
        if (at < 0 || part.slice(0, at).trim() !== name)
            continue;
        return part.slice(at + 1).trim();
    }
    return '';
}
function positiveIntParam(value) {
    if (value === null || value.trim() === '')
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
function requireGet(req, res) {
    if (req.method === 'GET')
        return true;
    res.writeHead(405, { allow: 'GET', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return false;
}
const STABLE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function boundedString(value, maxLength = 256) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}
function safeRunSummary(value) {
    const runId = boundedString(value.runId, 128);
    const workflowId = boundedString(value.workflowId, 128);
    if (!STABLE_WORKFLOW_ID.test(runId) || !STABLE_WORKFLOW_ID.test(workflowId))
        return null;
    const currentStep = value.currentStep === null ? null : boundedString(value.currentStep);
    const completedAt = value.completedAt === null ? null : boundedString(value.completedAt, 64);
    return {
        runId,
        workflowId,
        status: boundedString(value.status, 64),
        currentStep,
        createdAt: boundedString(value.createdAt, 64),
        updatedAt: boundedString(value.updatedAt, 64),
        completedAt,
    };
}
function safeHistoryEntry(value) {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 0)
        return null;
    const optional = (candidate, maxLength = 256) => {
        if (candidate === undefined)
            return undefined;
        if (candidate === null)
            return null;
        return boundedString(candidate, maxLength);
    };
    return {
        sequence: value.sequence,
        timestamp: boundedString(value.timestamp, 64),
        type: boundedString(value.type, 128),
        ...(value.status !== undefined ? { status: optional(value.status, 64) } : {}),
        ...(value.stepId !== undefined ? { stepId: optional(value.stepId) } : {}),
        ...(value.executionId !== undefined ? { executionId: optional(value.executionId) } : {}),
        ...(value.gateId !== undefined ? { gateId: optional(value.gateId) } : {}),
        ...(value.attempt !== undefined && (value.attempt === null || (Number.isSafeInteger(value.attempt) && value.attempt >= 0))
            ? { attempt: value.attempt }
            : {}),
        ...(value.actorId !== undefined ? { actorId: optional(value.actorId, 128) } : {}),
        ...(value.errorClass !== undefined ? { errorClass: optional(value.errorClass, 64) } : {}),
    };
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
    provenance;
    /** Token guarding /api/*; supplied by the browser via Bearer, with ?token= retained for compatibility. */
    token;
    launchTicket;
    launchTicketAvailable = true;
    eventSnapshots;
    constructor(deps) {
        this.deps = deps;
        this.host = deps.host ?? '127.0.0.1';
        this.now = deps.now ?? (() => Date.now());
        this.actorId = deps.actorId ?? 'console';
        this.token = deps.token ?? randomBytes(16).toString('hex');
        this.launchTicket = deps.launchTicket ?? randomBytes(16).toString('hex');
        this.eventSnapshots = new EventSnapshotCache(deps.eventSource ?? fileEventSnapshotSource(deps.eventsPath));
        this.ingestor = deps.ingestor ?? new ev.Ingestor({ path: deps.eventsPath });
        // Co-locate the review ledger with the store so the queue reads the same review.jsonl the CLI writes.
        this.review = deps.review ?? (deps.store instanceof assetstore.LocalJsonlProvider ? new assetstore.ReviewLedger(deps.store.baseDir) : undefined);
        this.provenance = deps.provenance ?? (deps.store instanceof assetstore.LocalJsonlProvider ? new assetstore.ProvenanceStore(deps.store.baseDir) : undefined);
        this.server = createServer((req, res) => { void this.handle(req, res); });
    }
    async listen(port = 0) {
        if (port !== 0 && util.isFetchForbiddenPort(port))
            throw new Error('webui_port_blocked');
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const assigned = await this.listenOnce(port);
            if (port !== 0 || !util.isFetchForbiddenPort(assigned))
                return assigned;
            await this.close();
        }
        throw new Error('webui_safe_port_unavailable');
    }
    listenOnce(port) {
        return new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            this.server.once('error', onError);
            this.server.listen(port, this.host, () => {
                this.server.removeListener('error', onError);
                const a = this.server.address();
                resolve(a && typeof a === 'object' ? a.port : port);
            });
        });
    }
    close() {
        return new Promise((resolve, reject) => {
            this.server.close((error) => (error ? reject(error) : resolve()));
            this.server.closeAllConnections();
        });
    }
    async handle(req, res) {
        try {
            if (!LOOPBACK.has(req.socket.remoteAddress ?? ''))
                return this.send(res, 403, 'text/plain', 'non-loopback');
            const url = new URL(req.url ?? '/', 'http://localhost');
            const p = url.pathname;
            if (p === '/launch') {
                if (req.method !== 'GET') {
                    res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain' });
                    res.end('method not allowed');
                    return;
                }
                const ticket = url.searchParams.get('ticket') ?? '';
                if (!this.launchTicketAvailable || !tokenEq(ticket, this.launchTicket)) {
                    return this.send(res, 401, 'text/plain', 'unauthorized');
                }
                this.launchTicketAvailable = false;
                res.writeHead(302, {
                    location: '/',
                    'set-cookie': `${DASHBOARD_COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
                    'cache-control': 'no-store',
                    'referrer-policy': 'no-referrer',
                });
                res.end();
                return;
            }
            // Root HTML is a static shell (no data) → served freely; it reads ?token= and authenticates the /api calls.
            if (p === '/' || p === '/index.html')
                return this.send(res, 200, 'text/html; charset=utf-8', CONSOLE_HTML);
            // Everything else (all /api/*) requires the token — accepted via Bearer header or ?token= (browser convenience).
            const auth = req.headers['authorization'] ?? '';
            const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
            const queryToken = url.searchParams.get('token') ?? '';
            const cookieToken = cookieValue(req.headers.cookie, DASHBOARD_COOKIE);
            const bearerValid = tokenEq(bearer, this.token);
            const queryValid = tokenEq(queryToken, this.token);
            const cookieValid = tokenEq(cookieToken, this.token);
            if (!bearerValid && !queryValid && !cookieValid) {
                return this.send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
            }
            const stateChanging = req.method !== 'GET' && req.method !== 'HEAD';
            if (stateChanging && cookieValid && !bearerValid && !queryValid) {
                const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : '';
                if (!expectedOrigin || req.headers.origin !== expectedOrigin) {
                    return this.send(res, 403, 'application/json', JSON.stringify({ error: 'same_origin_required' }));
                }
                if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
                    return this.send(res, 415, 'application/json', JSON.stringify({ error: 'json_required' }));
                }
            }
            if (p === '/api/status')
                return this.json(res, ev.statusReport(await this.eventSnapshots.read()));
            if (p === '/api/cycles')
                return this.json(res, ev.listCycles(await this.eventSnapshots.read()));
            if (p === '/api/cycle') {
                const cycle = ev.showCycle(await this.eventSnapshots.read(), url.searchParams.get('id') ?? '');
                const safeTimeline = cycle.timeline.map((event) => ({
                    ...event,
                    title: redactDiagnosticText(event.title),
                    ...(event.why ? { why: redactDiagnosticText(event.why) } : {}),
                    ...(event.payload ? { payload: sanitizeDiagnosticValue(event.payload) } : {}),
                }));
                const relationEvents = cycle.timeline.map((event) => ({
                    seq: event.seq, type: event.type, ts: event.ts, payload: event.payload,
                    human: { title: event.title, ...(event.why ? { why: event.why } : {}) },
                }));
                return this.json(res, { ...cycle, timeline: safeTimeline, relations: eventListRelations(relationEvents) });
            }
            if (p === '/api/narrative') {
                return this.json(res, ev.buildNarrativeSnapshot(await this.eventSnapshots.read(), { limit: positiveIntParam(url.searchParams.get('limit')) }));
            }
            if (p === '/api/triggers')
                return this.json(res, ev.listTriggers(await this.eventSnapshots.read()));
            if (p === '/api/evolution-graph') {
                // Read-only projection of the SAME event snapshot the other cards read. The WebUI never re-derives lineage:
                // core owns the projector, the server only bounds the window and serializes the summary + edge list.
                if (!requireGet(req, res))
                    return;
                try {
                    const graph = ops.projectEvolutionGraph(await this.eventSnapshots.read(), {
                        maxEvents: positiveIntParam(url.searchParams.get('maxEvents')),
                    });
                    return this.json(res, {
                        available: true,
                        graphId: graph.graphId,
                        generatedAt: graph.generatedAt,
                        dashboard: graph.dashboard,
                        nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, label: redactDiagnosticText(node.label) })),
                        edges: graph.edges.map((edge) => ({
                            id: edge.id,
                            kind: edge.kind,
                            from: edge.from,
                            to: edge.to,
                            ...(edge.reason ? { reason: redactDiagnosticText(edge.reason) } : {}),
                            ...(edge.metricDelta ? { metricDelta: edge.metricDelta } : {}),
                            provenance: edge.provenance.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
                        })),
                    });
                }
                catch {
                    return this.send(res, 503, 'application/json', JSON.stringify({
                        available: false,
                        error: 'evolution_graph_unavailable',
                    }));
                }
            }
            if (p === '/api/daily-summary') {
                const day = url.searchParams.get('day') ?? new Date(this.now()).toISOString().slice(0, 10);
                return this.json(res, ev.dailySummary(await this.eventSnapshots.read(), day));
            }
            if (p === '/api/value') {
                // Thin pass-through: the provider (composition layer) owns prices + traces; the server only scopes the
                // window and serializes. No provider wired → an empty summary so the card renders "no savings yet".
                const window = ops.windowFromSpec(url.searchParams.get('window') ?? undefined, this.now());
                const summary = this.deps.valueSummary ? this.deps.valueSummary(window, await this.eventSnapshots.read()) : EMPTY_VALUE_SUMMARY;
                return this.json(res, summary);
            }
            if (p === '/api/personality') {
                if (!requireGet(req, res))
                    return;
                return this.json(res, this.deps.personalityDiagnostics
                    ? await this.deps.personalityDiagnostics()
                    : { available: false, error: 'personality_unavailable' });
            }
            if (p === '/api/memory-graph') {
                if (!requireGet(req, res))
                    return;
                if (!this.deps.memoryGraphStatus)
                    return this.json(res, { available: false });
                try {
                    const status = sanitizeMemoryGraphStatus(this.deps.memoryGraphStatus());
                    return this.json(res, { available: true, ...status });
                }
                catch {
                    return this.send(res, 503, 'application/json', JSON.stringify({
                        available: false,
                        error: 'memory_graph_unavailable',
                    }));
                }
            }
            if (p === '/api/logs') {
                if (!requireGet(req, res))
                    return;
                return this.json(res, this.deps.logDiagnostics
                    ? await this.deps.logDiagnostics()
                    : { available: false, error: 'logs_unavailable' });
            }
            if (p === '/api/github-prs') {
                if (!requireGet(req, res))
                    return;
                return this.json(res, this.deps.githubPrDiagnostics
                    ? await this.deps.githubPrDiagnostics()
                    : { available: false, error: 'github_prs_unavailable' });
            }
            if (p === '/api/retention') {
                if (!this.deps.retentionReport)
                    return this.json(res, { available: false });
                try {
                    return this.json(res, { ...this.deps.retentionReport(), available: true });
                }
                catch {
                    return this.send(res, 503, 'application/json', JSON.stringify({
                        available: false,
                        error: 'retention_unavailable',
                    }));
                }
            }
            if (p === '/api/workflows') {
                if (req.method !== 'GET')
                    return this.methodNotAllowed(res, 'GET');
                if (!this.deps.workflow)
                    return this.json(res, { workflows: [] });
                try {
                    const workflows = (await this.deps.workflow.listRuns())
                        .map(safeRunSummary)
                        .filter((run) => run !== null);
                    return this.json(res, { workflows });
                }
                catch {
                    return this.apiError(res, 503, 'workflow_unavailable');
                }
            }
            if (p === '/api/workflow' || p === '/api/workflow/history') {
                if (req.method !== 'GET')
                    return this.methodNotAllowed(res, 'GET');
                const runId = url.searchParams.get('id') ?? '';
                if (!STABLE_WORKFLOW_ID.test(runId))
                    return this.apiError(res, 400, 'invalid_workflow_id');
                if (!this.deps.workflow)
                    return this.apiError(res, 503, 'workflow_unavailable');
                try {
                    if (p === '/api/workflow') {
                        const candidate = await this.deps.workflow.getRun(runId);
                        const run = candidate === null ? null : safeRunSummary(candidate);
                        return run ? this.json(res, { workflow: run }) : this.apiError(res, 404, 'workflow_not_found');
                    }
                    const history = await this.deps.workflow.getHistory(runId);
                    if (history === null)
                        return this.apiError(res, 404, 'workflow_not_found');
                    return this.json(res, {
                        runId,
                        history: history.map(safeHistoryEntry).filter((entry) => entry !== null),
                    });
                }
                catch {
                    return this.apiError(res, 503, 'workflow_unavailable');
                }
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
            if (p === '/api/asset-lineage/assets') {
                if (!requireGet(req, res))
                    return;
                return this.json(res, await listLineageAssets(this.deps.store, {
                    page: positiveIntParam(url.searchParams.get('page')),
                    pageSize: positiveIntParam(url.searchParams.get('pageSize')),
                }));
            }
            if (p === '/api/asset-lineage') {
                if (!requireGet(req, res))
                    return;
                return this.json(res, await loadAssetLineage({
                    store: this.deps.store,
                    events: () => this.eventSnapshots.read(),
                    review: this.review,
                    provenance: this.provenance,
                }, url.searchParams.get('id') ?? '', {
                    page: positiveIntParam(url.searchParams.get('page')),
                    pageSize: positiveIntParam(url.searchParams.get('pageSize')),
                    capsulePage: positiveIntParam(url.searchParams.get('capsulePage')),
                    capsulePageSize: positiveIntParam(url.searchParams.get('capsulePageSize')),
                    eventPage: positiveIntParam(url.searchParams.get('eventPage')),
                    eventPageSize: positiveIntParam(url.searchParams.get('eventPageSize')),
                }));
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
                const autoDrafted = new Set((await this.eventSnapshots.read())
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
        catch {
            return this.send(res, 500, 'application/json', JSON.stringify({ error: 'dashboard_request_failed' }));
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
    apiError(res, code, error) { this.send(res, code, 'application/json', JSON.stringify({ error })); }
    methodNotAllowed(res, allow) {
        res.writeHead(405, { allow, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
    }
    send(res, code, ct, body) { res.writeHead(code, { 'content-type': ct }); res.end(body); }
}