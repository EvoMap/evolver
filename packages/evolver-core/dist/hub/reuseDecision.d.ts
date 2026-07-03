/** Default reuse threshold (ported from v1 DEFAULT_MIN_REUSE_SCORE). The adapter overrides via env. */
export declare const DEFAULT_MIN_REUSE_SCORE = 0.72;
/** Streak cap to prevent unbounded score inflation (ported from v1 MAX_STREAK_CAP). */
export declare const MAX_STREAK_CAP = 5;
/** Weight of the semantic-similarity bonus when the hub provided a vector similarity (ported from v1). */
export declare const SEMANTIC_SIMILARITY_BONUS = 0.3;
/** Weight of the signal-match multiplier: how much local↔candidate signal overlap shapes the rank. */
export declare const SIGNAL_MATCH_FLOOR = 0.5;
/** Recency half-life in days: a candidate that is HALF_LIFE_DAYS old keeps half its recency weight. */
export declare const RECENCY_HALF_LIFE_DAYS = 90;
/**
 * Hub-quality metadata for ONE search candidate (the FREE phase-1 row — metadata only, no payload yet).
 * Hub-agnostic: any hub that can describe a reusable asset's quality fits here. No economic field exists by
 * design (see the boundary note above). Fields are all optional so a sparse hub still ranks.
 */
export interface HubMetadata {
    /** Content-addressed id of the candidate asset (used by the adapter to fetch the winner's payload). */
    assetId: string;
    /** The asset's own signals (signals_match / signals / trigger) — matched against the local signals. */
    signalsMatch?: readonly string[];
    /** Optional category/summary for semantic tag expansion (reuses signals/expand's matching). */
    category?: string;
    summary?: string;
    /** Hub gate status. Only 'promoted' is eligible for reuse (untrusted/quarantined are skipped). */
    status?: string;
    /** Author/asset confidence in [0..1]-ish range. */
    confidence?: number;
    /** Consecutive successful reuses (capped at MAX_STREAK_CAP). */
    successStreak?: number;
    /** Reputation of the source (0..100, defaults to 50 when absent — neutral). */
    reputationScore?: number;
    /** GDI quality score (0..1-ish) when the hub provides one; multiplies the rank when present. */
    gdiScore?: number;
    /** Observed success rate of past reuses (0..1) when the hub provides one. */
    successRate?: number;
    /** How many times the asset has been reused (popularity prior). */
    reuseCount?: number;
    /** Vector similarity from a semantic search leg (0..1), added as a bonus when present. */
    semanticSimilarity?: number;
    /** Last-updated epoch ms (for recency). Absent → no recency adjustment (neutral 1.0). */
    updatedAt?: number;
}
/** A scored, ranked candidate. Pure ranking — no economic dimension anywhere. */
export interface RankedCandidate {
    assetId: string;
    /** Final rank (higher = more worth reusing). Rounded to 3 dp for stable golden output. */
    score: number;
    /** Decomposition for explainability (禁黑盒): the multiplicative parts that produced `score`. */
    reasons: {
        quality: number;
        signalMatch: number;
        recency: number;
        semanticBonus: number;
        reuseFactor: number;
    };
    /** The original metadata row (carried through so the adapter can fetch the winner). */
    metadata: HubMetadata;
}
export interface ScoreOptions {
    /** Injected clock for recency (defaults to a neutral now if absent — keeps pure callers deterministic). */
    now?: number;
}
/**
 * Rank free hub search candidates by reuse quality only. Deterministic given (signals, metadata, now).
 * Returns a new array sorted high→low score; ties are broken by assetId for stable golden output.
 */
export declare function scoreSearchResults(localSignals: readonly string[], hubMetadata: readonly HubMetadata[], opts?: ScoreOptions): RankedCandidate[];
/** The reuse decision: fetch the winner, or solve fresh. */
export interface ReuseDecision {
    action: 'fetch' | 'solve-fresh';
    /** Present only when action === 'fetch': the single candidate worth paying to fetch. */
    candidate?: RankedCandidate;
    /** The threshold applied (for explainability / logging in the adapter). */
    threshold: number;
    /** How many candidates were considered (after the eligibility filter). */
    considered: number;
}
export interface DecideOptions {
    /** Reuse threshold (default DEFAULT_MIN_REUSE_SCORE). The adapter sources this from env. */
    threshold?: number;
}
/**
 * Decide whether to reuse (port of v1 pickBestMatch): among the ranked candidates, keep only eligible ones
 * (status promoted or unset), and pick the single highest scorer that clears the threshold. Below threshold
 * → solve-fresh. Picks AT MOST ONE — the adapter pays to fetch only this winner (or nothing).
 */
export declare function decideReuse(ranked: readonly RankedCandidate[], opts?: DecideOptions): ReuseDecision;