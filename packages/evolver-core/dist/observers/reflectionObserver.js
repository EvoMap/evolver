export const REFLECTION_RECORDED_EVENT_TYPE = 'reflection.recorded';
export const REFLECTION_SOURCE_EVENT_TYPES = ['cycle.solidified', 'cycle.failed'];
export function buildReflectionSummary(input) {
    const outcome = normalizeOutcome(input);
    const action = actionFor(outcome);
    const genePart = input.geneId ? ` using ${input.geneId}` : '';
    const scorePart = typeof input.score === 'number' ? ` score=${trimScore(input.score)}` : '';
    const errorPart = input.error ? ` Error: ${clip(input.error, 80)}` : '';
    const summary = clip(outcome === 'success'
        ? `Cycle ${input.cycleId} succeeded${genePart}${scorePart}; keep this pattern available for similar signals.`
        : outcome === 'inert'
            ? `Cycle ${input.cycleId} produced no value${genePart}${scorePart}; avoid reinforcing an inert loop.`
            : `Cycle ${input.cycleId} failed${genePart}${scorePart}; inspect the failure before reusing this pattern.${errorPart}`, 220);
    return cleanUndefined({ sourceEventId: input.sourceEventId, cycleId: input.cycleId, outcome, action, summary, geneId: input.geneId, score: input.score });
}
export function reflectionObserver(deps) {
    const seen = new Set();
    const inFlight = new Map();
    const meta = {
        name: 'reflection',
        eventTypes: REFLECTION_SOURCE_EVENT_TYPES,
        idempotent: true,
        timeoutMs: deps.timeoutMs ?? 5_000,
    };
    return {
        meta,
        async handle(event) {
            const input = reflectionInputFromEvent(event);
            if (!input)
                return;
            if (seen.has(input.sourceEventId))
                return;
            const pending = inFlight.get(input.sourceEventId);
            if (pending) {
                await pending;
                return;
            }
            const recording = Promise.resolve()
                .then(async () => {
                const reflection = buildReflectionSummary(input);
                await deps.ingestor.ingest({
                    type: REFLECTION_RECORDED_EVENT_TYPE,
                    human: {
                        title: `reflection ${reflection.cycleId}`,
                        detail: reflection.summary,
                        why: 'deterministic post-cycle reflection observer',
                    },
                    payload: reflection,
                });
                seen.add(input.sourceEventId);
            })
                .finally(() => {
                inFlight.delete(input.sourceEventId);
            });
            inFlight.set(input.sourceEventId, recording);
            await recording;
        },
    };
}
function reflectionInputFromEvent(event) {
    if (!REFLECTION_SOURCE_EVENT_TYPES.includes(event.type))
        return null;
    const payload = asRecord(event.payload);
    const cycleId = stringOf(payload?.['cycleId']);
    if (!cycleId)
        return null;
    const outcomeRecord = asRecord(payload?.['outcome']);
    const status = stringOf(outcomeRecord?.['status']);
    const outcome = status === 'success' ? 'success' : status === 'failed' ? 'failed' : undefined;
    const producedValue = boolOf(payload?.['producedValue']);
    const error = stringOf(payload?.['error'])
        ?? stringOf(payload?.['reason'])
        ?? stringOf(outcomeRecord?.['reason'])
        ?? stringOf(payload?.['failure_class_reason']);
    return cleanUndefined({
        type: event.type,
        sourceEventId: event.eventId,
        cycleId,
        geneId: stringOf(payload?.['gene']),
        outcome,
        score: numberOf(outcomeRecord?.['score']),
        producedValue,
        error,
    });
}
function normalizeOutcome(input) {
    if (input.type === 'cycle.failed')
        return 'failed';
    if (input.producedValue === false)
        return 'inert';
    return input.outcome ?? 'success';
}
function actionFor(outcome) {
    if (outcome === 'success')
        return 'reinforce_successful_pattern';
    if (outcome === 'inert')
        return 'avoid_inert_loop';
    return 'investigate_failure_pattern';
}
function clip(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
function trimScore(value) {
    return Math.round(value * 1000) / 1000;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stringOf(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function boolOf(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function cleanUndefined(record) {
    for (const key of Object.keys(record)) {
        if (record[key] === undefined)
            delete record[key];
    }
    return record;
}