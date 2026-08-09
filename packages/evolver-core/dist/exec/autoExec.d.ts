import type { AssetStoreProvider } from '../assetstore/provider.js';
import { type ProvenanceStore } from '../assetstore/provenance.js';
import type { ReviewLedger } from '../assetstore/reviewLedger.js';
import type { GeneCandidateInput, SelectionGuardMode } from '../algo/geneSelection.js';
import type { CycleEngine, ExecutionFailureKind, SolidifyPermitGate } from '../algo/cycleEngine.js';
import { type AutonomousSafety } from './autonomousCycle.js';
import { type GitRunner, type ValidateHook } from './claudeBridge.js';
import type { AgentRunner } from './runnerRegistry.js';
import { type OpenPrLister } from './openPrRegistry.js';
import type { ReuseOutcomeSummary, ReuseOutcomeEvent } from '../ops/reuseOutcomes.js';
import type { PersonalityStore } from '../personality/store.js';
import type { MemoryGraphProvider } from '../algo/memoryGraph.js';
import type { SelectionPolicy } from '../algo/ucb1.js';
import { type LearningPacketSink, type TraceSink } from '../trace/learningTrace.js';
import type { TraceReadOptions } from '../trace/trajectoryExport.js';
export interface AutoExecTask {
    id: string;
    repo: string;
    target: string;
    expectedEffect: string;
    /** Explicit opt-in public context safe to send to the public Hub question generator. */
    publicQuestionContext?: string;
    signals: readonly string[];
    /** Optional learned strategy to seed as a local (trusted) gene for this task. */
    strategy?: readonly string[];
    /** Optional explicit gene id/asset id selected by GEP or the task source. */
    forcedGeneId?: string;
    /** Legacy/GEP aliases accepted at the autoexec boundary and normalized into forcedGeneId. */
    preferredGeneId?: string;
    selected_gene_id?: string;
    selectedGeneId?: string;
    /** Optional explicit strategy preset name for this task; wins over daemon default and meta-signal auto-detection. */
    strategyName?: string;
    validationCmds?: readonly string[];
}
export interface AutoExecVerdict {
    taskId: string;
    status: 'refused' | 'skipped' | 'solidified' | 'failed' | 'innovated';
    reason?: string;
    finalStage?: string;
    outcome?: {
        status: string;
        score: number;
    };
    proofOfWork?: unknown;
    failureKind?: ExecutionFailureKind;
    exitCode?: number | null;
    usedAssetIds?: readonly string[];
}
/**
 * Reuse-before-solve seam (#110): given the task's signals, resolve hub candidates worth competing in the
 * selection pool. This is a pure FUNCTION SIGNATURE — core deliberately does NOT import the adapter's
 * `reuseBeforeSolve` (that would breach the core-can't-import-adapter boundary). The real implementation
 * (free hub search → pure score → paid fetch → cache) is injected at the composition layer that already owns
 * the hub capability (the CLI/daemon), mirroring how the exec bridge's `agent` seam is injected. The seam is
 * optional: when absent, no hub candidates flow and the cycle behaves exactly as today (and makes ZERO hub
 * calls). It must never throw — reuse is an optimization, so a hub failure degrades to solving fresh.
 */
export interface HubReuseContext {
    /** The cycle this reuse resolution feeds — carried so the composition layer can emit a reuse event whose
     *  refs point at the SAME cycleId the cycle records (value-ledger audit anchor, #112). */
    cycleId: string;
}
export type HubReuseSeam = (signals: readonly string[], ctx?: HubReuseContext) => Promise<readonly GeneCandidateInput[]>;
export interface AutoExecDeps {
    engine: CycleEngine;
    store: AssetStoreProvider;
    provenance?: ProvenanceStore;
    /** Optional review-state gate: withhold an unreviewed (auto-distilled) gene's strategy from the agent prompt. */
    review?: ReviewLedger;
    /**
     * Probation (#306, gated): when set, a quarantined auto-distilled gene is BOTH selectable and embeddable, so it
     * is tried with its own strategy and its outcome becomes real evidence for auto-promote. Forwarded to selection
     * (includeProbation) AND to makeSafeExecute (the resolver embeds the probation strategy). Omit (default) → today's
     * behavior: quarantined drafts wait for human approval. Bad probation strategies are contained by the exec gates.
     */
    includeProbation?: boolean;
    /**
     * Optional reuse-before-solve seam (#110): when set, it is called before the cycle to pull hub candidates
     * that compete in the SAME pool as local genes (trust-first — a trusted local gene wins on a geneId
     * collision). Omit to disable (zero hub calls, exactly today's behavior). Injected by the composition layer
     * that owns the hub capability so core stays hub-agnostic (the signature, not the adapter, lives here).
     */
    hubReuse?: HubReuseSeam;
    /** Build a validation hook for a task (e.g. run its validationCmds in the worktree). Deployment-specific. */
    validate?: (task: AutoExecTask) => ValidateHook;
    /** Optional adapter/runtime permit gate. Core owns only the seam; adapters own the verification policy. */
    solidifyPermit?: SolidifyPermitGate;
    /**
     * Optional open-PR dedup: when set, before spawning an agent the task's signals are compared against open PR
     * titles/branches; a strong overlap yields a 'skipped' verdict so the daemon never re-implements work that is
     * already in flight. Opt-in — omit to disable. Wrap with makeCachedPrLister for a polling daemon.
     */
    prLister?: OpenPrLister;
    /** Min token-overlap for a PR to count as a duplicate (default 0.5). */
    dedupThreshold?: number;
    /**
     * Cross-runtime reuse-outcome summary (#268 phase 1 on-switch): when set, it SOFTLY re-orders gene selection by
     * how MCP-native agents fared reusing each gene (forwarded to runEvolutionCycle). Omit (the default) → no reuse
     * re-order → exactly today's behavior. The composition layer computes it from reuse-outcome events behind a flag.
     */
    reuseOutcomes?: ReuseOutcomeSummary;
    /** Observed `value.recall` events (#274 slice 3): folded into the same soft re-order as reuseOutcomes (lower
     *  weight) so transcript-observed recall influences selection. Forwarded to runEvolutionCycle. Omit → none. */
    recallEvents?: readonly ReuseOutcomeEvent[];
    /** Scoped local MemoryGraph seam. Queries and records structured outcome data only. */
    memoryGraph?: MemoryGraphProvider;
    /** Optional daemon-level explicit strategy preset name, e.g. EVOLVE_STRATEGY. */
    strategyName?: string;
    /** Emergency rollback for semantic IDF selection. Omit to keep IDF enabled. */
    disableSemanticIdf?: boolean;
    /** Experimental plateau selection policy. Omit to preserve engine-health + legacy drift. */
    selectionPolicy?: SelectionPolicy;
    /** Production relevance-guard rollout. Omit only for legacy/custom composition. */
    selectionGuard?: SelectionGuardMode;
    /** Optional score floor canary. Omit to keep the selector default of zero. */
    selectionFloor?: number;
    /** Optional evolvable personality store shared with CycleEngine and the exec prompt. */
    personality?: PersonalityStore;
    /** Test/custom seam: inject a runner instead of spawning a real agent. */
    agent?: AgentRunner;
    /** Test/custom seam: inject git instead of spawning git. */
    git?: GitRunner;
    /**
     * Learning trace (Learning Ops slice 2): when set, each task run gets its own AgentRunTraceRecorder
     * (traceId = the cycleId) emitting run.started/model.called/tool.failed/run.completed, and a
     * LearningPacket draft is submitted here after the cycle. Best-effort: trace/packet failures never
     * change the verdict. Omit → zero trace work, byte-identical to today.
     */
    learningTrace?: {
        /** Where packet drafts go (file/memory/hub-adapter implementation). */
        packetSink: LearningPacketSink;
        /** Optional live per-event sink (e.g. FileTraceSink JSONL tail). */
        traceSink?: TraceSink;
        /** Hub packet sourceRepo column; default 'evolver-v2'. */
        sourceRepo?: string;
        /**
         * Proxy llm_turn fold (Learning Ops slice 5): when set, after the cycle (and BEFORE run.completed, so
         * sequence order holds) the run's wall-clock window of proxy trace records is read from `dir`
         * (llm-trace-*.jsonl day-files) and folded into the recorder via recordLlmTurn — real per-request
         * model.called + tool.called/tool.failed detail instead of only the bridge's coarse spawn event.
         * Correlation is the time window + session-first-turn heuristic (see trace/proxyTurns.ts). Best-effort:
         * a missing dir / unreadable file / no proxy degrades to zero folded turns, never a verdict change.
         */
        proxyTraces?: {
            /** Proxy trace day-file dir (events/paths.ts tracesDir()). */
            dir: string;
            /** Decryption material for encrypted trace envelopes (allowPartial is always forced on). */
            readOptions?: TraceReadOptions;
            /** Injected clock for deterministic tests. Default Date.now. */
            now?: () => number;
        };
    };
}
export interface ForcedGeneFields {
    forcedGeneId?: unknown;
    preferredGeneId?: unknown;
    selected_gene_id?: unknown;
    selectedGeneId?: unknown;
}
export declare function canonicalForcedGeneId(task: ForcedGeneFields): string | undefined;
export declare function normalizeAutoExecTask(task: AutoExecTask): AutoExecTask;
/**
 * Run one autonomous task end to end with every safety control composed (makeSafeExecute). Deny-by-default:
 * if task.repo is not within safety.allowedRoots, returns a 'refused' verdict and runs nothing. Otherwise seeds
 * the task's strategy as a local (trusted) gene, then drives a real evolution cycle and maps the result.
 */
export declare function runAutoExecTask(deps: AutoExecDeps, rawTask: AutoExecTask, safety: AutonomousSafety): Promise<AutoExecVerdict>;
/**
 * Single-flight re-entrancy guard for a poll-driven resident loop. A resident autoexec daemon polls on an
 * interval; if a pass outlives the poll period (a hung/slow agent), the next tick must NOT start a second
 * overlapping pass — that piled up runaway nested agents in an early scratch run. Wrap the pass: while one is
 * in flight, subsequent calls return { skipped: true } immediately instead of starting another.
 */
export declare function singleFlight<T>(fn: () => Promise<T>): () => Promise<T | {
    skipped: true;
}>;
/**
 * Process tasks strictly SEQUENTIALLY (one at a time, never overlapping) through `runOne`, collecting verdicts.
 * Sequential by construction — an autonomous agent edits a worktree and runs tools; concurrent passes would
 * contend. Combine with {@link singleFlight} so a poll tick that fires mid-drain is skipped, not stacked.
 */
export declare function drainTasks<T, V>(tasks: readonly T[], runOne: (task: T) => Promise<V>): Promise<V[]>;