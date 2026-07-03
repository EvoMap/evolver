/** Read a positive integer env override, falling back to a default (mirrors v1 config.js envInt). */
function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** System-wide blast caps. Env-overridable (EVOLVER_HARD_CAP_FILES / EVOLVER_HARD_CAP_LINES), same names/defaults as v1. */
export function globalHardCaps() {
    return {
        files: envInt('EVOLVER_HARD_CAP_FILES', 60),
        lines: envInt('EVOLVER_HARD_CAP_LINES', 20000),
    };
}
// Severity ratio bands ported verbatim from v1 policyCheck.js.
const BLAST_WARN_RATIO = 0.8;
const BLAST_CRITICAL_RATIO = 2.0;
/**
 * Classify a diff's blast radius (ported from v1 classifyBlastSeverity). The global hard cap is checked first
 * and is independent of any per-gene maxFiles (so it fires even when maxFiles is undefined). When a per-gene
 * maxFiles is given, the over-limit / 2x-critical / approaching bands apply on top.
 */
export function classifyBlastSeverity(stat, maxFiles, caps = globalHardCaps()) {
    const files = Number(stat.files) || 0;
    const lines = Number(stat.lines) || 0;
    if (files > caps.files || lines > caps.lines) {
        return {
            severity: 'hard_cap_breach',
            message: `HARD CAP BREACH: ${files} files / ${lines} lines exceeds system limit (${caps.files} files / ${caps.lines} lines)`,
        };
    }
    if (maxFiles === undefined || !Number.isFinite(maxFiles) || maxFiles <= 0) {
        return { severity: 'within_limit', message: 'no max_files constraint defined' };
    }
    if (files > maxFiles * BLAST_CRITICAL_RATIO) {
        return {
            severity: 'critical_overrun',
            message: `CRITICAL OVERRUN: ${files} files > ${maxFiles * BLAST_CRITICAL_RATIO} (${BLAST_CRITICAL_RATIO}x limit of ${maxFiles}). Agent likely performed bulk/unintended operation.`,
        };
    }
    if (files > maxFiles) {
        return { severity: 'exceeded', message: `max_files exceeded: ${files} > ${maxFiles}` };
    }
    if (files > maxFiles * BLAST_WARN_RATIO) {
        return {
            severity: 'approaching_limit',
            message: `approaching limit: ${files} / ${maxFiles} files (${Math.round((files / maxFiles) * 100)}%)`,
        };
    }
    return { severity: 'within_limit', message: `${files} / ${maxFiles} files` };
}
/**
 * GLOBAL blast-radius guard — ALWAYS enforced. Returns a violation when the diff breaches the system hard cap
 * (files or lines), regardless of whether a gene/constraints are present. The per-gene `critical_overrun` band
 * (2x the gene's own max_files) is also surfaced as a violation when a gene cap is supplied; the softer
 * `approaching_limit` band is a warning, not a violation. Per-gene `exceeded` (files > max_files) is handled by
 * constraints.ts so the two layers don't double-report; here we only escalate the global cap + the 2x overrun.
 */
export function checkBlastRadius(stat, constraints, caps = globalHardCaps()) {
    const violations = [];
    const sev = classifyBlastSeverity(stat, constraints?.max_files, caps);
    if (sev.severity === 'hard_cap_breach' || sev.severity === 'critical_overrun') {
        violations.push({ kind: 'blast_radius', detail: sev.message });
    }
    return violations;
}