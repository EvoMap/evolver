import { assetstore, events, observers, type material as materialNs } from '@evomap/evolver-core';
/** Consumer group the distill drain claims under — independent cursor from any other material consumer. */
export declare const DISTILL_CONSUMER_GROUP = "distill";
export interface DistillComposition {
    /** Consumer group cursor over the MaterialStore (at-least-once claim/ack). */
    consumer: materialNs.ConsumerGroups;
    /** Asset store the draft gene is written to. */
    store: assetstore.AssetStoreProvider;
    /** Review ledger the draft is quarantined in. Default co-located with the store (same gate as the read side). */
    review?: assetstore.ReviewLedger;
    /** Ingestor that records the gene.distilled audit event — MUST be the daemon's bus Ingestor (#117). */
    ingestor: events.Ingestor;
    /** Max drafts per drain tick. Default 3. */
    maxPerTick?: number;
    /** Backoff before the observer retries a STALLED drain (stuck head). Default 30s (see distillObserver). */
    retryDelayMs?: number;
    /** Read a session source file → raw chunk. Default fs read; injectable for tests. */
    readSource?: (path: string) => string;
}
/**
 * The injected drain side-effect: claim ready material → draft + quarantine genes. `runtime_session` material is
 * distilled (its narration drafts a strategy); `proxy_trace` is observation-only (metadata, no narration) and is
 * acked without drafting. Best-effort per material: a missing/unparseable source never blocks the rest of the
 * batch. Every material in the claimed batch is acked (drafted, skipped, or failed) so the cursor always advances.
 */
export declare function makeDistillDrain(c: DistillComposition): () => Promise<{
    drafted: number;
    stalled: boolean;
}>;
/** Compose the live distill observer from the daemon's material/store/ingestor — register the result on the bus.
 *  The observer only needs the `stalled` signal (to self-schedule a backoff retry); the drafted count is for the
 *  direct-drain tests / callers. */
export declare function resolveDistillObserver(c: DistillComposition): ReturnType<typeof observers.distillObserver>;