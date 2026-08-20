import type { AssetStoreProvider } from '../assetstore/provider.js';
import { type ReuseCounts } from '../ops/reuseOutcomes.js';
import type { ProvenanceStore } from '../assetstore/provenance.js';
import type { ReviewLedger } from '../assetstore/reviewLedger.js';
import type { AntiWarning, GeneCandidateInput } from './geneSelection.js';
import { type RuntimeRegistry } from './kautoValidator.js';
import { type CompatibilityEvidenceIndex } from '../modelCompatibility.js';
export interface AssembleOptions {
    limit?: number;
    /** Build the bounded trusted pre-admission corpus used by semantic IDF. Default true. */
    includeSemanticCorpus?: boolean;
    provenance?: ProvenanceStore;
    includeUntrusted?: boolean;
    review?: ReviewLedger;
    /**
     * Probation (gated, #306): when true, a quarantined auto-distilled gene is allowed into the candidate pool so it
     * can be TRIED and earn outcome evidence (its empty learning history keeps it ranked below proven genes; the
     * always-on safety gates + the 2-strike failure ban contain a bad one). An explicitly REJECTED gene is still
     * never a candidate. Absent/false (default) = today's behavior: a quarantined draft waits for approval first.
     */
    includeProbation?: boolean;
    /**
     * Reuse-before-solve (#110): hub candidates already resolved by the adapter's two-phase
     * search→score→fetch flow, injected to compete in the SAME pool as local genes. The
     * orchestration that triggers the free hub search + paid fetch lives in the adapter (so core's
     * assembly stays pure and hub-agnostic — it only MERGES the injected candidates here). These stay
     * trust-first: a geneId that collides with a local (trusted) gene keeps the local one; provenance
     * for the hub asset is tracked separately at the ingest layer (#30), this only shapes selection.
     */
    hubCandidates?: readonly GeneCandidateInput[];
    /**
     * Cross-runtime reuse COUNTS per id (#268 phase 1), from reuse-outcome events (ops.reuseCountsFromSummary). Keyed
     * by whatever id the events recorded (logical geneId OR content asset_id); assembly SUMS a gene's ids and derives
     * one sentiment, applied as a SOFT selection re-order (see geneSelection REUSE_WEIGHT). Absent → no effect
     * (default-off). Never resurrects a hard-gated gene (the trust/review/ban filters above run first).
     */
    reuseCounts?: ReadonlyMap<string, ReuseCounts>;
    /** Exact compatibility evidence; only quarantine decisions remove candidates. */
    compatibility?: CompatibilityEvidenceIndex;
    /**
     * K_auto EvidenceProjection revocation guard (T1, default-OFF). When provided, a candidate whose five
     * coordinates are all machine-decidable AND whose current projection touches a revoked (coordinate, value)
     * pair is treated as NOT eligible — the fail-safe "a revoked projection is not eligible" rule, applied
     * coordinate-locally (a sibling that differs on the revoked coordinate stays eligible). `revoked` is the set
     * produced by `projectRevocations(rootEvents)` (algo/kautoProjection). Absent (default) = deployed T2 behavior
     * unchanged: no projection guard runs, so signal-scoped `bannedGenesFromFailures` + the soft λ preference are
     * the only K_auto-related effects. `runtimeRegistry` is forwarded to `decideKauto` so the runtime coordinate
     * resolves against the same registry the caller uses elsewhere.
     */
    kautoProjection?: {
        revoked: ReadonlySet<string>;
        runtimeRegistry?: RuntimeRegistry;
    };
}
/** The selection pool for one cycle: the normal scored candidates + the last-resort distilled fallback (#97). */
export interface SelectionPool {
    /** Genes relevant to the live signals (literal or semantic match) — the normal scored candidate set. */
    candidates: GeneCandidateInput[];
    /**
     * Distilled genes that passed the trust/review/ban gates but do NOT match the live signals. Surfaced
     * separately (NOT in `candidates`, so they never compete in normal scoring) for the v1 #97 fallback: when no
     * normal selection has no reusable positive choice, selection reuses one of these broadly-applicable distilled
     * strategies instead of falling through to a blind innovate. Kept lightweight (no learning-history aggregation)
     * — picked first-match.
     */
    distilledFallback: GeneCandidateInput[];
    /** Trust-filtered library documents captured before live-signal relevance admission. */
    semanticCorpus: GeneCandidateInput[];
    /**
     * Matched AntiGene guardrails for the live signals. This list is advisory-only and is kept out of candidates and
     * distilledFallback so negative memory cannot be selected as a strategy.
     */
    antiWarnings: AntiWarning[];
}
/**
 * Assemble the full selection pool from the store for the given signals: the relevant scored candidates AND the
 * distilled-gene fallback pool, in a single pass over the gene list (one store.list + one ban computation). A gene
 * is a normal candidate if its signals_match literally intersects the signals OR semantically overlaps them (so a
 * '429' signal can still reach a gene tagged for 'repair'); a trusted/approved/non-banned *distilled* gene that
 * does NOT match goes to `distilledFallback` (v1 #97).
 */
export declare function assembleSelectionPool(store: AssetStoreProvider, signals: readonly string[], opts?: AssembleOptions): Promise<SelectionPool>;
/**
 * Assemble selection candidates from the store for the given signals (the relevant scored set only).
 * Thin wrapper over {@link assembleSelectionPool} kept for back-compat with callers that don't use the
 * distilled-gene fallback pool.
 */
export declare function assembleCandidates(store: AssetStoreProvider, signals: readonly string[], opts?: AssembleOptions): Promise<GeneCandidateInput[]>;