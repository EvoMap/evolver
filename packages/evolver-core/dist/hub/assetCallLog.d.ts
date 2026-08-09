export type AssetCallAction = 'hub_search_hit' | 'hub_search_miss' | 'asset_reuse' | 'asset_reference' | 'asset_publish' | 'asset_publish_skip' | 'asset_inject' | 'asset_inject_shadow' | 'hub_review_submitted' | 'hub_review_rejected' | 'hub_review_failed';
export type TokensSavedBasis = 'measured' | 'cost_index' | 'estimated_blast_radius' | 'estimated_default';
export interface AssetCallEntry {
    run_id?: string | null;
    action: AssetCallAction;
    asset_id?: string;
    asset_type?: string;
    source_node_id?: string;
    chain_id?: string;
    score?: number;
    mode?: 'direct' | 'reference';
    signals?: readonly string[];
    reason?: string;
    tokens_saved?: number | null;
    tokens_saved_basis?: TokensSavedBasis | null;
    tokens_spent?: number | null;
    extra?: Record<string, unknown>;
}
export interface AssetCallRecord extends AssetCallEntry {
    timestamp: string;
}
export interface ReadOpts {
    run_id?: string;
    action?: AssetCallAction;
    /** Only entries at/after this ISO time. */
    since?: string;
    /** Only the last N entries (after the other filters). */
    last?: number;
}
export interface CallLogSummary {
    total_entries: number;
    unique_assets: number;
    unique_runs: number;
    by_action: Record<string, number>;
    entries: AssetCallRecord[];
}
export interface AssetReuseAttribution {
    asset_id: string;
    source_node_id: string | null;
    chain_id: string | null;
    reuse: number;
    reference: number;
    tokens_saved: number;
}
export interface ReuseAttributionSummary {
    total_reuse: number;
    total_reference: number;
    total_tokens_saved: number;
    by_asset: AssetReuseAttribution[];
}
export interface ReuseSavingsMetric {
    tokens_saved: number;
    tokens_saved_basis: TokensSavedBasis;
}
/** Measured derivation cost carried by an asset (or by a Hub wrapper's payload). */
export declare function assetDerivationTokenCost(asset: unknown): number | undefined;
/**
 * Attribute savings without inventing a measured value: asset telemetry wins, then this node's publish-cost
 * index, then the savings-core blast/default estimator. Reference reuse applies the same fractional discount
 * to measured and estimated costs.
 */
export declare function reuseSavingsForAsset(asset: unknown, mode: 'direct' | 'reference', indexedTokenCost?: unknown): ReuseSavingsMetric;
export declare class AssetCallLog {
    private readonly path;
    private readonly now;
    constructor(path: string, now?: () => Date);
    /** Append one record (timestamped). Never throws — logging must not break evolution. */
    append(entry: AssetCallEntry): void;
    /** Read records with optional filters. Corrupt lines are skipped. */
    read(opts?: ReadOpts): AssetCallRecord[];
    /** Totals + per-action counts (for CLI / observability). */
    summarize(opts?: ReadOpts): CallLogSummary;
    /** Local-only attribution rollup over reuse/reference audit rows. */
    reuseAttributionSummary(opts?: ReadOpts): ReuseAttributionSummary;
    /** Later valid publish rows win; malformed/non-positive costs never erase a prior measurement. */
    assetCostIndex(opts?: ReadOpts): Record<string, number>;
}