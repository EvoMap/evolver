import type { AssetStoreProvider } from '../assetstore/provider.js';
import type { ProvenanceStore } from '../assetstore/provenance.js';
import type { ReviewLedger } from '../assetstore/reviewLedger.js';
import type { GepCategory } from '../wire/index.js';
import type { ProblemPattern } from '../schema/problem.js';
import type { GeneCandidateInput, SelectionGuardMode } from './geneSelection.js';
import { CycleEngine, type CycleInput, type CycleResult, type SolidifyPermitGate } from './cycleEngine.js';
import { type PendingSignalsContext } from '../assetstore/pendingSignals.js';
import { type ReuseOutcomeSummary, type ReuseOutcomeEvent } from '../ops/reuseOutcomes.js';
import type { MemoryGraphAdvice } from './memoryGraph.js';
import type { SelectionPolicy } from './ucb1.js';
export interface RunCycleOptions {
    cycleId: string;
    problem: ProblemPattern;
    signals: readonly string[];
    category: GepCategory;
    /** Optional explicit strategy preset name forwarded to CycleEngine. */
    strategyName?: string;
    target: string;
    expectedEffect: string;
    summary: string;
    confidence: number;
    selectionFloor?: number;
    /** Emergency rollback for semantic IDF. Also skips pre-admission corpus collection. */
    disableSemanticIdf?: boolean;
    /** Experimental plateau policy. Omit for current engine-health + random drift behavior. */
    selectionPolicy?: SelectionPolicy;
    /** Versioned relevance-guard rollout. Omit for legacy direct-call behavior. */
    selectionGuard?: SelectionGuardMode;
    /** Optional explicit gene chosen by GEP / an external runtime; forwarded to CycleEngine after assembly. */
    forcedGeneId?: string;
    /** The agent runtime's work: run the mutation, return the outcome. */
    execute: CycleInput['execute'];
    /** Optional triage context forwarded to CycleEngine for cycle.failed classification. */
    failureContext?: CycleInput['failureContext'];
    /** Optional adapter/runtime permit gate. Runs after execute succeeds and before solidify writes assets. */
    solidifyPermit?: SolidifyPermitGate;
    /** Cap on how many genes are pulled from the store as candidates. */
    candidateLimit?: number;
    /** Trust-first selection (#30): exclude hub-ingested genes unless promoted. */
    provenance?: ProvenanceStore;
    /** Review-first selection (#89/#91): exclude quarantined/rejected auto-distilled drafts. */
    review?: ReviewLedger;
    /** Probation (#306, gated): let a quarantined draft be TRIED to earn evidence (rejected stays out). Default off. */
    includeProbation?: boolean;
    /**
     * Reuse-before-solve hub candidates (#110): already-resolved hub assets (the adapter's free search →
     * pure score → paid fetch flow) injected to compete in the SAME selection pool as local genes. Core stays
     * hub-agnostic — it only forwards these into assembleCandidates, which merges them trust-first (a geneId
     * colliding with a trusted local gene keeps the local one). Omit (the default) → no hub candidates → exactly
     * today's behavior. The hub call/billing/cache all live in the adapter; this is the in-cycle injection point.
     */
    hubCandidates?: readonly GeneCandidateInput[];
    /** Optional v1-compatible pending_signals.json path context. */
    pendingSignalsContext?: PendingSignalsContext;
    /** Disable only when the caller already consumed pending_signals.json before invoking this cycle. */
    consumePendingSignals?: boolean;
    /**
     * Cross-runtime reuse-outcome summary (#268 phase 1): when provided, it is mapped to a per-gene sentiment that
     * SOFTLY re-orders selection (down-rank genes foreign agents keep finding unhelpful, up-rank ones they reuse
     * successfully). Omit (the default) → no reuse re-order → exactly today's behavior. The signal is computed by
     * the composition layer from reuse-outcome events; core just folds it into the selection pool here.
     */
    reuseOutcomes?: ReuseOutcomeSummary;
    /**
     * Observed `value.recall` events (#274 slice 3): folded into the same soft re-order as reuse outcomes, at a lower
     * weight (RECALL_WEIGHT) — `used` nudges up, `unused` nudges down. This is how transcript-OBSERVED recall (not
     * agent self-report) gains teeth on selection. Omit → no recall contribution. Never feeds quarantine.
     */
    recallEvents?: readonly ReuseOutcomeEvent[];
    /** Scoped local MemoryGraph query result. Omit to keep selection unchanged. */
    memoryGraphAdvice?: MemoryGraphAdvice;
}
/** Drive one full evolution cycle end-to-end: assemble candidates from the store, then run the cycle. */
export declare function runEvolutionCycle(engine: CycleEngine, store: AssetStoreProvider, opts: RunCycleOptions): Promise<CycleResult>;