/**
 * V1 → V2 environment variable compatibility layer (#698).
 *
 * Evolver V1 used several env var names that are no longer recognized by V2
 * resolvers. When operators upgrade from V1 to V2 without updating their env
 * files, these legacy names silently do nothing. This module detects the
 * presence of deprecated V1 env vars and emits structured warnings so
 * operators know which knobs to migrate.
 *
 * ## Migration map
 *
 * | V1 name | V2 equivalent | Notes |
 * |---|---|---|
 * | `OPENCLAW_WORKSPACE` | *(manual)* | Partial V2 support does not preserve V1 workspace and bridge semantics |
 * | `EVOLVER_NO_PARENT_GIT` | *(none)* | V2 uses `EVOLVER_REPO_ROOT` or nearest Git root |
 * | `EVOLVER_VERBOSE` | *(none)* | V2 has no global switch; opt in to feature-specific diagnostics manually |
 * | `EVOLVER_AUTO_ISSUE` | *(none)* | V2 creates local drafts; submit requires explicit approval-gated flow |
 * | `EVOLVER_ROLLBACK_MODE` | *(none)* | V2 uses worktree/snapshot/recovery policy |
 * | `WORKER_ENABLED` | *(none)* | No merchant-worker resolver in V2 |
 * | `WORKER_DOMAINS` | *(none)* | No merchant-worker resolver in V2 |
 * | `WORKER_MAX_LOAD` | *(none)* | No merchant-worker resolver in V2 |
 * | `EVOLVER_MEMORY_GRAPH_AUTO_ROTATE` | *(none)* | V2 LocalMemoryGraph always performs bounded maintenance |
 * | `EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB` | *(none)* | V2 LocalMemoryGraph uses a fixed 4 MiB active-file limit |
 * | `EVOLVER_MEMORY_GRAPH_RETENTION_COUNT` | *(none)* | V2 LocalMemoryGraph retains three archives by default |
 * | `GITHUB_TOKEN` | `GITHUB_TOKEN` | Already supported by V2 issue reporter and PR tooling |
 *
 * GITHUB_TOKEN is NOT deprecated — it's actively used. We only note its
 * presence for observability.
 */
export type V1EnvMigrationAction = 'map' | 'manual' | 'remove';
/** Metadata for a single V1 env var deprecation entry. */
export interface V1EnvDeprecation {
    /** The deprecated V1 env var name. */
    readonly v1Name: string;
    /** The V2 equivalent, or `null` if no equivalent exists. */
    readonly v2Equivalent: string | null;
    /** Whether migration is an exact map, requires operator review, or only removes the V1 key. */
    readonly migrationAction?: V1EnvMigrationAction;
    /** Human-readable migration guidance. */
    readonly guidance: string;
}
/** Result of scanning for deprecated V1 env vars. */
export interface V1EnvCompatResult {
    /** Deprecated V1 vars that were found set (non-empty) in the environment. */
    readonly detected: V1EnvDeprecation[];
    /** `GITHUB_TOKEN` or `GH_TOKEN` presence flag (not deprecated, just noted). */
    readonly githubTokenPresent: boolean;
}
/**
 * The canonical table of V1 → V2 env var deprecations.
 *
 * Order matters for deterministic output; the scan iterates this list
 * and checks each entry against the provided `env` object.
 */
export declare const V1_DEPRECATION_TABLE: readonly V1EnvDeprecation[];
/**
 * Scan the provided environment for deprecated V1 env vars and return
 * structured results. This function is purely read-only and never mutates
 * the `env` object.
 *
 * @param env  The environment to scan (defaults to `process.env`).
 * @returns    Structured scan results including detected deprecations.
 */
export declare function scanV1EnvCompat(env?: Record<string, string | undefined>): V1EnvCompatResult;
/** Resolve the migration action while preserving compatibility with pre-action table entries. */
export declare function resolveV1EnvMigrationAction(entry: Pick<V1EnvDeprecation, 'migrationAction' | 'v2Equivalent'>): V1EnvMigrationAction;
/**
 * Emit deprecation warnings to the provided logger for all detected
 * deprecated V1 env vars. This is the primary integration point for
 * entrypoints that want human-readable console output.
 *
 * @param result  The scan result from `scanV1EnvCompat`.
 * @param warn    Logger function (defaults to `console.warn`).
 */
export declare function emitV1DeprecationWarnings(result: V1EnvCompatResult, warn?: (msg: string) => void): void;
/**
 * Convenience function: scan + emit in one call. Intended for early
 * bootstrap in CLI/proxy/MCP entrypoints.
 *
 * @param env  The environment to scan.
 * @param warn Logger function.
 * @returns    The scan result (useful for programmatic inspection).
 */
export declare function checkV1EnvCompat(env?: Record<string, string | undefined>, warn?: (msg: string) => void): V1EnvCompatResult;
/** One suggested V2 assignment produced from a V1 env map. */
export interface V1EnvTranslationSuggestion {
    readonly v1Name: string;
    readonly action: V1EnvMigrationAction | 'keep';
    readonly v2Name?: string;
    readonly v2Value?: string;
    readonly guidance: string;
}
/** Full offline translation report for migrate env / doctor. */
export interface V1EnvTranslationReport {
    readonly suggestions: V1EnvTranslationSuggestion[];
    readonly detectedCount: number;
    readonly mappableCount: number;
    readonly manualCount: number;
    readonly removableCount: number;
    readonly githubTokenPresent: boolean;
    readonly caveats?: readonly string[];
}
/**
 * Build an offline V1→V2 env translation report.
 * Does not write files; callers decide how to present or apply suggestions.
 * Raw values are retained only as v2Value for mappable non-secret keys.
 * GITHUB_TOKEN and GH_TOKEN are reported as keep without retaining their values.
 */
export declare function translateV1Env(env?: Record<string, string | undefined>): V1EnvTranslationReport;
/** Human-readable report (never prints secret-looking values; only key names + actions). */
export declare function formatV1EnvTranslationReport(report: V1EnvTranslationReport): string;