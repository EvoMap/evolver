import type { DiffStat } from '../proofOfWork.js';
import { type ChangeConstraints, type PolicyViolation } from './constraints.js';
export interface PolicyInput {
    /** Parsed `git diff --shortstat` → {files, lines}. */
    stat: DiffStat;
    /** `git diff --name-only` → changed file list. */
    changedFiles: readonly string[];
    /** Optional `git diff --numstat` output — enables the destructive (delete/empty of a protected path) guard. */
    numstat?: string;
    /** Optional per-gene constraints. When absent, ONLY the always-on global guards run. */
    constraints?: ChangeConstraints;
}
/**
 * Run the full policy over a diff. The global guards (blast hard cap + protected paths + destructive) ALWAYS
 * run, gene or not. The per-gene constraints run additionally when `constraints` is supplied. Returns the
 * combined violation list (empty = the change is within policy). The order is: global blast cap → protected
 * paths → destructive → per-gene constraints.
 */
export declare function checkPolicy(input: PolicyInput): PolicyViolation[];
export * from './constraints.js';
export * from './blastRadius.js';
export * from './protectedPaths.js';
export * from './destructive.js';
export * from './failureMode.js';