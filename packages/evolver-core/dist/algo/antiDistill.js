import { createHash } from 'node:crypto';
export const ANTI_DISTILL_MIN_FAILURES = 2;
export const ANTI_DISTILL_TRIGGER_OVERLAP_MIN = 0.6;
function asStrings(value) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function isFailedCapsule(record) {
    if (record.type !== 'Capsule')
        return false;
    const outcome = record['outcome'];
    return Boolean(outcome && typeof outcome === 'object' && !Array.isArray(outcome)
        && outcome.status === 'failed');
}
function capsuleId(record, index) {
    return stringField(record, 'asset_id') ?? stringField(record, 'id') ?? `capsule:${index}`;
}
function capsuleDigest(record, index) {
    if (!isFailedCapsule(record))
        return null;
    const trigger = asStrings(record['trigger']);
    if (trigger.length === 0)
        return null;
    return {
        capsuleId: capsuleId(record, index),
        trigger,
        ...(stringField(record, 'gene') ? { gene: stringField(record, 'gene') } : {}),
        ...(stringField(record, 'summary') ? { summary: stringField(record, 'summary') } : {}),
        ...(record['outcome'] !== undefined ? { outcome: record['outcome'] } : {}),
        ...(record['proof_of_work'] !== undefined ? { proofOfWork: record['proof_of_work'] } : {}),
    };
}
function stableCapsuleView(capsule) {
    return {
        capsuleId: capsule.capsuleId,
        trigger: [...capsule.trigger].sort(),
        ...(capsule.gene ? { gene: capsule.gene } : {}),
        ...(capsule.summary ? { summary: capsule.summary } : {}),
        ...(capsule.outcome !== undefined ? { outcome: capsule.outcome } : {}),
        ...(capsule.proofOfWork !== undefined ? { proofOfWork: capsule.proofOfWork } : {}),
    };
}
function canonicalHashValue(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(canonicalHashValue);
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalHashValue(item)]));
}
function hashStable(value) {
    return createHash('sha256').update(JSON.stringify(canonicalHashValue(value))).digest('hex');
}
export function triggerOverlapScore(a, b) {
    const left = new Set(a.map(String).filter(Boolean));
    const right = new Set(b.map(String).filter(Boolean));
    if (left.size === 0 || right.size === 0)
        return 0;
    let hit = 0;
    for (const token of left)
        if (right.has(token))
            hit += 1;
    return hit / new Set([...left, ...right]).size;
}
function compatibleWithCluster(capsule, cluster, overlapMin) {
    let total = 0;
    for (const existing of cluster.capsules) {
        const overlap = triggerOverlapScore(capsule.trigger, existing.trigger);
        if (overlap < overlapMin)
            return { ok: false, avg: overlap };
        total += overlap;
    }
    return { ok: true, avg: cluster.capsules.length > 0 ? total / cluster.capsules.length : 1 };
}
function recurringTrigger(capsules, minFailures) {
    const counts = new Map();
    for (const capsule of capsules) {
        for (const token of capsule.trigger)
            counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= minFailures)
        .map(([token]) => token)
        .sort();
}
function sharedTrigger(capsules) {
    return recurringTrigger(capsules, capsules.length);
}
function clusterId(capsules) {
    return `anti_cluster_${hashStable(capsules.map(stableCapsuleView)).slice(0, 16)}`;
}
function toFailureCluster(cluster, minFailures) {
    const capsules = [...cluster.capsules].sort((a, b) => a.capsuleId.localeCompare(b.capsuleId));
    return {
        clusterId: clusterId(capsules),
        trigger: recurringTrigger(capsules, minFailures),
        sharedTrigger: sharedTrigger(capsules),
        capsuleIds: capsules.map((capsule) => capsule.capsuleId),
        genes: [...new Set(capsules.map((capsule) => capsule.gene).filter((gene) => Boolean(gene)))].sort(),
        failureCapsules: capsules,
    };
}
function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
function nonNegativeInteger(value, fallback) {
    return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : fallback;
}
function overlapThreshold(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : ANTI_DISTILL_TRIGGER_OVERLAP_MIN;
}
export function collectAntiDistillInput(capsules, opts = {}) {
    const minFailures = positiveInteger(opts.minFailures, ANTI_DISTILL_MIN_FAILURES);
    const overlapMin = overlapThreshold(opts.triggerOverlapMin);
    const failedCapsuleCount = capsules.filter(isFailedCapsule).length;
    const seen = new Set();
    const failed = capsules
        .map((record, index) => capsuleDigest(record, index))
        .filter((capsule) => capsule !== null)
        .filter((capsule) => {
        if (seen.has(capsule.capsuleId))
            return false;
        seen.add(capsule.capsuleId);
        return true;
    })
        .sort((a, b) => a.capsuleId.localeCompare(b.capsuleId));
    const clusters = [];
    for (const capsule of failed) {
        let bestIndex = -1;
        let bestScore = -1;
        for (let i = 0; i < clusters.length; i += 1) {
            const score = compatibleWithCluster(capsule, clusters[i], overlapMin);
            if (score.ok && score.avg > bestScore) {
                bestIndex = i;
                bestScore = score.avg;
            }
        }
        if (bestIndex >= 0)
            clusters[bestIndex].capsules.push(capsule);
        else
            clusters.push({ capsules: [capsule] });
    }
    const failureClusters = clusters
        .filter((cluster) => cluster.capsules.length >= minFailures)
        .map((cluster) => toFailureCluster(cluster, minFailures))
        .sort((a, b) => b.failureCapsules.length - a.failureCapsules.length
        || a.trigger.join('\0').localeCompare(b.trigger.join('\0'))
        || a.capsuleIds.join('\0').localeCompare(b.capsuleIds.join('\0')))
        .slice(0, opts.maxClusters !== undefined ? nonNegativeInteger(opts.maxClusters, clusters.length) : clusters.length);
    return {
        dataHash: hashStable(failureClusters.map((cluster) => ({
            trigger: cluster.trigger,
            capsuleIds: cluster.capsuleIds,
        }))),
        failedCapsuleCount,
        clusterableFailureCount: failed.length,
        failureClusters,
    };
}