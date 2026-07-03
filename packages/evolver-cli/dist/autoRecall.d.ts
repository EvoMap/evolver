import { events, ops, assetstore } from '@evomap/evolver-core';
export interface AutoRecallDeps {
    /** Read root_events (to find the session's value.inject + the idempotency marker). Default: live root log. */
    readEvents?: (eventsPath?: string) => events.ReportEvent[];
    /** Resolve injected geneIds to Gene records. Default: live local store. */
    store?: Pick<assetstore.AssetStoreProvider, 'get' | 'list'>;
    /** Sink for the emitted `value.recall` events. */
    ingestor: {
        ingest(raw: {
            type: string;
            human: {
                title: string;
                detail?: string;
            };
            payload?: Record<string, unknown>;
        }): Promise<unknown>;
    };
}
/**
 * Derive + emit `value.recall` for ONE session transcript. Returns the number of verdicts emitted (0 when there is
 * no matching inject, no resolvable gene, or the session was already recalled). Idempotent: a session whose
 * `value.recall` already exists is skipped, so a polling daemon never re-emits. Best-effort: any failure → 0, never
 * throws (session ingest must not break on a recall side-effect).
 */
export declare function emitSessionRecall(transcriptPath: string, turns: readonly ops.RecallTurn[], deps: AutoRecallDeps): Promise<number>;