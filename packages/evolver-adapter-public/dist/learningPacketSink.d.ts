import type { hub, trace } from '@evomap/evolver-core';
import { type FetchLike } from './hubFetch.js';
/** Hub traceEvents array cap (createLearningPacketSchema). Extra events are dropped, noted in metadata. */
export declare const HUB_TRACE_EVENTS_MAX = 100;
export interface HubLearningPacketSinkOptions {
    baseUrl: string;
    auth: hub.AuthProvider;
    fetchFn: FetchLike;
    /** Optional node identity recorded on the packet (hub nodeId column). */
    nodeId?: () => string | undefined;
}
/**
 * Deterministic content hash over the draft body (hub contentHash column, dedup aid).
 *
 * Bare 64-hex, NOT `sha256:`-prefixed: the hub column is VarChar(64), so a prefixed
 * digest is 71 chars and every upload failed with a Prisma "value too long" 500. The
 * hub schema now rejects over-64 at validation, which would make it a 400 instead —
 * either way the algorithm is fixed at sha256 by this contract, so the prefix carried
 * no information.
 */
export declare function learningPacketContentHash(draft: trace.LearningPacketDraft): string;
/**
 * Auth headers for the strict learning-packets routes (requireAuth reads Authorization only).
 * A legacy body credential (bodyFields.node_secret) is promoted to Bearer — the strict schemas
 * reject extra body fields, so credentials must never ride in the body here.
 */
export declare function learningOpsAuthHeaders(auth: hub.AuthProvider, method: string, path: string): Promise<Record<string, string>>;
/** Map a core draft to the hub createLearningPacket body. Exported for tests and for the private adapter to reuse. */
export declare function learningPacketWireBody(draft: trace.LearningPacketDraft, nodeId?: string): Record<string, unknown>;
/**
 * LearningPacketSink implementation against the public hub Learning Ops ingest API. Best-effort by
 * contract: every failure returns { accepted: false, reason } (never throws) — the runtime treats packet
 * delivery as observability, so a hub outage must never affect a task verdict. A 409 duplicate_source is
 * reported as accepted (the packet is already there; the idempotency key did its job).
 */
export declare class HubLearningPacketSink implements trace.LearningPacketSink {
    private readonly opts;
    constructor(opts: HubLearningPacketSinkOptions);
    submit(draft: trace.LearningPacketDraft): Promise<trace.LearningPacketSubmitResult>;
}
/** Fan-out: always deliver to `primary` (local file record), then best-effort to `secondary` (hub upload).
 *  The composite result reflects the PRIMARY sink — the local record is the durability guarantee. */
export declare class TeeLearningPacketSink implements trace.LearningPacketSink {
    private readonly primary;
    private readonly secondary;
    constructor(primary: trace.LearningPacketSink, secondary: trace.LearningPacketSink);
    submit(draft: trace.LearningPacketDraft): Promise<trace.LearningPacketSubmitResult>;
}