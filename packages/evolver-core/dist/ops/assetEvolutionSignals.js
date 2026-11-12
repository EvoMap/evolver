import { uniqueReuseFacts } from './reuseEventIdentity.js';
import { VALUE_INJECT_EVENT, VALUE_REUSE_HIT_EVENT } from './valueLedger.js';
import { VALUE_REUSE_OUTCOME_EVENT } from './reuseOutcomes.js';
import { GENE_CONTEXT_DELIVERY_EVENT, readGeneContextDeliveryReceipt } from './geneContextDelivery.js';
import { printableId } from './assetEvolutionFamilies.js';
const NEGATIVE_OUTCOMES = new Set(['failed', 'mismatched', 'stale', 'unsafe']);
const TIERS = new Set(['L1', 'L2', 'L3', 'none']);
const STAGES = new Set(['immediate', 'retention', 'correction']);
const HOST = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ENTRYPOINT = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_DELIVERY_REFS = 64;
export function isValidTime(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function hostOf(payload, cycleId) {
    const platform = typeof payload['platform'] === 'string' ? payload['platform'].trim().toLowerCase() : '';
    if (HOST.test(platform))
        return platform;
    return cycleId?.startsWith('mcp') ? 'mcp' : null;
}
function taskIdOf(payload, cycleId) {
    const declared = printableId(payload['taskId']);
    if (declared)
        return declared;
    const separator = cycleId?.startsWith('mcp') ? cycleId.indexOf(':') : -1;
    return separator > 0 ? printableId(cycleId.slice(separator + 1)) : null;
}
function outcomeOf(event) {
    if (event.type === VALUE_REUSE_HIT_EVENT)
        return 'success';
    const outcome = event.payload?.['outcome'];
    return typeof outcome === 'string' && NEGATIVE_OUTCOMES.has(outcome) ? outcome : null;
}
function reuseFactOf(event) {
    const payload = event.payload ?? {};
    const assetId = printableId(payload['assetId']);
    const outcome = outcomeOf(event);
    if (!assetId || !outcome || !isValidTime(event.ts))
        return null;
    const cycleId = printableId(payload['cycleId']);
    const tier = payload['tier'];
    const stage = payload['stage'];
    return {
        assetId, at: event.ts, outcome, cycleId,
        host: hostOf(payload, cycleId),
        tier: typeof tier === 'string' && TIERS.has(tier) ? tier : null,
        stage: typeof stage === 'string' && STAGES.has(stage) ? stage : null,
        taskId: taskIdOf(payload, cycleId),
    };
}
/** Reuse reports counted once per delivery identity, with the same dedupe the reuse report applies. */
export function reuseFactsOf(events) {
    const reuseEvents = events.filter((event) => event.type === VALUE_REUSE_HIT_EVENT || event.type === VALUE_REUSE_OUTCOME_EVENT);
    return uniqueReuseFacts(reuseEvents).flatMap((event) => reuseFactOf(event) ?? []);
}
function stringIds(value) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.flatMap((item) => printableId(item) ?? []))].slice(0, MAX_DELIVERY_REFS);
}
function contextDeliveryOf(event) {
    const payload = event.payload ?? {};
    const receipt = readGeneContextDeliveryReceipt(payload['receipt']);
    if (!receipt || payload['transport'] === 'would_render')
        return null;
    const entrypoint = typeof payload['entrypoint'] === 'string' && ENTRYPOINT.test(payload['entrypoint']) ? payload['entrypoint'] : 'unknown';
    return { at: event.ts, entrypoint, geneRefs: receipt.geneAssetIds, capsuleIds: receipt.capsuleAssetIds };
}
function injectDeliveryOf(event) {
    const payload = event.payload ?? {};
    const geneRefs = stringIds(payload['geneIds']);
    if (geneRefs.length === 0)
        return null;
    const cycleId = printableId(payload['cycleId']);
    return { at: event.ts, entrypoint: cycleId?.startsWith('mcp') ? 'mcp_recall' : 'session_start', geneRefs, capsuleIds: [] };
}
// A retried write repeats the delivery attempt id (or the event id); counting it twice would inflate deliveries.
function deliveryIdentity(event) {
    const attempt = printableId(event.payload?.['deliveryAttemptId']);
    if (attempt)
        return `attempt:${attempt}`;
    return typeof event.eventId === 'string' && event.eventId.length > 0 ? `event:${event.eventId}` : null;
}
/** Gene deliveries from session-start/prompt-recall receipts and `value.inject`, once per delivery. A shadow render is not a delivery. */
export function deliveryFactsOf(events) {
    const facts = [];
    const seen = new Set();
    for (const event of events) {
        if (!isValidTime(event.ts))
            continue;
        const fact = event.type === GENE_CONTEXT_DELIVERY_EVENT ? contextDeliveryOf(event)
            : event.type === VALUE_INJECT_EVENT ? injectDeliveryOf(event) : null;
        if (!fact)
            continue;
        const identity = deliveryIdentity(event);
        if (identity && seen.has(identity))
            continue;
        if (identity)
            seen.add(identity);
        facts.push(fact);
    }
    return facts;
}