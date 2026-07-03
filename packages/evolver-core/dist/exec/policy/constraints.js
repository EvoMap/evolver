// Per-gene change-constraint enforcement (ported from v1 src/gep/policyCheck.js checkConstraints — the
// forbidden_paths + max_files slice). renderExecPrompt only TELLS the agent "touch at most N file(s) / never
// modify X" — that is advisory. A misbehaving, confused, or prompt-injected agent can ignore it. This module
// ENFORCES the same limits against the ACTUAL git diff after the agent runs. These checks ONLY apply when a
// gene with constraints is present; the always-on global guards (blast hard cap + protected paths +
// destructive) live in their own modules and run regardless. Pure + deterministic.
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
/**
 * Does a changed path fall under a forbidden path? Matches on path SEGMENTS, never raw substrings, so
 * "migrations" hits "migrations/001.sql" and "db/migrations/x.sql" but NOT "migrations_helper.ts":
 *  - exact match: forbidden "src/x.ts" === changed "src/x.ts"
 *  - directory prefix: forbidden "migrations/" / "db/migrations" contains "db/migrations/001.sql"
 *  - bare segment (no slash, e.g. "node_modules", ".env"): matches any path containing that exact segment
 */
export function pathIsForbidden(changed, forbidden) {
    const c = norm(changed);
    const f = norm(forbidden);
    if (!f)
        return false;
    if (c === f)
        return true;
    if (c.startsWith(`${f}/`))
        return true; // forbidden dir is a path prefix at a segment boundary
    if (!f.includes('/'))
        return c.split('/').includes(f); // bare segment anywhere in the path
    return false;
}
/**
 * Check the agent's actual changed files (and optional line churn) against the gene's constraints.
 * Undefined/empty constraints = no policy (returns []). Returns every violation (one per offending file for
 * forbidden paths) so the caller can surface a complete reason.
 */
export function checkChangeConstraints(changedFiles, constraints, lines) {
    const violations = [];
    if (!constraints)
        return violations;
    const files = changedFiles.map(norm).filter(Boolean);
    if (constraints.max_files !== undefined && files.length > constraints.max_files) {
        violations.push({
            kind: 'blast_radius',
            detail: `changed ${files.length} file(s) > max_files ${constraints.max_files}`,
        });
    }
    if (constraints.max_lines !== undefined && lines !== undefined && lines > constraints.max_lines) {
        violations.push({
            kind: 'blast_radius',
            detail: `changed ${lines} line(s) > max_lines ${constraints.max_lines}`,
        });
    }
    if (constraints.forbidden_paths?.length) {
        for (const file of files) {
            const hit = constraints.forbidden_paths.find((fp) => pathIsForbidden(file, fp));
            if (hit)
                violations.push({ kind: 'forbidden_path', detail: `${file} matches forbidden path "${hit}"` });
        }
    }
    return violations;
}
/** One-line human summary of a violation set (for an outcome reason / audit log). */
export function summarizeViolations(violations) {
    return `constraint violation: ${violations.map((v) => v.detail).join('; ')}`;
}