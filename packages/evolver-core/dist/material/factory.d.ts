import { type Material } from '../schema/material.js';
import type { SourceAgent } from '../schema/common.js';
import type { Watermark } from '../schema/material.js';
/** Fresh ULID for a Material record. Kept in core so the ULID constraint lives next to the schema. */
export declare function newMaterialId(): string;
export interface BuildMaterialInput {
    /** Runtime agent for a session/tool source. Omit for an agent-agnostic origin (proxy trace), #95. */
    sourceAgent?: SourceAgent;
    /** Origin class (#95). Defaults to runtime_session (the only pre-#95 origin). */
    sourceKind?: 'runtime_session' | 'proxy_trace';
    sourcePath: string;
    kind: 'session_log' | 'tool_event' | 'llm_trace';
    watermark: Watermark;
    consumerGroup: string;
    payload?: unknown;
    /** Injected for determinism in tests; defaults to a fresh ULID. */
    materialId?: string;
    /** Injected for determinism in tests; defaults to wall-clock ISO time. */
    capturedAt?: string;
}
/**
 * Build a schema-valid Material from a recording event. The composition layer (CLI) owns the source content;
 * core owns the record shape + id/clock generation. Re-record idempotency is the caller's concern (see the
 * file watermark cursor): identical content yields a fresh materialId here, so dedup must gate the call, not
 * the build (a Material's identity is its ULID, not its content — that is the M1 substrate's design).
 */
export declare function buildMaterial(input: BuildMaterialInput): Material;