import { Ingestor } from './ingest.js';
import { rootEventsPath } from './paths.js';
import { HOST_SUPPRESS_CLASSES } from '../algo/cycleFailureClassifier.js';
export function readEvents(eventsPath) {
    const ing = new Ingestor({ path: eventsPath ?? rootEventsPath() });
    return ing.readAll();
}
const cycleIdOf = (e) => e.payload?.['cycleId'];
const failureClassOf = (e) => {
    const v = e.payload?.['failure_class'];
    return typeof v === 'string' ? v : undefined;
};
const suppressesFailure = (failureClass) => failureClass !== undefined && HOST_SUPPRESS_CLASSES.has(failureClass);
export function statusReport(evts) {
    const byType = {};
    const cycles = new Set();
    for (const e of evts) {
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        const c = cycleIdOf(e);
        if (c)
            cycles.add(c);
    }
    return { totalEvents: evts.length, byType, cycles: cycles.size, lastTs: evts.length ? evts[evts.length - 1].ts : null };
}
export function listCycles(evts) {
    const byCycle = new Map();
    for (const e of evts) {
        const c = cycleIdOf(e);
        if (!c)
            continue;
        (byCycle.get(c) ?? byCycle.set(c, []).get(c)).push(e);
    }
    const STAGE = new Set(['cycle.solidified', 'cycle.failed', 'cycle.aborted']);
    return [...byCycle.entries()].map(([cycleId, es]) => {
        const terminal = [...es].reverse().find((e) => STAGE.has(e.type));
        const failureClass = terminal?.type === 'cycle.failed' ? failureClassOf(terminal) : undefined;
        return {
            cycleId,
            events: es.length,
            finalStage: terminal?.type.replace('cycle.', '') ?? 'in_progress',
            lastTs: es[es.length - 1].ts,
            ...(failureClass !== undefined ? { failureClass, failureSuppressed: suppressesFailure(failureClass) } : {}),
        };
    });
}
export function showCycle(evts, cycleId) {
    const timeline = evts.filter((e) => cycleIdOf(e) === cycleId).map((e) => ({
        type: e.type, title: e.human?.title ?? '', ts: e.ts, seq: e.seq,
        ...(e.human?.why ? { why: e.human.why } : {}), ...(e.payload ? { payload: e.payload } : {}),
    }));
    return { cycleId, timeline };
}
export function listTriggers(evts) {
    return evts.filter((e) => e.type === 'decision.triggered' || e.type === 'decision.suppressed').map((e) => ({
        patternId: e.payload?.['patternId'] ?? '?',
        triggered: e.type === 'decision.triggered',
        value: e.payload?.['value'] ?? 0,
        reasons: e.payload?.['reasons'] ?? (e.human?.why ? [e.human.why] : []),
    }));
}
export function dailySummary(evts, dayPrefix) {
    const today = evts.filter((e) => e.ts.startsWith(dayPrefix));
    const count = (t) => today.filter((e) => e.type === t).length;
    const cycleIds = new Set(today.map(cycleIdOf).filter(Boolean));
    const failureBuckets = {};
    let suppressedFailures = 0;
    for (const e of today) {
        if (e.type !== 'cycle.failed')
            continue;
        const failureClass = failureClassOf(e);
        if (failureClass !== undefined) {
            failureBuckets[failureClass] = (failureBuckets[failureClass] ?? 0) + 1;
            if (suppressesFailure(failureClass))
                suppressedFailures += 1;
        }
    }
    return {
        date: dayPrefix,
        cycles: cycleIds.size,
        solidified: count('cycle.solidified'),
        failed: count('cycle.failed'),
        triggered: count('decision.triggered'),
        suppressed: count('decision.suppressed'),
        failureBuckets,
        suppressedFailures,
    };
}
export const NARRATIVE_DEFAULT_LIMIT = 30;
export const NARRATIVE_MAX_LIMIT = 200;
const NARRATIVE_EVENTS = new Set([
    'reflection.recorded',
    'cycle.solidified',
    'cycle.failed',
    'cycle.aborted',
    'decision.gene_selected',
    'value.reuse_hit',
    'value.inject',
    'value.reuse_outcome',
    'value.recall',
]);
const TOKEN_LIKE = /\b[A-Za-z0-9_-]{24,}\b|\b[A-Fa-f0-9]{16,}\b/g;
export function buildNarrativeSnapshot(evts, opts = {}) {
    const limit = clampLimit(opts.limit);
    const allEntries = evts.map(toNarrativeEntry).filter((entry) => entry !== null);
    const entries = allEntries.slice(-limit);
    const cycles = new Set();
    const outcomes = { success: 0, failed: 0, inert: 0, unknown: 0 };
    let reflections = 0;
    for (const entry of entries) {
        if (entry.cycleId)
            cycles.add(entry.cycleId);
        if (entry.type === 'reflection.recorded')
            reflections += 1;
        if (entry.outcome)
            outcomes[entry.outcome] += 1;
    }
    return {
        totalEvents: evts.length,
        includedEvents: entries.length,
        cycles: cycles.size,
        reflections,
        outcomes,
        entries,
    };
}
function toNarrativeEntry(event) {
    if (!isNarrativeEvent(event))
        return null;
    const payload = event.payload ?? {};
    const base = {
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        title: cleanText(event.human?.title ?? event.type, 120) ?? event.type,
    };
    if (event.type === 'reflection.recorded') {
        return cleanUndefined({
            ...base,
            cycleId: stringOf(payload['cycleId']),
            summary: cleanText(stringOf(payload['summary']) ?? event.human?.detail ?? event.human?.why),
            action: stringOf(payload['action']),
            outcome: narrativeOutcome(stringOf(payload['outcome'])),
            geneId: stringOf(payload['geneId']),
            score: numberOf(payload['score']),
        });
    }
    if (event.type === 'cycle.solidified' || event.type === 'cycle.failed' || event.type === 'cycle.aborted') {
        const outcome = event.type === 'cycle.failed'
            ? 'failed'
            : event.type === 'cycle.aborted'
                ? 'unknown'
                : payload['producedValue'] === false
                    ? 'inert'
                    : narrativeOutcome(stringOf(asRecord(payload['outcome'])?.['status'])) ?? 'success';
        return cleanUndefined({
            ...base,
            cycleId: stringOf(payload['cycleId']),
            summary: cycleSummary(event, payload),
            action: event.type.replace('cycle.', 'cycle_'),
            outcome,
            geneId: stringOf(payload['gene']),
            score: numberOf(asRecord(payload['outcome'])?.['score']),
        });
    }
    if (event.type === 'decision.gene_selected') {
        return cleanUndefined({
            ...base,
            cycleId: stringOf(payload['cycleId']),
            summary: cleanText(event.human?.detail ?? event.human?.why),
            action: 'gene_selected',
            geneId: stringOf(payload['selectedGeneId']) ?? stringOf(payload['geneId']) ?? stringOf(payload['gene']),
        });
    }
    if (event.type.startsWith('actor.human.')) {
        return cleanUndefined({
            ...base,
            cycleId: stringOf(payload['cycleId']),
            summary: cleanText(stringOf(payload['reason']) ?? stringOf(payload['note']) ?? event.human?.detail ?? event.human?.why ?? event.human?.next),
            action: event.type.replace('actor.human.', 'human_').replace(/\./g, '_'),
            geneId: stringOf(payload['geneId']),
        });
    }
    return cleanUndefined({
        ...base,
        cycleId: stringOf(payload['cycleId']),
        summary: cleanText(event.human?.detail ?? event.human?.why ?? stringOf(payload['outcome'])),
        action: event.type.replace('value.', 'value_'),
        geneId: stringOf(payload['geneId']) ?? stringOf(payload['assetId']),
    });
}
function isNarrativeEvent(event) {
    return NARRATIVE_EVENTS.has(event.type) || event.type.startsWith('actor.human.');
}
function cycleSummary(event, payload) {
    const outcome = asRecord(payload['outcome']);
    return cleanText(event.human?.detail
        ?? event.human?.why
        ?? stringOf(payload['error'])
        ?? stringOf(payload['reason'])
        ?? stringListOf(payload['reasons'])
        ?? stringOf(outcome?.['reason'])
        ?? stringOf(payload['failure_class_reason'])
        ?? stringOf(payload['failure_class']));
}
function clampLimit(limit) {
    if (typeof limit !== 'number' || !Number.isFinite(limit))
        return NARRATIVE_DEFAULT_LIMIT;
    return Math.min(NARRATIVE_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
function cleanText(value, max = 240) {
    if (!value)
        return undefined;
    const normalized = value.replace(/\s+/g, ' ').trim().replace(TOKEN_LIKE, '[redacted]');
    if (!normalized)
        return undefined;
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}
function narrativeOutcome(value) {
    if (value === 'success' || value === 'failed' || value === 'inert' || value === 'unknown')
        return value;
    return undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stringOf(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
function stringListOf(value) {
    if (!Array.isArray(value))
        return undefined;
    const parts = value.filter((item) => typeof item === 'string' && item.trim().length > 0);
    return parts.length > 0 ? parts.join('; ') : undefined;
}
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function cleanUndefined(record) {
    for (const key of Object.keys(record)) {
        if (record[key] === undefined)
            delete record[key];
    }
    return record;
}