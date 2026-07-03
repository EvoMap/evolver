import type { Mutation } from '../wire/index.js';
import type { GeneDecision } from '../algo/geneSelection.js';
import type { PersonalityStateInput } from '../personality/schema.js';
/** The slice of a selected gene that shapes the instruction (all optional — pass what the store has). */
export interface GeneStrategyInfo {
    strategy?: readonly string[];
    preconditions?: readonly string[];
    summary?: string;
    constraints?: {
        max_files?: number;
        forbidden_paths?: readonly string[];
    };
    /** Provenance: whether this gene's content is trusted enough to embed into an autonomous agent's prompt.
     *  The exec bridge's requireTrustedGene gate uses this; hub-ingested/unverified genes should be false. */
    trusted?: boolean;
    /** Reuse provenance (#113): when this strategy was fetched from the hub by reuse-before-solve (a HIT short-
     *  circuited a fresh solve), the source asset id. Surfaced in the prompt so the run — and the user reading it
     *  — sees that a ready-made solution was reused rather than re-derived. */
    reusedFromAssetId?: string;
}
/** Neutralize blatant injection directives in untrusted embedded text and cap its length (finding #39.3). */
export declare function sanitizeInjection(text: string, maxLen?: number): string;
export interface ExecPromptInput {
    mutation: Mutation;
    decision: GeneDecision;
    gene?: GeneStrategyInfo;
    /** Validation commands the change must pass, if the caller resolved a validation plan. */
    validationCmds?: readonly string[];
    /** Evolvable personality for this run — injected as a behavioral-style block (personality use-case ①).
     *  Absent ⇒ no style block (fully back-compatible). Pass the store's current state per run. */
    personality?: PersonalityStateInput | null;
}
/** Build the agent instruction. Deterministic: same input → same text (no clock, no randomness). */
export declare function renderExecPrompt(input: ExecPromptInput): string;