import { createHash } from 'node:crypto';
import { GENERATION_SOURCES, SCHEMA_VERSION, canonicalize, computeAssetId, stripGeneHints, validateWireDeep, wireSchemaIssues } from '../wire/index.js';
import { parseGeneMarkdown, renderGeneMarkdown } from './geneMarkdown.js';
import { say } from './locale.js';
const ASSET_ID = /^sha256:[a-f0-9]{64}$/;
const MAX_TITLE_CHARS = 200;
const FIELD_ORDER = ['type', 'schema_version', 'id', 'category', 'signals_match', 'preconditions', 'strategy', 'constraints', 'validation', 'summary', 'claims'];
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
}
function derivedId(gene, title) {
    const { id: _id, asset_id: _assetId, ...content } = gene;
    const digest = createHash('sha256').update(canonicalize(content), 'utf8').digest('hex').slice(0, 8);
    const name = slug(title) || slug(typeof gene['summary'] === 'string' ? gene['summary'] : '') || 'manual';
    return `gene_${name}_${digest}`;
}
function generationMeta(raw, title, supersedes) {
    const base = isRecord(raw) ? { ...raw } : {};
    const source = base['source'] === undefined ? 'manual' : base['source'];
    const named = title || base['title'];
    const replaced = supersedes ?? base['supersedes'];
    delete base['title'];
    delete base['supersedes'];
    return { ...base, source, ...(named !== undefined && named !== '' ? { title: named } : {}), ...(replaced !== undefined ? { supersedes: replaced } : {}) };
}
function ordered(gene) {
    const out = {};
    for (const key of FIELD_ORDER)
        if (gene[key] !== undefined)
            out[key] = gene[key];
    for (const [key, value] of Object.entries(gene))
        if (!(key in out) && key !== 'asset_id' && value !== undefined)
            out[key] = value;
    return out;
}
/** Fills what an author never writes (type, schema_version, id, generation_meta, asset_id) and keeps everything given. */
function assembleGene(candidate, title, supersedes) {
    const gene = { ...candidate };
    gene['type'] = candidate['type'] === undefined ? 'Gene' : candidate['type'];
    gene['schema_version'] = candidate['schema_version'] === undefined ? SCHEMA_VERSION : candidate['schema_version'];
    gene['generation_meta'] = generationMeta(candidate['generation_meta'], title, supersedes);
    delete gene['asset_id'];
    if (candidate['id'] === undefined || candidate['id'] === '') {
        delete gene['id'];
        gene['id'] = derivedId(gene, String(gene['generation_meta']['title'] ?? ''));
    }
    const result = ordered(gene);
    result['asset_id'] = computeAssetId(result) ?? '';
    return result;
}
const FIELD_LABELS = {
    category: ['分类', 'category'],
    signals_match: ['触发信号', 'signals'],
    strategy: ['步骤', 'steps'],
    validation: ['检查命令', 'validation commands'],
    preconditions: ['适用条件', 'conditions'],
    constraints: ['约束', 'constraints'],
    'constraints.max_files': ['最多改动文件数', 'max_files'],
    'constraints.forbidden_paths': ['禁止改动的路径', 'forbidden_paths'],
    summary: ['简介', 'summary'],
    claims: ['成功标准', 'success criteria'],
};
const FIELD_MESSAGES = {
    'minItems:strategy': ['至少写 1 步', 'Write at least one step'],
    'minItems:validation': ['至少写 1 条检查命令', 'Write at least one validation command'],
    'minItems:signals_match': ['至少写 1 个触发信号', 'Write at least one signal'],
    'enum:category': ['分类只能是 repair、optimize、innovate 或 explore', 'category must be repair, optimize, innovate or explore'],
};
const KEYWORD_MESSAGES = {
    minItems: (zh, en) => [`${zh}至少要有 1 项`, `${en} needs at least one item`],
    minLength: (zh, en) => [`${zh}不能为空`, `${en} must not be empty`],
    minimum: (zh, en) => [`${zh}的数值太小`, `${en} is too small`],
    type: (zh, en) => [`${zh}的类型不对`, `${en} has the wrong type`],
};
function schemaMessage(issue, locale) {
    const field = issue.path.replace(/\.\d+(?=\.|$)/g, '');
    const specific = FIELD_MESSAGES[`${issue.keyword}:${field}`];
    if (specific)
        return say(locale, ...specific);
    const property = issue.property ?? '';
    if (issue.keyword === 'required') {
        const label = FIELD_LABELS[property];
        return say(locale, label ? `缺少${label[0]}` : `缺少字段 ${property}`, `Missing ${label?.[1] ?? property}`);
    }
    if (issue.keyword === 'additionalProperties')
        return say(locale, `不支持的字段：${property}`, `Unsupported field: ${property}`);
    const [zh, en] = FIELD_LABELS[field] ?? [issue.path || '资产', issue.path || 'asset'];
    const message = KEYWORD_MESSAGES[issue.keyword] ?? ((label, name) => [`${label}格式不正确`, `${name} is malformed`]);
    return say(locale, ...message(zh, en));
}
/** Every Draft-07 violation of the gep-sdk Gene schema, located by JSON pointer, after local-only hints are stripped. */
export function geneSchemaErrors(gene, locale) {
    const wire = stripGeneHints(gene);
    const issues = wireSchemaIssues(wire).map((issue) => ({
        path: `/${issue.path.replace(/\./g, '/')}`, code: issue.keyword, message: schemaMessage(issue, locale),
    }));
    if (issues.length === 0 && !validateWireDeep(wire).ok) {
        issues.push({ path: '/', code: 'schema', message: say(locale, '资产不符合 Gene 格式', 'The asset does not match the Gene schema') });
    }
    return issues;
}
/** `generation_meta` never reaches the wire schema (it is stripped as a local hint), so build and lint both check it here. */
export function generationMetaErrors(meta, locale) {
    if (meta === undefined)
        return [];
    if (!isRecord(meta))
        return [{ path: '/generation_meta', code: 'type', message: say(locale, 'generation_meta 需要是对象', 'generation_meta must be an object') }];
    const errors = [];
    if (meta['source'] !== undefined && !GENERATION_SOURCES.includes(meta['source'])) {
        errors.push({ path: '/generation_meta/source', code: 'enum',
            message: say(locale, `来源只能是 ${GENERATION_SOURCES.join('、')}`, `source must be one of ${GENERATION_SOURCES.join(', ')}`) });
    }
    if (meta['supersedes'] !== undefined && !(typeof meta['supersedes'] === 'string' && ASSET_ID.test(meta['supersedes']))) {
        errors.push({ path: '/generation_meta/supersedes', code: 'pattern',
            message: say(locale, '被替代的经验要写成 sha256:… 资产 ID', 'supersedes must be an asset id (sha256:…)') });
    }
    if (meta['title'] !== undefined && typeof meta['title'] !== 'string') {
        errors.push({ path: '/generation_meta/title', code: 'type', message: say(locale, '标题需要是文字', 'title must be a string') });
    }
    if (typeof meta['title'] === 'string' && meta['title'].length > MAX_TITLE_CHARS) {
        errors.push({ path: '/generation_meta/title', code: 'maxLength',
            message: say(locale, `标题最多 ${MAX_TITLE_CHARS} 个字`, `The title is longer than ${MAX_TITLE_CHARS} characters`) });
    }
    return errors;
}
function parseSource(request) {
    if (request.format === 'markdown') {
        const parsed = parseGeneMarkdown(request.source, request.locale);
        return { candidate: parsed.gene, title: parsed.title, ...(parsed.supersedes ? { supersedes: parsed.supersedes } : {}), issues: parsed.issues };
    }
    let value;
    try {
        value = JSON.parse(request.source);
    }
    catch {
        value = undefined;
    }
    if (!isRecord(value)) {
        return { candidate: null, title: '', issues: [{ path: '/', code: 'parse', message: say(request.locale, '内容不是 Gene JSON 对象', 'The source is not a Gene JSON object') }] };
    }
    return { candidate: value, title: '', issues: [] };
}
/** GENE.md or Gene JSON in, a complete Gene out: full schema validation, every violation listed, the Gene kept when invalid. */
export function buildGene(request) {
    const parsed = parseSource(request);
    if (!parsed.candidate)
        return { valid: false, gene: null, markdown: '', errors: parsed.issues };
    const gene = assembleGene(parsed.candidate, parsed.title, request.supersedes ?? parsed.supersedes);
    const given = parsed.candidate['generation_meta'];
    const meta = given === undefined || isRecord(given) ? gene['generation_meta'] : given;
    const errors = [...parsed.issues, ...geneSchemaErrors(gene, request.locale), ...generationMetaErrors(meta, request.locale)];
    return { valid: errors.length === 0, gene, markdown: renderGeneMarkdown(gene, request.locale), errors };
}