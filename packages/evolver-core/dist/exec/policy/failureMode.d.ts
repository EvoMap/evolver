import type { PolicyViolation } from './constraints.js';
export interface FailureMode {
    mode: 'hard' | 'soft';
    reasonClass: 'constraint_destructive' | 'constraint' | 'validation' | 'unknown';
    retryable: boolean;
}
/**
 * Classify the failure mode from the policy violations + whether validation passed (ported from v1
 * classifyFailureMode). hard ⇒ not retryable (re-running the same change won't help); soft ⇒ retryable.
 */
export declare function classifyFailureMode(opts: {
    violations?: readonly PolicyViolation[];
    validationPassed?: boolean;
}): FailureMode;
/**
 * Build a one-line, length-capped human failure reason from policy violations + an optional validation error
 * (ported from v1 buildFailureReason — the constraint + validation arms; v2 has no canary/protocol arms here).
 */
export declare function buildFailureReason(opts: {
    violations?: readonly PolicyViolation[];
    validationError?: string;
}): string;
/**
 * Expand a soft failure into the semantic learning tags the cycle records (ported from v1
 * buildSoftFailureLearningSignals). Keeps only the problem:/risk:/area:/action: tags so the next selection can
 * steer away from the same failure class, not the raw noise. Uses v2's expandSignals (signals/expand.ts).
 */
export declare function buildSoftFailureLearningSignals(opts: {
    signals?: readonly string[];
    violations?: readonly PolicyViolation[];
    failureReason?: string;
    validationText?: string;
}): string[];