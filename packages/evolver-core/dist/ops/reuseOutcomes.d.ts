/** root_events type appended for a NON-success MCP reuse-result — the negative half of the keep/prune signal. */
export declare const VALUE_REUSE_OUTCOME_EVENT = "value.reuse_outcome";
/** The negative reuse outcomes an agent can self-report (success is recorded as `value.reuse_hit`, not here). */
export type ReuseNegativeOutcome = 'failed' | 'mismatched' | 'stale' | 'unsafe';
/** Payload of a `value.reuse_outcome` root_event. */
export interface ReuseOutcomePayload {
    assetId: string;
    cycleId: string;
    outcome: ReuseNegativeOutcome;
}
/** A minimal root_event view this module reads (matches the events module's ReportEvent shape; declared locally so
 *  ops stays decoupled from the events module, mirroring valueLedger's LedgerRootEvent). */
export interface ReuseOutcomeEvent {
    type: string;
    payload?: Record<string, unknown>;
}
export interface GeneReuseOutcome {
    assetId: string;
    /** Successful reuses (from `value.reuse_hit`). */
    success: number;
    /** Non-success reuses (from `value.reuse_outcome`). */
    negative: number;
    /** Per-outcome breakdown of the negatives. */
    byOutcome: Record<ReuseNegativeOutcome, number>;
}
export interface ReuseOutcomeSummary {
    /** Total reuse signals considered (success + negative). */
    total: number;
    /** Per-gene rollup, sorted by negative desc then assetId. */
    perGene: GeneReuseOutcome[];
    /** Genes reused but NEVER successfully (negative>0 AND success===0) — the strongest cross-runtime prune signal.
     *  Mirrors summarizeRecall.pruneCandidates, but sourced from reuse outcomes across every runtime. */
    pruneCandidates: string[];
}
/**
 * Roll reuse signals up per gene from root_events: SUCCESS from `value.reuse_hit`, the negative verdicts from
 * `value.reuse_outcome`. Pure; deterministic ordering. Unknown/garbled payloads are skipped, never counted.
 */
export declare function summarizeReuseOutcomes(events: readonly ReuseOutcomeEvent[]): ReuseOutcomeSummary;
/** Raw reuse tallies for one gene-id, kept as COUNTS (not a pre-collapsed sentiment) so a consumer that knows a
 *  gene's multiple ids can COMBINE them before computing sentiment (#268 Bugbot: events for one gene can split
 *  across its logical id and its content asset_id — averaging two sentiments would skew; summing counts is right). */
export interface ReuseCounts {
    success: number;
    negative: number;
}
/**
 * Map a reuse-outcome summary to per-id reuse COUNTS (#268 phase 1) — the input to a SOFT selection re-order.
 * Keyed by the id the events recorded (which may be a logical geneId OR a content asset_id), so the store-aware
 * consumer (candidateAssembly) can fold all of a gene's ids together via `reuseSentiment` before ranking. Only ids
 * with at least one reuse signal are included. Pure; the cycle injects it via RunCycleOptions.reuseOutcomes.
 */
export declare function reuseCountsFromSummary(summary: ReuseOutcomeSummary): Map<string, ReuseCounts>;
/** Net reuse sentiment in [-1, 1] from combined counts: (success − negative) / (success + negative). all-success
 *  → +1, all-negative → −1, balanced → 0. Zero total → 0. The WEIGHT/clamping that bounds its selection influence
 *  lives in geneSelection (it can never override the hard trust/review/ban gates, which run before scoring). */
export declare function reuseSentiment(counts: ReuseCounts): number;
/** Weight of an OBSERVED recall verdict (#274 slice 3) relative to a reported reuse outcome. < 1 because a
 *  transcript-observed `used`/`unused` is weaker evidence than an agent (or daemon) explicitly reporting that a
 *  reuse WORKED or FAILED — being applied/ignored is softer than working/breaking. */
export declare const RECALL_WEIGHT = 0.5;
/**
 * Per-gene reuse COUNTS contributed by OBSERVED `value.recall` events (#274 slice 3): `used` → success, `unused` →
 * negative, each weighted RECALL_WEIGHT (weaker than a reported reuse outcome); `unknown` is ignored. Keyed by the
 * recall payload's geneId. Pure. Merged into the reuse-outcome counts upstream so recall SOFTLY re-orders selection
 * — it never reaches the quarantine path (summarizeReuseOutcomes reads only the reuse-outcome events, not recall).
 */
export declare function recallCountsFromEvents(events: readonly ReuseOutcomeEvent[]): Map<string, ReuseCounts>;