export const PRIORITY_AXES = Object.freeze([
    'task_success',
    'user_preference',
    'quality',
    'safety',
    'cost',
    'latency',
    'other',
]);
export const LABELS = Object.freeze(['positive', 'negative', 'mixed', 'neutral']);
export const ATTENTION_LEVELS = Object.freeze(['full', 'limited', 'skimmed', 'unknown']);
export const EVIDENCE_KINDS = Object.freeze([
    'evolution_event',
    'evolution_outcome',
    'user_override',
    'review',
    'turn',
    'external',
]);
export function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0.5;
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
export function labelFromScalar(value) {
    const scalar = clamp01(value);
    if (scalar >= 0.6)
        return 'positive';
    if (scalar <= 0.4)
        return 'negative';
    return 'mixed';
}
export function normalizeAttention(input) {
    const record = asRecord(input);
    if (!record)
        return { level: 'unknown' };
    const attention = {
        level: enumValue(record['level'], ATTENTION_LEVELS, 'unknown'),
    };
    const observedItems = nonNegativeInteger(record['observed_items']);
    const elapsedMs = nonNegativeInteger(record['elapsed_ms']);
    if (observedItems !== null)
        attention.observed_items = observedItems;
    if (elapsedMs !== null)
        attention.elapsed_ms = elapsedMs;
    return attention;
}
export function evidenceRef(kind, id, options = {}) {
    const ref = {
        kind: enumValue(kind, EVIDENCE_KINDS, 'external'),
        id: String(id ?? '').trim() || 'unknown',
    };
    if (typeof options.summary === 'string' && options.summary.trim()) {
        ref.summary = options.summary.trim();
    }
    return ref;
}
export function normalizeEvidenceRef(input) {
    const record = asRecord(input);
    if (!record)
        return evidenceRef('external', 'unknown');
    return evidenceRef(record['kind'], record['id'], { summary: record['summary'] });
}
export function envelopeUncertainty(scalar, attentionLevel, indecision, conflict) {
    const normalizedScalar = clamp01(scalar);
    const ambiguity = 1 - Math.abs(normalizedScalar - 0.5) * 2;
    const attentionPenalty = {
        full: 0,
        limited: 0.15,
        skimmed: 0.30,
        unknown: 0.20,
    };
    return clamp01(0.10
        + 0.30 * ambiguity
        + attentionPenalty[attentionLevel]
        + (indecision ? 0.25 : 0)
        + (conflict ? 0.35 : 0));
}
export function fromScalarFeedback(options = {}) {
    const input = options ?? {};
    const scalar = clamp01(input.scalar);
    const label = labelFromScalar(scalar);
    const indecision = Boolean(input.indecision) || label === 'mixed';
    const conflict = Boolean(input.conflict);
    const evaluatorAttention = normalizeAttention(input.evaluator_attention ?? input.evaluatorAttention);
    const priorityAxis = enumValue(input.priority_axis ?? input.priorityAxis, PRIORITY_AXES, 'task_success');
    const evidence = input.evidence_ref ?? input.evidenceRef ?? evidenceRef('external', 'unknown');
    return {
        priority_axis: priorityAxis,
        label,
        scalar,
        indecision,
        conflict,
        evaluator_attention: evaluatorAttention,
        evidence_ref: normalizeEvidenceRef(evidence),
        uncertainty: envelopeUncertainty(scalar, evaluatorAttention.level, indecision, conflict),
    };
}
export function fromOutcomeScalar(outcome, options = {}) {
    const record = asRecord(outcome);
    if (!record)
        return null;
    const scalar = record['user_override'] ?? record['score'];
    if (scalar === null || scalar === undefined)
        return null;
    return fromScalarFeedback({ ...options, scalar });
}
export function withConflict(envelope) {
    const evaluatorAttention = normalizeAttention(envelope.evaluator_attention);
    return {
        ...envelope,
        conflict: true,
        evaluator_attention: evaluatorAttention,
        uncertainty: envelopeUncertainty(envelope.scalar, evaluatorAttention.level, envelope.indecision, true),
    };
}
export function withIndecision(envelope) {
    const evaluatorAttention = normalizeAttention(envelope.evaluator_attention);
    return {
        ...envelope,
        indecision: true,
        evaluator_attention: evaluatorAttention,
        uncertainty: envelopeUncertainty(envelope.scalar, evaluatorAttention.level, true, envelope.conflict),
    };
}
export function aggregateFeedbackEnvelopes(envelopes) {
    const list = Array.isArray(envelopes) ? envelopes.filter(Boolean) : [];
    if (list.length === 0)
        return { dominant_label: null, uncertainty: 1, sample_count: 0 };
    const sampleCount = list.length;
    const meanUncertainty = list.reduce((sum, envelope) => sum + clamp01(envelope.uncertainty), 0) / sampleCount;
    const hasPositive = list.some((envelope) => envelope.label === 'positive');
    const hasNegative = list.some((envelope) => envelope.label === 'negative');
    const hasConflict = list.some((envelope) => envelope.conflict) || (hasPositive && hasNegative);
    const hasIndecision = list.some((envelope) => envelope.indecision || envelope.label === 'mixed' || envelope.label === 'neutral');
    const hasLowAttention = list.some((envelope) => normalizeAttention(envelope.evaluator_attention).level !== 'full');
    const uncertainty = clamp01(meanUncertainty
        + (hasConflict ? 0.25 : 0)
        + (hasIndecision ? 0.10 : 0)
        + (hasLowAttention ? 0.10 : 0));
    let dominantLabel = null;
    if (!hasConflict && !hasLowAttention && uncertainty < 0.5) {
        if (hasPositive)
            dominantLabel = 'positive';
        else if (hasNegative)
            dominantLabel = 'negative';
    }
    return { dominant_label: dominantLabel, uncertainty, sample_count: sampleCount };
}
function enumValue(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value)
        ? value
        : fallback;
}
function nonNegativeInteger(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}