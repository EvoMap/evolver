import type { AssetStoreProvider } from '../assetstore/provider.js';
import type { ReviewLedger } from '../assetstore/reviewLedger.js';
export interface AutoPromoteOptions {
    /** Min real (value-producing) successes — with ZERO failures — before a quarantined draft is auto-approved. */
    minSuccess?: number;
    /** Who/why stamp for the audited approval. Defaults to the auto-promoter. */
    by?: string;
}
/** The default proven-success bar. Symmetric to reuse-report's prune threshold (a few clean signals, not one). */
export declare const DEFAULT_PROMOTE_MIN_SUCCESS = 3;
/**
 * The single promote predicate: a quarantined gene auto-promotes iff it has ZERO failures AND at least minSuccess
 * real (value-producing) successes. Inert (zero-work) successes are excluded by aggregateLearningHistory, so they
 * never count here. Every surface that judges promote-eligibility (auto-promote, reuse-report --promote, the
 * review listing) MUST route through this so they cannot diverge — e.g. a gene the review view labels "healthy"
 * by success-rate but that still has a failure must read as NOT promotable here.
 */
export declare function probationWouldPromote(view: {
    success: number;
    failed: number;
}, minSuccess?: number): boolean;
/** A quarantined gene's evidence so far, measured against the promote threshold. Read-only: this is what the
 *  daemon's auto-promote tick decides on, surfaced so an operator can SEE the probation pool before flipping
 *  EVOLVER_GENE_PROBATION on. `wouldPromote` is the exact predicate autoPromoteProbationGenes acts on. */
export interface ProbationStatus {
    assetId: string;
    geneId: string;
    success: number;
    failed: number;
    inert: number;
    total: number;
    /** The bar this status was scored against (echoes the option for display). */
    minSuccess: number;
    /** True iff this gene would be auto-approved right now (0 failures AND success >= minSuccess). */
    wouldPromote: boolean;
}
/**
 * Read-only scan of the review ledger: for every QUARANTINED gene, derive its learning evidence and whether it
 * meets the promote bar right now. The single source of truth for the promote predicate — autoPromoteProbationGenes
 * acts on exactly this, and reuse-report --promote displays it. Never mutates the ledger.
 */
export declare function scanProbationGenes(store: AssetStoreProvider, review: ReviewLedger, opts?: Pick<AutoPromoteOptions, 'minSuccess'>): Promise<ProbationStatus[]>;
/**
 * Scan the review ledger for quarantined genes and auto-approve those whose cycle outcomes prove their value
 * (>= minSuccess real successes AND 0 failures). Returns the asset_ids promoted. Never promotes a gene with any
 * failure, nor one whose only "successes" were inert. Idempotent: an already-approved/rejected gene is skipped.
 */
export declare function autoPromoteProbationGenes(store: AssetStoreProvider, review: ReviewLedger, opts?: AutoPromoteOptions): Promise<string[]>;