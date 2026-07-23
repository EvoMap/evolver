import { algo, type signals } from '@evomap/evolver-core';
import type { NormalizedTurn } from '@evomap/evolver-runtime-adapters';
/** Short matchable signal tokens from the STRONG signals only (toolName + a known error class). Every strong
 *  signal yields ≥1 token: if it has no toolName and matches no known error class (e.g. `FAILED: …` or
 *  `Error: connection refused`), it falls back to its kind (`structured_error`/`error_result`) so a real strong
 *  signal is never silently tokenless — keeping `signals_match.length === 0` an honest "no strong signal" gate.
 *  Deduped, ≤8. */
export declare function signalTokens(sigs: readonly signals.ExtractedSignal[]): string[];
/** Draft strategy steps = the agent's own substantive (non-meta) turns — boundary-trimmed (never chopped
 *  mid-word); turns that are PURELY narration ("let me look around" with no cause/action) are dropped, and a
 *  narration-opening turn that also states a cause/fix keeps that substance (its narration opener is stripped so
 *  the capped step leads with the fix). NOT fabricated: real transcript excerpts; the gene lands UNPROVEN and is
 *  curated by `review` + pruned by the cycle, so a noisy draft self-corrects. */
export declare function draftStrategy(turns: readonly NormalizedTurn[]): string[];
/**
 * Assemble an UNPROVEN draft GeneCandidate from a parsed session, or null when too thin to distill (no strong
 * signal OR no substantive step). The single source of the "what makes a draftable session" gate + candidate
 * shape, shared by `evolver ingest --distill` and the distillObserver so the two never drift. `sigs` is passed in
 * (already extracted by the caller) to avoid a second extraction pass.
 */
export declare function draftGeneCandidate(turns: readonly NormalizedTurn[], sigs: readonly signals.ExtractedSignal[], agent: string): algo.GeneCandidate | null;
/** Minimal reference to an existing pool gene for the novelty check (id + its signals). */
export interface ExistingGeneSignals {
    id?: string;
    signals_match?: readonly string[];
}
export interface DraftAdmissionOptions {
    /** Reject a draft with fewer matchable signals than this (default 2): a single generic signal is too broad. */
    minSignals?: number;
    /** Reject a draft with fewer strategy steps than this (default 1, i.e. just non-empty like intakeGene; raise it
     *  for a stricter substance floor). A real fix can be one concrete step, so the default does not over-filter. */
    minStrategy?: number;
    /** Reject a draft whose signal-set Jaccard similarity to ANY existing gene is >= this (default 0.6).
     *  Signal sets are capped at 8 tokens, so two same-size sets differing by ONE token score 7/9 ≈ 0.78 —
     *  the old 0.8 default could never fire on the dominant draft shape (#562: 118-draft flood, max pairwise
     *  similarity exactly 0.78, zero rejections). 0.6 rejects shared-core near-dupes while genuinely
     *  cross-domain drafts (less than half the tokens shared) still pass. */
    maxSimilarity?: number;
}
export interface DraftAdmission {
    admit: boolean;
    reason?: string;
}
/**
 * Value/novelty gate run BEFORE a draft is quarantined (#117 improvement 3). `intakeGene` already rejects
 * empty/structurally-invalid candidates and EXACT signal subsets (fullyOverlaps), but two kinds of noise still
 * reach the human review queue: drafts too thin to be worth reviewing (one weak signal, one vague step), and
 * near-duplicates that escape the subset check by carrying one extra signal. Unattended auto-distill turns that
 * trickle into a flood, and a review gate nobody reads is no gate. This adds a substance floor + a SOFT similarity
 * reject. Pure and deterministic; the caller decides what to do with a non-admit (skip, never an error).
 */
export declare function assessDraftAdmission(candidate: algo.GeneCandidate, existing?: readonly ExistingGeneSignals[], opts?: DraftAdmissionOptions): DraftAdmission;