import type { PolicyViolation } from './constraints.js';
export declare const CRITICAL_PROTECTED_PREFIXES: readonly string[];
export declare const CRITICAL_PROTECTED_FILES: readonly string[];
/**
 * Is `relPath` a critical-protected path? Ported from v1 isCriticalProtectedPath.
 *  - prefix subtree: rel === "skills/evolver" OR rel starts with "skills/evolver/"
 *  - protected file: any path segment chain ending in a protected file name (e.g. ".env", "config/.env",
 *    "package.json", "a/b/MEMORY.md). v1 only matched a bare top-level name; we extend to a segment-boundary
 *    match so a nested copy (e.g. "packages/x/.env" / "packages/x/package.json") is protected too — strictly
 *    safer, and consistent with constraints.pathIsForbidden's bare-segment rule.
 */
export declare function isCriticalProtectedPath(relPath: string): boolean;
/**
 * GLOBAL protected-path guard — ALWAYS enforced. Returns one violation per changed file that touches a
 * critical-protected path. Independent of any gene/constraints: a protected-path edit fails the cycle outright.
 */
export declare function checkProtectedPaths(changedFiles: readonly string[]): PolicyViolation[];