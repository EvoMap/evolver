export type AssetCallAction = 'hub_search_hit' | 'hub_search_miss' | 'asset_reuse' | 'asset_reference' | 'asset_publish' | 'asset_publish_skip' | 'hub_review_submitted' | 'hub_review_rejected' | 'hub_review_failed';
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
}