const MAX_SIGNALS = 32;
const MAX_SIGNAL_CHARS = 120;
const MAX_GENE_CHARS = 240;
const MIN_SIMILARITY = 0.34;
const HALF_LIFE_DAYS = 30;
export function normalizeMemorySignals(signals) {
    return [...new Set(signals
            .filter((signal) => typeof signal === 'string')
            .map((signal) => signal.trim().toLowerCase().slice(0, MAX_SIGNAL_CHARS))
            .filter(Boolean))]
        .sort()
        .slice(0, MAX_SIGNALS);
}
export function memorySignalFingerprint(signals) {
    return normalizeMemorySignals(signals).join('|') || '(none)';
}
export function safeMemoryGeneId(value) {
    return value.trim().slice(0, MAX_GENE_CHARS);
}
export function deriveMemoryGraphAdvice(records, signals, nowMs, diagnostics) {
    const currentSignals = normalizeMemorySignals(signals);
    const aggregates = new Map();
    for (const record of records) {
        const similarity = jaccard(currentSignals, record.signals);
        if (similarity < MIN_SIMILARITY)
            continue;
        const successCount = boundedCount(record.successCount ?? (record.status === 'success' ? 1 : 0));
        const failCount = boundedCount(record.failCount ?? (record.status === 'failed' ? 1 : 0));
        const total = successCount + failCount;
        if (total === 0)
            continue;
        const decay = decayWeight(record.at, nowMs);
        const weight = similarity * decay;
        const current = aggregates.get(record.geneId) ?? { success: 0, fail: 0, weightedSimilarity: 0, weight: 0, lastAt: record.at };
        current.success += successCount * weight;
        current.fail += failCount * weight;
        current.weightedSimilarity += similarity * total;
        current.weight += total;
        if (Date.parse(record.at) > Date.parse(current.lastAt))
            current.lastAt = record.at;
        aggregates.set(record.geneId, current);
    }
    const genes = [];
    for (const [geneId, aggregate] of aggregates) {
        const successCount = Math.round(aggregate.success);
        const failCount = Math.round(aggregate.fail);
        const attempts = successCount + failCount;
        if (attempts === 0)
            continue;
        const expectedSuccess = (aggregate.success + 1) / (aggregate.success + aggregate.fail + 2);
        const similarity = aggregate.weight > 0 ? Math.min(1, aggregate.weightedSimilarity / aggregate.weight) : 0;
        const confidence = Math.min(1, Math.log2(attempts + 1) / 3);
        const boost = clamp((expectedSuccess - 0.5) * 2 * similarity * confidence, -1, 1);
        genes.push({ geneId, boost, expectedSuccess, successCount, failCount, attempts, similarity, lastAt: aggregate.lastAt });
    }
    genes.sort((left, right) => Math.abs(right.boost) - Math.abs(left.boost) || right.attempts - left.attempts || left.geneId.localeCompare(right.geneId));
    return { genes: genes.slice(0, 64), diagnostics };
}
function boundedCount(value) {
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(1_000_000, Math.floor(value));
}
function jaccard(left, right) {
    const a = new Set(normalizeMemorySignals(left));
    const b = new Set(normalizeMemorySignals(right));
    if (a.size === 0 && b.size === 0)
        return 1;
    if (a.size === 0 || b.size === 0)
        return 0;
    let intersection = 0;
    for (const value of a)
        if (b.has(value))
            intersection += 1;
    return intersection / (a.size + b.size - intersection);
}
function decayWeight(at, nowMs) {
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp))
        return 0;
    const ageDays = Math.max(0, nowMs - timestamp) / 86_400_000;
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}