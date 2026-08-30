import { ulid as makeUlid } from 'ulid';
import { material } from '../schema/material.js';
/** Fresh ULID for a Material record. Kept in core so the ULID constraint lives next to the schema. */
export function newMaterialId() {
    return makeUlid();
}
/**
 * Build a schema-valid Material from a recording event. The composition layer (CLI) owns the source content;
 * core owns the record shape + id/clock generation. Re-record idempotency is the caller's concern (see the
 * file watermark cursor): identical content yields a fresh materialId here, so dedup must gate the call, not
 * the build (a Material's identity is its ULID, not its content — that is the M1 substrate's design).
 */
export function buildMaterial(input) {
    return material.parse({
        materialId: input.materialId ?? newMaterialId(),
        ...(input.sourceAgent ? { sourceAgent: input.sourceAgent } : {}),
        sourceKind: input.sourceKind ?? 'runtime_session',
        sourcePath: input.sourcePath,
        kind: input.kind,
        watermark: input.watermark,
        capturedAt: input.capturedAt ?? new Date().toISOString(),
        consumerGroup: input.consumerGroup,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
}