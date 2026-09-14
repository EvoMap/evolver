import { brandReferenceObject } from './guard.js';
import { createHash } from 'node:crypto';
import { canonicalize, verifyAssetId } from '../wire/index.js';
import { validateWireDeep } from '../wire/schemaGate.js';
export const MAX_REFERENCE_BATCH_BYTES = 4 * 1024 * 1024;
export const MAX_REFERENCE_BATCH = 100;
export const MAX_REFERENCE_TEXT_BYTES = 256 * 1024;
export const REFERENCE_ELIGIBILITY = Object.freeze({ executable: false, evidence_eligible: false, reward_eligible: false, task_result_eligible: false });
export function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('reference_expected_object');
    return value;
}
function boundedJson(value, max) {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max)
        throw new Error('reference_size_limit');
}
export function decodeReferencePair(value) {
    boundedJson(value, MAX_REFERENCE_BATCH_BYTES);
    const pair = record(value);
    if (Object.keys(pair).some((key) => !['gene', 'capsule', 'bundle_id', 'asset_id', 'type', 'payload', 'evidence_mode', 'source_node_id', 'executable', 'evidence_eligible', 'reward_eligible', 'task_result_eligible', 'origin', 'stored_at'].includes(key)))
        throw new Error('reference_pair_unknown_field');
    if ('evidence_mode' in pair && pair['evidence_mode'] !== 'reference_only')
        throw new Error('reference_unsupported_evidence_mode');
    for (const key of Object.keys(REFERENCE_ELIGIBILITY))
        if (key in pair && pair[key] !== false)
            throw new Error('reference_eligibility_invalid');
    const gene = record(pair['gene']);
    const capsule = record(pair['capsule']);
    if (gene['type'] !== 'Gene' || capsule['type'] !== 'Capsule')
        throw new Error('reference_pair_required');
    if (capsule['evidence_mode'] !== 'reference_only')
        throw new Error('reference_unsupported_evidence_mode');
    for (const asset of [gene, capsule]) {
        if (!validateWireDeep(asset).ok)
            throw new Error('reference_schema_invalid');
        if (!verifyAssetId(asset))
            throw new Error('reference_asset_hash_mismatch');
    }
    if (gene['category'] !== 'explore' || ![gene['id'], gene['asset_id']].includes(capsule['gene']))
        throw new Error('reference_gene_binding_invalid');
    const content = record(capsule['content']);
    const text = content['text'];
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text)
        throw new Error('reference_invalid_unicode');
    if (bytes.byteLength > MAX_REFERENCE_TEXT_BYTES)
        throw new Error('reference_text_limit');
    const proof = record(record(capsule['proof_of_work'])['artifact_hash']);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (proof['size'] !== bytes.byteLength || proof['sha256'] !== digest
        || (content['chunk_sha256'] !== undefined && content['chunk_sha256'] !== digest))
        throw new Error('reference_utf8_proof_mismatch');
    if ('payload' in pair) {
        const projection = pair['type'] === 'Gene' ? gene : pair['type'] === 'Capsule' ? capsule : null;
        if (!projection || pair['asset_id'] !== projection['asset_id'] || canonicalize(record(pair['payload'])) !== canonicalize(projection))
            throw new Error('reference_projection_mismatch');
    }
    if ('bundle_id' in pair && pair['bundle_id'] !== referenceBundleId({ gene, capsule }))
        throw new Error('reference_bundle_id_mismatch');
    // Snapshot originals, never normalize, repair, strip or rehash remote assets.
    return brandPair(structuredClone({ gene, capsule }));
}
export function decodeReferenceBatch(value) {
    boundedJson(value, MAX_REFERENCE_BATCH_BYTES);
    let rows;
    if (Array.isArray(value))
        rows = value;
    else {
        const obj = record(value);
        if (Array.isArray(obj['assets'])) {
            const assets = obj['assets'];
            if (assets.length !== 2)
                throw new Error('reference_pair_required');
            rows = [{ gene: assets.find((a) => record(a)['type'] === 'Gene'), capsule: assets.find((a) => record(a)['type'] === 'Capsule') }];
        }
        else
            rows = [value];
    }
    if (rows.length === 0 || rows.length > MAX_REFERENCE_BATCH)
        throw new Error('reference_batch_limit');
    return rows.map(decodeReferencePair);
}
function brandPair(pair) {
    brandReferenceObject(pair.gene);
    brandReferenceObject(pair.capsule);
    return brandReferenceObject(pair);
}
export function referenceBundleId(pair) {
    return 'reference_' + createHash('sha256').update(`${pair.gene.asset_id}|${pair.capsule.asset_id}`).digest('hex');
}
export function validReferencePublisher(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value)
        return false;
    return !/\s/u.test(value) && Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
    });
}
export function referenceResult(pair, sourceNodeId, type = 'Capsule') {
    const snapshot = brandPair(structuredClone(pair));
    const payload = type === 'Gene' ? snapshot.gene : snapshot.capsule;
    return { ...snapshot, asset_id: payload.asset_id, type, payload, evidence_mode: 'reference_only', ...REFERENCE_ELIGIBILITY, ...(sourceNodeId ? { source_node_id: sourceNodeId } : {}) };
}
export function decodeReferencePage(value, requireSourceNodeId = false) {
    boundedJson(value, MAX_REFERENCE_BATCH_BYTES);
    const envelope = record(value);
    const page = 'payload' in envelope ? record(envelope['payload']) : envelope;
    if (page['evidence_mode'] !== 'reference_only' || !Array.isArray(page['results']) || page['results'].length > MAX_REFERENCE_BATCH
        || page['count'] !== page['results'].length || (page['next_cursor'] !== null && typeof page['next_cursor'] !== 'string'))
        throw new Error('reference_page_invalid');
    const results = page['results'].map((value) => {
        const row = record(value);
        if (row['evidence_mode'] !== 'reference_only' || Object.keys(REFERENCE_ELIGIBILITY).some((key) => row[key] !== false))
            throw new Error('reference_eligibility_invalid');
        const pair = decodeReferencePair(row);
        const type = row['type'];
        if (type !== 'Gene' && type !== 'Capsule')
            throw new Error('reference_projection_invalid');
        const payload = type === 'Gene' ? pair.gene : pair.capsule;
        if (row['asset_id'] !== payload.asset_id || canonicalize(record(row['payload'])) !== canonicalize(payload))
            throw new Error('reference_projection_mismatch');
        if (requireSourceNodeId && !validReferencePublisher(row['source_node_id']))
            throw new Error('reference_provenance_required');
        if (row['source_node_id'] !== undefined && !validReferencePublisher(row['source_node_id']))
            throw new Error('reference_provenance_invalid');
        return { ...referenceResult(pair, row['source_node_id'], type), ...(typeof row['bundle_id'] === 'string' ? { bundle_id: row['bundle_id'] } : {}) };
    });
    return { evidence_mode: 'reference_only', results, count: results.length, next_cursor: page['next_cursor'] };
}
export function normalizeReferenceQuery(value) {
    const q = record(value);
    if (Object.keys(q).some((key) => !['query', 'signals', 'asset_ids', 'content_hash', 'max_assets', 'cursor', 'asset_type'].includes(key)))
        throw new Error('reference_query_unknown_field');
    for (const key of ['query', 'content_hash', 'cursor'])
        if (q[key] !== undefined && (typeof q[key] !== 'string' || q[key].length > (key === 'query' ? 2000 : 4096)))
            throw new Error('reference_query_invalid');
    for (const key of ['signals', 'asset_ids'])
        if (q[key] !== undefined && (!Array.isArray(q[key]) || q[key].length > 100 || q[key].some((x) => typeof x !== 'string' || x.length > 256)))
            throw new Error('reference_query_invalid');
    const limit = q['max_assets'] ?? 20;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_REFERENCE_BATCH)
        throw new Error('reference_query_limit');
    if (q['asset_type'] !== undefined && q['asset_type'] !== 'Gene' && q['asset_type'] !== 'Capsule')
        throw new Error('reference_projection_invalid');
    return { ...value, max_assets: Number(limit) };
}