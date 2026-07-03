import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const nodeRequire = createRequire(import.meta.url);
const SCHEMA_SUBPATH = {
    Gene: '@evomap/gep-sdk/schemas/gene.schema.json',
    Capsule: '@evomap/gep-sdk/schemas/capsule.schema.json',
    EvolutionEvent: '@evomap/gep-sdk/schemas/evolution-event.schema.json',
};
const cache = new Map();
function loadSchema(type) {
    const sub = SCHEMA_SUBPATH[type];
    if (!sub)
        return undefined;
    const cached = cache.get(type);
    if (cached)
        return cached;
    const path = nodeRequire.resolve(sub);
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    cache.set(type, schema);
    return schema;
}
/**
 * 结构校验(required 齐 + additionalProperties:false 不许多字段). 轻量, 不做深类型校验(那是发版 CI conformance 的活).
 * 用途: 发 hub 前确认资产能被 gep-sdk schema 接受; v2-delta(proof_of_work/resolution_status)在 bump 前会在此暴露.
 */
export function validateWire(asset) {
    const errors = [];
    const type = asset['type'];
    if (typeof type !== 'string')
        return { ok: false, errors: ['缺 type 字段'] };
    const schema = loadSchema(type);
    if (!schema)
        return { ok: false, errors: [`未知资产类型: ${type}`] };
    for (const req of schema.required ?? []) {
        if (asset[req] === undefined || asset[req] === null)
            errors.push(`缺 required 字段: ${req}`);
    }
    if (schema.additionalProperties === false && schema.properties) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const k of Object.keys(asset))
            if (!allowed.has(k))
                errors.push(`多余字段(additionalProperties:false 会 reject): ${k}`);
    }
    return { ok: errors.length === 0, errors };
}
/** schema 已声明的字段白名单(给上层判断哪些 v2-delta 尚未进 SDK). */
export function schemaProperties(type) {
    return Object.keys(loadSchema(type)?.properties ?? {});
}