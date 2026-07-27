// Learning Ops packet upload (slice 3) — the adapter half of core's LearningPacketSink port.
// Maps a local LearningPacketDraft (learning_packet.v0, built by evolver-core/trace) onto the hub's
// `POST /api/learning-packets` ingest contract (strict zod schema, requireAuth Bearer token).
//
// Deliberately NOT built on HubFetch: that helper injects sender_id/credential fields into every POST body
// (the /a2a envelope convention), which the strict learning-packets schema rejects. This sink authenticates
// via the injected AuthProvider (Authorization header only) and sends exactly the schema's fields.
import { createHash } from 'node:crypto';
import { assertHubUrlSecure, isHubUnreachableError } from './hubFetch.js';
/** Hub traceEvents array cap (createLearningPacketSchema). Extra events are dropped, noted in metadata. */
export const HUB_TRACE_EVENTS_MAX = 100;
/** Hub failureCategory is a closed enum; runtime failureKind is looser. Only the sure mapping is direct. */
function failureCategoryFor(failureKind) {
    if (failureKind === null)
        return undefined;
    if (failureKind === 'permission_denied')
        return 'permission_error';
    if (failureKind === 'timeout' || failureKind === 'non_zero_exit' || failureKind === 'invalid_output')
        return 'tool_error';
    return 'other';
}
function outcomeStatusFor(status) {
    if (status === 'success')
        return 'succeeded';
    if (status === 'failed')
        return 'failed';
    return undefined;
}
/** Deterministic content hash over the draft body (hub contentHash column, dedup aid). */
export function learningPacketContentHash(draft) {
    return `sha256:${createHash('sha256').update(JSON.stringify(draft)).digest('hex')}`;
}
/**
 * Auth headers for the strict learning-packets routes (requireAuth reads Authorization only).
 * A legacy body credential (bodyFields.node_secret) is promoted to Bearer — the strict schemas
 * reject extra body fields, so credentials must never ride in the body here.
 */
export async function learningOpsAuthHeaders(auth, method, path) {
    const signed = await auth.authenticate({ method, path });
    const headers = { 'content-type': 'application/json', ...(signed.headers ?? {}) };
    const bodySecret = signed.bodyFields?.['node_secret'];
    if (headers['authorization'] === undefined && bodySecret !== undefined)
        headers['authorization'] = `Bearer ${String(bodySecret)}`;
    return headers;
}
/** Map a core draft to the hub createLearningPacket body. Exported for tests and for the private adapter to reuse. */
export function learningPacketWireBody(draft, nodeId) {
    const truncated = draft.trajectory.length > HUB_TRACE_EVENTS_MAX;
    const events = draft.trajectory.slice(0, HUB_TRACE_EVENTS_MAX);
    const outcomeStatus = outcomeStatusFor(draft.evaluation.outcomeStatus);
    const failureCategory = failureCategoryFor(draft.evaluation.failureCategory);
    return {
        schemaVersion: draft.schemaVersion,
        status: 'draft',
        sourceRepo: draft.source.repo,
        sourceRun: draft.source.run,
        sourceType: draft.source.type,
        sourceId: draft.source.id,
        // One packet per run: the run id IS the idempotency key, so a retried submit dedups hub-side (409).
        idempotencyKey: `${draft.source.repo}:${draft.source.run}`,
        contentHash: learningPacketContentHash(draft),
        ...(nodeId ? { nodeId } : {}),
        ...(outcomeStatus ? { outcomeStatus } : {}),
        // evaluation fill-in (slice 6): a non-placeholder evaluation carries the runtime's external verifier
        // ('automated_test' is in the hub VERIFIERS enum); passed/score details ride inside payload.evaluation.
        ...(draft.evaluation.verifier !== null ? { verifier: draft.evaluation.verifier } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        ...(draft.task.summary !== null ? { summary: draft.task.summary } : {}),
        payload: {
            task: draft.task,
            context: draft.context,
            artifacts: draft.artifacts,
            evaluation: draft.evaluation,
            governance: draft.governance,
        },
        metadata: {
            ...(truncated ? { traceEventsTruncated: true, traceEventsTotal: draft.trajectory.length } : {}),
            ...(draft.evaluation.failureCategory !== null ? { runtimeFailureKind: draft.evaluation.failureCategory } : {}),
        },
        redactionStatus: draft.governance.redactionStatus,
        consentStatus: draft.governance.consentStatus,
        retentionPolicy: draft.governance.retentionPolicy,
        traceEvents: events.map((e) => ({
            eventId: e.eventId,
            schemaVersion: e.schemaVersion,
            eventType: e.eventType,
            occurredAt: e.occurredAt,
            traceId: e.traceId,
            ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
            ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
            sequence: e.sequence,
            payload: e.payload,
            metadata: e.metadata,
        })),
    };
}
/**
 * LearningPacketSink implementation against the public hub Learning Ops ingest API. Best-effort by
 * contract: every failure returns { accepted: false, reason } (never throws) — the runtime treats packet
 * delivery as observability, so a hub outage must never affect a task verdict. A 409 duplicate_source is
 * reported as accepted (the packet is already there; the idempotency key did its job).
 */
export class HubLearningPacketSink {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async submit(draft) {
        try {
            const url = `${this.opts.baseUrl}/api/learning-packets`;
            assertHubUrlSecure(url);
            const headers = await learningOpsAuthHeaders(this.opts.auth, 'POST', '/api/learning-packets');
            const res = await this.opts.fetchFn(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(learningPacketWireBody(draft, this.opts.nodeId?.())),
            });
            if (res.status === 201) {
                const body = await res.json().catch(() => null);
                const packet = body && typeof body === 'object' ? body.packet : undefined;
                return { accepted: true, ...(typeof packet?.id === 'string' ? { reason: packet.id } : {}) };
            }
            if (res.status === 409)
                return { accepted: true, reason: 'duplicate_source' };
            const text = await res.text().catch(() => '');
            return { accepted: false, reason: `hub ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
        }
        catch (e) {
            if (isHubUnreachableError(e))
                return { accepted: false, reason: 'hub_unreachable' };
            return { accepted: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
}
/** Fan-out: always deliver to `primary` (local file record), then best-effort to `secondary` (hub upload).
 *  The composite result reflects the PRIMARY sink — the local record is the durability guarantee. */
export class TeeLearningPacketSink {
    primary;
    secondary;
    constructor(primary, secondary) {
        this.primary = primary;
        this.secondary = secondary;
    }
    async submit(draft) {
        const primary = await this.primary.submit(draft);
        try {
            await this.secondary.submit(draft);
        }
        catch { /* secondary is best-effort by contract; sinks should not throw, but never let one break the record */ }
        return primary;
    }
}