// Artifact GC (ported + generalized from v1 src/ops/cleanup.js). A resident daemon accumulates artifacts —
// exec patch files (proof.gitDiff.patchRef under tmpdir), old event logs, scratch prompts — that nothing ever
// reclaims. This applies a two-phase retention policy to a directory: (1) age-based, always keeping the N
// newest regardless of age; (2) a hard count cap as a safety backstop. Generic over a filename pattern so the
// daemon can GC each artifact kind. Best-effort + graceful: a missing dir or an undeletable file never throws.
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
function listMatching(dir, pattern) {
    return readdirSync(dir)
        .filter((f) => pattern.test(f))
        .map((f) => {
        const path = join(dir, f);
        try {
            return { path, mtimeMs: statSync(path).mtimeMs };
        }
        catch {
            return { path, mtimeMs: 0 };
        } // raced/removed — sorts oldest, deletion is a no-op
    })
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
}
function safeBatchDelete(paths) {
    const deleted = [];
    for (const p of paths) {
        try {
            unlinkSync(p);
            deleted.push(p);
        }
        catch { /* best-effort */ }
    }
    return deleted;
}
/**
 * Reclaim stale artifacts matching `pattern` in `dir`. Returns what was scanned/deleted (for audit/logging).
 * Two phases: age-based (keep the minKeep newest, delete the rest older than maxAgeMs), then a maxFiles count
 * cap. A non-existent dir → a clean zero result. Never throws.
 */
export function cleanupArtifacts(dir, pattern, policy = {}) {
    const maxAgeMs = policy.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const minKeep = policy.minKeep ?? 10;
    const maxFiles = policy.maxFiles ?? 50;
    const now = policy.now ?? (() => Date.now());
    if (!existsSync(dir))
        return { scanned: 0, deleted: 0, deletedPaths: [] };
    let files;
    try {
        files = listMatching(dir, pattern);
    }
    catch {
        return { scanned: 0, deleted: 0, deletedPaths: [] };
    }
    const scanned = files.length;
    const t = now();
    const deletedPaths = [];
    // Phase 1: age-based, but always keep the minKeep newest.
    const ageVictims = files.slice(minKeep).filter((e) => t - e.mtimeMs > maxAgeMs).map((e) => e.path);
    deletedPaths.push(...safeBatchDelete(ageVictims));
    // Phase 2: hard count cap (newest wins) over whatever remains.
    const remaining = files.filter((e) => !deletedPaths.includes(e.path));
    if (remaining.length > maxFiles) {
        deletedPaths.push(...safeBatchDelete(remaining.slice(maxFiles).map((e) => e.path)));
    }
    return { scanned, deleted: deletedPaths.length, deletedPaths };
}
/** Convenience: GC the exec bridge's leftover patch files (`evolver-patch-*.diff`) in a temp dir. */
export function cleanupExecPatches(tmpDir, policy) {
    return cleanupArtifacts(tmpDir, /^evolver-patch-.*\.diff$/, policy);
}