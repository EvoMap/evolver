/** A single per-(fingerprint, gene) outcome observation derived from the event log. */
export interface ConfidenceObservation {
    signalFingerprint: string;
    geneId: string;
    /**
     * `inert` (port of v1 #195 `stable_no_error`): the cycle hit no error AND produced no measurable value
     * (no ProofOfWork output) — i.e. nothing happened. Counting that as a `success` lets a gene that only ever
     * does nothing climb confidence → ~1.0 and dominate `--loop` selection forever (diversity collapse). An
     * inert observation therefore builds NO positive evidence: it does not touch success/fail counts and so does
     * not raise baseConfidence; it is tallied apart (inertCount) and is what `inertBannedGeneIds` uses to ban a
     * gene stuck doing nothing on a signal.
     */
    status: 'success' | 'failed' | 'inert';
    /** Epoch millis of the outcome (from the event ts). Used for half-life decay. */
    at: number;
}
/** A derived confidence edge: how reliably `geneId` resolved problems under `signalFingerprint`. */
export interface ConfidenceEdge {
    signalFingerprint: string;
    geneId: string;
    successCount: number;
    failCount: number;
    /**
     * Inert (zero-work) observations on this edge (#195). Tallied apart from success/fail so they neither raise
     * baseConfidence nor count toward attempts — an all-inert edge stays at the neutral 0.5 prior, never ~1.0.
     */
    inertCount: number;
    /** Epoch millis of the most recent observation on this edge (newest wins). */
    lastAt: number;
    /** Laplace-smoothed, undecayed expected success rate in [0,1]. Decay is applied at query time against `now`. */
    baseConfidence: number;
}
/** All derived edges, keyed by `confidenceEdgeKey(signalFingerprint, geneId)`. */
export type ConfidenceEdges = ReadonlyMap<string, ConfidenceEdge>;
/** Default half-life for confidence decay (days). Aligned with v1 edgeExpectedSuccess half_life_days=30. */
export declare const CONFIDENCE_HALF_LIFE_DAYS = 30;
/**
 * Composite map key for an edge: `<fingerprint>::<geneId>`. The fingerprint is fixed-length hex (no `:`), so
 * `::` is an unambiguous separator. Exported so callers/tests look edges up the same way they are stored,
 * instead of hand-building the key string.
 */
export declare function confidenceEdgeKey(signalFingerprint: string, geneId: string): string;
/**
 * Stable signal fingerprint (port of v1 computeSignalKey): normalize → de-duplicate → sort → digest.
 * Deterministic and order-independent, so the same signal SET always yields the same fingerprint.
 * An empty set maps to a fixed sentinel digest so "no signals" is still a well-defined edge key.
 */
export declare function signalFingerprint(signals: readonly string[]): string;
/**
 * Half-life decay weight in (0,1] (port of v1 decayWeight): 0.5^(ageDays / halfLife).
 * Age is measured from the edge's lastAt to `now`. Future/zero/negative age → no decay (weight 1).
 */
export declare function decayWeight(lastAt: number, now: number, halfLifeDays?: number): number;
/**
 * Derive confidence edges from a flat list of per-(fingerprint, gene) outcome observations.
 * Pure and deterministic: the same observations (in any order — we track the max `at` for lastAt) always
 * produce the same edges. This is the replay primitive — feed it the observations re-extracted from
 * root_events and you get byte-identical edges back.
 */
export declare function deriveConfidenceEdges(observations: readonly ConfidenceObservation[]): ConfidenceEdges;
/**
 * Query the confidence of `geneId` under `signalFingerprint` at time `now`, in [0,1].
 * = baseConfidence (Laplace-smoothed success rate) × half-life decay weight.
 * Returns 0 when there is no edge (no history) so a never-tried gene gets no positive nudge —
 * absence of evidence is not evidence of success — and 0 for a purely-inert edge (only zero-work cycles),
 * so a do-nothing gene gets the same zero nudge as a never-tried one (#195).
 */
export declare function confidenceFor(edges: ConfidenceEdges, signalFingerprint: string, geneId: string, now: number, halfLifeDays?: number): number;
/**
 * Consecutive inert (zero-work) outcomes on a (fingerprint, gene) edge after which a gene with NO real success
 * on that signal is banned, so `--loop` selection explores instead of re-running a do-nothing gene (#195).
 * Port of v1 `GENE_INERT_BAN_STREAK` (env `EVOLVER_GENE_INERT_BAN_STREAK`, default 8); kept an inline const to
 * match v2's algo-tunable convention (BAN_THRESHOLD / MIN_ENV_ATTEMPTS), not env-driven.
 */
export declare const GENE_INERT_BAN_STREAK = 8;
/**
 * Observation window (in raw events) over which the inert ban is derived — deliberately MUCH wider than the
 * small recency window used for confidence SCORING. A banned gene runs as `ad-hoc` and accrues no new
 * observation for itself, so its trailing inert run must be recomputed from a history wide enough that
 * intervening innovate/ad-hoc cycles cannot evict it — and cannot evict an earlier real success that exempts
 * the gene (`successCount > 0`). With a small window the run/exemption age out purely from unrelated cycles, so
 * the ban flaps: the do-nothing gene resurfaces and the productive gene gets falsely banned (#195 regression).
 * ~14000 events ≈ 2000 cycles, mirroring v1's multi-hundred-cycle memory-graph read horizon: far past any
 * realistic flap window, yet still bounded (a long-idle gene's stale success eventually ages out, matching v1).
 * `EventStore.tail()` reads the entire log regardless of window size, so a larger window costs no extra I/O.
 */
export declare const INERT_BAN_OBSERVATION_WINDOW = 14000;
/**
 * Trailing consecutive-inert run per (fingerprint, gene), keyed by `confidenceEdgeKey`. Unlike
 * `deriveConfidenceEdges` (a pure function of the observation SET), this is deliberately order-DEPENDENT: it
 * counts inert outcomes from the most recent backward and ANY real success/failure resets the run to 0 — so a
 * gene that ever does real work is never punished for older idle cycles. Input MUST be chronological
 * (oldest→newest, i.e. the order `ingestor.tail` yields); the trailing run is the value left after the final
 * observation per edge.
 */
export declare function trailingInertByEdge(observations: readonly ConfidenceObservation[]): Map<string, number>;
/**
 * Gene ids to ban for the CURRENT signal fingerprint because they are stuck producing inert (zero-work)
 * cycles (#195). A gene is banned iff, on this fingerprint's edge, its trailing inert run ≥ `streak` AND it has
 * ZERO real success on this signal (double guard: the consecutive run is reset by any real outcome, and a gene
 * that ever truly succeeded here keeps successCount > 0). Banning a sole-matching inert gene lets selection
 * fall through to mutation (selected:null → fresh gene), restoring diversity — the failure-streak ban never
 * fires on these because nothing "fails". Per-signal, mirroring v1's per-signal-key ban: a gene idle on THIS
 * signal can still be tried on others.
 */
export declare function inertBannedGeneIds(edges: ConfidenceEdges, observations: readonly ConfidenceObservation[], fingerprint: string, streak?: number): Set<string>;