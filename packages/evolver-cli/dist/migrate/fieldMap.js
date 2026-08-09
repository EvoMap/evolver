import { wire } from '@evomap/evolver-core';
// v1→v2 source_type 枚举转换(skill2gep_distillation 等非标 → generated).
const SOURCE_TYPE_MAP = { skill2gep_distillation: 'generated' };
const KNOWN_SOURCE = new Set(['generated', 'reused', 'reference', 'user_authored']);
/**
 * v1 资产 → v2 wire(M8-2). 规则:
 * - 只留 gep-sdk schema 允许字段, 其余(avoid 等)落 dropped→sidecar(不参与 canonicalize, 不动 asset_id).
 * - 缺 schema_version → 注入 wire.SCHEMA_VERSION 作为新记录 authoring default；已有版本原样保留。
 *   SDK package version 不是最低可接受 wire version。
 * - source_type 非标枚举 → generated; mutation_id null → ''.
 * - asset_id: 有则**冻结**(原样); 缺失时新算(recomputed=true). 若映射改变正文，importer 会用
 *   content-bound provenance 隔离 frozen mismatch，而不是把它默认为可信资产(Refs #677).
 * - v2 新增 optional(resolution_status/proof_of_work/...) v1 无 → 自然省略(不合成).
 * - Gene 的 routing_hint/tool_policy 是 v2-delta(v1 PR #93): gep-sdk gene.schema.json 尚无 → schemaProperties
 *   不含它们, 默认会落 sidecar; 这里按已知 delta 归一化后保留在 record(保真). 存在但归一化为 null 的脏值
 *   (如 {tier:'ultra'})落 sidecar(可审计, 不静默丢); v1 的 null/缺省干净省略, 不污染 sidecar.
 */
export function mapV1Asset(kind, v1) {
    const allowed = new Set(wire.schemaProperties(kind));
    // V1 rows are untrusted. Null prototypes keep keys such as `__proto__` auditable instead of invoking
    // Object.prototype setters and silently losing extension data.
    const record = Object.create(null);
    const dropped = Object.create(null);
    // v2-delta gene 提示字段不当作"非 schema 字段"丢 sidecar — 下方归一化后保留为 record 一等字段.
    const deltaKeys = kind === 'Gene' ? new Set(wire.GENE_HINT_FIELDS) : new Set();
    for (const [k, val] of Object.entries(v1)) {
        // Hint fields are owned EXCLUSIVELY by the normalize block below — never copied raw. This must hold even
        // after a future gep-sdk bump adds them to schemaProperties (allowed): otherwise `allowed.has(k)` would
        // copy the RAW v1 hint into record, and the normalize-overwrite below only fires when normalize returns
        // truthy — so a malformed hint (normalizes to null) would leak through un-normalized.
        if (deltaKeys.has(k))
            continue;
        if (allowed.has(k))
            record[k] = val;
        else
            dropped[k] = val;
    }
    if (kind === 'Gene') {
        // 归一化后留在 record(保真). 一个"存在且非 null 却归一化为 null"的脏 hint(如 {tier:'ultra'})既进不了
        // record, 也不该静默蒸发 —— 与 mapper 对其它非 schema 字段(avoid 等)"落 sidecar, 绝不静默丢"的契约一致,
        // 把原始脏值留到 dropped 以便审计回溯. v1 的 null/缺省(无意见)仍干净省略, 不污染 sidecar.
        const routingHint = wire.normalizeRoutingHint(v1['routing_hint']);
        const toolPolicy = wire.normalizeToolPolicy(v1['tool_policy']);
        if (routingHint)
            record['routing_hint'] = routingHint;
        else if (v1['routing_hint'] !== null && v1['routing_hint'] !== undefined)
            dropped['routing_hint'] = v1['routing_hint'];
        if (toolPolicy)
            record['tool_policy'] = toolPolicy;
        else if (v1['tool_policy'] !== null && v1['tool_policy'] !== undefined)
            dropped['tool_policy'] = v1['tool_policy'];
        // v1 #302 `_source` block (generation_source / quality_score / quality_heuristics / overcame_errors) → v2
        // `generation_meta`. v1 #302 was never merged to HEAD, so real v1 genes lack `_source`; this maps it IF present
        // (forward-compat for a repo that carried the #302 branch). A `_source` whose generation_source normalizes away
        // (unknown enum) is NOT silently dropped — the raw `_source` stays in `dropped` for audit (it already landed there
        // above as a non-schema field). `generation_meta` itself (if a v1 gene already carried the v2 field name) is a
        // deltaKey so it was skipped above and is handled here by normalize, same as the hints.
        if (v1['_source'] !== undefined && v1['_source'] !== null) {
            const src = v1['_source'];
            if (src && typeof src === 'object') {
                const s = src;
                const mapped = wire.normalizeGenerationMeta({
                    source: s['generation_source'],
                    quality_score: s['quality_score'],
                    quality_heuristics: s['quality_heuristics'],
                    overcame_errors: s['overcame_errors'],
                });
                if (mapped)
                    record['generation_meta'] = mapped;
            }
        }
        const generationMeta = wire.normalizeGenerationMeta(v1['generation_meta']);
        if (generationMeta)
            record['generation_meta'] = generationMeta;
        else if (v1['generation_meta'] !== null && v1['generation_meta'] !== undefined)
            dropped['generation_meta'] = v1['generation_meta'];
    }
    if (allowed.has('schema_version') && record['schema_version'] === undefined)
        record['schema_version'] = wire.SCHEMA_VERSION;
    if (record['source_type'] !== undefined) {
        const st = String(record['source_type']);
        if (!KNOWN_SOURCE.has(st))
            record['source_type'] = SOURCE_TYPE_MAP[st] ?? 'generated';
    }
    if ('mutation_id' in record && (record['mutation_id'] === null || record['mutation_id'] === undefined))
        record['mutation_id'] = '';
    let recomputed = false;
    const claimed = record['asset_id'];
    if (typeof claimed === 'string' && claimed.length > 0) {
        // 冻结: 原样保留(硬化 A6, 不重算)
    }
    else if (allowed.has('asset_id')) {
        record['asset_id'] = wire.computeAssetId(record); // 仅缺失时新算(verified=false)
        recomputed = true;
    }
    return { record, dropped, recomputed };
}