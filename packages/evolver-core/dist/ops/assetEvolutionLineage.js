import { normalizeReusedAssetIds } from '../wire/index.js';
import { capsuleGeneRef } from './assetEvolutionFamilies.js';
const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;
const DERIVATION_KINDS = new Set(['reused_in_distillation', 'reverified']);
function sameFamilyEdges(family) {
    return family.members.slice(1).map((member, index) => ({
        from: family.members[index].asset_id, to: member.asset_id, kind: 'same_family', evidence: 'logical_id',
    }));
}
function reusedInDistillationEdges(gene) {
    const meta = gene['generation_meta'];
    const reused = meta && typeof meta === 'object' ? normalizeReusedAssetIds(meta['reused_asset_ids']) : [];
    return reused.filter((id) => id !== gene.asset_id).map((from) => ({
        from, to: gene.asset_id, kind: 'reused_in_distillation', evidence: 'generation_meta.reused_asset_ids',
    }));
}
function reverifiedEdges(capsule, lookup) {
    const content = capsule['content'];
    const sources = content && typeof content === 'object' ? content['source_asset_ids'] : undefined;
    if (!Array.isArray(sources))
        return [];
    const geneRef = capsuleGeneRef(capsule);
    const child = geneRef ? lookup.familyOfGene(geneRef) : undefined;
    // The capsule names one version (content id) or the family (logical id, i.e. the version reverify produced, the
    // first): pin to that, so a later version of the family never inherits the edge.
    const to = !child ? capsule.asset_id
        : child.members.some((member) => member.asset_id === geneRef) ? geneRef
            : child.members[0].asset_id;
    return sources
        .filter((id) => typeof id === 'string' && CONTENT_ID.test(id) && id !== to && !lookup.isLocalCapsule(id))
        .map((from) => ({ from, to, kind: 'reverified', evidence: 'capsule.content.source_asset_ids' }));
}
function observedReuseEdge(capsule) {
    const reused = capsule['reused_asset_id'];
    if (capsule['source_type'] !== 'reused' || typeof reused !== 'string' || !CONTENT_ID.test(reused))
        return [];
    return [{ from: reused, to: capsule.asset_id, kind: 'observed_reuse', evidence: 'capsule.reused_asset_id' }];
}
/** Only links the stores already hold; nothing is inferred from similarity or timing. */
export function lineageEdgesOf(families, capsules, lookup) {
    const edges = [];
    for (const family of families) {
        edges.push(...sameFamilyEdges(family));
        for (const member of family.members)
            edges.push(...reusedInDistillationEdges(member));
    }
    for (const capsule of capsules)
        edges.push(...reverifiedEdges(capsule, lookup), ...observedReuseEdge(capsule));
    const seen = new Set();
    return edges.filter((edge) => {
        const key = `${edge.kind}\n${edge.from}\n${edge.to}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
export function isDerivation(edge) {
    return DERIVATION_KINDS.has(edge.kind);
}
function relative(assetId, lookup) {
    const family = lookup.familyOfAsset(assetId);
    return { key: family ? `family:${family.key}` : `asset:${assetId}`, assetId, family };
}
function addRelative(index, familyKey, item) {
    const relatives = index.get(familyKey) ?? new Map();
    if (!relatives.has(item.key))
        relatives.set(item.key, item);
    index.set(familyKey, relatives);
}
/** Parents and children of every local family through derivation edges, excluding the family itself. */
export function relativesOf(edges, lookup) {
    const parents = new Map();
    const children = new Map();
    for (const edge of edges) {
        if (!isDerivation(edge))
            continue;
        const from = relative(edge.from, lookup);
        const to = relative(edge.to, lookup);
        if (from.key === to.key)
            continue;
        if (to.family)
            addRelative(parents, to.family.key, from);
        if (from.family)
            addRelative(children, from.family.key, to);
    }
    return { parents, children };
}