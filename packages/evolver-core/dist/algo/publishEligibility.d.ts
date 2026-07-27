import { type GeneLearningView } from '../assetstore/learningHistory.js';
import type { AssetStoreProvider } from '../assetstore/provider.js';
export type PublishEligibilityReason = 'eligible' | 'no_proven_success';
export interface GenePublishEvidence {
    geneId: string;
    /** Real, value-producing successes (inert zero-work successes excluded upstream). */
    success: number;
    failed: number;
    inert: number;
    total: number;
    eligible: boolean;
    reason: PublishEligibilityReason;
}
/**
 * The single publish/upload eligibility predicate: a gene may be published iff
 * it has at least one capsule with a `success` outcome.
 *
 * We count `success + inert`, NOT just `success`. aggregateLearningHistory
 * demotes a `success` capsule that carries no `proof_of_work` to `inert`
 * (#195), but the evox capsule builder (asset_builder.rs) does NOT emit
 * `proof_of_work` — a genuine successful run surfaces there as `inert`. Gating
 * publish on the proof-only `success` count would therefore block genes that
 * actually succeeded in production. "Has a success outcome" is the honest bar
 * for the publish gate; the proof/inert distinction stays where it belongs
 * (success-rate, auto-promote), not here. A gene with only failures — or one
 * never run at all — has `success + inert === 0` and is not publishable.
 */
export declare function isGenePublishEligible(view: Pick<GeneLearningView, 'success' | 'inert'>): boolean;
/**
 * Read-only: derive a gene's outcome evidence and whether it clears the publish
 * bar. Returns `no_proven_success` for a gene the store has never seen succeed,
 * so callers can surface a precise, self-serviceable reason.
 */
export declare function assessGenePublishEvidence(store: AssetStoreProvider, geneId: string): Promise<GenePublishEvidence>;