import { type algo, type assetstore } from '@evomap/evolver-core';
import { type DraftAdmission, type DraftAdmissionOptions, type ExistingGeneSignals } from './distillPrimitives.js';
export interface StoreDraftAdmission {
    admission: DraftAdmission;
    existing: ExistingGeneSignals[];
}
/**
 * Build the complete dedupe context without loading the entire pool. Any subset or positive-Jaccard duplicate must
 * share at least one candidate signal, so a store-side signalsAny query is complete for admission while excluding
 * unrelated Genes. MAX_SAFE_INTEGER deliberately removes the provider's default result window; silently accepting
 * a duplicate after row 1000 is worse than evaluating all signal-related rows in a mature pool.
 */
export declare function assessDraftAdmissionFromStore(store: Pick<assetstore.AssetStoreProvider, 'search'>, candidate: algo.GeneCandidate, additional?: readonly ExistingGeneSignals[], opts?: DraftAdmissionOptions): Promise<StoreDraftAdmission>;
/**
 * Sessions a host plugin already distilled (its Capsule records the host session id as `source_thread`). The
 * transcript backfill skips them so one session never yields both a plugin draft and a structural one.
 */
export declare function sessionsDistilledByHost(store: Pick<assetstore.AssetStoreProvider, 'list'>): Promise<ReadonlySet<string>>;
/** The host's own session id as a transcript records it near its start (Claude `sessionId`, Codex `session_meta`). */
export declare function transcriptSessionIdOf(content: string): string | undefined;