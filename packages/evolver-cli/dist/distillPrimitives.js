// Distill primitives (#117 A1) — the PURE session→gene-draft logic, extracted from runIngest so the one-shot
// `evolver ingest --distill` and the live distillObserver reuse ONE copy (no forked distill logic). Zero behavior
// change vs the inline version: same tokens, same step drafting, same candidate shape. No I/O — the caller parses
// the session into turns + extracts signals; this turns them into a draft GeneCandidate (or null when too thin).
import { algo } from '@evomap/evolver-core';
// Map a strong signal's free-text to a SHORT, matchable token (so a gene's signals_match stays a few
// keywords, not a dumped error blob). Deterministic + testable; unknown errors fall back to the tool name only.
const SIGNAL_ERROR_CLASSES = [
    [/exit code:?\s*[1-9]/i, 'exit-code'],
    [/ENOENT|no such file|does not exist|cannot access|did not match/i, 'file-not-found'],
    [/command not found/i, 'command-not-found'],
    [/Traceback|Exception|panic:/i, 'exception'],
    [/SyntaxError/i, 'syntax-error'],
    [/permission denied/i, 'permission-denied'],
    [/timed?\s?out/i, 'timeout'],
];
/** Short matchable signal tokens from the STRONG signals only (toolName + a known error class). Every strong
 *  signal yields ≥1 token: if it has no toolName and matches no known error class (e.g. `FAILED: …` or
 *  `Error: connection refused`), it falls back to its kind (`structured_error`/`error_result`) so a real strong
 *  signal is never silently tokenless — keeping `signals_match.length === 0` an honest "no strong signal" gate.
 *  Deduped, ≤8. */
export function signalTokens(sigs) {
    const set = new Set();
    for (const s of sigs) {
        if (s.strength !== 'strong')
            continue;
        let matched = false;
        if (s.toolName) {
            set.add(s.toolName);
            matched = true;
        }
        for (const [re, tok] of SIGNAL_ERROR_CLASSES)
            if (re.test(s.text)) {
                set.add(tok);
                matched = true;
                break;
            }
        if (!matched)
            set.add(s.kind);
    }
    return [...set].slice(0, 8);
}
/** Trim free text to a clean step: collapse whitespace, and when longer than `cap` keep as much as fits, cutting
 *  at the last word boundary within the cap (marked `…`) — never mid-word, and never shorter than the cap allows
 *  (an earlier sentence end is NOT preferred, so substance later in the turn is not dropped). */
function trimToBoundary(text, cap = 200) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length <= cap)
        return t;
    const slice = t.slice(0, cap);
    const sp = slice.lastIndexOf(' ');
    return `${(sp > 0 ? slice.slice(0, sp) : slice).trim()}…`;
}
/** Narration openers ("let me take a look / check / see …") — the agent saying it will go inspect. */
const NARRATION_OPENER = /^(let me (take a (closer )?)?look|let me (check|see|inspect|investigate)|i'?ll (take a look|check|look|see)|let'?s (take a )?(look|see)|now,? let me (look|check|see))\b/i;
/** Reusable substance: a named cause, a decision/action verb, or a concrete code target (path / `code`). A turn
 *  that opens with narration is dropped ONLY when it has none of these — so "let me check … the root cause is X,
 *  fix by Y" keeps its substantive remainder rather than being discarded for its opener. */
const HAS_SUBSTANCE = /\b(because|so that|root cause|the (issue|bug|problem|fix|error)|fix(ed|es|ing)?|add(ed|ing)?|remov(e|ed|ing)|delet(e|ed|ing)|chang(e|ed|ing)?|updat(e|ed|ing)?|replac(e|ed|ing)?|renam(e|ed|ing)?|implement(ed|ing)?|revert(ed)?|switch(ed|ing)?|configur(e|ed|ing)?|install(ed|ing)?|return(s|ed)?|throw(s|n)?|catch|wrap(ped)?|guard|import(ed|s)?|export(ed|s)?|re-?run|retry|set\s)\b/i;
function isNarrationOnly(raw) {
    return NARRATION_OPENER.test(raw) && !HAS_SUBSTANCE.test(raw) && !/[`]|[\w/-]+\.[a-z]{2,5}\b|\/[\w./-]+/.test(raw);
}
/** When a turn opens with narration but states real substance, drop the leading narration sentence so the step
 *  LEADS with the cause/fix — otherwise the (capped) step could be narration while the substance is trimmed off.
 *  Keeps the original when there is no clean sentence split or the remainder is too thin to stand alone. */
function dropNarrationOpener(raw) {
    if (!NARRATION_OPENER.test(raw))
        return raw;
    const m = /^.*?[.!?。]\s+/.exec(raw);
    if (!m)
        return raw;
    const rest = raw.slice(m[0].length).trim();
    return rest.length >= 40 ? rest : raw;
}
/** Draft strategy steps = the agent's own substantive (non-meta) turns — boundary-trimmed (never chopped
 *  mid-word); turns that are PURELY narration ("let me look around" with no cause/action) are dropped, and a
 *  narration-opening turn that also states a cause/fix keeps that substance (its narration opener is stripped so
 *  the capped step leads with the fix). NOT fabricated: real transcript excerpts; the gene lands UNPROVEN and is
 *  curated by `review` + pruned by the cycle, so a noisy draft self-corrects. */
export function draftStrategy(turns) {
    const steps = [];
    const seen = new Set();
    for (const t of turns) {
        if (t.role !== 'assistant' || t.isMeta)
            continue;
        const raw = (t.text ?? '').replace(/\s+/g, ' ').trim();
        if (raw.length < 40)
            continue; // too short to be a step
        if (isNarrationOnly(raw))
            continue; // "let me look around" with no cause/action — not a strategy
        const step = trimToBoundary(dropNarrationOpener(raw));
        if (seen.has(step))
            continue;
        seen.add(step);
        steps.push(step);
    }
    return steps.slice(-6); // the latest substantive actions (closest to the resolution)
}
/**
 * Assemble an UNPROVEN draft GeneCandidate from a parsed session, or null when too thin to distill (no strong
 * signal OR no substantive step). The single source of the "what makes a draftable session" gate + candidate
 * shape, shared by `evolver ingest --distill` and the distillObserver so the two never drift. `sigs` is passed in
 * (already extracted by the caller) to avoid a second extraction pass.
 */
export function draftGeneCandidate(turns, sigs, agent) {
    const signals_match = signalTokens(sigs);
    const strategy = draftStrategy(turns);
    if (signals_match.length === 0 || strategy.length === 0) {
        const hit = algo.sniffConversationCapabilities(turns)[0];
        if (!hit)
            return null;
        const fallbackStrategy = hit.evidence;
        if (fallbackStrategy.length === 0)
            return null;
        return {
            category: 'innovate',
            signals_match: hit.signals,
            strategy: fallbackStrategy.slice(0, 6),
            summary: `Auto-drafted verified capability from ${agent} session (UNPROVEN — curate via review): ${hit.summary}`,
            preconditions: [
                'A live agent conversation explicitly described a reusable capability.',
                'The same conversation included validation or successful tool evidence.',
            ],
            validation: ['node --version'],
            generation_meta: { source: 'distilled' },
        };
    }
    return {
        category: 'repair',
        signals_match,
        strategy,
        summary: `Auto-drafted from ${agent} session (UNPROVEN — curate via review): ${signals_match.slice(0, 3).join(', ')}`,
        // A session-distilled gene has execution evidence (the session's turns) but no verified fail→pass-with-blast
        // trajectory → `distilled` per V1 #302 classifyProvenance. Tagged so future governance/selection can grade it
        // apart from evolved (solve→fail→mutate→pass) and manual (human-taught) genes.
        generation_meta: { source: 'distilled' },
    };
}
/**
 * Value/novelty gate run BEFORE a draft is quarantined (#117 improvement 3). `intakeGene` already rejects
 * empty/structurally-invalid candidates and EXACT signal subsets (fullyOverlaps), but two kinds of noise still
 * reach the human review queue: drafts too thin to be worth reviewing (one weak signal, one vague step), and
 * near-duplicates that escape the subset check by carrying one extra signal. Unattended auto-distill turns that
 * trickle into a flood, and a review gate nobody reads is no gate. This adds a substance floor + a SOFT similarity
 * reject. Pure and deterministic; the caller decides what to do with a non-admit (skip, never an error).
 */
export function assessDraftAdmission(candidate, existing = [], opts = {}) {
    const minSignals = opts.minSignals ?? 2;
    const minStrategy = opts.minStrategy ?? 1;
    const maxSimilarity = opts.maxSimilarity ?? 0.6;
    const sigs = [...new Set((candidate.signals_match ?? []).map((s) => String(s).toLowerCase()).filter(Boolean))];
    const strategy = (candidate.strategy ?? []).filter((s) => String(s).trim());
    if (sigs.length < minSignals)
        return { admit: false, reason: `too few signals (${sigs.length} < ${minSignals})` };
    if (strategy.length < minStrategy)
        return { admit: false, reason: `strategy too thin (${strategy.length} < ${minStrategy} steps)` };
    const newSet = new Set(sigs);
    for (const eg of existing) {
        const egSet = new Set((eg.signals_match ?? []).map((s) => String(s).toLowerCase()).filter(Boolean));
        if (egSet.size === 0)
            continue;
        const inter = [...newSet].filter((s) => egSet.has(s)).length;
        const union = new Set([...newSet, ...egSet]).size;
        const jaccard = union ? inter / union : 0;
        if (jaccard >= maxSimilarity)
            return { admit: false, reason: `near-duplicate of ${eg.id ?? '?'} (similarity ${jaccard.toFixed(2)})` };
    }
    return { admit: true };
}