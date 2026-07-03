// Directory prefixes whose entire subtree is protected (ported verbatim from v1 gitOps.js).
export const CRITICAL_PROTECTED_PREFIXES = [
    'skills/skill-tools/',
    'skills/git-sync/',
    'skills/evolver/',
];
// Individual protected files — the agent's identity/config/secret surface (ported verbatim from v1 gitOps.js).
export const CRITICAL_PROTECTED_FILES = [
    'MEMORY.md',
    'SOUL.md',
    'IDENTITY.md',
    'AGENTS.md',
    'USER.md',
    'HEARTBEAT.md',
    'RECENT_EVENTS.md',
    'TOOLS.md',
    'TROUBLESHOOTING.md',
    'openclaw.json',
    'evolver.json',
    '.env',
    'package.json',
];
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
/**
 * Is `relPath` a critical-protected path? Ported from v1 isCriticalProtectedPath.
 *  - prefix subtree: rel === "skills/evolver" OR rel starts with "skills/evolver/"
 *  - protected file: any path segment chain ending in a protected file name (e.g. ".env", "config/.env",
 *    "package.json", "a/b/MEMORY.md). v1 only matched a bare top-level name; we extend to a segment-boundary
 *    match so a nested copy (e.g. "packages/x/.env" / "packages/x/package.json") is protected too — strictly
 *    safer, and consistent with constraints.pathIsForbidden's bare-segment rule.
 */
export function isCriticalProtectedPath(relPath) {
    const rel = norm(relPath);
    if (!rel)
        return false;
    for (const prefix of CRITICAL_PROTECTED_PREFIXES) {
        const p = prefix.replace(/\/+$/, '');
        if (rel === p || rel.startsWith(`${p}/`))
            return true;
    }
    const segments = rel.split('/');
    for (const f of CRITICAL_PROTECTED_FILES) {
        if (rel === f)
            return true;
        if (segments[segments.length - 1] === f)
            return true; // protected basename at any depth
    }
    return false;
}
/**
 * GLOBAL protected-path guard — ALWAYS enforced. Returns one violation per changed file that touches a
 * critical-protected path. Independent of any gene/constraints: a protected-path edit fails the cycle outright.
 */
export function checkProtectedPaths(changedFiles) {
    const violations = [];
    for (const file of changedFiles) {
        const rel = norm(file);
        if (!rel)
            continue;
        if (isCriticalProtectedPath(rel)) {
            violations.push({ kind: 'protected_path', detail: `critical_path_modified: ${rel}` });
        }
    }
    return violations;
}