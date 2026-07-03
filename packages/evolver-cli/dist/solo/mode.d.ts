export declare const SOLO_DEFAULT_MAX_FAILS = 5;
/** True when this autoexec invocation is solo (CLI flag or explicit env). */
export declare function isSoloRun(argv: readonly string[], env?: NodeJS.ProcessEnv): boolean;
/** Circuit-breaker threshold; tunable via EVOLVER_SOLO_MAX_FAILS, clamped to >= 1. */
export declare function soloMaxFails(env?: NodeJS.ProcessEnv): number;
/**
 * Hard-cut the network + autonomous spend at the source, in-process. Returns the
 * keys it forced (for logging/tests). Idempotent.
 */
export declare function applySoloLockdown(env?: NodeJS.ProcessEnv): Record<string, string>;
/** The solo startup banner lines (returned so the caller writes them and tests assert them). */
export declare function soloBanner(repoRoot: string): string[];