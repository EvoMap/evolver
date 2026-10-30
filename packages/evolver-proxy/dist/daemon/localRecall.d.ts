import { assetstore } from '@evomap/evolver-core';
export type ReuseTallies = (options?: {
    signal?: AbortSignal;
    deadlineAt?: number;
}) => ReadonlyMap<string, assetstore.ReuseTally> | Promise<ReadonlyMap<string, assetstore.ReuseTally>>;
export declare const LOCAL_RECALL_TIMEOUT_MS = 1500;
export declare const LOCAL_RECALL_STALE_MS = 30000;
export declare const MAX_OUTSTANDING_LOCAL_READS = 2;
export interface LocalRecallDiagnostics {
    considered: number;
    injected: number;
    refusal?: assetstore.LocalRecallRefusal;
    closest?: {
        asset_id: string;
        relevance: number;
        prompt_similarity: number;
        signal_hits: string[];
    };
    error?: string;
    /** The store held more records of a kind than one recall reads; the rest were not considered. */
    truncated?: boolean;
}
export interface LocalRecallOutcome {
    assets: assetstore.AssetRecord[];
    /** Exact server-created response objects mapped to the raw records their eligibility binds. */
    rawAssets?: ReadonlyMap<assetstore.AssetRecord, assetstore.AssetRecord>;
    diagnostics: LocalRecallDiagnostics;
}
interface LocalRecallRead {
    finish: (eligibility: assetstore.GeneContextEligibility, reuse: ReadonlyMap<string, assetstore.ReuseTally>) => LocalRecallOutcome;
}
/** Per-asset reuse counts the hosts recorded in root_events, active log and rotated archive alike, re-read only
 *  when that history changed. */
export declare function rootEventReuseTallies(path?: string): ReuseTallies;
/** The local Gene, with its project's notes, that this prompt should get from the local store, or none. */
export declare function recallFromLocalStore(store: assetstore.AssetStoreProvider, text: string, projectDir: unknown): Promise<LocalRecallRead>;
export {};