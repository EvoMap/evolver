export interface CleanupPolicy {
    /** Delete files older than this (ms), beyond the minKeep newest. Default 7 days. */
    maxAgeMs?: number;
    /** Always keep at least this many newest files regardless of age. Default 10. */
    minKeep?: number;
    /** Hard cap: keep at most this many files total (newest wins). Default 50. */
    maxFiles?: number;
    /** Clock (test seam). Default: Date.now. */
    now?: () => number;
}
export interface CleanupResult {
    scanned: number;
    deleted: number;
    deletedPaths: string[];
}
/**
 * Reclaim stale artifacts matching `pattern` in `dir`. Returns what was scanned/deleted (for audit/logging).
 * Two phases: age-based (keep the minKeep newest, delete the rest older than maxAgeMs), then a maxFiles count
 * cap. A non-existent dir → a clean zero result. Never throws.
 */
export declare function cleanupArtifacts(dir: string, pattern: RegExp, policy?: CleanupPolicy): CleanupResult;
/** Convenience: GC the exec bridge's leftover patch files (`evolver-patch-*.diff`) in a temp dir. */
export declare function cleanupExecPatches(tmpDir: string, policy?: CleanupPolicy): CleanupResult;