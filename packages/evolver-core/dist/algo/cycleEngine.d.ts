import type { Ingestor } from '../events/ingest.js';
import type { ProblemPattern } from '../schema/problem.js';
import type { GepCategory, Mutation, Capsule, EvolutionEvent } from '../wire/index.js';
import type { AssetStoreProvider } from '../assetstore/provider.js';
import type { StrategyPoint } from '../strategy/strategyPoint.js';
import { type CycleStage } from '../cycle/stateMachine.js';
import { type GeneDecision, type SelectionInput, type GeneCandidateInput, type AntiWarning } from './geneSelection.js';
import { type EnvFingerprint } from '../bootstrap/envFingerprint.js';
import type { PersonalityStore } from '../personality/store.js';
import { type ResolutionStatus } from './solidify.js';
import type { ProofOfWork } from '../schema/proofOfWork.js';
import { type ClassifyRecentEvent } from './cycleFailureClassifier.js';
export interface TriggerEval {
    trigger: boolean;
    reasons: string[];
    valueScore: number;
}
export interface ExecutionResult {
    outcome: {
        status: 'success' | 'failed';
        score: number;
        reason?: string;
    };
    proofOfWork?: ProofOfWork;
    strongEvidence?: boolean;
    /**
     * The agent run's transcript (stdout, plus stderr when present), attached by the execution layer on a FAILED
     * outcome. It is the host-side context classifyCycleFailure needs to reach the host_no_transcript /
     * host_provider_error buckets on the PRODUCTION path (#279): an empty transcript means the host gave evolver
     * nothing to evolve from; a provider-error string (429 / quota / context-length) means the host's LLM call
     * failed, not the gene. Consumed only for failure triage and NEVER persisted to event payloads (the engine
     * writes only the derived failure_class), so it adds no root_events bloat and leaks no transcript content.
     */
    sessionLog?: string;
}
export interface SolidifyPermitContext {
    cycleId: string;
    geneId: string;
    signals: readonly string[];
    mutation: Mutation;
    decision: GeneDecision;
    outcome: ExecutionResult['outcome'];
    proofOfWork?: ProofOfWork;
    strongEvidence?: boolean;
}
export type SolidifyPermitDecision = {
    ok: true;
    reason?: string;
} | {
    ok: false;
    reason: string;
    detail?: string;
};
export type SolidifyPermitGate = (ctx: SolidifyPermitContext) => Promise<SolidifyPermitDecision> | SolidifyPermitDecision;
export interface CycleEngineDeps {
    ingestor: Ingestor;
    selection: StrategyPoint<SelectionInput, GeneDecision>;
    store: AssetStoreProvider;
    now: () => number;
    /** Injected randomness for exploration drift (deterministic tests). Defaults to Math.random inside selection. */
    rng?: () => number;
    /** Injected environment fingerprint (deterministic tests). Defaults to capturing the real runtime env. */
    envFingerprint?: () => EnvFingerprint;
    /** 触发评估(常注入 TriggerEngine.evaluate 的包装; 缺省=直接触发). */
    trigger?: (p: ProblemPattern, now: number) => Promise<TriggerEval> | TriggerEval;
    /** 可进化人格(可选). 注入后, 每轮:
     *   - 轮首: (平台期?先 applyForcePivot→personality.pivoted) → applySelectForRun 自然选择+触发变异
     *     (personality.mutated), 落盘, 选出的状态喂 personality.selected + 人格风险闸(personality.risk_gated),
     *     并被 exec bridge 读回注入 prompt(用途①).
     *   - 轮尾(拿到 outcome 后): applyStatsUpdate 把本轮 outcome/score 回写到当轮所用人格桶
     *     (personality.stats_updated); v1 语义: 只动 stats/history, 不挪 current.
     *  缺省 ⇒ 完全不改现有行为(逐字向后兼容). 人格只调"风格/风险", 不改"选哪个 gene / 做什么"——
     *  与 valueModel/gene 选择共存而非互斥. */
    personality?: PersonalityStore;
}
export interface CycleInput {
    cycleId: string;
    problem: ProblemPattern;
    signals: readonly string[];
    category: GepCategory;
    /** Optional explicit strategy preset name; when set, it wins over history-derived meta-signal auto-detection. */
    strategyName?: string;
    candidates: readonly GeneCandidateInput[];
    selectionFloor?: number;
    /**
     * Explicit GEP/runtime-selected gene. Forwarded after candidate assembly and local hard filters, so it cannot
     * bypass trust/review/ban; selection still rejects an env-suppressed candidate.
     */
    forcedGeneId?: string;
    target: string;
    expectedEffect: string;
    summary: string;
    confidence: number;
    execute: (mutation: Mutation, decision: GeneDecision) => Promise<ExecutionResult> | ExecutionResult;
    /** Optional adapter/runtime permit gate. Runs after execute succeeds and before solidify writes assets. */
    solidifyPermit?: SolidifyPermitGate;
    /**
     * Distilled-gene fallback pool (ported from v1 #97): broadly-applicable distilled genes that do NOT match the
     * live signals, assembled (trust/review/ban-filtered) upstream. Forwarded to selection, which uses one only as a
     * last resort when no candidate clears the floor — reusing a known distilled strategy instead of a blind innovate.
     */
    distilledFallback?: readonly GeneCandidateInput[];
    /** Advisory-only AntiGene warnings matched upstream for this cycle's base signals. */
    antiWarnings?: readonly AntiWarning[];
    /**
     * Optional triage context for the cycle.failed event (PORT v1 #279 issue-reporter half). When the caller can
     * supply a session transcript or a list of recent failed cycles, classifyCycleFailure runs and the resulting
     * `failure_class` is written onto cycle.failed payloads. Inert handling (V2 #216) is untouched — this is purely
     * additive metadata. When absent, host transcript classification stays off; V2-local no-blast classification may
     * still run from the current failed gene + capsule blast radius.
     *
     * This is the EXTERNAL/test injection path. The PRODUCTION host transcript no longer comes through here: the
     * execution layer (claudeBridge) attaches the agent transcript to ExecutionResult.sessionLog on a failed
     * outcome, and the failed-write site feeds THAT into classifyCycleFailure (#279 wiring). So host_no_transcript /
     * host_provider_error now fire on the real autonomous path. failureContext remains for callers that supply a
     * transcript or recentFailedEvents out-of-band (and for tests). local_gene_no_blast runs in production from the
     * current gene + capsule blast radius and needs neither.
     */
    failureContext?: {
        sessionLog?: string;
        recentFailedEvents?: readonly ClassifyRecentEvent[];
    };
}
export interface CycleResult {
    cycleId: string;
    triggered: boolean;
    finalStage: CycleStage;
    decision?: GeneDecision;
    mutation?: Mutation;
    capsule?: Capsule;
    event?: EvolutionEvent;
    resolutionStatus?: ResolutionStatus;
    reasons: string[];
}
/**
 * cycle engine(M4A-1d): signals → trigger → 选 gene → mutation → 执行 → solidify → Capsule + EvolutionEvent.
 * 每阶段 emit root_events 并校验状态机迁移; 写入序列守硬化 A4(capsule asset_id 先 → 填 capsule_id → event asset_id).
 */
export declare class CycleEngine {
    private readonly deps;
    constructor(deps: CycleEngineDeps);
    runCycle(input: CycleInput): Promise<CycleResult>;
}