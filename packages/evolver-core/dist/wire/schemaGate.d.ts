export interface WireValidation {
    ok: boolean;
    errors: string[];
}
/** One schema violation located at a concrete field, so a caller can decide what to do about THAT field.
 *  `validateWireDeep`'s message strings are deliberately stable/opaque; repair needs the location instead. */
export interface WireSchemaIssue {
    /** Dotted path into the record (`constraints.forbidden_paths`); `''` for a record-level violation. */
    path: string;
    /** Ajv keyword that failed (`required`, `additionalProperties`, `minItems`, `pattern`, …). */
    keyword: string;
    /** Field named by a record-level violation: the missing required prop or the rejected extra prop. */
    property?: string;
    message: string;
}
/**
 * 结构校验(required 齐 + additionalProperties:false 不许多字段). 轻量, 不做深类型校验(那是发版 CI conformance 的活).
 * 用途: 发 hub 前确认资产能被 gep-sdk schema 接受; v2-delta(proof_of_work/resolution_status)在 bump 前会在此暴露.
 */
export declare function validateWire(asset: Record<string, unknown>): WireValidation;
/**
 * Full Draft-07 runtime validation against the gep-sdk JSON Schema SSOT.
 * Validation is observational: values are never coerced, defaulted, stripped, or otherwise mutated.
 */
export declare function validateWireDeep(asset: Record<string, unknown>): WireValidation;
/**
 * Every schema violation of `asset`, located by field. Same SSOT and same verdict as {@link validateWireDeep}
 * (empty ⇔ ok) — this form exists for callers that must ACT on a specific field rather than only report.
 */
export declare function wireSchemaIssues(asset: Record<string, unknown>): WireSchemaIssue[];
/** schema 已声明的字段白名单(给上层判断哪些 v2-delta 尚未进 SDK). */
export declare function schemaProperties(type: string): string[];