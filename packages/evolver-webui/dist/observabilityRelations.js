import { redactDiagnosticText } from './diagnosticSanitize.js';
const MAX_ID = 160;
const MAX_RELATIONS = 50;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
function safeOpaqueId(value) {
    if (typeof value !== 'string')
        return '';
    const id = value.trim();
    return OPAQUE_ID_RE.test(id) ? id : '';
}
function safeDisplayText(value) {
    if (typeof value !== 'string')
        return '';
    return redactDiagnosticText(value, MAX_ID);
}
function safePrUrl(value) {
    if (typeof value !== 'string')
        return '';
    const raw = value.replace(/[\r\n\t]/g, '').trim();
    if (!raw)
        return '';
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:')
            return '';
        const host = url.hostname.toLowerCase();
        if ((host !== 'github.com' && !host.endsWith('.github.com')) || url.port)
            return '';
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString().slice(0, MAX_ID);
    }
    catch {
        return '';
    }
}
function positivePrNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function addAsset(out, value, type) {
    const id = safeOpaqueId(value);
    if (!id || out.size >= MAX_RELATIONS)
        return;
    const key = `${type}:${id}`;
    if (!out.has(key))
        out.set(key, { id, assetId: id, type });
}
function addAssetArray(out, value, type) {
    if (!Array.isArray(value))
        return;
    for (const item of value)
        addAsset(out, item, type);
}
function relationsFromPayload(payload) {
    const assets = new Map();
    addAsset(assets, payload['assetId'] ?? payload['asset_id'], 'asset');
    addAsset(assets, payload['geneId'] ?? payload['gene'], 'gene');
    addAsset(assets, payload['capsuleId'] ?? payload['capsule_id'], 'capsule');
    addAssetArray(assets, payload['assetIds'] ?? payload['asset_ids'], 'asset');
    addAssetArray(assets, payload['genesUsed'] ?? payload['genes_used'] ?? payload['genes'], 'gene');
    const traceId = safeOpaqueId(payload['traceId'] ?? payload['trace_id'] ?? payload['trajectoryId'] ?? payload['trajectory_id']);
    const sessionId = safeOpaqueId(payload['sessionId'] ?? payload['session_id']);
    const trajectories = traceId || sessionId ? [{ traceId, sessionId }] : [];
    const url = safePrUrl(payload['pullRequestUrl'] ?? payload['pull_request_url'] ?? payload['prUrl'] ?? payload['pr_url'] ?? payload['githubPrUrl']);
    const number = positivePrNumber(payload['pullRequestNumber'] ?? payload['pull_request_number'] ?? payload['prNumber'] ?? payload['pr_number'] ?? payload['githubPrNumber']);
    const repo = safeDisplayText(payload['repo'] ?? payload['repository'] ?? payload['githubRepo']);
    const pullRequests = url || number !== null ? [{ number, url, repo }] : [];
    return { assets: [...assets.values()], trajectories, pullRequests };
}
function dedupe(items, key) {
    const out = new Map();
    for (const item of items) {
        const itemKey = key(item);
        if (!itemKey || out.has(itemKey) || out.size >= MAX_RELATIONS)
            continue;
        out.set(itemKey, item);
    }
    return [...out.values()];
}
export function eventRelations(event) {
    return relationsFromPayload((event.payload ?? {}));
}
export function eventListRelations(events) {
    const relations = events.map(eventRelations);
    return {
        assets: dedupe(relations.flatMap((entry) => entry.assets), (item) => `${item.type}:${item.assetId}`),
        trajectories: dedupe(relations.flatMap((entry) => entry.trajectories), (item) => `${item.traceId}:${item.sessionId}`),
        pullRequests: dedupe(relations.flatMap((entry) => entry.pullRequests), (item) => `${item.url}:${item.repo}:${item.number ?? ''}`),
    };
}