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