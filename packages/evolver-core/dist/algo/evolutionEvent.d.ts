import { type EvolutionEvent, type GepCategory } from '../wire/index.js';
/** Selection-side lifecycle stamp carried in EvolutionEvent.meta (schema-allowed object). */
export type EvolutionSelectionStage = 'selected' | 'applied';
export interface EvolutionSelectionStamp {
    /** Content asset_id of the selected Gene when known (sha256:…). */
    selectedAssetId?: string;
    /** True only when assembly stamped kautoMember on the selected candidate. */
    kautoMember?: boolean;
    /** Producer evolver version from env fingerprint, when known. */
    evolverVersion?: string;
    /**
     * selected = gene was chosen for the cycle;
     * applied = cycle produced an EvolutionEvent after execution (this builder always emits applied).
     */
    selectionStage?: EvolutionSelectionStage;
}
export interface BuildEvolutionEventInput {
    intent: GepCategory;
    signals: readonly string[];
    genesUsed: readonly string[];
    mutationId: string;
    blastRadius: {
        files: number;
        lines: number;
    };
    outcome: {
        status: 'success' | 'failed';
        score: number;
    };
    capsuleId: string | null;
    sourceType: 'generated' | 'reused' | 'reference';
    parent?: string | null;
    /** Optional selection lifecycle stamp; omitted keys stay absent (omit-not-null). */
    selection?: EvolutionSelectionStamp;
}
/**
 * Build the schema-allowed `meta` object for selection telemetry.
 * Absent optional fields are omitted so they do not enter the asset_id hash as null.
 */
export declare function buildEvolutionSelectionMeta(selection: EvolutionSelectionStamp | undefined): Record<string, unknown> | undefined;
/**
 * EvolutionEvent = 世代记录(outcome 真值在此, 硬化 A4). 单向引 Capsule(capsule_id);
 * 写入序列: capsule asset_id 先算 → 填 capsule_id → 再算 event asset_id.
 *
 * Optional selection stamp lands in `meta` (schema-allowed) so production cohort
 * collection can separate writer membership from selected/applied member share
 * without inventing a LearningAsset bridge.
 */
export declare function buildEvolutionEvent(input: BuildEvolutionEventInput): EvolutionEvent;