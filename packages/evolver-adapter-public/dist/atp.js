import { createHash } from 'node:crypto';
import { ATP_EXECUTION_MODES, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES, } from '@evomap/atp-sdk';
import { HubClientError, HubFetch } from './hubFetch.js';
export { ATP_EXECUTION_MODES, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES, };
export class AtpHubClient {
    opts;
    http;
    constructor(opts) {
        this.opts = opts;
        this.http = new HubFetch({ baseUrl: opts.baseUrl, auth: opts.auth, fetchFn: opts.fetchFn, senderId: opts.senderId });
    }
    /**
     * The node every call of this client speaks for. Ownership checks must read it from
     * here rather than resolve their own: a filter that answers about a different node
     * than the one submitting is how work gets skipped or handed to the wrong claimant.
     */
    nodeId() {
        return this.opts.senderId();
    }
    /**
     * The node id every task-protocol write is made under. These calls take and hand back
     * work on one node's behalf, so a request that cannot name that node is not a weaker
     * request — it is an unattributable one, and the Hub should never be asked to guess.
     */
    requireSenderId(call) {
        const senderId = this.opts.senderId();
        if (!senderId)
            throw new Error(`${call} needs a node identity: this client cannot say which node it authenticates as`);
        return senderId;
    }
    async placeOrder(opts) {
        const capabilities = opts.capabilities.map((s) => String(s).trim()).filter(Boolean);
        if (capabilities.length === 0)
            throw new Error('ATP order requires at least one capability');
        const body = {
            capabilities,
            budget: clampBudget(opts.budget),
            routing_mode: enumValue(opts.routingMode ?? 'fastest', ATP_ROUTING_MODES, 'routingMode'),
            verify_mode: enumValue(opts.verifyMode ?? 'auto', ATP_VERIFY_MODES, 'verifyMode'),
        };
        if (opts.question !== undefined)
            body['question'] = opts.question;
        if (opts.signals !== undefined)
            body['signals'] = opts.signals;
        if (opts.minReputation !== undefined)
            body['min_reputation'] = opts.minReputation;
        return this.callResult('POST', '/a2a/atp/order', body);
    }
    async submitDelivery(orderId, proofPayload = {}) {
        return this.callResult('POST', '/a2a/atp/deliver', {
            order_id: nonEmpty(orderId, 'orderId'),
            proof_payload: proofPayload,
        });
    }
    async verifyDelivery(orderId, action = 'confirm') {
        return this.callResult('POST', '/a2a/atp/verify', {
            order_id: nonEmpty(orderId, 'orderId'),
            action: enumValue(action, ATP_VERIFY_ACTIONS, 'action'),
        });
    }
    async settleOrder(orderId) {
        return this.callResult('POST', '/a2a/atp/settle', { order_id: nonEmpty(orderId, 'orderId') });
    }
    async disputeOrder(orderId, reason) {
        return this.callResult('POST', '/a2a/atp/dispute', {
            order_id: nonEmpty(orderId, 'orderId'),
            reason: nonEmpty(reason, 'reason'),
        });
    }
    async getMerchantTier(nodeId) {
        const nid = nodeId ?? this.opts.senderId();
        return this.callResult('GET', '/a2a/atp/merchant/tier', undefined, nid ? { node_id: nid } : undefined);
    }
    async getOrderStatus(orderId) {
        return this.callResult('GET', `/a2a/atp/order/${encodeURIComponent(nonEmpty(orderId, 'orderId'))}`);
    }
    async listProofs(opts = {}) {
        const query = {
            node_id: opts.nodeId ?? this.opts.senderId(),
            role: opts.role === undefined ? undefined : enumValue(opts.role, ATP_ROLES, 'role'),
            status: opts.status === undefined ? undefined : enumValue(opts.status, ATP_PROOF_STATUSES, 'status'),
            limit: opts.limit === undefined ? undefined : clampLimit(opts.limit),
        };
        return this.callResult('GET', '/a2a/atp/proofs', undefined, query);
    }
    async getAtpPolicy() {
        return this.callResult('GET', '/a2a/atp/policy');
    }
    async listMyTasks(limit, nodeId) {
        const nid = nodeId ?? this.opts.senderId();
        const query = {
            node_id: nid,
            limit: limit === undefined ? undefined : clampLimit(limit),
        };
        return this.callResult('GET', '/a2a/task/my', undefined, query);
    }
    /**
     * Available tasks the Hub is willing to hand this node. The Hub answers the
     * A2A `fetch` envelope with a `tasks` array; `tasks_only` keeps it from
     * piggybacking anything else onto the response.
     */
    async fetchTasks(opts = {}) {
        // The node these calls speak for is the one the credentials belong to. Letting a
        // caller name a different node_id would ask the Hub to act on someone else's behalf.
        const nid = this.requireSenderId('fetchTasks');
        return this.callResult('POST', '/a2a/fetch', {
            protocol: 'gep-a2a',
            protocol_version: '1.0.0',
            message_type: 'fetch',
            message_id: opts.messageId ?? AtpHubClient.envelopeIdFor(nid, opts),
            sender_id: nid,
            timestamp: new Date().toISOString(),
            payload: {
                tasks_only: true,
                include_tasks: true,
                ...(opts.limit === undefined ? {} : { limit: clampLimit(opts.limit) }),
                ...(opts.questions && opts.questions.length > 0 ? { questions: opts.questions } : {}),
            },
        });
    }
    /**
     * The id the Hub dedupes envelopes on. A plain read has no side effect and gets a fresh
     * id; a fetch carrying `questions` can create bounties, so its id is derived from the
     * questions themselves — retrying the same ask after a lost response repeats the id and
     * the Hub recognises it, instead of posting the same question a second time.
     */
    static envelopeIdFor(senderId, opts) {
        const questions = opts.questions;
        if (!questions || questions.length === 0)
            return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Canonical, or the same ask written two ways hashes two ways and the dedupe is lost:
        // keys in a fixed order, signals in a fixed order, questions in a fixed order.
        const canonical = questions
            .map((q) => JSON.stringify([q.question, q.amount ?? null, [...(q.signals ?? [])].sort()]))
            .sort();
        // `limit` rides along, as the wire sees it: the same questions asked with a different
        // page size is a different request, but two raw limits that clamp to the same value
        // ARE the same request and a retry between them must keep its id.
        const limit = opts.limit === undefined ? null : clampLimit(opts.limit);
        return `msg_q_${createHash('sha256').update(JSON.stringify([senderId ?? '', canonical, limit])).digest('hex').slice(0, 32)}`;
    }
    /**
     * Take a task. `commitmentDeadline` is the promise the node makes back: the
     * Hub holds the task for this node until then, so a caller that cannot
     * finish in time must not send one it cannot keep.
     */
    async claimTask(taskId, opts = {}) {
        return this.callResult('POST', '/a2a/task/claim', {
            task_id: nonEmpty(taskId, 'taskId'),
            node_id: this.requireSenderId('claimTask'),
            ...(opts.commitmentDeadline ? { commitment_deadline: opts.commitmentDeadline } : {}),
        });
    }
    /** Hand a claimed task back to the Hub with the asset the work produced. */
    async completeTask(taskId, assetId) {
        return this.callResult('POST', '/a2a/task/complete', {
            task_id: nonEmpty(taskId, 'taskId'),
            asset_id: nonEmpty(assetId, 'assetId'),
            node_id: this.requireSenderId('completeTask'),
        });
    }
    /**
     * Take a deferred worker task. The Hub gates this channel separately from
     * `/a2a/task/claim` and answers `worker_disabled` while it is closed.
     */
    async claimWorkerTask(taskId) {
        return this.callResult('POST', '/a2a/work/claim', {
            task_id: nonEmpty(taskId, 'taskId'),
            node_id: this.requireSenderId('claimWorkerTask'),
        });
    }
    /** Hand a worker task back with the asset it produced. */
    async completeWorkerTask(taskId, assetId) {
        return this.callResult('POST', '/a2a/work/complete', {
            task_id: nonEmpty(taskId, 'taskId'),
            asset_id: nonEmpty(assetId, 'assetId'),
            node_id: this.requireSenderId('completeWorkerTask'),
        });
    }
    async callResult(method, path, body, query) {
        try {
            const raw = await this.http.call(method, path, body, query);
            return normalizeAtpResult(raw);
        }
        catch (err) {
            if (err instanceof HubClientError) {
                return normalizeAtpError(err.status, err.body);
            }
            throw err;
        }
    }
}
export function normalizeAtpResult(raw) {
    const rec = asRecord(raw);
    const data = rec ? (rec['data'] ?? rec['payload'] ?? raw) : raw;
    if (typeof rec?.['ok'] === 'boolean') {
        if (rec['ok'])
            return { ok: true, data: data };
        return { ok: false, data: data, error: extractError(raw, 'atp_error') };
    }
    return { ok: true, data: data };
}
function normalizeAtpError(status, raw) {
    const data = asRecord(raw)?.['data'] ?? asRecord(raw)?.['payload'] ?? raw;
    return { ok: false, status, data: data, error: extractError(raw, `hub ${status}`) };
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function extractError(value, fallback) {
    if (typeof value === 'string' && value.trim())
        return value;
    const rec = asRecord(value);
    const payload = asRecord(rec?.['payload']);
    const data = asRecord(rec?.['data']);
    const direct = rec?.['error'] ?? rec?.['message'] ?? payload?.['error'] ?? payload?.['message'] ?? data?.['error'] ?? data?.['message'];
    return typeof direct === 'string' && direct.trim() ? direct : fallback;
}
function enumValue(value, allowed, name) {
    const v = String(value);
    if (!allowed.includes(v)) {
        throw new Error(`invalid ATP ${name}: ${v} (expected ${allowed.join('|')})`);
    }
    return v;
}
function nonEmpty(value, name) {
    const v = String(value ?? '').trim();
    if (!v)
        throw new Error(`ATP ${name} is required`);
    return v;
}
function clampBudget(value) {
    const n = Math.round(Number(value) || 10);
    // budget is a spend cap that goes on the wire: a non-finite value (e.g. `1e400` parses to Infinity)
    // JSON-serializes to `null`, which the hub could read as "no cap". Force a finite positive integer so the
    // wire never carries null/Infinity/NaN as a budget. (An explicit upper MAX_BUDGET ceiling is a separate
    // policy decision for the hub/maintainer; this only guarantees finiteness.)
    return Number.isFinite(n) ? Math.max(1, n) : 10;
}
function clampLimit(value) {
    const n = Math.round(Number(value) || 20);
    return Math.max(1, Math.min(100, n));
}