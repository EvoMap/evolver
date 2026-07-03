/** A minimal session turn shape (decoupled from the runtime-adapter NormalizedTurn so core needs no adapter import). */
export interface RecallTurn {
    /** 'assistant' = the agent's own output — the only place "the agent applied the strategy" can show. */
    role: string;
    text: string;
}
/** The distinctive content of an injected gene that recall is checked against. */
export interface GeneRecallInput {
    geneId: string;
    /** The gene's learned strategy steps — the strongest recall evidence when their distinctive terms reappear. */
    strategy?: readonly string[];
    /** The gene's one-line summary (secondary evidence). */
    summary?: string;
}
export type RecallVerdict = 'used' | 'unused' | 'unknown';
/** root_events type for an OBSERVED recall verdict (#274): derived from a session transcript (not agent self-report),
 *  so the experience loop learns which injected/fetched genes were actually applied. Distinct from the reuse-outcome
 *  events (which record whether a reused gene WORKED) — recall records whether it was USED at all. */
export declare const VALUE_RECALL_EVENT = "value.recall";
/** Payload of a `value.recall` root_event: one gene's observed recall verdict for a session. */
export interface RecallEventPayload {
    geneId: string;
    recalled: RecallVerdict;
    /** Fraction of the gene's distinctive terms found in the agent's output, in [0,1]. */
    score: number;
    /** The session this verdict was observed in (transcript-derived), for idempotency + attribution. */
    sessionId?: string;
}
export interface GeneRecallResult {
    geneId: string;
    /** used = the agent's output carries the gene's distinctive terms; unused = injected but ~no overlap;
     *  unknown = the gene has no distinctive content OR the session has no agent turns to judge against. */
    recalled: RecallVerdict;
    /** Fraction of the gene's distinctive terms that appear in the agent's output, in [0,1]. */
    score: number;
    /** The distinctive terms that were found in the agent's output (for explainability / audit). */
    matched: string[];
}
export interface RecallOptions {
    /** Minimum score to call a gene `used`. Default 0.3 — a third of the distinctive terms reappearing is a
     *  deliberate, conservative bar (above incidental single-word coincidence, below demanding verbatim echo). */
    threshold?: number;
    /** Drop terms at or below this length before matching (kills articles/operators that overlap by chance). Default 3. */
    minTermLength?: number;
}
/**
 * Decide whether an injected gene was recalled by the agent in a session. Pure: looks only at the gene's
 * distinctive terms (strategy + summary) and whether they reappear in the agent's OWN turns. We check assistant
 * turns specifically — the strategy text was injected into the prompt (user side), so finding it echoed in the
 * agent's output is the evidence that the agent actually carried it out, not just that we put it there.
 */
export declare function verifyGeneRecall(gene: GeneRecallInput, turns: readonly RecallTurn[], opts?: RecallOptions): GeneRecallResult;
/** Verify a batch of injected genes against one session's turns (the inject-attribution → recall closure). */
export declare function verifyInjectedGenes(genes: readonly GeneRecallInput[], turns: readonly RecallTurn[], opts?: RecallOptions): GeneRecallResult[];
/** Operator-facing rollup of a batch recall check. `pruneCandidates` are genes judged 'unused' (injected but the
 *  agent did not echo their strategy) — the ones that keep paying prompt budget for no observed effect. Never
 *  includes 'unknown' (no agent output / no distinctive terms — not judgeable, so not a prune signal). */
export interface RecallSummary {
    total: number;
    used: number;
    unused: number;
    unknown: number;
    pruneCandidates: string[];
}
export declare function summarizeRecall(results: readonly GeneRecallResult[]): RecallSummary;