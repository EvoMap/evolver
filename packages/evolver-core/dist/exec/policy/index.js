import { checkBlastRadius } from './blastRadius.js';
import { checkProtectedPaths } from './protectedPaths.js';
import { detectDestructiveChanges, renameSourcePaths } from './destructive.js';
import { checkChangeConstraints } from './constraints.js';
/**
 * Run the full policy over a diff. The global guards (blast hard cap + protected paths + destructive) ALWAYS
 * run, gene or not. The per-gene constraints run additionally when `constraints` is supplied. Returns the
 * combined violation list (empty = the change is within policy). The order is: global blast cap → protected
 * paths → destructive → per-gene constraints.
 */
export function checkPolicy(input) {
    const violations = [];
    // ── Always-on global guards (fire even with no gene / no constraints) ──
    violations.push(...checkBlastRadius(input.stat, input.constraints));
    // A rename moves a file out from under `git diff --name-only` (which lists only the destination). Fold the
    // rename SOURCE paths from `--numstat` into the protected-path check so renaming a protected file (e.g.
    // MEMORY.md => harmless.ts) is still caught here — not only by the destructive guard below (rename-bypass fix).
    violations.push(...checkProtectedPaths([...input.changedFiles, ...renameSourcePaths(input.numstat)]));
    violations.push(...detectDestructiveChanges(input.numstat));
    // ── Per-gene constraints (layer on top when a gene supplies them) ──
    if (input.constraints) {
        violations.push(...checkChangeConstraints(input.changedFiles, input.constraints, input.stat.lines));
    }
    return violations;
}
export * from './constraints.js';
export * from './blastRadius.js';
export * from './protectedPaths.js';
export * from './destructive.js';
export * from './failureMode.js';