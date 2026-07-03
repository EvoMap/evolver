export type V1Kind = 'Gene' | 'Capsule' | 'EvolutionEvent';
export interface MappedAsset {
    record: Record<string, unknown>;
    dropped: Record<string, unknown>;
    recomputed: boolean;
}
/**
 * v1 资产 → v2 wire(M8-2). 规则:
 * - 只留 gep-sdk schema 允许字段, 其余(avoid 等)落 dropped→sidecar(不参与 canonicalize, 不动 asset_id).
 * - Gene 缺 schema_version → 注入 wire.SCHEMA_VERSION(权威 1.6.0, 非 package version).
 * - source_type 非标枚举 → generated; mutation_id null → ''.
 * - asset_id: 有则**冻结**(原样); 仅 event 缺 asset_id 时新算(recomputed=true).
 * - v2 新增 optional(resolution_status/proof_of_work/...) v1 无 → 自然省略(不合成).
 * - Gene 的 routing_hint/tool_policy 是 v2-delta(v1 PR #93): gep-sdk gene.schema.json 尚无 → schemaProperties
 *   不含它们, 默认会落 sidecar; 这里按已知 delta 归一化后保留在 record(保真). 存在但归一化为 null 的脏值
 *   (如 {tier:'ultra'})落 sidecar(可审计, 不静默丢); v1 的 null/缺省干净省略, 不污染 sidecar.
 */
export declare function mapV1Asset(kind: V1Kind, v1: Record<string, unknown>): MappedAsset;