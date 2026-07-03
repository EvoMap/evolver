export declare const SAVINGS_SPEC_VERSION = "0.3.0";
export declare const ENTROPY_EVENT_TOKENS_EST: Readonly<{
    dedup_quarantine: 12000;
    dedup_warning: 3600;
    hub_search_hit: 8000;
    hub_search_miss: 0;
    fetch_reuse: 4000;
}>;
export declare const FETCH_USAGE_TOKENS_EST: Readonly<{
    Gene: 1500;
    Capsule: 3500;
    EvolutionEvent: 0;
}>;
export declare const REUSE_ESTIMATOR: Readonly<{
    derive_base_tokens: 120000;
    tokens_per_changed_line: 800;
    derive_cap_tokens: 600000;
    typical_changed_lines: 75;
    reference_saving_fraction: 0.4;
}>;
export declare const USD_PER_M_TOKENS_BLENDED = 9;
export declare const CACHE_READ_SAVED_USD_PER_M_TOKENS: Readonly<{
    anthropic: 2.7;
}>;
export declare const SAVINGS_BASIS_PRECEDENCE: readonly string[];
export declare function measuredSavings(rawTokens: number, optimizedTokens: number): {
    tokens_saved: number;
    savings_pct: number;
};
export declare function rolloutFoldPct(nAvgRollouts: number): number;
export interface EntropyEvent {
    type: string;
    count?: number;
    tokensEstSaved?: number | null;
}
export declare function entropyTotal(events: readonly EntropyEvent[]): {
    total_tokens_saved: number;
    total_events: number;
};
export declare function fetchUsageEstimate(byType: Record<string, number>): number;
export declare function reuseEstimate(blastRadiusLines: number | null | undefined, mode?: string): {
    tokens_saved: number;
    basis: 'estimated_blast_radius' | 'estimated_default';
};
export declare function hitRatePct(hits: number, misses: number): number;
export declare function usdSaved(tokens: number): number;
export declare function cacheSavedUsd(provider: string, cacheReadTokens: number): number;