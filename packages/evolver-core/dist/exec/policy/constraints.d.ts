export interface ChangeConstraints {
    max_files?: number;
    /** Per-gene line-churn cap (insertions+deletions). Layers UNDER the global hard cap. */
    max_lines?: number;
    forbidden_paths?: readonly string[];
}
export interface PolicyViolation {
    kind: 'blast_radius' | 'forbidden_path' | 'protected_path' | 'destructive';
    detail: string;
}
/**
 * Does a changed path fall under a forbidden path? Matches on path SEGMENTS, never raw substrings, so
 * "migrations" hits "migrations/001.sql" and "db/migrations/x.sql" but NOT "migrations_helper.ts":
 *  - exact match: forbidden "src/x.ts" === changed "src/x.ts"
 *  - directory prefix: forbidden "migrations/" / "db/migrations" contains "db/migrations/001.sql"
 *  - bare segment (no slash, e.g. "node_modules", ".env"): matches any path containing that exact segment
 */
export declare function pathIsForbidden(changed: string, forbidden: string): boolean;
/**
 * Check the agent's actual changed files (and optional line churn) against the gene's constraints.
 * Undefined/empty constraints = no policy (returns []). Returns every violation (one per offending file for
 * forbidden paths) so the caller can surface a complete reason.
 */
export declare function checkChangeConstraints(changedFiles: readonly string[], constraints?: ChangeConstraints, lines?: number): PolicyViolation[];
/** One-line human summary of a violation set (for an outcome reason / audit log). */
export declare function summarizeViolations(violations: readonly PolicyViolation[]): string;