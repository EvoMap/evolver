import type { Strategy } from '../strategy/strategyPoint.js';
import { StrategyPoint } from '../strategy/strategyPoint.js';
import { type GeneHealth } from './geneHealth.js';
import type { GeneLearningView } from '../assetstore/learningHistory.js';
import type { AssetRecord } from '../assetstore/provider.js';
import { type ExplorationInput } from './exploration.js';
import type { GenerationSource } from '../wire/index.js';
import type { MemoryGraphGeneEvidence } from './memoryGraph.js';
import { UCB1_REWARD_POLICY_VERSION, UCB1_SELECTION_POLICY_VERSION, type SelectionPolicy, type Ucb1Choice, type Ucb1FallbackReason } from './ucb1.js';
/** 一个候选 gene 的选择期素材. */
export interface GeneCandidateInput {
    geneId: string;
    /**
     * Content asset_id (sha256:…) of this candidate, when distinct from the logical geneId. Optional. Lets the
     * cross-runtime reuse map (#268, keyed by reuse-event assetId) match a candidate by EITHER id — local genes
     * supply it from their record; an injected hub candidate can carry it so it is matched on the same footing.
     */
    assetId?: string;
    signalsMatch: readonly string[];
    view: GeneLearningView;
    reuseCount?: number;
    antiPatternCount?: number;
    /** Optional gene category/summary for semantic tag expansion (signal-expansion recall, ported from v1). */
    category?: string;
    summary?: string;
    /**
     * Full hub-fetched Gene payload, when an adapter injects a transient reuse candidate. Selection never reads this;
     * autoexec uses it to land the asset through the provenance/review gates before the candidate can be executed.
     */
    hubAsset?: AssetRecord;
    /** Epigenetic penalty for the current environment class (subtracted from score; computed upstream, ported from v1). */
    epigeneticPenalty?: number;
    /**
     * Preferred-gene confidence in [0,1] for the current signal fingerprint (added to score; positive cross-cycle
     * learning, computed upstream from the confidence sidecar, ported from v1). A gene that keeps succeeding under
     * the same signals is nudged up. This is a SOFT re-ordering factor only: it is applied to the same candidate
     * set the hard gates already produced, so a high confidence can never resurrect a gene that was excluded.
     */
    confidence?: number;
    /** Scoped local MemoryGraph outcome signal in [-1,1]. Data-only and never executable prompt content. */
    memoryBoost?: number;
    /**
     * Cross-runtime reuse sentiment in [-1, 1] for this gene (#268 phase 1): the net of self-reported reuse
     * SUCCESSes vs negatives (failed/mismatched/stale/unsafe), computed upstream from reuse-outcome events
     * (reuseAdjustFromSummary). A SOFT, bounded re-order factor — added with a small weight and clamped — so this
     * weak, self-reported signal can nudge near-ties (and down-rank a gene foreign agents keep finding unhelpful)
     * yet can NEVER override the hard gates (trust/review/ban run in assembly, before scoring). Absent → 0 → no
     * effect, so the factor is dormant until a caller injects the signal (default-off).
     */
    reuseAdjust?: number;
    /**
     * Authoritative provenance tag from Gene.generation_meta.source. The legacy `gene_distilled_` prefix remains a
     * fallback only for old candidates that do not carry this field.
     */
    generationSource?: GenerationSource;
    /**
     * Assembly-owned UCB1 eligibility. Only trusted approved/legacy-local candidates may set true. Injected callers
     * must not self-assert this bit; candidateAssembly overwrites Hub candidates to false.
     */
    explorationEligible?: boolean;
}
export interface SelectionInput {
    signals: readonly string[];
    candidates: readonly GeneCandidateInput[];
    /** Trust-filtered library corpus captured before relevance admission. Omit for direct strategy callers. */
    semanticCorpus?: readonly GeneCandidateInput[];
    /** Emergency rollback: restore the pre-IDF semantic scorer and skip profile construction. */
    disableSemanticIdf?: boolean;
    /** 低于此分则不选(→ 走 innovate 新基因), 默认 0. */
    floor?: number;
    /** Relevance guard rollout. Omit for legacy selector behavior in direct/core callers. */
    selectionGuard?: SelectionGuardMode;
    /**
     * Explicit gene requested by GEP / an external runtime. This is a hard selection only within the already
     * assembled candidate/fallback pools: it cannot resurrect a gene filtered by trust/review/ban upstream, and it is
     * refused here when the entry is epigenetically suppressed for the current environment. Accepts either logical
     * geneId or content assetId.
     */
    forcedGeneId?: string;
    /** Exploration control (drift / plateau override). Absent → deterministic top-score selection (ported from v1). */
    exploration?: ExplorationInput;
    /**
     * Distilled-gene fallback pool (ported from v1 #97): broadly-applicable distilled genes that do NOT match the
     * live signals, supplied by the assembly layer (already trust/review/ban-filtered) so they never compete in the
     * normal scored set. Used ONLY after normal selection has no reusable positive choice (the legacy non-positive
     * pool or an enforced no-match guard): instead of falling through to a blind innovate, selection reuses a known
     * distilled strategy. Epigenetically-suppressed entries
     * (epigeneticPenalty > 0) are skipped — v2's event-log-derived epigeneticPenalty is the analog of v1's asset-mark
     * hard suppression (a related band, not the identical predicate).
     */
    distilledFallback?: readonly GeneCandidateInput[];
    /**
     * Non-executable negative memory matched for the current signals. These warnings are carried into the decision
     * for prompt rendering only; they never enter scoring, fallback, or forced selection.
     */
    antiWarnings?: readonly AntiWarning[];
    /** Structured, scoped outcome evidence selected upstream. Contains no raw memory text or instructions. */
    memoryEvidence?: readonly MemoryGraphGeneEvidence[];
}
export interface ScoredCandidate {
    geneId: string;
    assetId?: string;
    score: number; /** Internal expanded match in [0,1]; omitted from root-event candidate payloads. */
    matchScore?: number;
    reasons: string[];
    health?: GeneHealth;
}
export interface AntiWarning {
    antiGeneId: string;
    assetId?: string;
    trigger: readonly string[];
    avoid: readonly string[];
    summary?: string;
    severity?: 'low' | 'medium' | 'high';
    rationale?: string;
}
/** 可解释的选择决策(禁黑盒, 军杰§9.4): 带 candidates/scores/reasons/weightsVersion. */
export interface GeneDecision {
    selectedGeneId: string | null;
    /** Content asset_id for the selected candidate when known. Preserves exact forced-by-asset execution semantics. */
    selectedAssetId?: string;
    candidates: ScoredCandidate[];
    /** Advisory-only AntiGene guardrails; never selected, executed, or attributed as used genes. */
    antiWarnings?: AntiWarning[];
    weightsVersion: string;
    strategyName: string;
    /** Human-readable explanation for the winning candidate. */
    selectedReason?: string;
    /** Bounded structured outcome evidence for prompt enrichment. */
    memoryEvidence?: MemoryGraphGeneEvidence[];
    /** Deterministic identity of the bounded IDF profile used for this decision. */
    semanticProfileVersion?: string;
    /** Number of trusted semantic documents represented by the profile. */
    semanticDocumentCount?: number;
    /** Compact policy trace; omitted for the default engine-health behavior. */
    selectionPolicy?: SelectionPolicyTrace;
    /** Versioned relevance guard trace; omitted only for explicit legacy rollback. */
    selectionGuard?: SelectionGuardTrace;
}
export interface SelectionPolicyTrace {
    requested: Exclude<SelectionPolicy, 'engine-health'>;
    effective: 'engine-health' | 'ucb1';
    selectionPolicyVersion: typeof UCB1_SELECTION_POLICY_VERSION;
    rewardPolicyVersion: typeof UCB1_REWARD_POLICY_VERSION;
    arm?: Ucb1Choice;
    shadowArmId?: string;
    shadowDisagrees?: boolean;
    fallbackReason?: Ucb1FallbackReason;
}
export type SelectionGuardMode = 'legacy' | 'shadow' | 'enforce';
export declare const SELECTION_GUARD_VERSION = "relevance-guard-v1";
export type SelectionGuardReason = 'no_match' | 'plateau_flat_match';
export type SelectionGuardStatus = 'allowed' | 'shadow' | 'forced' | 'ucb1' | 'fallback' | 'innovate';
export interface SelectionGuardTrace {
    mode: Exclude<SelectionGuardMode, 'legacy'>;
    version: typeof SELECTION_GUARD_VERSION;
    status: SelectionGuardStatus;
    reason?: SelectionGuardReason;
    maxMatch?: number;
    matchSpread?: number;
}
/**
 * Weight of the preferred-gene confidence factor (fourth factor, positive cross-cycle learning). Kept small so
 * it only re-orders near-ties between already-eligible candidates rather than overriding health / signal match.
 */
export declare const CONFIDENCE_WEIGHT = 0.15;
/**
 * Weight of the cross-runtime reuse-sentiment factor (#268 phase 1). Deliberately SMALLER than CONFIDENCE_WEIGHT:
 * a self-reported reuse outcome is weaker evidence than the confidence sidecar (which is built from verified cycle
 * history), so it only re-orders near-ties. Clamped to a [-1,1] sentiment, so its contribution is bounded to
 * ±REUSE_WEIGHT and can never dominate health/signal-match.
 */
export declare const REUSE_WEIGHT = 0.1;
/** Weight of scoped local MemoryGraph outcome evidence. */
export declare const MEMORY_GRAPH_WEIGHT = 0.12;
/** Bounded weight for a canonical task-domain signal match (#628). */
export declare const TASK_DOMAIN_WEIGHT = 0.08;
/** signals_match is weak domain evidence; its maximum score contribution is 0.08 * 0.5 = 0.04. */
export declare const TASK_DOMAIN_SIGNAL_EVIDENCE = 0.5;
/**
 * Version of the full engine-health weight vector (health 0.6 + signal-match 0.4 − epigenetic penalty
 * + CONFIDENCE_WEIGHT × confidence + REUSE_WEIGHT × reuse-sentiment). Bumped whenever a factor is added so golden
 * weight snapshots track the change. Composed from the health-weights version so a change to either layer shows.
 */
export declare const LEGACY_SELECTION_WEIGHTS_VERSION = "sel-5-domain(gh-2,conf=0.15,memory=0.12,reuse=0.1,domain=0.08)";
export declare const SELECTION_WEIGHTS_VERSION = "sel-6-idf-domain(gh-2,conf=0.15,memory=0.12,reuse=0.1,domain=0.08)";
interface SelectionGuardAssessment {
    wouldAbstain: boolean;
    reason?: SelectionGuardReason;
    maxMatch?: number;
    matchSpread?: number;
}
/** Refs #626: identify selections whose relevance is absent or cannot discriminate during a plateau. */
export declare function assessSelectionGuard(scored: readonly ScoredCandidate[], plateauActive: boolean): SelectionGuardAssessment;
/** 实现1: engine 健康分主导(health 0.6 + 信号匹配 0.4). */
export declare const engineHealthSelection: Strategy<SelectionInput, GeneDecision>;
/** 实现2: 纯信号匹配采样(忽略 health, 对照基线 — 经验主义要可对比). */
export declare const signalMatchSelection: Strategy<SelectionInput, GeneDecision>;
/** 实现3: agent 主导(注入决策回调; engine 只给候选+分, agent 拍板, D26 agent 一等公民). */
export declare function agentLedSelection(pick: (scored: ScoredCandidate[], input: SelectionInput) => string | null): Strategy<SelectionInput, GeneDecision>;
/** 选 gene StrategyPoint: 默认 engine-health, 备选 signal-match(+ 可注册 agent-led). */
export declare function makeGeneSelectionPoint(): StrategyPoint<SelectionInput, GeneDecision>;
export {};