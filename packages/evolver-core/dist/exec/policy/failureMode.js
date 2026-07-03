// Structured failure classification + soft-failure learning signals (ported from v1 src/gep/policyCheck.js:
// classifyFailureMode, buildFailureReason, buildSoftFailureLearningSignals). Pure functions over a run's
// violations / validation result. They turn a failed cycle into (a) a one-line human reason, (b) a hard/soft
// classification with a retryable flag, and (c) the semantic learning tags the cycle records so the next
// selection can avoid the same trap. No canary/protocol arms in v2 (canary is intentionally not ported and
// protocol violations are handled elsewhere) — the constraint/validation arms are what the exec bridge feeds.
import { expandSignals } from '../../signals/expand.js';
// A destructive/protected/over-cap/forbidden constraint breach is a HARD, non-retryable failure: retrying the
// SAME mutation would just hit it again. A validation failure is SOFT/retryable (the agent can try a different
// edit). Pattern mirrors v1 classifyFailureMode's `constraint_destructive` regex over the violation details.
const DESTRUCTIVE_VIOLATION_RE = /HARD CAP BREACH|CRITICAL OVERRUN|critical_file_deleted_or_emptied|critical_path_modified|forbidden path|forbidden_path/i;
/**
 * Classify the failure mode from the policy violations + whether validation passed (ported from v1
 * classifyFailureMode). hard ⇒ not retryable (re-running the same change won't help); soft ⇒ retryable.
 */
export function classifyFailureMode(opts) {
    const violations = opts.violations ?? [];
    const hasDestructive = violations.some((v) => DESTRUCTIVE_VIOLATION_RE.test(v.detail) || v.kind === 'destructive' || v.kind === 'protected_path');
    if (hasDestructive)
        return { mode: 'hard', reasonClass: 'constraint_destructive', retryable: false };
    if (violations.length > 0)
        return { mode: 'hard', reasonClass: 'constraint', retryable: false };
    if (opts.validationPassed === false)
        return { mode: 'soft', reasonClass: 'validation', retryable: true };
    return { mode: 'soft', reasonClass: 'unknown', retryable: true };
}
/**
 * Build a one-line, length-capped human failure reason from policy violations + an optional validation error
 * (ported from v1 buildFailureReason — the constraint + validation arms; v2 has no canary/protocol arms here).
 */
export function buildFailureReason(opts) {
    const reasons = [];
    for (const v of opts.violations ?? [])
        reasons.push(`constraint: ${v.detail}`);
    if (opts.validationError)
        reasons.push(`validation_failed: ${opts.validationError.slice(0, 200)}`);
    return reasons.join('; ').slice(0, 2000) || 'unknown';
}
/**
 * Expand a soft failure into the semantic learning tags the cycle records (ported from v1
 * buildSoftFailureLearningSignals). Keeps only the problem:/risk:/area:/action: tags so the next selection can
 * steer away from the same failure class, not the raw noise. Uses v2's expandSignals (signals/expand.ts).
 */
export function buildSoftFailureLearningSignals(opts) {
    const signals = opts.signals ?? [];
    const violationDetails = (opts.violations ?? []).map((v) => v.detail);
    const extra = `${opts.failureReason ?? ''} ${opts.validationText ?? ''}`.trim();
    return expandSignals([...signals, ...violationDetails], extra).filter((tag) => /^(problem|risk|area|action):/.test(tag));
}