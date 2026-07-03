import { ulid as makeUlid } from 'ulid';
import { computeAssetId, SCHEMA_VERSION } from '../wire/index.js';
/**
 * EvolutionEvent = 世代记录(outcome 真值在此, 硬化 A4). 单向引 Capsule(capsule_id);
 * 写入序列: capsule asset_id 先算 → 填 capsule_id → 再算 event asset_id.
 */
export function buildEvolutionEvent(input) {
    const base = {
        type: 'EvolutionEvent',
        schema_version: SCHEMA_VERSION,
        id: makeUlid(),
        parent: input.parent ?? null,
        intent: input.intent,
        signals: [...input.signals],
        genes_used: [...input.genesUsed],
        mutation_id: input.mutationId,
        blast_radius: input.blastRadius,
        outcome: input.outcome,
        capsule_id: input.capsuleId,
        source_type: input.sourceType,
    };
    const asset_id = computeAssetId(base);
    return { ...base, asset_id };
}