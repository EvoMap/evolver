/**
 * Progressive curriculum signals, adapted from V1's curriculum producer.
 *
 * V2 keeps the policy pure and derives its history from the append-only root event log. This avoids V1's
 * separate mutable curriculum_state.json sidecar while preserving the behavior that matters to selection:
 * classify recent outcomes and add at most one capability-gap target plus one frontier target.
 */
const MASTERY_THRESHOLD = 0.8;
const MASTERY_MIN_ATTEMPTS = 3;
const FAILURE_THRESHOLD = 0.3;
const MIN_CLASSIFICATION_ATTEMPTS = 2;
const MAX_CURRICULUM_SIGNALS = 2;
const MAX_TARGET_CHARS = 60;
const DEFAULT_OUTCOME_WINDOW = 200;
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/;
export const MAX_CAPABILITY_GAPS = 16;
export const CAPABILITY_GAPS_STATE_KEY = 'curriculum:capability_gaps';
const CAPABILITY_GAPS_STATE_VERSION = 1;
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function stringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter((entry) => typeof entry === 'string');
}
function boundedWindow(value) {
    if (!Number.isFinite(value))
        return DEFAULT_OUTCOME_WINDOW;
    return Math.max(1, Math.min(10_000, Math.floor(value)));
}
/** Normalize untrusted capability names before they cross adapter, persistence, or selection boundaries. */
export function normalizeCapabilityGaps(value) {
    if (!Array.isArray(value))
        return [];
    const gaps = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            continue;
        const normalized = entry.trim().toLowerCase();
        if (!CAPABILITY_NAME.test(normalized) || gaps.includes(normalized))
            continue;
        gaps.push(normalized);
        if (gaps.length >= MAX_CAPABILITY_GAPS)
            break;
    }
    return gaps;
}
/** Versioned, bounded snapshot stored atomically in the lifecycle mailbox KV table. */
export function serializeCapabilityGapsState(capabilityGaps, observedAt) {
    const safeObservedAt = Number.isFinite(observedAt) && observedAt >= 0 ? Math.floor(observedAt) : 0;
    return JSON.stringify({
        version: CAPABILITY_GAPS_STATE_VERSION,
        capabilityGaps: normalizeCapabilityGaps(capabilityGaps),
        observedAt: safeObservedAt,
    });
}
/** Parse only the current bounded snapshot format. Unknown versions fail open without influencing selection. */
export function capabilityGapsFromState(value) {
    if (typeof value !== 'string' || value.length === 0)
        return [];
    try {
        const parsed = record(JSON.parse(value));
        if (!parsed || parsed['version'] !== CAPABILITY_GAPS_STATE_VERSION)
            return [];
        const observedAt = parsed['observedAt'];
        if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt < 0)
            return [];
        return normalizeCapabilityGaps(parsed['capabilityGaps']);
    }
    catch {
        return [];
    }
}
/** Stable V2 equivalent of V1 computeSignalKey, excluding previously generated curriculum targets. */
export function curriculumSignalKey(signals) {
    return [...new Set(signals
            .map((signal) => signal.trim())
            .filter((signal) => signal.length > 0 && !signal.startsWith('curriculum_target:')))]
        .sort()
        .join('|');
}
/** Classify signal-key outcomes using V1's thresholds. */
export function classifyCurriculumOutcomes(outcomes) {
    const aggregates = new Map();
    for (const outcome of outcomes) {
        const key = typeof outcome?.key === 'string' ? outcome.key.trim() : '';
        if (!key || (outcome.status !== 'success' && outcome.status !== 'failed'))
            continue;
        const aggregate = aggregates.get(key) ?? { success: 0, failed: 0 };
        if (outcome.status === 'success')
            aggregate.success += 1;
        else
            aggregate.failed += 1;
        aggregates.set(key, aggregate);
    }
    const mastered = [];
    const failing = [];
    const frontier = [];
    for (const [key, aggregate] of aggregates) {
        const total = aggregate.success + aggregate.failed;
        if (total < MIN_CLASSIFICATION_ATTEMPTS)
            continue;
        const rate = aggregate.success / total;
        const bucket = { key, success: aggregate.success, failed: aggregate.failed, total, rate };
        if (rate >= MASTERY_THRESHOLD && total >= MASTERY_MIN_ATTEMPTS)
            mastered.push(bucket);
        else if (rate <= FAILURE_THRESHOLD)
            failing.push(bucket);
        else
            frontier.push(bucket);
    }
    frontier.sort((left, right) => Math.abs(left.rate - 0.5) - Math.abs(right.rate - 0.5));
    return { mastered, failing, frontier };
}
/** Generate no more than the two target families V1 produced: gap first, then closest frontier. */
export function generateCurriculumSignals(input) {
    const analysis = classifyCurriculumOutcomes(input.outcomes);
    const generated = [];
    const gap = (input.capabilityGaps ?? []).find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim();
    if (gap) {
        const normalizedGap = gap.toLowerCase();
        const alreadyMastered = analysis.mastered.some((entry) => entry.key.toLowerCase().includes(normalizedGap));
        if (!alreadyMastered)
            generated.push(`curriculum_target:gap:${gap.slice(0, MAX_TARGET_CHARS)}`);
    }
    const best = analysis.frontier[0];
    if (generated.length < MAX_CURRICULUM_SIGNALS && best) {
        const alreadyTargeted = generated.some((signal) => signal.includes(best.key));
        if (!alreadyTargeted)
            generated.push(`curriculum_target:frontier:${best.key.slice(0, MAX_TARGET_CHARS)}`);
    }
    return generated.slice(0, MAX_CURRICULUM_SIGNALS);
}
/**
 * Map V2's capability signal conventions to concrete curriculum gaps. A bare cap:* tag is not sufficient by
 * itself: it becomes a curriculum gap only when the same signal set explicitly declares capability_gap.
 */
export function capabilityGapsFromSignals(signals) {
    const hasGapMarker = signals.some((signal) => signal === 'capability_gap' || signal.startsWith('capability_gap:'));
    if (!hasGapMarker)
        return [];
    const gaps = [];
    const add = (raw) => {
        const normalized = raw.trim().toLowerCase();
        if (!CAPABILITY_NAME.test(normalized) || gaps.includes(normalized))
            return;
        gaps.push(normalized);
    };
    for (const signal of signals)
        if (signal.startsWith('cap:'))
            add(signal.slice('cap:'.length));
    for (const signal of signals)
        if (signal.startsWith('capability_gap:'))
            add(signal.slice('capability_gap:'.length));
    return normalizeCapabilityGaps(gaps);
}
/**
 * Join cycle.signals_collected to terminal cycle events and retain the latest outcome window. `baseSignals`
 * wins over `signals`, so history-derived meta-signals do not become a self-reinforcing curriculum key.
 */
export function curriculumOutcomesFromEvents(events, maxOutcomes = DEFAULT_OUTCOME_WINDOW) {
    const limit = boundedWindow(maxOutcomes);
    const selectedNewestFirst = [];
    const terminalCycles = new Set();
    // Pick the latest unique terminal cycles first. EventStore.readAll already owns the input array, while every
    // auxiliary collection in this adapter remains bounded by the configured outcome window.
    for (let index = events.length - 1; index >= 0 && selectedNewestFirst.length < limit; index -= 1) {
        const event = events[index];
        if (event.type !== 'cycle.solidified' && event.type !== 'cycle.failed')
            continue;
        const payload = record(event.payload);
        if (!payload || typeof payload['cycleId'] !== 'string' || terminalCycles.has(payload['cycleId']))
            continue;
        const cycleId = payload['cycleId'];
        terminalCycles.add(cycleId);
        selectedNewestFirst.push({
            cycleId,
            status: event.type === 'cycle.failed' || payload['producedValue'] === false ? 'failed' : 'success',
        });
    }
    const signalsByCycle = new Map();
    // Build the signal lookup independently of terminal ordering. Normal logs collect signals first, but a
    // recovered/imported history can be reordered without making otherwise valid outcomes disappear.
    for (const event of events) {
        const payload = record(event.payload);
        if (!payload)
            continue;
        const cycleId = typeof payload['cycleId'] === 'string' ? payload['cycleId'] : undefined;
        if (!cycleId || !terminalCycles.has(cycleId) || event.type !== 'cycle.signals_collected')
            continue;
        const baseSignals = stringArray(payload['baseSignals']);
        const fallbackSignals = stringArray(payload['signals']);
        signalsByCycle.set(cycleId, baseSignals ?? fallbackSignals ?? []);
    }
    return selectedNewestFirst.reverse().flatMap(({ cycleId, status }) => {
        const key = curriculumSignalKey(signalsByCycle.get(cycleId) ?? []);
        return key ? [{ key, status }] : [];
    });
}