import { algo, type signals } from '@evomap/evolver-core';
import type { NormalizedTurn } from '@evomap/evolver-runtime-adapters';
/** Short matchable signal tokens from STRONG signals (error classes) and SUCCESS signals (verified capabilities).
 *  Every strong signal yields ≥1 token: if it has no toolName and matches no known error class (e.g. `FAILED: …` or
 *  `Error: connection refused`), it falls back to its kind (`structured_error`/`error_result`) so a real strong
 *  signal is never silently tokenless — keeping `signals_match.length === 0` an honest "no strong signal" gate.
 *  Success signals (#578) also produce tokens so a purely successful session can yield a matchable gene.
 *  Deduped, ≤8. */
export declare function signalTokens(sigs: readonly signals.ExtractedSignal[]): string[];
/** 位置属于调用方传入的 normalized turn，使用原始 UTF-16 半开区间；不是 JSONL 文件行号。 */
interface StrategySourcePosition {
    turnIndex: number;
    field: 'text' | 'toolResult';
    start: number;
    end: number;
}
type UnitRejection = 'unit_too_long' | 'incomplete_unit' | 'source_truncated';
export interface StrategyDraftDiagnostics {
    status: 'ready' | 'insufficient';
    reason: 'complete_units' | 'no_actionable_units' | UnitRejection | 'no_eligible_signal' | 'no_discriminating_topic';
    evidence: StrategySourcePosition[];
    rejected: Array<StrategySourcePosition & {
        reason: UnitRejection;
    }>;
    omitted: {
        nonActionable: number;
        duplicate: number;
        overBudget: number;
        incomplete: number;
        sourceTruncated: number;
        capacity: number;
    };
}
export interface StrategyDraft {
    strategy: string[];
    diagnostics: StrategyDraftDiagnostics;
}
/** 最多六个完整且已脱敏的操作单元。拒绝信息只含位置/原因/计数，不保存秘密原文。 */
export declare function draftStrategyWithEvidence(turns: readonly NormalizedTurn[], toolWorkflowsOnly?: boolean): StrategyDraft;
/** 兼容旧调用方；实际入口使用带位置和不足原因的同一实现。 */
export declare function draftStrategy(turns: readonly NormalizedTurn[]): string[];
/**
 * Assemble an UNPROVEN draft GeneCandidate from a parsed session, or null when too thin to distill (no strong
 * signal OR no substantive step). The single source of the "what makes a draftable session" gate + candidate
 * shape, shared by `evolver ingest --distill` and the distillObserver so the two never drift. `sigs` is passed in
 * (already extracted by the caller) to avoid a second extraction pass.
 */
export declare function draftGeneCandidate(turns: readonly NormalizedTurn[], sigs: readonly signals.ExtractedSignal[], agent: string): algo.GeneCandidate | null;
export interface GeneDraftAssessment {
    candidate: algo.GeneCandidate | null;
    diagnostics: StrategyDraftDiagnostics;
}
/** 共享 caller 的实际入口；diagnostics 不进入 Gene 内容或 asset_id。 */
export declare function assessGeneDraft(turns: readonly NormalizedTurn[], sigs: readonly signals.ExtractedSignal[], agent: string): GeneDraftAssessment;
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
    /** Reject a draft whose discriminating-signal Jaccard similarity to ANY existing gene is >= this (default 0.6).
     *  Generated fallback markers and generic command runners are omitted from this SOFT comparison, while the
     *  exact-subset check still uses the complete signal sets. */
    maxSimilarity?: number;
}
export interface DraftAdmission {
    admit: boolean;
    reason?: string;
}
/**
 * Value/novelty gate run BEFORE a draft is quarantined (#117 improvement 3). `intakeGene` already rejects
 * empty/structurally-invalid candidates and EXACT signal subsets (fullyOverlaps). Admission mirrors that subset
 * check so a duplicate is a per-candidate skip instead of aborting a whole batch, then adds the two missing noise
 * controls: a substance floor and a SOFT near-duplicate comparison. Unattended auto-distill turns that trickle
 * into a flood, and a review gate nobody reads is no gate. Pure and deterministic; the caller decides what to do
 * with a non-admit (skip, never an error).
 */
export declare function assessDraftAdmission(candidate: algo.GeneCandidate, existing?: readonly ExistingGeneSignals[], opts?: DraftAdmissionOptions): DraftAdmission;
export {};