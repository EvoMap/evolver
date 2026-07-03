import { type EvolutionEvent, type GepCategory } from '../wire/index.js';
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
}
/**
 * EvolutionEvent = 世代记录(outcome 真值在此, 硬化 A4). 单向引 Capsule(capsule_id);
 * 写入序列: capsule asset_id 先算 → 填 capsule_id → 再算 event asset_id.
 */
export declare function buildEvolutionEvent(input: BuildEvolutionEventInput): EvolutionEvent;