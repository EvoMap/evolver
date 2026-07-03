import type { PolicyViolation } from './constraints.js';
export interface NumstatRow {
    /** The destination path (for a rename) or the changed path (otherwise). */
    file: string;
    /** The source path of a rename, when this row is a rename; undefined for a non-rename change. */
    from?: string;
    added: number;
    deleted: number;
}
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
export declare function resolveRenamePaths(field: string): {
    from?: string;
    to: string;
};
/**
 * Parse `git diff --numstat` output into per-file added/deleted counts (ported from v1 parseNumstatRows).
 * Each row is `<added>\t<deleted>\t<path>`. Binary files report `-` for the counts → treated as 0. A rename
 * row (`old => new` or the brace form `prefix/{old => new}/suffix`) keeps BOTH paths: `file` is the new path
 * and `from` is the original — so a protected SOURCE moved out from under the guards is still visible (the
 * rename-bypass fix). v1 only kept the new path; that let a rename of a protected file slip every check.
 */
export declare function parseNumstat(text: string): NumstatRow[];
/**
 * The set of original (source) paths of every rename in a numstat. A rename moves a file out from under the
 * `--name-only` listing (which shows only the destination), so a protected SOURCE would otherwise be invisible
 * to the protected-path guard. Surfacing these lets the policy treat a moved-away protected file as a touch.
 */
export declare function renameSourcePaths(numstat?: string): string[];
/**
 * GLOBAL destructive-change guard — ALWAYS enforced. Returns a violation for any critical-protected path whose
 * numstat shows it was deleted or emptied (added === 0 && deleted > 0). Independent of any gene/constraints.
 * When no numstat is available (caller didn't run `git diff --numstat`), returns [] — the protected-path guard
 * still catches an EDIT to these paths; this only adds the stronger "it was wiped out" signal when we have it.
 */
export declare function detectDestructiveChanges(numstat?: string): PolicyViolation[];