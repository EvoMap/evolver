// Recall verification (v1 gap: recallVerifier) — the missing other half of the inject attribution rail.
//
// The `value.inject` event records WHICH genes were injected into a SessionStart prompt, but the ledger is
// "attribution-only": it never checks whether the agent ACTUALLY used the injected gene, so an injected-but-
// ignored gene looks the same as an injected-and-applied one. That makes inject a permanently weak signal and
// lets dead genes ride along, taxing the prompt budget for nothing.
//
// This is the verification primitive: given a gene's distinctive content and the session's turns, decide
// whether the gene was RECALLED (its strategy shows up in the agent's OWN output, i.e. the agent acted on it).
// It is PURE and deterministic — no live agent, no fs/clock — so it is fully unit-testable with fixtures, and it
// reads only data that already exists (the gene record + the session transcript turns). Wiring it onto the
// experience loop (emit a `value.recall` enrichment, prune never-recalled genes) is a separate, later slice; this
// module is just the decision function so the heuristic can be reviewed and tested in isolation first.
/** root_events type for an OBSERVED recall verdict (#274): derived from a session transcript (not agent self-report),
 *  so the experience loop learns which injected/fetched genes were actually applied. Distinct from the reuse-outcome
 *  events (which record whether a reused gene WORKED) — recall records whether it was USED at all. */
export const VALUE_RECALL_EVENT = 'value.recall';
// Common English + Chinese-pipeline filler that would create spurious overlap. Intentionally small: the goal is
// to remove obvious noise, not to do real NLP. Anything not filtered is fine — it only raises the matching bar.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'then', 'from', 'into', 'your', 'you', 'use', 'using', 'used',
    'when', 'will', 'should', 'must', 'have', 'has', 'are', 'was', 'were', 'not', 'but', 'all', 'any', 'can',
    'add', 'set', 'get', 'run', 'fix', 'via', 'per', 'its', 'it', 'a', 'an', 'to', 'of', 'in', 'on', 'or', 'is',
]);
// Light suffix stemmer so an inflected paraphrase still counts as recall ("cleared"→"clear", "retried"→"retry",
// "retrying"→"retry", "cookies"→"cookie"). Deliberately tiny — over-merging only widens matches slightly and the
// score threshold absorbs it; the alternative (exact match) misses the common case where the agent re-tenses the
// strategy verbs, which is exactly what "the agent applied it" looks like.
function stem(t) {
    if (t.length > 4 && t.endsWith('ied'))
        return `${t.slice(0, -3)}y`; // tried/retried → try/retry (verb form)
    if (t.length > 5 && t.endsWith('ing'))
        return t.slice(0, -3); // retrying → retry
    if (t.length > 4 && t.endsWith('ed'))
        return t.slice(0, -2); // cleared → clear
    // Plural -s: strip only the trailing 's' for a normal plural (cookies → cookie, sessions → session). 'es' is two
    // real letters ONLY after a sibilant (boxes → box, matches → match); elsewhere stripping 'es' over-strips
    // (cookies → cooki) and false-marks a plural paraphrase as unused (Bugbot), so gate the -es strip on a sibilant.
    // NOTE: a y→ies plural (retries → retry) is NOT handled — a tiny stemmer can't tell it from cookie+s; the verb
    // forms (retried/retrying) cover that gene, and the score threshold absorbs the occasional plural-noun miss.
    if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t))
        return t.slice(0, -2);
    // Plural -s, but NOT a singular lemma ending in 's': -ss (process/class), -us (focus/status/bonus), -is
    // (analysis/basis/crisis) are singular and must keep their 's', else gene "focus" stems to "focu" while the
    // agent's "focused" stems to "focus" and a real recall is missed (Bugbot; NB its "process" example was wrong —
    // process ends -ss, already excluded). Rare -us/-is plurals (menus/skis) lose a strip; acceptably uncommon.
    if (t.length > 4 && t.endsWith('s') && !/(?:ss|us|is)$/.test(t))
        return t.slice(0, -1);
    return t;
}
// A doubled-consonant -ing (committing→committ) hides the base verb (commit). We CANNOT destructively undouble in
// stem() — "calling"→"call" already matches and undoubling would wrongly break it to "cal" (regressing
// call/press/pass/fall/fill, verified). So instead, ONLY on the agent side, ADD the undoubled form as an EXTRA
// accepted variant: "committing" contributes {committ, commit} — "committ" is kept and "commit" is gained, nothing
// is lost (Bugbot -ing finding; note retrying→retry was never wrong). The variant is added by distinctiveTerms only
// when it clears minLen (so "calling" keeps "call" but the sub-minLen "cal" is dropped — see there).
function ingUndoubledVariant(raw, stemmed) {
    if (raw.length <= 5 || !raw.endsWith('ing') || stemmed.length < 3)
        return null;
    const last = stemmed[stemmed.length - 1];
    if (last === stemmed[stemmed.length - 2] && /[bcdfghjklmnpqrstvwxz]/.test(last))
        return stemmed.slice(0, -1);
    return null;
}
// Undouble an already-stemmed token (committ→commit, wrapp→wrap) for MATCH-TIME comparison only. The agent-side
// expansion above handles "agent gerund vs gene base"; this handles the mirror — a GENE gerund (committing→committ)
// vs an agent BASE (commit) — without adding a second gene term (which would inflate the recall denominator).
// "commit" base stems stay single-consonant so they return null; a genuine doubled base like "call"→"cal" only ever
// produces a variant the agent never emits, so it cannot create a false match.
function undoubledStem(s) {
    if (s.length < 4)
        return null;
    const last = s[s.length - 1];
    if (last === s[s.length - 2] && /[bcdfghjklmnpqrstvwxz]/.test(last))
        return s.slice(0, -1);
    return null;
}
/**
 * Lowercase + split on non-word-ish boundaries → distinctive STEMMED terms (stopwords + short tokens dropped,
 * deduped). With expandIng, also emits the undoubled -ing variant (agent side only) so a doubled-consonant
 * gerund still matches the base-verb gene term, without the destructive undouble that would regress call/press.
 */
function distinctiveTerms(text, minLen, expandIng = false) {
    const out = new Set();
    for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
        if (raw.length <= minLen)
            continue;
        if (STOPWORDS.has(raw))
            continue;
        const s = stem(raw);
        // A stem that collapses onto a stopword (fixing→fix, adding→add) is not distinctive, and the bare stopword
        // (fix/add) is dropped on the OTHER side (both stopword AND <=minLen), so keeping it here scores a phantom
        // miss for one side only. Drop stopword stems so the gene and agent sides agree (Bugbot).
        if (STOPWORDS.has(s))
            continue;
        out.add(s);
        if (expandIng) {
            const u = ingUndoubledVariant(raw, s);
            // Keep the undouble variant only when it is itself a distinctive term: length > minLen and not a stopword.
            // A <=minLen undouble (calling→cal, running→run) is intentionally dropped — gene terms are never that short
            // for a doubled-consonant base (the gene side yields "commit"/"wrap", not "run"), so it could match nothing.
            if (u && u.length > minLen && !STOPWORDS.has(u))
                out.add(u);
        }
    }
    return out;
}
/**
 * Decide whether an injected gene was recalled by the agent in a session. Pure: looks only at the gene's
 * distinctive terms (strategy + summary) and whether they reappear in the agent's OWN turns. We check assistant
 * turns specifically — the strategy text was injected into the prompt (user side), so finding it echoed in the
 * agent's output is the evidence that the agent actually carried it out, not just that we put it there.
 */
export function verifyGeneRecall(gene, turns, opts = {}) {
    const threshold = opts.threshold ?? 0.3;
    const minLen = opts.minTermLength ?? 3;
    const geneText = [...(gene.strategy ?? []), gene.summary ?? ''].join(' ');
    const terms = distinctiveTerms(geneText, minLen);
    const agentTurns = turns.filter((t) => t.role === 'assistant');
    // Cannot judge → unknown (never a false 'unused'): EITHER the gene has no distinctive content to look for, OR
    // there is no agent output at all to judge against. Gate on the PRESENCE of agent turns, not on whether they
    // yielded distinctive terms (Bugbot): an agent turn that exists but stems to nothing (stopword-only, or only
    // dropped short tokens like "401 ok") IS judgeable — the agent produced output that does not carry the gene,
    // i.e. 'unused', not 'unknown'. Conflating the two blurs the signal the downstream value.recall / pruning needs.
    if (terms.size === 0 || agentTurns.length === 0) {
        return { geneId: gene.geneId, recalled: 'unknown', score: 0, matched: [] };
    }
    const agentTerms = distinctiveTerms(agentTurns.map((t) => t.text).join(' \n '), minLen, true); // expandIng: agent side
    // A gene term matches when the agent set has it directly, OR has its undoubled base — so a gene gerund
    // ("committing"→"committ") still matches an agent base ("commit"). One match per gene term, denominator unchanged.
    const matched = [...terms].filter((t) => {
        if (agentTerms.has(t))
            return true;
        const u = undoubledStem(t);
        return u !== null && agentTerms.has(u);
    });
    const score = matched.length / terms.size;
    return { geneId: gene.geneId, recalled: score >= threshold ? 'used' : 'unused', score, matched };
}
/** Verify a batch of injected genes against one session's turns (the inject-attribution → recall closure). */
export function verifyInjectedGenes(genes, turns, opts) {
    return genes.map((g) => verifyGeneRecall(g, turns, opts));
}
export function summarizeRecall(results) {
    return {
        total: results.length,
        used: results.filter((r) => r.recalled === 'used').length,
        unused: results.filter((r) => r.recalled === 'unused').length,
        unknown: results.filter((r) => r.recalled === 'unknown').length,
        pruneCandidates: results.filter((r) => r.recalled === 'unused').map((r) => r.geneId),
    };
}