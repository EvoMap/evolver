export type V1Kind = 'Gene' | 'Capsule' | 'EvolutionEvent';
export interface MappedAsset {
    record: Record<string, unknown>;
    dropped: Record<string, unknown>;
    recomputed: boolean;
}
/**
 * v1 资产 → v2 wire(M8-2). 规则:
 * - 只留 gep-sdk schema 允许字段, 其余(avoid 等)落 dropped→sidecar(不参与 canonicalize, 不动 asset_id).
 * - 缺 schema_version → 注入 wire.SCHEMA_VERSION 作为新记录 authoring default；已有版本原样保留。
 *   SDK package version 不是最低可接受 wire version。
 * - source_type 非标枚举 → generated; mutation_id null → ''.
 * - asset_id: 有则**冻结**(原样); 缺失时新算(recomputed=true). 若映射改变正文，importer 会用
 *   content-bound provenance 隔离 frozen mismatch，而不是把它默认为可信资产(Refs #677).
 * - v2 新增 optional(resolution_status/proof_of_work/...) v1 无 → 自然省略(不合成).
 * - Gene 的 routing_hint/tool_policy/generation_meta 需要先 normalize，不能走 raw-copy；这里维护迁移本地
 *   的阻断集，避免 future schema promotion 让 `allowed.has(k)` 把原始脏值直接塞进 record。
 *   v1 的 null/缺省干净省略；存在但归一化失败的脏值落 dropped 便于审计。
 */
export declare function mapV1Asset(kind: V1Kind, v1: Record<string, unknown>): MappedAsset;