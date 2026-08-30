const REQUIRED_PREFIX = 'required:';
/** Strip a `required:` facet prefix to get the bare signal a facet gates on. */
export function bareSignal(tag) {
    const t = String(tag).trim();
    return t.startsWith(REQUIRED_PREFIX) ? t.slice(REQUIRED_PREFIX.length).trim() : t;
}
function asStrings(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
/**
 * Build the scope vocabulary from a set of Gene asset records already in hand. Hard facets contribute their BARE
 * signal, because `required:rounding-v2` and `rounding-v2` refer to the same scope dimension — one gates on it,
 * one hints at it. Factored out of {@link deriveScopeVocabulary} so a caller that ALREADY holds the gene records
 * (e.g. the distiller, which lists existing genes for dedup anyway) can build the same vocabulary without a second
 * store round-trip, and so the prompt-injection path and the post-hoc resolve path share ONE derivation.
 */
export function scopeVocabularyFromRecords(records) {
    const counts = new Map();
    for (const g of records) {
        // One asset counts once per distinct signal, so a repeated tag within one asset cannot inflate the count.
        const seen = new Set();
        for (const raw of asStrings(g['signals_match'])) {
            const s = bareSignal(raw);
            if (!s || seen.has(s))
                continue;
            seen.add(s);
            counts.set(s, (counts.get(s) ?? 0) + 1);
        }
    }
    const entries = [...counts.entries()]
        .map(([signal, assetCount]) => ({ signal, assetCount }))
        .sort((a, b) => b.assetCount - a.assetCount || a.signal.localeCompare(b.signal));
    return { entries, signals: new Set(entries.map((e) => e.signal)) };
}
/**
 * Derive the scope vocabulary from the Gene assets in a store. Thin async wrapper over
 * {@link scopeVocabularyFromRecords} that fetches the records first.
 */
export async function deriveScopeVocabulary(store, limit = 500) {
    return scopeVocabularyFromRecords(await store.list('Gene', limit));
}
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
export function resolveScopeTag(proposed, vocab) {
    const bare = bareSignal(proposed);
    if (!bare)
        return { status: 'unknown', proposed };
    if (vocab.signals.has(bare))
        return { status: 'exact', proposed, resolved: bare };
    const lower = bare.toLowerCase();
    const candidates = [...vocab.signals].filter((s) => {
        const sl = s.toLowerCase();
        if (sl === lower)
            return true;
        return sl.endsWith(`-${lower}`) || sl.endsWith(`_${lower}`)
            || sl.startsWith(`${lower}-`) || sl.startsWith(`${lower}_`);
    });
    if (candidates.length === 1) {
        return {
            status: 'resolved',
            proposed,
            resolved: candidates[0],
            reason: `proposed '${bare}' is a bare qualifier; the store's vocabulary declares '${candidates[0]}'`,
        };
    }
    if (candidates.length > 1)
        return { status: 'ambiguous', proposed, candidates: candidates.sort() };
    return { status: 'unknown', proposed };
}
/**
 * Render the vocabulary as a compact, promptable list. This is what makes the vocabulary \emph{discoverable} to a
 * distiller: it can be shown the signals that exist before being asked to choose a facet, instead of guessing.
 * Bounded by `max` so a large store cannot blow a prompt budget; the most-declared signals come first, and the
 * count is reported so a reader can tell a load-bearing scope from a one-off tag.
 */
export function renderScopeVocabulary(vocab, max = 40) {
    if (vocab.entries.length === 0)
        return '(no signals observed in this store yet)';
    const shown = vocab.entries.slice(0, max);
    const body = shown.map((e) => `${e.signal} (${e.assetCount})`).join(', ');
    const omitted = vocab.entries.length - shown.length;
    return omitted > 0 ? `${body}, ... and ${omitted} more` : body;
}