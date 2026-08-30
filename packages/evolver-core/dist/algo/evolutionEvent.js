import { ulid as makeUlid } from 'ulid';
import { computeAssetId, SCHEMA_VERSION } from '../wire/index.js';
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
/**
 * Build the schema-allowed `meta` object for selection telemetry.
 * Absent optional fields are omitted so they do not enter the asset_id hash as null.
 */
export function buildEvolutionSelectionMeta(selection) {
    if (!selection)
        return undefined;
    const selectedAssetId = nonEmptyString(selection.selectedAssetId);
    const evolverVersion = nonEmptyString(selection.evolverVersion);
    const selectionStage = selection.selectionStage === 'selected' || selection.selectionStage === 'applied'
        ? selection.selectionStage
        : undefined;
    const meta = {};
    if (selectedAssetId)
        meta['selected_asset_id'] = selectedAssetId;
    if (selection.kautoMember === true)
        meta['kauto_member'] = true;
    if (evolverVersion)
        meta['evolver_version'] = evolverVersion;
    if (selectionStage)
        meta['selection_stage'] = selectionStage;
    return Object.keys(meta).length > 0 ? meta : undefined;
}
/**
 * EvolutionEvent = 世代记录(outcome 真值在此, 硬化 A4). 单向引 Capsule(capsule_id);
 * 写入序列: capsule asset_id 先算 → 填 capsule_id → 再算 event asset_id.
 *
 * Optional selection stamp lands in `meta` (schema-allowed) so production cohort
 * collection can separate writer membership from selected/applied member share
 * without inventing a LearningAsset bridge.
 */
export function buildEvolutionEvent(input) {
    const meta = buildEvolutionSelectionMeta(input.selection);
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
        ...(meta ? { meta } : {}),
    };
    const asset_id = computeAssetId(base);
    return { ...base, asset_id };
}