import type { AssetRecord, LocalProjectContextV1 } from './provider.js';
/** What one injected strategy may cost: hosts drop a longer one outright rather than cut it. */
export declare const RECALL_STRATEGY_BUDGET_CHARS = 4000;
export interface ReuseTally {
    success: number;
    negative: number;
}
export interface LocalRecallQuery {
    text: string;
    /** From projectFingerprint(); project notes are only offered to the project that wrote them. */
    projectFingerprint?: string;
    limit?: number;
}
export interface LocalRecallHit {
    gene: AssetRecord;
    relevance: number;
    score: number;
    signalHits: string[];
    promptSimilarity: number;
    projectMatch: boolean;
    reuse: ReuseTally;
    /** Near-duplicate Genes folded into this one; their reuse counts are in `reuse`. */
    mergedAssetIds: string[];
    projectNotes: string[];
}
/** no_candidates: nothing injectable is stored; empty_query: the prompt holds no word to match; weak_match: no
 *  candidate is strong enough; pruned: the strong ones all failed too often to offer again. */
export type LocalRecallRefusal = 'no_candidates' | 'empty_query' | 'weak_match' | 'pruned';
export interface LocalRecallResult {
    hits: LocalRecallHit[];
    considered: number;
    refusal?: LocalRecallRefusal;
    /** On a weak match, the candidate that came closest, so a refusal can be told from an empty pool. */
    closest?: {
        assetId: string;
        relevance: number;
        promptSimilarity: number;
        signalHits: string[];
    };
}
/** Characters a host injects for these steps: each step is cut to STEP_MAX_CHARS. */
export declare function injectedChars(lines: readonly string[]): number;
/**
 * Picks the local Genes worth injecting for a prompt, or none. Only a strong match counts (two specific signals, or a
 * prompt like the one the Gene was distilled from), weighed against the whole local pool so the bar rises with it;
 * near-duplicates of one project collapse into one candidate carrying their combined reuse record; proven reuse lifts
 * a candidate, repeated failure without a success drops it, and a Gene from the same project gets a small lift.
 */
export declare function recallLocalAssets(records: readonly AssetRecord[], query: LocalRecallQuery, reuse?: ReadonlyMap<string, ReuseTally>, contexts?: readonly LocalProjectContextV1[]): LocalRecallResult;