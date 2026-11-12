import { fullLeakCheck, sanitizeBundle } from '../hub/sanitize.js';
import { GENE_HINT_FIELDS, computeAssetId, stripGeneHints } from '../wire/index.js';
const LOCAL_CONTEXT_FIELDS = ['project_notes', 'project_fingerprint'];
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function withId(asset) {
    const { asset_id: _old, ...body } = asset;
    return { ...body, asset_id: computeAssetId(body) ?? '' };
}
function strippedCapsule(capsule, keep, removed) {
    const out = { ...capsule };
    if (isRecord(capsule['content'])) {
        const content = { ...capsule['content'] };
        if (!keep.excerpt && content['excerpt'] !== undefined) {
            delete content['excerpt'];
            removed.push('capsule.content.excerpt');
        }
        for (const field of LOCAL_CONTEXT_FIELDS) {
            if (content[field] !== undefined) {
                delete content[field];
                removed.push(`capsule.content.${field}`);
            }
        }
        out['content'] = content;
    }
    // The publish sanitizer keeps a Capsule's task prompt on this machine whatever the caller asks, so it is always listed.
    if (isRecord(capsule['trigger_context']) && capsule['trigger_context']['prompt'] !== undefined) {
        const { prompt: _prompt, ...context } = capsule['trigger_context'];
        out['trigger_context'] = context;
        removed.push('capsule.trigger_context.prompt');
    }
    return out;
}
function leafLeaks(value, path, env, out) {
    if (typeof value === 'string') {
        for (const leak of fullLeakCheck(value, env).leaks)
            if (leak.type !== 'local_path')
                out.push({ kind: leak.type, path });
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => leafLeaks(item, `${path}[${index}]`, env, out));
        return;
    }
    if (isRecord(value))
        for (const [key, item] of Object.entries(value))
            leafLeaks(item, `${path}.${key}`, env, out);
}
function blockingLeaks(prefixes, assets, bundleLeaks, env) {
    const located = [];
    assets.forEach((asset, index) => leafLeaks(asset, prefixes[index], env, located));
    const kinds = new Set(located.map((leak) => leak.kind));
    const unlocated = bundleLeaks.filter((leak) => leak.type !== 'local_path' && !kinds.has(leak.type))
        .map((leak) => ({ kind: leak.type, path: prefixes.join('+') }));
    const seen = new Set();
    return [...located, ...unlocated].filter((leak) => {
        const key = `${leak.kind}:${leak.path}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/**
 * What would leave this machine: local-only Gene hints and unkept Capsule text stripped, the strict publish sanitizer
 * applied, content ids recomputed and the Capsule rebound to the final Gene id. Leaks are located by field.
 */
export function preparePublication(gene, capsule, keep, env) {
    const removed = GENE_HINT_FIELDS.filter((field) => gene[field] !== undefined).map((field) => `gene.${field}`);
    const wireGene = withId(stripGeneHints(gene));
    const references = new Set([gene.asset_id, wireGene.asset_id, String(gene['id'] ?? '')].filter(Boolean));
    const bound = capsule ? withId({ ...strippedCapsule(capsule, keep, removed),
        ...(typeof capsule['gene'] === 'string' && references.has(capsule['gene']) ? { gene: wireGene.asset_id } : {}) }) : undefined;
    const bundle = bound ? [wireGene, bound] : [wireGene];
    const sanitized = sanitizeBundle(bundle, { env, mode: 'strict' });
    const [finalGene, finalCapsule] = sanitized.bundle;
    const assets = finalCapsule && finalCapsule['gene'] === wireGene.asset_id && finalGene.asset_id !== wireGene.asset_id
        ? [finalGene, withId({ ...finalCapsule, gene: finalGene.asset_id })] : sanitized.bundle;
    const prefixes = bound ? ['gene', 'capsule'] : ['gene'];
    return { assets, removed, leaks: sanitized.blocked ? blockingLeaks(prefixes, bundle, sanitized.leaks, env) : [], blocked: sanitized.blocked };
}