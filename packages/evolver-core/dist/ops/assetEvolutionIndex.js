import { resolveReviewHistory } from '../assetstore/reviewLedger.js';
import { capsuleGeneRef, familiesOf, reviewTimelineKind, boundedText } from './assetEvolutionFamilies.js';
import { isDerivation, lineageEdgesOf, relativesOf } from './assetEvolutionLineage.js';
import { deliveryFactsOf, isValidTime, reuseFactsOf } from './assetEvolutionSignals.js';
function familyLookup(families, capsules) {
    const byAsset = new Map();
    const byLogical = new Map();
    for (const family of families) {
        if (family.logicalId)
            byLogical.set(family.logicalId, family);
        for (const member of family.members)
            byAsset.set(member.asset_id, family);
    }
    const capsuleById = new Map(capsules.map((capsule) => [capsule.asset_id, capsule]));
    const familyOfGene = (ref) => byAsset.get(ref) ?? byLogical.get(ref);
    return {
        familyOfGene,
        familyOfAsset: (assetId) => {
            const direct = byAsset.get(assetId);
            if (direct)
                return direct;
            const geneRef = capsuleById.has(assetId) ? capsuleGeneRef(capsuleById.get(assetId)) : null;
            return geneRef ? familyOfGene(geneRef) : undefined;
        },
        isLocalCapsule: (assetId) => capsuleById.has(assetId),
    };
}
function appendTo(index, key, value) {
    const list = index.get(key);
    if (list)
        list.push(value);
    else
        index.set(key, [value]);
}
function capsulesByFamilyOf(capsules, lookup) {
    const index = new Map();
    for (const capsule of capsules) {
        const geneRef = capsuleGeneRef(capsule);
        const reused = typeof capsule['reused_asset_id'] === 'string' ? capsule['reused_asset_id'] : null;
        const family = (geneRef ? lookup.familyOfGene(geneRef) : undefined) ?? (reused ? lookup.familyOfGene(reused) : undefined);
        if (family)
            appendTo(index, family.key, capsule);
    }
    return index;
}
function deliveriesByFamilyOf(deliveries, lookup) {
    const index = new Map();
    for (const delivery of deliveries) {
        const families = new Set();
        for (const ref of delivery.geneRefs) {
            const family = lookup.familyOfGene(ref);
            if (family)
                families.add(family);
        }
        for (const id of delivery.capsuleIds) {
            const family = lookup.familyOfAsset(id);
            if (family)
                families.add(family);
        }
        for (const family of families)
            appendTo(index, family.key, delivery);
    }
    return index;
}
function emptyEntry(at, kind, assetId, family) {
    return {
        at, kind, assetId, logicalId: family?.logicalId ?? null, title: family?.title ?? null,
        by: null, reason: null, outcome: null, host: null, tier: null, stage: null, related: [],
    };
}
function reviewEntries(history, lookup) {
    const entries = [];
    const born = new Set();
    for (const record of history) {
        const family = lookup.familyOfGene(record.assetId);
        if (!family || !isValidTime(record.at))
            continue;
        if (!born.has(record.assetId)) {
            born.add(record.assetId);
            entries.push(emptyEntry(record.at, 'born', record.assetId, family));
        }
        entries.push({ ...emptyEntry(record.at, reviewTimelineKind(record), record.assetId, family),
            by: boundedText(record.by, 80), reason: boundedText(record.reason, 240) });
    }
    return entries;
}
function reuseEntries(reuses, lookup) {
    return reuses.map((fact) => ({
        ...emptyEntry(fact.at, fact.outcome === 'success' ? 'reused' : 'reuse_failed', fact.assetId, lookup.familyOfAsset(fact.assetId)),
        outcome: fact.outcome, host: fact.host, tier: fact.tier, stage: fact.stage,
    }));
}
/** A derivation is dated by its child's first review record; a child with no record has no derivable time. */
function derivedEntries(edges, reviewByAsset, lookup) {
    const parentsByChild = new Map();
    for (const edge of edges)
        if (isDerivation(edge))
            appendTo(parentsByChild, edge.to, edge.from);
    const entries = [];
    for (const [child, parents] of parentsByChild) {
        const bornAt = reviewByAsset.get(child)?.find((record) => isValidTime(record.at))?.at;
        if (bornAt)
            entries.push({ ...emptyEntry(bornAt, 'derived', child, lookup.familyOfAsset(child)), related: [...new Set(parents)] });
    }
    return entries;
}
function newestFirst(entries) {
    return entries
        .map((entry, seq) => ({ entry, seq, time: Date.parse(entry.at) }))
        .sort((a, b) => (b.time - a.time) || (b.seq - a.seq))
        .map(({ entry }) => entry);
}
// A delivery is activity too: a gene handed to every session is the most active one, though no review or reuse names it.
function lastActivityOf(timeline, lookup, deliveriesByFamily) {
    const latest = new Map();
    const touch = (key, at) => {
        const current = latest.get(key);
        if (current === undefined || Date.parse(at) > Date.parse(current))
            latest.set(key, at);
    };
    for (const entry of timeline) {
        for (const assetId of [entry.assetId, ...entry.related]) {
            const family = lookup.familyOfAsset(assetId);
            if (family)
                touch(family.key, entry.at);
        }
    }
    for (const [key, deliveries] of deliveriesByFamily)
        for (const delivery of deliveries)
            touch(key, delivery.at);
    return latest;
}
export function buildEvolutionIndex(input) {
    const families = familiesOf(input.genes, input.provenance);
    const lookup = familyLookup(families, input.capsules);
    const reviewByAsset = new Map();
    for (const record of input.reviewHistory)
        appendTo(reviewByAsset, record.assetId, record);
    const reuses = reuseFactsOf(input.events);
    const deliveries = deliveryFactsOf(input.events);
    const edges = lineageEdgesOf(families, input.capsules, lookup);
    const { parents, children } = relativesOf(edges, lookup);
    const reusesByFamily = new Map();
    for (const fact of reuses) {
        const family = lookup.familyOfAsset(fact.assetId);
        if (family)
            appendTo(reusesByFamily, family.key, fact);
    }
    const timeline = newestFirst([
        ...reviewEntries(input.reviewHistory, lookup), ...reuseEntries(reuses, lookup), ...derivedEntries(edges, reviewByAsset, lookup),
    ]);
    const deliveriesByFamily = deliveriesByFamilyOf(deliveries, lookup);
    return {
        input, families, lookup, reviewByAsset, reuses, deliveries, edges, parents, children, reusesByFamily, timeline,
        effectiveReview: resolveReviewHistory(input.reviewHistory),
        reviewOrder: new Map(input.reviewHistory.map((record, position) => [record, position])),
        capsulesByFamily: capsulesByFamilyOf(input.capsules, lookup),
        deliveriesByFamily,
        lastActivityByFamily: lastActivityOf(timeline, lookup, deliveriesByFamily),
    };
}