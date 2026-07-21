import { assetstore, events as ev } from '@evomap/evolver-core';
import { eventListRelations, eventRelations } from './observabilityRelations.js';
import { redactDiagnosticText } from './diagnosticSanitize.js';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE = 20;
const MAX_EVENT_SCAN = 5_000;
const MAX_ASSET_SCAN = 5_000;
const MAX_TEXT = 240;
function boundedPage(input) {
    const requestedPage = Number.isFinite(input.page) ? Math.floor(input.page ?? 1) : 1;
    const page = Math.min(Math.max(requestedPage, 1), MAX_PAGE);
    const requestedSize = Number.isFinite(input.pageSize) ? Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    return { page, pageSize, offset, limit: offset + pageSize + 1, truncated: requestedPage > MAX_PAGE };
}
function redactText(value) {
    return redactDiagnosticText(value, MAX_TEXT).replace(/[\r\n\t]+/g, ' ').trim();
}
function idText(value) {
    return redactText(value).slice(0, 160);
}
function lookupId(value) {
    if (!value || value.length > 512)
        return null;
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            return null;
    }
    return value.trim() ? value : null;
}
function assetRow(record) {
    return {
        assetId: idText(record.asset_id),
        id: idText(record['id'] ?? record.asset_id),
        type: record.type,
        category: redactText(record['category'] ?? record['intent']),
        summary: redactText(record['summary']),
    };
}
function pageItems(items, input, sourceTruncated = false) {
    const page = boundedPage(input);
    const hasMoreItems = items.length > page.offset + page.pageSize;
    const pageLimitReached = page.page === MAX_PAGE && hasMoreItems;
    return {
        items: items.slice(page.offset, page.offset + page.pageSize),
        page: page.page,
        pageSize: page.pageSize,
        hasMore: page.page < MAX_PAGE && hasMoreItems,
        truncated: sourceTruncated || page.truncated || pageLimitReached,
    };
}
async function resolveAsset(store, id) {
    const direct = await store.get(id);
    if (direct)
        return { asset: direct, ambiguous: false, truncated: false };
    if (store.findByLogicalId) {
        const matches = await store.findByLogicalId(id, 2);
        return {
            asset: matches.length === 1 ? matches[0] : null,
            ambiguous: matches.length > 1,
            truncated: false,
        };
    }
    const records = await store.list(undefined, MAX_ASSET_SCAN + 1);
    const truncated = records.length > MAX_ASSET_SCAN;
    const matches = records.filter((record) => record['id'] === id);
    if (matches.length > 1)
        return { asset: null, ambiguous: true, truncated: false };
    if (truncated)
        return { asset: null, ambiguous: false, truncated: true };
    return { asset: matches.length === 1 ? matches[0] : null, ambiguous: false, truncated: false };
}
function pageInput(page, pageSize, fallback) {
    return { page: page ?? fallback.page, pageSize: pageSize ?? fallback.pageSize };
}
function eventMentions(event, ids) {
    if (ids.size === 0)
        return false;
    const payload = event.payload ?? {};
    for (const key of ['assetId', 'asset_id', 'geneId', 'gene', 'capsuleId', 'capsule_id']) {
        const value = payload[key];
        if (typeof value === 'string' && ids.has(value))
            return true;
    }
    for (const key of ['genes', 'genesUsed', 'genes_used', 'assetIds', 'asset_ids']) {
        const value = payload[key];
        if (Array.isArray(value) && value.some((entry) => typeof entry === 'string' && ids.has(entry)))
            return true;
    }
    return false;
}
function eventRow(event) {
    return {
        seq: Number.isFinite(event.seq) ? event.seq : 0,
        ts: redactText(event.ts),
        type: redactText(event.type),
        cycleId: redactText(event.payload?.['cycleId']),
        title: redactText(event.human?.title),
        why: redactText(event.human?.why),
        trajectories: eventRelations(event).trajectories,
        pullRequests: eventRelations(event).pullRequests,
    };
}
function unavailable(error) {
    return { available: false, error };
}
export async function listLineageAssets(store, input) {
    if (!store)
        return unavailable('asset_store_unavailable');
    const page = boundedPage(input);
    try {
        const records = await store.list(undefined, page.limit);
        return { available: true, data: pageItems(records.map(assetRow), input) };
    }
    catch {
        return unavailable('asset_store_unavailable');
    }
}
export async function loadAssetLineage(deps, requestedId, input) {
    const requestedLookupId = lookupId(requestedId);
    const id = idText(requestedId);
    if (!requestedLookupId) {
        return {
            id,
            asset: unavailable('asset_id_required'),
            capsules: unavailable('asset_id_required'),
            events: unavailable('asset_id_required'),
            review: unavailable('asset_id_required'),
            provenance: unavailable('asset_id_required'),
            relations: { assets: [], trajectories: [], pullRequests: [] },
        };
    }
    let asset = null;
    let ambiguousAsset = false;
    let truncatedLookup = false;
    let assetSource;
    if (!deps.store) {
        assetSource = unavailable('asset_store_unavailable');
    }
    else {
        try {
            const resolved = await resolveAsset(deps.store, requestedLookupId);
            asset = resolved.asset;
            ambiguousAsset = resolved.ambiguous;
            truncatedLookup = resolved.truncated;
            if (ambiguousAsset)
                assetSource = unavailable('asset_id_ambiguous');
            else if (truncatedLookup)
                assetSource = unavailable('asset_lookup_truncated');
            else
                assetSource = { available: true, data: asset ? assetRow(asset) : null };
        }
        catch {
            assetSource = unavailable('asset_store_unavailable');
        }
    }
    const resolutionError = ambiguousAsset ? 'asset_id_ambiguous' : truncatedLookup ? 'asset_lookup_truncated' : null;
    if (resolutionError) {
        return {
            id,
            asset: assetSource,
            capsules: unavailable(resolutionError),
            events: unavailable(resolutionError),
            review: unavailable(resolutionError),
            provenance: unavailable(resolutionError),
            relations: { assets: [], trajectories: [], pullRequests: [] },
        };
    }
    const logicalId = asset && typeof asset['id'] === 'string' ? asset['id'] : requestedLookupId;
    const parentGene = asset?.type === 'Capsule' && typeof asset['gene'] === 'string' ? asset['gene'] : undefined;
    const parentGeneRefs = new Set(parentGene ? [parentGene] : []);
    if (parentGene && deps.store) {
        try {
            const resolvedParent = await resolveAsset(deps.store, parentGene);
            if (resolvedParent.asset?.type === 'Gene') {
                parentGeneRefs.add(resolvedParent.asset.asset_id);
                if (typeof resolvedParent.asset['id'] === 'string')
                    parentGeneRefs.add(resolvedParent.asset['id']);
            }
        }
        catch {
            // The selected Capsule remains usable even if its parent cannot be expanded.
        }
    }
    const ids = new Set([requestedLookupId, logicalId, ...parentGeneRefs, asset?.asset_id].filter((value) => typeof value === 'string' && value.length > 0));
    const capsuleInput = pageInput(input.capsulePage, input.capsulePageSize, input);
    const eventInput = pageInput(input.eventPage, input.eventPageSize, input);
    let capsules;
    if (!deps.store) {
        capsules = unavailable('asset_store_unavailable');
    }
    else {
        try {
            const page = boundedPage(capsuleInput);
            const geneRefs = asset?.type === 'Capsule' ? [...parentGeneRefs] : [logicalId, asset?.asset_id];
            const records = [];
            const seen = new Set();
            for (const gene of geneRefs) {
                if (!gene)
                    continue;
                for (const record of await deps.store.search({ kind: 'Capsule', gene, limit: page.limit })) {
                    if (seen.has(record.asset_id))
                        continue;
                    seen.add(record.asset_id);
                    records.push(record);
                }
            }
            capsules = { available: true, data: pageItems(records.map(assetRow), capsuleInput) };
        }
        catch {
            capsules = unavailable('asset_store_unavailable');
        }
    }
    let events;
    let relations = { assets: [], trajectories: [], pullRequests: [] };
    try {
        const snapshot = await deps.events();
        const start = Math.max(0, snapshot.length - MAX_EVENT_SCAN);
        const matchedEvents = snapshot.slice(start).filter((event) => eventMentions(event, ids));
        relations = eventListRelations(matchedEvents);
        const matches = matchedEvents.reverse().map(eventRow);
        events = { available: true, data: pageItems(matches, eventInput, start > 0) };
    }
    catch {
        events = unavailable('event_snapshot_unavailable');
    }
    let review;
    try {
        if (ambiguousAsset)
            throw new Error('asset_id_ambiguous');
        const record = deps.review?.get(asset?.asset_id ?? requestedLookupId) ?? null;
        review = { available: true, data: record ? {
                state: redactText(record.state), at: redactText(record.at), by: redactText(record.by), reason: redactText(record.reason),
            } : null };
    }
    catch {
        review = unavailable(ambiguousAsset ? 'asset_id_ambiguous' : 'review_ledger_unavailable');
    }
    let provenance;
    try {
        if (ambiguousAsset)
            throw new Error('asset_id_ambiguous');
        const record = deps.provenance?.get(asset?.asset_id ?? requestedLookupId) ?? null;
        provenance = { available: true, data: record ? {
                source: redactText(record.source), trusted: record.trusted, at: redactText(record.at),
                promotedBy: redactText(record.promotedBy), reason: redactText(record.reason),
            } : null };
    }
    catch {
        provenance = unavailable(ambiguousAsset ? 'asset_id_ambiguous' : 'provenance_unavailable');
    }
    return { id, asset: assetSource, capsules, events, review, provenance, relations };
}