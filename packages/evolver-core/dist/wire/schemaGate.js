import { Ajv } from 'ajv';
// Static JSON imports, NOT createRequire.resolve + readFileSync: `bun build --compile` can only embed an asset
// it sees at bundle time. A runtime resolve compiles fine and then throws
// `Cannot find module '@evomap/gep-sdk/schemas/gene.schema.json' from '/$bunfs/root/<binary>'` inside every
// standalone release binary, which took down the whole publish/distill path (schema gate is on it) while
// `--version`/`--help` smoke stayed green. Node keeps resolving these identically, so npm consumers are unaffected.
import capsuleSchemaJson from '@evomap/gep-sdk/schemas/capsule.schema.json' with { type: 'json' };
import evolutionEventSchemaJson from '@evomap/gep-sdk/schemas/evolution-event.schema.json' with { type: 'json' };
import geneSchemaJson from '@evomap/gep-sdk/schemas/gene.schema.json' with { type: 'json' };
// Bundle-time constants, so no lazy cache is needed. Unknown types must still resolve to `undefined`:
// validateWire / validateWireDeep / wireSchemaIssues / schemaProperties all branch on that.
const SCHEMA_BY_TYPE = {
    Gene: geneSchemaJson,
    Capsule: capsuleSchemaJson,
    EvolutionEvent: evolutionEventSchemaJson,
};
function loadSchema(type) {
    return SCHEMA_BY_TYPE[type];
}
function validateObjectShape(value, schema, path, errors) {
    if (!schema.properties && schema.additionalProperties !== false)
        return;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return;
    const record = value;
    for (const req of schema.required ?? []) {
        if (record[req] === undefined || record[req] === null)
            errors.push(`${path}: 缺 required 字段: ${req}`);
    }
    if (schema.additionalProperties === false && schema.properties) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const k of Object.keys(record))
            if (!allowed.has(k))
                errors.push(`${path}: 多余字段(additionalProperties:false 会 reject): ${k}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const childValue = record[key];
        if (childValue === undefined || childValue === null)
            continue;
        if (Array.isArray(childValue) && child.items) {
            const itemSchema = child.items;
            childValue.forEach((item, index) => validateObjectShape(item, itemSchema, `${path}.${key}[${index}]`, errors));
        }
        else {
            validateObjectShape(childValue, child, `${path}.${key}`, errors);
        }
    }
}
const deepValidatorCache = new Map();
const issueValidatorCache = new Map();
const deepValidator = new Ajv({
    allErrors: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
});
// Repair needs EVERY violation in one pass — a first-error validator would make repair converge one field per
// round-trip. Kept as a second instance so the gate's own fail-fast cost is unchanged.
const issueValidator = new Ajv({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
});
function loadDeepValidator(type) {
    const schema = loadSchema(type);
    if (!schema)
        return undefined;
    const cached = deepValidatorCache.get(type);
    if (cached)
        return cached;
    const validator = deepValidator.compile(schema);
    deepValidatorCache.set(type, validator);
    return validator;
}
function loadIssueValidator(type) {
    const schema = loadSchema(type);
    if (!schema)
        return undefined;
    const cached = issueValidatorCache.get(type);
    if (cached)
        return cached;
    const validator = issueValidator.compile(schema);
    issueValidatorCache.set(type, validator);
    return validator;
}
function stableSchemaError(error) {
    return `wire schema violation: ${error.schemaPath} (${error.keyword})`;
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
    validateObjectShape(asset, schema, type, errors);
    return { ok: errors.length === 0, errors };
}
/**
 * Full Draft-07 runtime validation against the gep-sdk JSON Schema SSOT.
 * Validation is observational: values are never coerced, defaulted, stripped, or otherwise mutated.
 */
export function validateWireDeep(asset) {
    const type = asset['type'];
    if (typeof type !== 'string')
        return { ok: false, errors: ['wire schema requires a string type'] };
    const validator = loadDeepValidator(type);
    if (!validator)
        return { ok: false, errors: ['unsupported wire type'] };
    if (validator(asset))
        return { ok: true, errors: [] };
    return {
        ok: false,
        errors: (validator.errors ?? []).map(stableSchemaError),
    };
}
function issueFrom(error) {
    const property = error.keyword === 'required'
        ? String(error.params.missingProperty ?? '')
        : error.keyword === 'additionalProperties'
            ? String(error.params.additionalProperty ?? '')
            : '';
    const instancePath = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
    return {
        path: property ? [instancePath, property].filter(Boolean).join('.') : instancePath,
        keyword: error.keyword,
        ...(property ? { property } : {}),
        message: error.message ?? stableSchemaError(error),
    };
}
/**
 * Every schema violation of `asset`, located by field. Same SSOT and same verdict as {@link validateWireDeep}
 * (empty ⇔ ok) — this form exists for callers that must ACT on a specific field rather than only report.
 */
export function wireSchemaIssues(asset) {
    const type = asset['type'];
    if (typeof type !== 'string')
        return [{ path: 'type', keyword: 'type', property: 'type', message: 'wire schema requires a string type' }];
    const validator = loadIssueValidator(type);
    if (!validator)
        return [{ path: 'type', keyword: 'enum', property: 'type', message: 'unsupported wire type' }];
    if (validator(asset))
        return [];
    return (validator.errors ?? []).map(issueFrom);
}
/** schema 已声明的字段白名单(给上层判断哪些 v2-delta 尚未进 SDK). */
export function schemaProperties(type) {
    return Object.keys(loadSchema(type)?.properties ?? {});
}