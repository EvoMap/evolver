import { computeAssetId, stripGeneHints, validateWireDeep } from '../wire/index.js';
import { ExperienceError } from './experienceError.js';
export const SUPERSEDED = 'superseded';
const ASSET_ID = /^sha256:[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const ANTI_GENE_FIELDS = new Set(['type', 'schema_version', 'id', 'summary', 'trigger', 'avoid', 'source_clusters', 'evidence_capsules',
    'failure_count', 'rationale', 'severity', 'asset_id']);
const LOCAL_SOURCE_FIELDS = ['source_task', 'task', 'material'];
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => { throw new ExperienceError('INPUT_INVALID', message); };
function metaOf(gene) {
    return isRecord(gene['generation_meta']) ? gene['generation_meta'] : {};
}
/** A complete Gene from `gene build`, kept exactly as authored: deep-valid, with the content id it claims. */
export function authoredGene(raw) {
    if (!isRecord(raw) || raw['type'] !== 'Gene')
        return invalid('要保存的 Gene 不完整，请先用 gene build 生成。');
    if (LOCAL_SOURCE_FIELDS.some((field) => Object.hasOwn(raw, field)))
        return invalid('Gene 里不能夹带任务材料。');
    if (!validateWireDeep(stripGeneHints(raw)).ok)
        return invalid('这条 Gene 还不符合格式，请先修正 gene build 列出的问题。');
    if (typeof raw['asset_id'] !== 'string' || raw['asset_id'] !== computeAssetId(raw))
        return invalid('Gene 的资产 ID 与内容不一致，请重新生成。');
    const supersedes = metaOf(raw)['supersedes'];
    if (supersedes !== undefined && !(typeof supersedes === 'string' && ASSET_ID.test(supersedes)))
        invalid('被替代的经验 ID 格式不正确。');
    if (supersedes === raw['asset_id'])
        invalid('一条经验不能替代它自己。');
    return raw;
}
/** The Capsule distilled with that Gene, bound to it by content id or logical id. */
export function authoredCapsule(raw, gene) {
    if (!isRecord(raw) || raw['type'] !== 'Capsule')
        return invalid('随附的 Capsule 不完整。');
    if (raw['gene'] !== gene.asset_id && raw['gene'] !== gene['id'])
        return invalid('随附的 Capsule 没有绑定这条 Gene。');
    if (!validateWireDeep(raw).ok)
        return invalid('随附的 Capsule 不符合格式。');
    if (typeof raw['asset_id'] !== 'string' || raw['asset_id'] !== computeAssetId(raw))
        return invalid('Capsule 的资产 ID 与内容不一致。');
    return raw;
}
const filledStrings = (value) => Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const text = (value) => typeof value === 'string' && value.trim().length > 0;
function hasAntiGeneContent(raw) {
    return typeof raw['id'] === 'string' && raw['id'].startsWith('anti_gene_') && text(raw['summary'])
        && filledStrings(raw['trigger']) && filledStrings(raw['avoid']);
}
function hasAntiGeneBookkeeping(raw) {
    return typeof raw['schema_version'] === 'string' && SEMVER.test(raw['schema_version'])
        && stringList(raw['source_clusters']) && stringList(raw['evidence_capsules'])
        && Number.isSafeInteger(raw['failure_count']) && raw['failure_count'] >= 1;
}
/** The local AntiGene shape (`autoDistillAntiGene`): there is no gep-sdk schema for it, so its fields are checked here. */
function isAntiGeneShape(raw) {
    const optional = (raw['rationale'] === undefined || typeof raw['rationale'] === 'string')
        && (raw['severity'] === undefined || ['low', 'medium', 'high'].includes(raw['severity']));
    return hasAntiGeneContent(raw) && hasAntiGeneBookkeeping(raw) && optional && Object.keys(raw).every((field) => ANTI_GENE_FIELDS.has(field));
}
/** An AntiGene from `gene distill` for a failed fragment: a guardrail with its content id, never steps to follow. */
export function authoredAntiGene(raw) {
    if (!isRecord(raw) || raw['type'] !== 'AntiGene')
        return invalid('要保存的 AntiGene 不完整，请先用 gene distill 生成。');
    if (LOCAL_SOURCE_FIELDS.some((field) => Object.hasOwn(raw, field)))
        return invalid('AntiGene 里不能夹带任务材料。');
    if (!isAntiGeneShape(raw))
        return invalid('AntiGene 的字段不符合本地 AntiGene 格式，请用 gene distill 重新生成。');
    if (typeof raw['asset_id'] !== 'string' || raw['asset_id'] !== computeAssetId(raw))
        return invalid('AntiGene 的资产 ID 与内容不一致，请重新生成。');
    return raw;
}
const listOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
/** What the experience library shows for a Gene, or for an AntiGene: its guardrails stand where steps would be. */
export function experienceFields(asset) {
    if (asset['type'] === 'AntiGene') {
        return { kind: 'AntiGene', title: String(asset['summary'] ?? asset['id'] ?? '经验'), conditions: [], steps: listOf(asset['avoid']), signals: listOf(asset['trigger']) };
    }
    return { kind: 'Gene', title: experienceTitle(asset), conditions: listOf(asset['preconditions']), steps: listOf(asset['strategy']), signals: listOf(asset['signals_match']) };
}
export function supersedesOf(gene) {
    const value = metaOf(gene)['supersedes'];
    return typeof value === 'string' && ASSET_ID.test(value) ? value : null;
}
export function experienceTitle(gene) {
    const title = metaOf(gene)['title'];
    return typeof title === 'string' && title.trim() ? title : String(gene['summary'] ?? gene['id'] ?? '经验');
}
/** The Gene an approval withholds from recall, when the approved Gene names a predecessor still in use. */
export function supersededTarget(gene, snapshot) {
    const target = supersedesOf(gene);
    if (!target || target === gene.asset_id || !snapshot.genes.some((candidate) => candidate.asset_id === target))
        return null;
    const review = snapshot.review.get(target);
    return review?.state === 'rejected' && review.reason !== 'experience:paused' ? null : target;
}
export function supersededReview(assetId, at) {
    return { assetId, at, state: 'rejected', by: 'local-experience-user', reason: SUPERSEDED };
}
const supersededByCache = new WeakMap();
/** Which approved Gene replaced each Gene: the one whose approval wrote the `superseded` record, in the same operation. */
export function supersededBy(snapshot, assetId) {
    let index = supersededByCache.get(snapshot);
    if (!index) {
        index = new Map();
        for (const gene of snapshot.genes) {
            const target = supersedesOf(gene);
            const approval = snapshot.review.get(gene.asset_id);
            const replaced = target ? snapshot.review.get(target) : undefined;
            if (target && approval?.state === 'approved' && replaced?.reason === SUPERSEDED
                && approval.operationId !== undefined && replaced.operationId === approval.operationId)
                index.set(target, gene.asset_id);
        }
        supersededByCache.set(snapshot, index);
    }
    return index.get(assetId) ?? null;
}