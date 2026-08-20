import type { AssetStoreProvider, AssetRecord } from '../assetstore/provider.js';
/** A signal observed in the store, with how many assets declare it. */
export interface ScopeVocabularyEntry {
    signal: string;
    /** Number of Gene assets whose signals_match declares this signal (hard facets counted by their bare tag). */
    assetCount: number;
}
export interface ScopeVocabulary {
    /** Observed signals, most-declared first. */
    entries: ScopeVocabularyEntry[];
    /** Convenience set of the bare signal strings. */
    signals: Set<string>;
}
/** Strip a `required:` facet prefix to get the bare signal a facet gates on. */
export declare function bareSignal(tag: string): string;
/**
 * Build the scope vocabulary from a set of Gene asset records already in hand. Hard facets contribute their BARE
 * signal, because `required:rounding-v2` and `rounding-v2` refer to the same scope dimension — one gates on it,
 * one hints at it. Factored out of {@link deriveScopeVocabulary} so a caller that ALREADY holds the gene records
 * (e.g. the distiller, which lists existing genes for dedup anyway) can build the same vocabulary without a second
 * store round-trip, and so the prompt-injection path and the post-hoc resolve path share ONE derivation.
 */
export declare function scopeVocabularyFromRecords(records: readonly AssetRecord[]): ScopeVocabulary;
/**
 * Derive the scope vocabulary from the Gene assets in a store. Thin async wrapper over
 * {@link scopeVocabularyFromRecords} that fetches the records first.
 */
export declare function deriveScopeVocabulary(store: AssetStoreProvider, limit?: number): Promise<ScopeVocabulary>;
export type ScopeResolution = 
/** The proposed tag names a signal that exists; usable as-is. */
{
    status: 'exact';
    proposed: string;
    resolved: string;
}
/**
 * The proposed tag does not exist, but exactly ONE observed signal is an unambiguous refinement of it — the
 * autonomous-scope failure mode, where `v2` was proposed and `rounding-v2` is what exists. `resolved` is the
 * real signal; a caller may adopt it, or surface it for review.
 */
 | {
    status: 'resolved';
    proposed: string;
    resolved: string;
    reason: string;
}
/** Several observed signals match equally well; resolving would be a guess, so we refuse to pick. */
 | {
    status: 'ambiguous';
    proposed: string;
    candidates: string[];
}
/** Nothing in the store resembles the tag. Not an error: a genuinely new scope looks like this. */
 | {
    status: 'unknown';
    proposed: string;
};
/**
 * Resolve a proposed scope tag against an observed vocabulary.
 *
 * Matching is deliberately conservative. Beyond an exact hit we accept only ONE relation: an observed signal that
 * ends with `-<proposed>` or `_<proposed>` (or begins with `<proposed>-`/`<proposed>_`), i.e. the proposal is a
 * bare qualifier and the real signal is that qualifier scoped to a domain. That is exactly the `v2` →
 * `rounding-v2` shape. We do NOT do fuzzy/edit-distance matching: silently rewriting a scope key on a weak
 * similarity signal would be a governance hazard far worse than an unresolved tag, since scope decides what gets
 * injected into an agent's context. Multiple candidates yield `ambiguous` rather than an arbitrary pick.
 */
export declare function resolveScopeTag(proposed: string, vocab: ScopeVocabulary): ScopeResolution;
/**
 * Render the vocabulary as a compact, promptable list. This is what makes the vocabulary \emph{discoverable} to a
 * distiller: it can be shown the signals that exist before being asked to choose a facet, instead of guessing.
 * Bounded by `max` so a large store cannot blow a prompt budget; the most-declared signals come first, and the
 * count is reported so a reader can tell a load-bearing scope from a one-off tag.
 */
export declare function renderScopeVocabulary(vocab: ScopeVocabulary, max?: number): string;