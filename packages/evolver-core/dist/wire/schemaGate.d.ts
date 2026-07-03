export interface WireValidation {
    ok: boolean;
    errors: string[];
}
/**
 * 结构校验(required 齐 + additionalProperties:false 不许多字段). 轻量, 不做深类型校验(那是发版 CI conformance 的活).
 * 用途: 发 hub 前确认资产能被 gep-sdk schema 接受; v2-delta(proof_of_work/resolution_status)在 bump 前会在此暴露.
 */
export declare function validateWire(asset: Record<string, unknown>): WireValidation;
/** schema 已声明的字段白名单(给上层判断哪些 v2-delta 尚未进 SDK). */
export declare function schemaProperties(type: string): string[];