function finiteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return null;
}
function arrayCount(value) {
    return Array.isArray(value) ? value.length : 0;
}
export function summarizeAntiGeneEvidence(asset, observedDecisionCount = 0) {
    const failureCount = finiteNumber(asset['failure_count']);
    const sourceClusterCount = arrayCount(asset['source_clusters']);
    const evidenceCapsuleCount = arrayCount(asset['evidence_capsules']);
    const weakReasons = [];
    if (failureCount === null || failureCount < 2)
        weakReasons.push('failure_count<2');
    if (sourceClusterCount < 1)
        weakReasons.push('source_clusters=0');
    if (evidenceCapsuleCount < 1)
        weakReasons.push('evidence_capsules=0');
    return {
        failureCount,
        sourceClusterCount,
        evidenceCapsuleCount,
        observedDecisionCount: Math.max(0, Math.floor(observedDecisionCount)),
        strength: weakReasons.length === 0 ? 'strong' : 'weak',
        weakReasons,
    };
}
export function formatAntiGeneEvidenceSummary(summary) {
    const failureCount = summary.failureCount === null ? '-' : String(summary.failureCount);
    const base = `failures=${failureCount} clusters=${summary.sourceClusterCount} evidence=${summary.evidenceCapsuleCount} evidence_quality=${summary.strength}`;
    if (summary.strength === 'strong')
        return base;
    return `${base} warning=weak evidence weak_reason=${summary.weakReasons.join('+')}`;
}
export function formatAntiGeneEvidenceAction(summary, state) {
    if (state === 'approved')
        return 'suggested_action=monitor_impact';
    if (state === 'rejected')
        return 'suggested_action=keep_rejected_unless_new_evidence';
    if (summary.strength === 'weak')
        return 'suggested_action=reject_or_defer approve_override=--allow-weak-evidence';
    return 'suggested_action=approve_after_manual_review';
}