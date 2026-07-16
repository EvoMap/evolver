import { hub, algo } from '@evomap/evolver-core';
type HubMetadata = hub.HubMetadata;
type ReuseDecision = hub.ReuseDecision;
type GeneCandidateInput = algo.GeneCandidateInput;
export declare const SEARCH_CACHE_TTL_MS: number;
export declare const SEARCH_CACHE_MAX = 200;
export declare const PAYLOAD_CACHE_MAX = 100;
/** Default reuse mode (ported from v1): 'reference' injects the asset as a strong hint; 'direct' applies it. */
export type ReuseMode = 'direct' | 'reference';
export declare const DEFAULT_REUSE_MODE: ReuseMode;
/** Reads EVOLVER_MIN_REUSE_SCORE here (env is an ADAPTER concern — core never reads it). */
export declare function getMinReuseScore(env?: NodeJS.ProcessEnv): number;
/** Reads EVOLVER_REUSE_MODE here (adapter concern). */
export declare function getReuseMode(env?: NodeJS.ProcessEnv): ReuseMode;
/** Stable signal fingerprint (ported from v1 _cacheKey: sort + join). */
export declare function signalFingerprint(signals: readonly string[]): string;
/**
 * The two-layer reuse cache. Bounded + TTL'd, per-process. A search-cache hit means phase 1 makes ZERO hub
 * calls; a payload-cache hit means phase 3 makes ZERO hub calls. The clock is injected for deterministic tests.
 */
export declare class ReuseCache {
    private readonly now;
    private readonly searchTtlMs;
    private readonly searchMax;
    private readonly payloadMax;
    private readonly search;
    private readonly payload;
    constructor(now?: () => number, searchTtlMs?: number, searchMax?: number, payloadMax?: number);
    getSearch(key: string): HubMetadata[] | null;
    setSearch(key: string, value: HubMetadata[]): void;
    getPayload(assetId: string): hub.AssetRecord | null;
    setPayload(assetId: string, payload: hub.AssetRecord): void;
    clear(): void;
}
/**
 * Map a hub search row (AssetRecord with arbitrary quality fields) → the core's price-free HubMetadata.
 * Accepts both camelCase and the hub's snake_case (gdi_score / success_rate / reuse_count / ...). Drops any
 * price/credit field by simply not reading it — the core HubMetadata has no slot for cost.
 */
export declare function toHubMetadata(rec: hub.AssetRecord): HubMetadata;
/** Map a fetched hub asset (full payload) → a selection candidate so it competes in candidateAssembly. */
export declare function toGeneCandidate(rec: hub.AssetRecord): GeneCandidateInput;
/** A receipt the adapter SURFACES but never interprets (mirrors core's PublishReceipt.economic handling). */
export interface ReuseReceipt {
    /** The hub's credit_cost block, passed through verbatim for observability/UI. Never gated on. */
    creditCost?: unknown;
    fromCache: boolean;
}
export interface ReuseBeforeSolveOptions {
    /** Reuse threshold; default from EVOLVER_MIN_REUSE_SCORE (read in the adapter, never in core). */
    threshold?: number;
    /** Injected clock for recency scoring (passed to core scoreSearchResults). */
    now?: number;
    /** Cap on how many candidates the free search pulls. */
    searchLimit?: number;
    /** Reuse mode label carried into the result (direct/reference). */
    mode?: ReuseMode;
    /** Observability sink (asset-call log). Receives structured records; never throws. */
    log?: {
        append(entry: Record<string, unknown>): void;
    };
    runId?: string | null;
    /**
     * Value-ledger emission seam (#112). Fired exactly once on a reuse HIT (action === 'fetch') with the audit
     * anchors the ledger needs to derive a source=reuse entry: the reused assetId, the cycleId it feeds, the
     * signal fingerprint, and the tokens the fetch actually consumed (≈0 — payload/cache pull, no fresh solve).
     * The composition layer wires this to a `value.reuse_hit` root_event. Optional + must never throw (reuse is
     * an optimization, and observability emission can never be allowed to break it).
     */
    onReuseHit?: (hit: ReuseHitInfo) => void;
    /** The cycle this resolution feeds — carried into onReuseHit so the event refs the SAME cycleId as the cycle. */
    cycleId?: string;
}
/** What onReuseHit reports on a reuse hit — the value-ledger audit anchors (#112). */
export interface ReuseHitInfo {
    assetId: string;
    cycleId: string;
    signalFingerprint: string;
    /** Tokens the fetch actually consumed (cache/payload pull — typically 0). */
    fetchTokens: number;
}
export interface ReuseBeforeSolveResult {
    /** 'fetch' = a winner was fetched and is ready to compete; 'solve-fresh' = nothing worth reusing. */
    action: ReuseDecision['action'];
    /** The fetched winner as a selection candidate (only when action === 'fetch'). */
    candidate?: GeneCandidateInput;
    /** The raw fetched payload (only when action === 'fetch'), for ingest/reference injection. */
    asset?: hub.AssetRecord;
    /** The reuse mode applied. */
    mode: ReuseMode;
    /** Decision score of the winner (rounded), for logging. */
    score?: number;
    /** Economic receipt read-through (read-only; the adapter never interprets credits). */
    receipt?: ReuseReceipt;
    /** True when the whole flow made ZERO hub calls (both layers hit). */
    zeroHubCalls: boolean;
    /** Why we didn't reuse, when action === 'solve-fresh' (no_signals / no_results / below_threshold). */
    reason?: string;
}
/**
 * The reuse-before-solve flow. Returns the single winner (already fetched) as a selection candidate, or a
 * solve-fresh verdict. Never throws on a hub error — reuse is an optimization, not a hard dependency:
 * a failed search/fetch degrades to solve-fresh.
 *
 * @param cap   the HubCapability (free search + paid fetch).
 * @param cache the two-layer cache (caller owns it across cycles so it actually warms).
 * @param signals the local problem signals.
 */
export declare function reuseBeforeSolve(cap: hub.HubCapability, cache: ReuseCache, signals: readonly string[], opts?: ReuseBeforeSolveOptions): Promise<ReuseBeforeSolveResult>;
export declare function assetMatchesId(asset: hub.AssetRecord | null | undefined, assetId: string): asset is hub.AssetRecord;
export {};