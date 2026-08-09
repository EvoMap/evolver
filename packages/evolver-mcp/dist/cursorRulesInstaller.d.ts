import { type InstallResult } from './installerShared.js';
/** Project-relative location cursor loads project rules from. */
export declare const CURSOR_RULES_DIR: string;
/** The single evolver-owned rules file. Other `.cursor/rules/*.mdc` (user-authored) are never touched. */
export declare const CURSOR_RULES_FILE = "evolver.mdc";
/** sentinel marker that opens the evolver-managed region inside evolver.mdc (so a user can hand-edit around it). */
export declare const CURSOR_MANAGED_BEGIN = "<!-- evolver:managed:begin -->";
/** sentinel marker that closes the evolver-managed region. Everything between begin/end is evolver-owned. */
export declare const CURSOR_MANAGED_END = "<!-- evolver:managed:end -->";
/** Default cap on injected genes — keep the always-on body small so the per-request token tax stays bounded. */
export declare const DEFAULT_CURSOR_MAX_GENES = 8;
/** The body preamble that heads the gene list (mirrors the CC SessionStart preamble for a consistent voice). */
export declare const CURSOR_PREAMBLE = "evolver memory \u2014 use these learned hints silently when directly relevant; do not mention Evolver, preflight, status, or this memory block unless the user asks or reuse materially changes the answer:";
/** A minimal projection of a gene that the renderer needs — id + a short hint. Decoupled from the asset store
 *  so the renderer (and its tests) need no store; the composition layer maps real assets onto this shape. */
export interface CursorGene {
    id: string;
    category?: string;
    /** A one-line hint (summary or joined signals). Already short; the renderer caps it defensively. */
    hint?: string;
}
/** One compact line for a gene in the rules body. Deterministic; defensively caps the hint length. */
export declare function formatCursorGeneLine(g: CursorGene): string;
/**
 * Render the evolver-managed region (the fenced block only — NOT the frontmatter). Deterministic given the
 * genes: the same gene set renders byte-identical, which is what makes a re-run a no-op. An empty pool renders
 * only the paired sentinels, so Cursor receives no placeholder noise.
 */
export declare function renderManagedBlock(genes: readonly CursorGene[], maxGenes?: number): string;
/** A complete evolver.mdc from scratch: frontmatter + a blank line + the managed block, newline-terminated. */
export declare function renderCursorRulesFile(genes: readonly CursorGene[], maxGenes?: number): string;
/**
 * Splice a freshly-rendered managed block into existing evolver.mdc content, preserving everything OUTSIDE the
 * sentinels (a user may have added their own prose above/below the managed block in this file). If the file has
 * no sentinels yet (e.g. the user created evolver.mdc by hand, or this is a fresh install path that fell through
 * to a merge), the managed block is appended after the existing content. Idempotent: replacing a block with an
 * identical render yields identical bytes.
 */
export declare function spliceManagedBlock(existing: string, managedBlock: string): string;
/** Remove the evolver-managed region (and the surrounding blank line we may have inserted) from evolver.mdc
 *  content, leaving any user-authored prose intact. Returns [changed, text]. */
export declare function stripManagedBlock(existing: string): {
    changed: boolean;
    text: string;
};
/** Where evolver.mdc lives under a config root. */
export declare function cursorRulesPath(configRoot: string): string;
export interface CursorInstallOptions {
    configRoot: string;
    genes: readonly CursorGene[];
    maxGenes?: number;
}
/**
 * Write/refresh `.cursor/rules/evolver.mdc` from the current top genes. Non-destructive + idempotent:
 *   - a fresh install writes the full file (frontmatter + managed block);
 *   - a re-render only replaces the managed block, preserving frontmatter and any user prose in the same file;
 *   - re-running with an unchanged gene set produces identical bytes ⇒ we skip the write (a true no-op, so
 *     mtime/inode are untouched and nothing downstream sees a spurious change).
 * Symlink-hardened on every adapter-owned path; other `.cursor/rules/*.mdc` files are never read or written.
 */
export declare function installCursorRules(opts: CursorInstallOptions): InstallResult & {
    rewritten: boolean;
};
/**
 * Remove evolver's cursor injection. If evolver.mdc is evolver-only (we created it, no user prose), delete the
 * file; otherwise strip just the managed block and keep the user's content. Other rules files are untouched.
 */
export declare function uninstallCursorRules(opts: {
    configRoot: string;
}): InstallResult;
/** Convenience for the daemon rewrite trigger: rewrite the rules file to reflect the current top genes. Returns
 *  whether the file actually changed (so callers can avoid redundant downstream work / emissions). */
export declare function rewriteCursorRules(configRoot: string, genes: readonly CursorGene[], maxGenes?: number): boolean;
/** Whether cursor's injection file is currently installed at a config root (used to gate rewrite-on-change so we
 *  only maintain the file for users who opted in via `evolver setup-hooks --runtime=cursor`). */
export declare function cursorRulesInstalled(configRoot: string): boolean;