import { type ReferenceScope } from '../reference/guard.js';
import { EventStore, type EventStoreOptions, type EventWriteAdmission } from './eventStore.js';
import type { RawEvent, RootEvent } from './eventSchema.js';
import type { EventSink } from './sink.js';
import { type AuditWriteOptions } from './boundedAudit.js';
import { type ContextDeliveryStatus, type PreparedContextDelivery } from '../ops/geneContextDeliveryJournal.js';
import type { IdempotentEventAdmission, RootOperationTicket } from './rootEventOperations.js';
/** 已知事件类型 (军杰 §9; 可 registerEventType 扩展). */
export declare const EVENT_TYPES: readonly ["cycle.started", "cycle.signals_collected", "cycle.solidified", "cycle.failed", "cycle.aborted", "cycle.heartbeat", "cycle.consumed", "cycle.execution_admitted", "cycle.validation", "decision.gene_selected", "decision.triggered", "decision.suppressed", "personality.selected", "personality.risk_gated", "personality.mutated", "personality.stats_updated", "personality.pivoted", "signals.extracted", "mutation.built", "capsule.produced", "evolution_event.projected", "observer.quarantined", "observer.dead_letter", "actor.human.nudge", "actor.human.intervene", "actor.human.teach", "actor.human.observe", "actor.human.review.approve", "actor.human.review.reject", "actor.human.trust.promote", "actor.human.trust.revoke", "actor.human.source.qualify", "actor.human.sidecar.recover", "gene.distilled", "gene.distill_shadowed", "experience.activity", "experience.operation.requested", "experience.source.recovered", "anti_gene.distilled", "anti_gene.distill_shadowed", "anti_gene.benchmark_result", "anti_gene.rollout_result", "reflection.recorded", "material.batch_ready", "value.reuse_hit", "value.inject", "value.reuse_outcome", "value.recall", "value.gene_context_delivery", "value.gene_context_observation", "execution.binding.created", "execution.started", "execution.decision", "execution.terminal", "execution.recovered", "execution.reference_access", "governance.projection.revoked", "governance.projection.reinstated"];
export type EventType = (typeof EVENT_TYPES)[number];
export declare function registerEventType(t: string): void;
export declare function isKnownEventType(t: string): boolean;
export declare class IngestValidationError extends Error {
    constructor(message: string);
}
export declare class UnknownEventTypeError extends Error {
    readonly type: string;
    constructor(type: string);
}
export type IngestorOptions = (EventStoreOptions | {
    store: EventStore;
}) & {
    sink?: EventSink;
};
/** A receipt for one observation attempt; cancellation alone never proves non-commit. */
export interface ContextObservationReceiptV1 {
    readonly operationId: string;
    readonly outcome: 'committed' | 'not_committed' | 'unknown';
}
export interface ContextObservationOperationV1 {
    readonly version: 1;
    readonly result: Promise<ContextObservationReceiptV1>;
    cancelAndSettle(): Promise<ContextObservationReceiptV1>;
}
/** root_events 的全仓唯一写入口 (军杰 §9.2). EventStore 不对外暴露 (见 public.ts). */
export declare class Ingestor {
    private readonly store;
    readonly referenceScope: ReferenceScope;
    private readonly sink;
    /** Product observation admission. A structural V1 callback cannot attest that
     * it stopped after cancellation: only the ordinary built-in writer owns the
     * append, terminal result and durable readback used by automatic recall.
     * This is a composition check, not a JavaScript sandbox for hostile code
     * already running inside the process. */
    static isBuiltInObservationSink(value: unknown): value is Ingestor;
    constructor(opts: IngestorOptions);
    /**
     * Local delivery audit only, with the authority snapshot already loaded by the bounded selection path.
     * No synchronous constructor/reference read, issue reporter, sink, outbox or detached worker. A returned
     * event confirms append+fsync, not host receipt. Throws/skips never claim a durable receipt.
     */
    static ingestBoundedReceipt(raw: RawEvent, opts: EventStoreOptions & AuditWriteOptions & {
        referenceScope: ReferenceScope;
    }): Promise<RootEvent>;
    ingestBoundedReceipt(raw: RawEvent, options?: AuditWriteOptions): Promise<RootEvent>;
    static prepareContextDelivery(raw: RawEvent, opts: EventStoreOptions & AuditWriteOptions & {
        referenceScope: ReferenceScope;
    }): PreparedContextDelivery;
    prepareContextDelivery(raw: RawEvent, options?: AuditWriteOptions): PreparedContextDelivery;
    /** Async preparation avoids a synchronous RPC child on the bounded product path.
     * The returned confirmation/release capability retains the legacy sync semantics. */
    static prepareContextDeliveryAsync(raw: RawEvent, opts: EventStoreOptions & AuditWriteOptions & {
        referenceScope: ReferenceScope;
    }): Promise<PreparedContextDelivery>;
    prepareContextDeliveryAsync(raw: RawEvent, options?: AuditWriteOptions): Promise<PreparedContextDelivery>;
    static recoverContextDeliveries(opts: EventStoreOptions & AuditWriteOptions & {
        referenceScope: ReferenceScope;
    }): Promise<ContextDeliveryStatus>;
    recoverContextDeliveries(options?: AuditWriteOptions): Promise<ContextDeliveryStatus>;
    static contextDeliveryStatus(path: string): ContextDeliveryStatus;
    /**
     * Start one observation with a stable operation identity. The caller may stop admission,
     * but must await the original operation before releasing its owner or replaying it.
     */
    beginContextObservationV1(raw: RawEvent, attempt: {
        readonly operationId: string;
        readonly signal: AbortSignal;
        readonly deadlineAt?: number;
        readonly expectedPath?: string;
        readonly expectedAlias?: string;
    }): ContextObservationOperationV1;
    /** Diagnostic only: legacy intent has no business identity. Never use this scan to authorize replay. */
    static experienceLegacyAuditStatus(path: string, limit?: number): {
        operationId: string;
        assetId: string;
        action: string;
        proof: "unresolved";
        missingEvidence: "business_operation_identity";
    }[];
    /** Durable experience projection has no external sink replay. The root writer owns exact-once readback. */
    ingestExperienceAuditV1(raw: RawEvent, operationId: string, deadlineAt?: number, expectedNamespace?: string): Promise<RootEvent>;
    /** No dispatch: callers checkpoint this namespace binding before asking for an idempotent root write. */
    prepareIdempotent(raw: RawEvent, admission: IdempotentEventAdmission): Promise<RootOperationTicket>;
    /** Durable root audit only. Replay never re-dispatches a sink or issue reporter. */
    ingestIdempotent(raw: RawEvent, admission: IdempotentEventAdmission): Promise<RootEvent>;
    ingest(raw: RawEvent, admission?: EventWriteAdmission): Promise<RootEvent>;
    readAll(): RootEvent[];
    readAllStrict(): RootEvent[];
    iterate(fromSeq?: number): Generator<RootEvent>;
    tail(n?: number): RootEvent[];
    recover(): {
        truncated: boolean;
    };
    get path(): string;
}