/**
 * A feedback delivery may be replayed after its local append was committed but before the
 * writer received an acknowledgement. Count that delivery once. If the same operation ID
 * names conflicting facts, count neither: arrival order must not decide whether an asset
 * receives a positive or negative signal.
 *
 * Historical autoexec fetch-time hits had a recognizable cycle prefix but no
 * application binding. They were not terminal reuse evidence and are excluded
 * from projections without rewriting the append-only audit log. Other legacy
 * (including MCP result) events retain their existing counting semantics.
 */
import { isExecutionEligible } from '../reference/guard.js';
export function hasReusePayload(event) {
    return event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload);
}
function semanticSignature(parts) {
    return JSON.stringify(parts, (_key, value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return value;
        // These fields are normally scalars, but historical/untyped event payloads can contain
        // JSON objects. Their property insertion order is not a difference in the reuse fact.
        const ordered = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return Object.fromEntries(ordered);
    });
}
export function* uniqueReuseFactSteps(events, scope) {
    const kinds = new Set(['value.reuse_hit', 'value.reuse_outcome']);
    // Reference-only evidence cannot veto or shadow an executable fact sharing its source ID.
    const eligibleEvents = [];
    for (const event of events) {
        yield;
        if (kinds.has(event.type) && isExecutionEligible(event, scope))
            eligibleEvents.push(event);
    }
    const facts = new Map();
    for (const event of eligibleEvents) {
        yield;
        const p = hasReusePayload(event) ? event.payload : {};
        if (event.type === 'value.reuse_hit'
            && typeof p['cycleId'] === 'string'
            && p['cycleId'].startsWith('autoexec-')
            && p['applicationBinding'] !== 'selected_execution')
            continue;
        const id = p['sourceEventId'];
        if (id === undefined)
            continue;
        if (typeof id !== 'string' || id.trim().length === 0)
            continue;
        const signature = semanticSignature([
            event.type, p['assetId'], p['cycleId'], p['outcome'], p['fetchTokens'],
            p['baselineTokens'], p['signalFingerprint'], p['model'], p['geneId'],
            p['source'], p['applicationBinding'], p['verification'], p['producedValue'],
            p['capsuleId'], p['eventId'], p['terminalDisposition'],
        ]);
        const previous = facts.get(id);
        if (!previous)
            facts.set(id, { signature, conflict: false });
        else if (previous.signature !== signature)
            previous.conflict = true;
    }
    const seen = new Set();
    const unique = [];
    for (const event of eligibleEvents) {
        yield;
        const p = hasReusePayload(event) ? event.payload : {};
        if (event.type === 'value.reuse_hit'
            && typeof p['cycleId'] === 'string'
            && p['cycleId'].startsWith('autoexec-')
            && p['applicationBinding'] !== 'selected_execution')
            continue;
        const id = p['sourceEventId'];
        if (id !== undefined) {
            if (typeof id !== 'string' || id.trim().length === 0 || facts.get(id)?.conflict || seen.has(id))
                continue;
            seen.add(id);
        }
        unique.push(event);
    }
    return unique;
}
export function uniqueReuseFacts(events, scope) {
    const steps = uniqueReuseFactSteps(events, scope);
    let result = steps.next();
    while (!result.done)
        result = steps.next();
    return result.value;
}