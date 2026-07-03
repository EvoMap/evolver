// Destructive-change guard (ported from v1 src/gep/policyCheck.js detectDestructiveChanges + parseNumstatRows).
// v1's heuristic: a critical-protected path that was DELETED (no longer on disk) or EMPTIED (size 0) after the
// agent ran is destructive — the agent wiped out its own identity/config rather than editing it. v1 read that
// from the live filesystem (fs.existsSync / statSync.size === 0) AFTER the cycle, which works against the repo
// working tree. v2 runs the agent in a THROWAWAY worktree that is removed in claudeBridge's `finally`, so a
// live-FS check at decision time is unreliable. Instead we read the same signal from `git diff --numstat`:
//  - a deleted file → numstat row `added=0` with a positive deletion count (every line removed, file gone)
//  - an emptied file → numstat row `added=0` with all prior lines deleted
// Both collapse to "a critical-protected path with added=0 and deleted>0", which is the destructive case we
// reject. This is a useful subset of v1's check that needs no live FS. DEFERRED vs v1: the exact
// "file still exists but is now 0 bytes due to a separate truncation" distinction and the baselineUntracked
// new-file exemption are not reproduced — numstat already only reports paths the diff actually changed, and a
// freshly-added empty file shows added=0/deleted=0 (not flagged). Pure + deterministic over the numstat text.
import { isCriticalProtectedPath } from './protectedPaths.js';
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
/**
 * Resolve a numstat path field that may encode a rename into its source + destination paths. git emits a
 * rename as ONE row whose path field is `old => new` OR a brace form `{old => new}`, `prefix/{old => new}`,
 * `{old => new}/suffix`, or `prefix/{old => new}/suffix` (the common prefix/suffix factored out of the brace).
 * Returns `{ from, to }` with both fully expanded (from===to and from===undefined-equivalent for a non-rename).
 *   - `MEMORY.md => x.ts`            → { from: 'MEMORY.md',         to: 'x.ts' }
 *   - `src/{old.ts => new.ts}`       → { from: 'src/old.ts',       to: 'src/new.ts' }
 *   - `{a => b}/file.ts`             → { from: 'a/file.ts',        to: 'b/file.ts' }
 *   - `a/{b => c}/d.ts`              → { from: 'a/b/d.ts',         to: 'a/c/d.ts' }
 * A field with no `=>` is returned as { from: undefined, to: <path> }. Both sides are normalized.
 */
export function resolveRenamePaths(field) {
    const raw = String(field ?? '').trim();
    if (!raw.includes('=>'))
        return { to: norm(raw) };
    // Brace form: `prefix/{old => new}/suffix` — the prefix/suffix are shared, only the brace differs.
    const brace = raw.match(/^(.*)\{([^{}]*)=>([^{}]*)\}(.*)$/);
    if (brace) {
        const prefix = brace[1] ?? '';
        const suffix = brace[4] ?? '';
        const join = (mid) => norm(`${prefix}${mid.trim()}${suffix}`.replace(/\/{2,}/g, '/'));
        return { from: join(brace[2] ?? ''), to: join(brace[3] ?? '') };
    }
    // Plain form: `old => new`.
    const [left, right] = raw.split('=>');
    return { from: norm((left ?? '').trim()), to: norm((right ?? '').trim()) };
}
/**
 * Parse `git diff --numstat` output into per-file added/deleted counts (ported from v1 parseNumstatRows).
 * Each row is `<added>\t<deleted>\t<path>`. Binary files report `-` for the counts → treated as 0. A rename
 * row (`old => new` or the brace form `prefix/{old => new}/suffix`) keeps BOTH paths: `file` is the new path
 * and `from` is the original — so a protected SOURCE moved out from under the guards is still visible (the
 * rename-bypass fix). v1 only kept the new path; that let a rename of a protected file slip every check.
 */
export function parseNumstat(text) {
    const rows = [];
    for (const line of String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length < 3)
            continue;
        const a = Number(parts[0]);
        const d = Number(parts[1]);
        const { from, to } = resolveRenamePaths(parts.slice(2).join('\t'));
        rows.push({
            file: to,
            ...(from !== undefined && from !== to ? { from } : {}),
            added: Number.isFinite(a) ? a : 0,
            deleted: Number.isFinite(d) ? d : 0,
        });
    }
    return rows;
}
/**
 * The set of original (source) paths of every rename in a numstat. A rename moves a file out from under the
 * `--name-only` listing (which shows only the destination), so a protected SOURCE would otherwise be invisible
 * to the protected-path guard. Surfacing these lets the policy treat a moved-away protected file as a touch.
 */
export function renameSourcePaths(numstat) {
    if (!numstat)
        return [];
    return parseNumstat(numstat)
        .map((r) => r.from)
        .filter((f) => !!f);
}
/**
 * GLOBAL destructive-change guard — ALWAYS enforced. Returns a violation for any critical-protected path whose
 * numstat shows it was deleted or emptied (added === 0 && deleted > 0). Independent of any gene/constraints.
 * When no numstat is available (caller didn't run `git diff --numstat`), returns [] — the protected-path guard
 * still catches an EDIT to these paths; this only adds the stronger "it was wiped out" signal when we have it.
 */
export function detectDestructiveChanges(numstat) {
    const violations = [];
    if (!numstat)
        return violations;
    for (const row of parseNumstat(numstat)) {
        // Rename of a critical-protected SOURCE: the protected file is being MOVED/removed out from under the
        // guards (it vanishes from `--name-only`, which lists only the destination). This is destructive
        // regardless of the row's added/deleted counts — renaming MEMORY.md → harmless.ts (added>0) must NOT slip
        // through. The rename-bypass fix (Bugbot): without this, the protected source disappears with no violation.
        if (row.from && isCriticalProtectedPath(row.from)) {
            violations.push({ kind: 'destructive', detail: `critical_file_renamed_or_removed: ${row.from} => ${row.file}` });
            continue;
        }
        if (!row.file)
            continue;
        if (!isCriticalProtectedPath(row.file))
            continue;
        if (row.added === 0 && row.deleted > 0) {
            violations.push({ kind: 'destructive', detail: `critical_file_deleted_or_emptied: ${row.file}` });
        }
    }
    return violations;
}