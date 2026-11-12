import { capsuleKind, boundedText, memberOrigin, printableId, reviewView } from './assetEvolutionFamilies.js';
import { isDerivation } from './assetEvolutionLineage.js';
import { buildEvolutionIndex } from './assetEvolutionIndex.js';
import { assetState, byRecentActivity, deliveryStatsOf, reuseStatsOf, summaryOf } from './assetEvolutionSummary.js';
export { ASSET_EVOLUTION_SCHEMA } from './assetEvolutionModel.js';
const MAX_LISTED_FAMILIES = 300;
const MAX_NETWORK_ASSETS = 200;
const MAX_DOSSIER_ITEMS = 200;
const MAX_DOSSIER_REUSES = 300;
const STATES = ['trial', 'approved', 'eligible', 'rejected', 'paused', 'removed', 'untrusted'];
function networkOf(index) {
    const byAsset = new Map();
    for (const fact of index.reuses) {
        if (index.lookup.familyOfAsset(fact.assetId))
            continue;
        const facts = byAsset.get(fact.assetId);
        if (facts)
            facts.push(fact);
        else
            byAsset.set(fact.assetId, [fact]);
    }
    return [...byAsset.entries()]
        .map(([assetId, facts]) => ({ assetId, reuse: reuseStatsOf(facts) }))
        .sort((a, b) => (b.reuse.success + b.reuse.failed) - (a.reuse.success + a.reuse.failed)
        || Date.parse(b.reuse.lastAt ?? '') - Date.parse(a.reuse.lastAt ?? '') || a.assetId.localeCompare(b.assetId));
}
function loopOf(index) {
    const lastReuse = index.timeline.find((entry) => entry.kind === 'reused' || entry.kind === 'reuse_failed')?.at ?? null;
    const reuseTime = lastReuse ? Date.parse(lastReuse) : -Infinity;
    return {
        lastDeliveryAt: deliveryStatsOf(index.deliveries, false).lastAt,
        lastReuseAt: lastReuse,
        deliveriesSinceLastReuse: index.deliveries.filter((delivery) => Date.parse(delivery.at) > reuseTime).length,
    };
}
function totalsOf(index, network) {
    const states = Object.fromEntries(STATES.map((state) => [state, 0]));
    for (const gene of index.input.genes)
        states[assetState(index, gene.asset_id)] += 1;
    const all = reuseStatsOf(index.reuses);
    const localAssets = new Set(index.reuses.flatMap((fact) => index.lookup.familyOfAsset(fact.assetId) ? [fact.assetId] : []));
    return {
        families: index.families.length,
        assets: index.input.genes.length,
        states,
        reuse: { success: all.success, failed: all.failed, localAssets: localAssets.size, networkAssets: network.length, hosts: all.hosts },
        deliveries: index.deliveries.length,
        derived: index.families.filter((family) => (index.parents.get(family.key)?.size ?? 0) > 0).length,
    };
}
export function projectAssetEvolutionOverview(input, options) {
    const index = buildEvolutionIndex(input);
    const network = networkOf(index);
    const assets = index.families
        .map((family) => ({ family, summary: summaryOf(index, family) }))
        .sort(byRecentActivity)
        .slice(0, MAX_LISTED_FAMILIES)
        .map(({ summary }) => summary);
    const capped = index.families.length > MAX_LISTED_FAMILIES || network.length > MAX_NETWORK_ASSETS;
    return {
        generatedAt: new Date(input.now).toISOString(),
        sources: { ...input.sources, truncated: input.sources.truncated || capped },
        totals: totalsOf(index, network),
        loop: loopOf(index),
        assets,
        network: network.slice(0, MAX_NETWORK_ASSETS),
        timeline: index.timeline.slice(0, options.limit),
    };
}
/** Slices dossier lists to their caps and remembers whether anything was actually cut. */
class ListCap {
    truncated = false;
    first(items, max) {
        if (items.length > max)
            this.truncated = true;
        return items.slice(0, max);
    }
    last(items, max) {
        if (items.length > max)
            this.truncated = true;
        return items.slice(-max);
    }
}
function relatedOf(parents, children, cap) {
    const seen = new Set();
    const view = (relation) => (item) => {
        if (seen.has(`${relation}\n${item.key}`))
            return [];
        seen.add(`${relation}\n${item.key}`);
        return [{ assetId: item.assetId, logicalId: item.family?.logicalId ?? null, title: item.family?.title ?? null, relation }];
    };
    return cap.first([...[...parents].flatMap(view('parent')), ...[...children].flatMap(view('child'))], MAX_DOSSIER_ITEMS);
}
function reuseRecords(facts, cap) {
    return cap.first([...facts].reverse(), MAX_DOSSIER_REUSES)
        .map(({ at, outcome, host, tier, stage, taskId, cycleId }) => ({ at, outcome, host, tier, stage, taskId, cycleId }));
}
function touching(ids) {
    return {
        edge: (edge) => ids.has(edge.from) || ids.has(edge.to),
        entry: (entry) => ids.has(entry.assetId) || entry.related.some((id) => ids.has(id)),
    };
}
function familyDossier(index, family, options, cap) {
    const ids = new Set(family.members.map((member) => member.asset_id));
    const touches = touching(ids);
    const capsules = cap.first([...(index.capsulesByFamily.get(family.key) ?? [])].reverse(), MAX_DOSSIER_ITEMS);
    return {
        asset: summaryOf(index, family),
        network: null,
        members: family.members.map((member, position) => {
            const record = index.effectiveReview.get(member.asset_id);
            const reviewed = (index.reviewByAsset.get(member.asset_id)?.length ?? 0) > 0;
            return { assetId: member.asset_id, ordinal: position + 1, current: position === family.members.length - 1,
                origin: memberOrigin(family, member, position + 1, reviewed, index.input.provenance.get(member.asset_id)),
                review: record ? reviewView(record) : null };
        }),
        edges: cap.first(index.edges.filter(touches.edge), MAX_DOSSIER_ITEMS),
        related: relatedOf(index.parents.get(family.key)?.values() ?? [], index.children.get(family.key)?.values() ?? [], cap),
        capsules: capsules.map((capsule) => {
            const outcome = capsule['outcome'];
            return { assetId: capsule.asset_id, id: printableId(capsule['id']) ?? capsule.asset_id, kind: capsuleKind(capsule),
                outcome: outcome?.status === 'success' ? 'success' : 'failed',
                score: typeof outcome?.score === 'number' && Number.isFinite(outcome.score) ? outcome.score : 0,
                summary: boundedText(capsule['summary'], 240) ?? '' };
        }),
        reuses: reuseRecords(index.reusesByFamily.get(family.key) ?? [], cap),
        deliveries: deliveryStatsOf(index.deliveriesByFamily.get(family.key) ?? [], true),
        review: cap.last(index.input.reviewHistory.filter((record) => ids.has(record.assetId)), MAX_DOSSIER_ITEMS).map(reviewView),
        timeline: index.timeline.filter(touches.entry).slice(0, options.limit),
    };
}
function networkDossier(index, assetId, options, cap) {
    const touches = touching(new Set([assetId]));
    const facts = index.reuses.filter((fact) => fact.assetId === assetId);
    const edges = index.edges.filter(touches.edge);
    const deliveries = index.deliveries.filter((delivery) => delivery.geneRefs.includes(assetId) || delivery.capsuleIds.includes(assetId));
    if (facts.length === 0 && edges.length === 0 && deliveries.length === 0)
        return null;
    const derivations = edges.filter(isDerivation);
    const endpoint = (id) => {
        const family = index.lookup.familyOfAsset(id);
        return { key: family ? family.key : id, assetId: id, family };
    };
    return {
        asset: null,
        network: { assetId, reuse: reuseStatsOf(facts) },
        members: [],
        edges: cap.first(edges, MAX_DOSSIER_ITEMS),
        related: relatedOf(derivations.filter((edge) => edge.to === assetId).map((edge) => endpoint(edge.from)), derivations.filter((edge) => edge.from === assetId).map((edge) => endpoint(edge.to)), cap),
        capsules: [],
        reuses: reuseRecords(facts, cap),
        deliveries: deliveryStatsOf(deliveries, true),
        review: [],
        timeline: index.timeline.filter(touches.entry).slice(0, options.limit),
    };
}
/** The dossier for a local Gene (by content id or logical id) or a network asset seen locally; null when unknown. */
export function projectAssetEvolutionDossier(input, ref, options) {
    const index = buildEvolutionIndex(input);
    const family = index.lookup.familyOfGene(ref) ?? index.lookup.familyOfAsset(ref);
    const cap = new ListCap();
    const dossier = family ? familyDossier(index, family, options, cap) : networkDossier(index, ref, options, cap);
    if (!dossier)
        return null;
    return { ...dossier, sources: { ...input.sources, truncated: input.sources.truncated || cap.truncated } };
}