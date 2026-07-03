import type { DiffStat } from '../proofOfWork.js';
import type { ChangeConstraints, PolicyViolation } from './constraints.js';
/** System-wide blast caps. Env-overridable (EVOLVER_HARD_CAP_FILES / EVOLVER_HARD_CAP_LINES), same names/defaults as v1. */
export declare function globalHardCaps(): {
    files: number;
    lines: number;
};
export type BlastSeverity = 'hard_cap_breach' | 'critical_overrun' | 'exceeded' | 'approaching_limit' | 'within_limit';
/**
 * Classify a diff's blast radius (ported from v1 classifyBlastSeverity). The global hard cap is checked first
 * and is independent of any per-gene maxFiles (so it fires even when maxFiles is undefined). When a per-gene
 * maxFiles is given, the over-limit / 2x-critical / approaching bands apply on top.
 */
export declare function classifyBlastSeverity(stat: DiffStat, maxFiles?: number, caps?: {
    files: number;
    lines: number;
}): {
    severity: BlastSeverity;
    message: string;
};
/**
 * GLOBAL blast-radius guard — ALWAYS enforced. Returns a violation when the diff breaches the system hard cap
 * (files or lines), regardless of whether a gene/constraints are present. The per-gene `critical_overrun` band
 * (2x the gene's own max_files) is also surfaced as a violation when a gene cap is supplied; the softer
 * `approaching_limit` band is a warning, not a violation. Per-gene `exceeded` (files > max_files) is handled by
 * constraints.ts so the two layers don't double-report; here we only escalate the global cap + the 2x overrun.
 */
export declare function checkBlastRadius(stat: DiffStat, constraints?: ChangeConstraints, caps?: {
    files: number;
    lines: number;
}): PolicyViolation[];