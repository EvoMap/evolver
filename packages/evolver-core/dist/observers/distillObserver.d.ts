import type { Observer } from './observerBus.js';
/** The root_event ingestion emits when a batch of material lands (see CLI ingest). The only trigger this observer
 *  subscribes to — it claims from the consumer group, so the event is a tick, not a payload it reads. */
export declare const MATERIAL_READY_EVENT_TYPE = "material.batch_ready";
export interface DistillObserverDeps {
    /**
     * Drain newly-ready material into UNPROVEN quarantined gene drafts. Injected by the CLI composition (it owns the
     * consumer-group claim, session re-parse, intake, quarantine, and the gene.distilled emit). Returns TRUE when the
     * drain STALLED — it stopped on a stuck head (un-acked material it could not advance past, e.g. a transient
     * persist/audit failure) with a backlog still behind it. A stalled drain needs another attempt that does NOT
     * depend on a future material.batch_ready, so the observer self-schedules a backoff retry. Falsy = fully drained.
     */
    distill(): boolean | void | Promise<boolean | void>;
    /** Backoff before retrying a STALLED drain (no new material.batch_ready needed). Default 30s. */
    retryDelayMs?: number;
    /** Observer handle timeout the bus enforces. Default 30s (a drain re-reads + parses several session files). */
    timeoutMs?: number;
}
/**
 * Build the distill observer. Subscribes to `material.batch_ready` only. On each such event it runs `distill()`
 * once, SINGLE-FLIGHT: an event arriving while a drain is in flight is coalesced into ONE trailing drain (never
 * dropped). If a drain STALLS on a stuck head, the observer self-schedules a backoff retry so a transient write
 * failure cannot stall the queue forever waiting on an external event. idempotent=false: distill writes a gene +
 * a root_event, so the bus must not assume a free re-run.
 */
export declare function distillObserver(deps: DistillObserverDeps): Observer & {
    flush(): Promise<void>;
    running(): boolean;
    retryScheduled(): boolean;
    kick(): void;
};