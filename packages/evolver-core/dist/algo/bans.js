// Ban genes that have repeatedly failed on the SAME signals (ported from v1 selector.js
// banGenesFromFailedCapsules). Complements epigenetic suppression (which is per-environment): this is a
// hard, signal-overlap-based exclusion — but only when the failures carry counted identity quality. Legacy raw
// or partial-digest rows remain audit/advisory evidence and cannot satisfy the automatic tau=2 quarantine.
const BAN_THRESHOLD = 2;
const OVERLAP_MIN = 0.6;
/** Fraction of the current signals covered by a failure's trigger (how much it is "the same problem"). */
function signalCoverage(signals, trigger) {
    if (signals.length === 0)
        return 0;
    const t = new Set(trigger.map((s) => String(s)));
    let hit = 0;
    for (const s of signals)
        if (t.has(s))
            hit += 1;
    return hit / signals.length;
}
function nonEmpty(s) {
    return typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined;
}
function failureEvidenceIdentity(fc) {
    const failure = nonEmpty(fc.failureId);
    const root = nonEmpty(fc.rootAttemptId);
    const execution = nonEmpty(fc.executionId);
    const direct = [
        failure ? `failure:${failure}` : undefined,
        root ? `root:${root}` : undefined,
        execution ? `execution:${execution}` : undefined,
    ].filter((key) => key !== undefined);
    if (direct.length > 0)
        return { quality: 'strong_id', keys: direct };
    const verifier = nonEmpty(fc.verifierDigest);
    const artifact = nonEmpty(fc.artifactDigest);
    if (verifier && artifact)
        return { quality: 'complete_verifier_artifact_digest', keys: [`evidence:${verifier}:${artifact}`] };
    if (verifier || artifact)
        return { quality: 'legacy_partial', keys: [] };
    return { quality: 'legacy_raw', keys: [] };
}
function isCountedIdentity(identity) {
    return identity.quality === 'strong_id' || identity.quality === 'complete_verifier_artifact_digest';
}
function addFailureIdentity(clusters, keys) {
    const matches = [];
    for (let i = 0; i < clusters.length; i++) {
        if (keys.some((key) => clusters[i].has(key)))
            matches.push(i);
    }
    if (matches.length === 0) {
        clusters.push(new Set(keys));
        return;
    }
    const target = clusters[matches[0]];
    for (const key of keys)
        target.add(key);
    for (let i = matches.length - 1; i > 0; i--) {
        const index = matches[i];
        for (const key of clusters[index])
            target.add(key);
        clusters.splice(index, 1);
    }
}
/** Gene ids with >=2 independent failed capsules whose trigger covers >=60% of the current signals. */
export function bannedGenesFromFailures(failures, signals) {
    const counts = new Map();
    for (const fc of failures) {
        if (!fc.gene)
            continue;
        if (signalCoverage(signals, fc.trigger ?? []) < OVERLAP_MIN)
            continue;
        const identity = failureEvidenceIdentity(fc);
        if (!isCountedIdentity(identity))
            continue;
        const clusters = counts.get(fc.gene) ?? [];
        addFailureIdentity(clusters, identity.keys);
        counts.set(fc.gene, clusters);
    }
    const banned = new Set();
    for (const [gene, clusters] of counts)
        if (clusters.length >= BAN_THRESHOLD)
            banned.add(gene);
    return banned;
}