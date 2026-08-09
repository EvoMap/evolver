/**
 * Expand a signal list into literal signals + namespace prefixes + semantic category tags.
 * e.g. ['429', 'auth:token'] → ['429', 'auth:token', 'auth', 'problem:reliability', 'action:repair'].
 */
export declare function expandSignals(signals: readonly string[], extraText?: string): string[];
/**
 * Bag-of-words cosine similarity (0..1) between two free-text strings (ported from v1 scoreGeneSemantic).
 * Term-frequency vectors, cosine of the angle. Returns 0 when either side has no tokens or they share none.
 * This is the lexical-similarity recall path that complements {@link tagOverlapScore}'s curated tags:
 * a signal 'timeout_slow' and a gene summarized "fix the slow timeout" share the 'timeout'/'slow' tokens
 * even when neither the literal signal nor the expansion rules connect them.
 */
export declare function bagCosine(a: string, b: string): number;
/** Inputs used to derive a gene's tag set. All optional so callers can pass whatever they have. */
export interface GeneTagInput {
    signalsMatch?: readonly string[];
    category?: string;
    geneId?: string;
    summary?: string;
}
/** Expand a gene's category + signals_match + id + summary into its semantic tag set. */
export declare function geneTags(gene: GeneTagInput): string[];
/**
 * Semantic tag overlap (0..1): fraction of the expanded SIGNAL tags that the gene's expanded tags cover.
 * Normalized on the signal (query) side so a gene with a long id/summary is not penalized by noise.
 * This is the recall component: '429' and a gene tagged 'error'/'repair' both expand to
 * 'problem:reliability'/'action:repair', so they overlap even with zero literal string match.
 *
 * Known v1→v2 fidelity delta: a lone non-Latin signal caps near ~2/3 here — its raw token ('错误') is in the
 * signal tag-set but never on the English-keyworded gene side, while an exact English signal short-circuits to
 * literal=1.0 upstream in expandedMatchScore. v1 #99 gave CJK full literal credit via pipe-aliases; v2 reaches
 * the right gene at ~2/3 strength. Lifting this to parity is a scoring-design change beyond this signal port.
 */
export declare function tagOverlapScore(signals: readonly string[], gene: GeneTagInput): number;
export interface SemanticIdfDocument {
    readonly tags: readonly string[];
    readonly text: string;
}
export interface SemanticIdfProfile {
    readonly documentCount: number;
    readonly tagIdf: ReadonlyMap<string, number>;
    readonly tokenIdf: ReadonlyMap<string, number>;
    /** Deterministic, data-free identity for replaying the exact document-frequency profile. */
    readonly version: string;
}
export declare function buildSemanticIdfProfile(documents: readonly SemanticIdfDocument[]): SemanticIdfProfile;
export declare function idfTagOverlapScore(signals: readonly string[], gene: GeneTagInput, profile: SemanticIdfProfile): number;
export declare function idfBagCosine(a: string, b: string, profile: SemanticIdfProfile): number;