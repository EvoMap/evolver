import type { AssetStoreProvider } from '../assetstore/provider.js';
import type { ProvenanceStore } from '../assetstore/provenance.js';
import type { ReviewLedger } from '../assetstore/reviewLedger.js';
import type { Mutation } from '../wire/index.js';
import type { GeneDecision } from '../algo/geneSelection.js';
import type { ExecutionResult } from '../algo/cycleEngine.js';
import { type GeneResolver, type ValidateHook, type AgentRunnerOptions, type RunnerName, type AgentRunner, type GitRunner } from './claudeBridge.js';
import type { PersonalityStore } from '../personality/store.js';
import type { AgentRunTraceRecorder } from '../trace/learningTrace.js';
/**
 * Resolve a gene's strategy from the store and whether it is safe to EMBED into an autonomous agent's prompt —
 * the exec-side link from #30 (provenance ledger) and the review-state gate to #45 (requireTrustedGene gate). A
 * gene is embeddable only when BOTH axes pass: trusted ORIGIN (no provenance record → local/trusted; a hub one
 * is untrusted until promoted) AND review-APPROVED content (no review record → eligible; an auto-distilled draft
 * is quarantined until a human approves). Both default-open, so cycle-self-produced/local genes are unaffected;
 * only hub-ingested (untrusted) and auto-distilled (unreviewed) drafts are withheld. Looks up by id or asset_id.
 */
export declare function makeTrustedGeneResolver(store: AssetStoreProvider, provenance?: ProvenanceStore, review?: ReviewLedger, includeProbation?: boolean): GeneResolver;
export interface AutonomousSafety {
    /** Deny-by-default repo allowlist (#41). Required — an empty array refuses everything. */
    allowedRoots: readonly string[];
    /** Which built-in runner (#66). Default 'claude'. The same safety controls wrap whichever runner. cursor is a scaffold (unverified). */
    runner?: RunnerName;
    /** Agent runner options (#38/#40). Default: bounded skip-permissions (Read/Edit/Write). */
    agentOptions?: AgentRunnerOptions;
    /** Strip evolver/hub secrets from the agent env (#42). Default true. */
    scrubEnv?: boolean;
    /** Run in a throwaway git worktree (#43). Default 'worktree'. */
    isolation?: 'worktree' | 'none';
    /** Only embed trusted gene strategies (#45). Default true. */
    requireTrustedGene?: boolean;
    timeoutMs?: number;
    /** Cooperative cancellation propagated to the spawned runner process tree. */
    signal?: AbortSignal;
}
/**
 * Build the fully-hardened `execute` for an autonomous run against `repo`. Composes every exec-bridge control
 * with secure defaults so they can't be forgotten piecemeal: deny-by-default allowedRoots (#41) + worktree
 * isolation (#43) + env scrub (#42) + bounded skip-permissions agent (#38/#40) + trusted-gene gate fed by
 * provenance (#45/#30). Pass the result as runEvolutionCycle's `execute`.
 */
export declare function makeSafeExecute(repo: string, store: AssetStoreProvider, safety: AutonomousSafety, opts?: {
    provenance?: ProvenanceStore;
    review?: ReviewLedger;
    validate?: ValidateHook;
    validationCmds?: readonly string[];
    includeProbation?: boolean;
    personality?: PersonalityStore;
    agent?: AgentRunner;
    git?: GitRunner;
    /** Optional learning-trace recorder forwarded to the exec bridge (Learning Ops slice 2). */
    traceRecorder?: AgentRunTraceRecorder;
}): (mutation: Mutation, decision: GeneDecision) => Promise<ExecutionResult>;