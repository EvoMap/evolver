// Cursor injection RENDERER — the cursor analogue of the Claude Code / codex installers (installer.ts /
// codexInstaller.ts), but a fundamentally different mechanism. Cursor has NO MCP-server-config + SessionStart
// lifecycle-hook hybrid to write, so the config-writer pattern does not transfer. Cursor's stable injection
// point is a PROJECT RULES file: it loads `.cursor/rules/*.mdc` (Markdown with YAML frontmatter), and a rule
// with `alwaysApply: true` is injected into the context of every request. The active path keeps that functional
// injection, but renders only quiet, relevant memory hints and no placeholder text for an empty gene pool.
//
// Format sources (cursor official docs, verified 2026-06 — cursor.com/docs/context/rules):
//   - Project rules live in `.cursor/rules/` as `.mdc` files, version-controlled.
//   - YAML frontmatter controls behavior: `alwaysApply` (boolean), `description` (string), `globs` (string).
//   - `alwaysApply: true` ⇒ "Always included. Globs and description are ignored." We keep it so approved genes still
//     reach Cursor, but keep the body to top-N quiet hints so the always-on token tax and user-visible chatter stay bounded.
//
// We write ONLY the evolver-owned region, fenced by managed-marker sentinels, so the file is idempotent (re-run
// with an unchanged gene set is a byte-for-byte no-op) and we never clobber rules a user hand-wrote in the same
// file. Hardened exactly like the other installers: atomic writes (tmp+rename) and refusal to follow a symlink
// at any adapter-owned path (a hostile workspace could redirect writes/unlinks outside the project).
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SymlinkRefusedError } from './installer.js';
/** Project-relative location cursor loads project rules from. */
export const CURSOR_RULES_DIR = join('.cursor', 'rules');
/** The single evolver-owned rules file. Other `.cursor/rules/*.mdc` (user-authored) are never touched. */
export const CURSOR_RULES_FILE = 'evolver.mdc';
/** sentinel marker that opens the evolver-managed region inside evolver.mdc (so a user can hand-edit around it). */
export const CURSOR_MANAGED_BEGIN = '<!-- evolver:managed:begin -->';
/** sentinel marker that closes the evolver-managed region. Everything between begin/end is evolver-owned. */
export const CURSOR_MANAGED_END = '<!-- evolver:managed:end -->';
/** Default cap on injected genes — keep the always-on body small so the per-request token tax stays bounded. */
export const DEFAULT_CURSOR_MAX_GENES = 8;
/** The frontmatter description (documentation only — cursor ignores it when alwaysApply:true, but it is the
 *  human-readable "what is this rule" string and keeps the file self-explanatory). */
const RULE_DESCRIPTION = 'evolver memory — learned experiences from your past sessions (auto-maintained; do not edit the managed block)';
/** The body preamble that heads the gene list (mirrors the CC SessionStart preamble for a consistent voice). */
export const CURSOR_PREAMBLE = 'evolver memory — use these learned hints silently when directly relevant; do not mention Evolver, preflight, status, or this memory block unless the user asks or reuse materially changes the answer:';
// ── fs hardening (mirrors installer.ts / codexInstaller.ts) ───────────────────
function assertNotSymlink(path, label) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return;
        throw e;
    }
    if (st.isSymbolicLink())
        throw new SymlinkRefusedError(label, path);
}
function writeTextAtomic(path, text) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
}
// ── pure rendering (exported for tests) ───────────────────────────────────────
/** One compact line for a gene in the rules body. Deterministic; defensively caps the hint length. */
export function formatCursorGeneLine(g) {
    const cat = g.category ? ` [${g.category}]` : '';
    const hint = (g.hint ?? '').replace(/\s+/g, ' ').trim();
    return `- ${g.id}${cat}${hint ? `: ${hint.slice(0, 160)}` : ''}`;
}
/**
 * Render the evolver-managed region (the fenced block only — NOT the frontmatter). Deterministic given the
 * genes: the same gene set renders byte-identical, which is what makes a re-run a no-op. An empty pool renders
 * only the paired sentinels, so Cursor receives no placeholder noise.
 */
export function renderManagedBlock(genes, maxGenes = DEFAULT_CURSOR_MAX_GENES) {
    const lines = genes.slice(0, maxGenes).map(formatCursorGeneLine);
    if (lines.length === 0)
        return `${CURSOR_MANAGED_BEGIN}\n${CURSOR_MANAGED_END}`;
    return `${CURSOR_MANAGED_BEGIN}\n${CURSOR_PREAMBLE}\n\n${lines.join('\n')}\n${CURSOR_MANAGED_END}`;
}
/** The YAML frontmatter block. `alwaysApply: true` ⇒ injected into every request (globs/description ignored,
 *  per cursor docs, but description is kept as the human-readable label). */
function frontmatter() {
    return `---\ndescription: ${RULE_DESCRIPTION}\nglobs:\nalwaysApply: true\n---`;
}
/** A complete evolver.mdc from scratch: frontmatter + a blank line + the managed block, newline-terminated. */
export function renderCursorRulesFile(genes, maxGenes = DEFAULT_CURSOR_MAX_GENES) {
    return `${frontmatter()}\n\n${renderManagedBlock(genes, maxGenes)}\n`;
}
/**
 * Splice a freshly-rendered managed block into existing evolver.mdc content, preserving everything OUTSIDE the
 * sentinels (a user may have added their own prose above/below the managed block in this file). If the file has
 * no sentinels yet (e.g. the user created evolver.mdc by hand, or this is a fresh install path that fell through
 * to a merge), the managed block is appended after the existing content. Idempotent: replacing a block with an
 * identical render yields identical bytes.
 */
export function spliceManagedBlock(existing, managedBlock) {
    const begin = existing.indexOf(CURSOR_MANAGED_BEGIN);
    const end = existing.indexOf(CURSOR_MANAGED_END);
    if (begin >= 0 && end > begin) {
        const before = existing.slice(0, begin);
        const after = existing.slice(end + CURSOR_MANAGED_END.length);
        return `${before}${managedBlock}${after}`;
    }
    // No managed region yet: append, keeping the user's existing content intact (separated by a blank line).
    const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${sep}${managedBlock}\n`;
}
/** Remove the evolver-managed region (and the surrounding blank line we may have inserted) from evolver.mdc
 *  content, leaving any user-authored prose intact. Returns [changed, text]. */
export function stripManagedBlock(existing) {
    const begin = existing.indexOf(CURSOR_MANAGED_BEGIN);
    const end = existing.indexOf(CURSOR_MANAGED_END);
    if (begin < 0 || end <= begin)
        return { changed: false, text: existing };
    const before = existing.slice(0, begin).replace(/\n+$/, '');
    const after = existing.slice(end + CURSOR_MANAGED_END.length).replace(/^\n+/, '');
    const joined = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    return { changed: true, text: joined };
}
/** Is this evolver.mdc content effectively "evolver-only" — i.e. nothing but our managed block and frontmatter
 *  remains once the managed region is stripped? Used to decide delete-file vs strip-block on uninstall. */
function isEvolverOnly(text) {
    const { text: stripped } = stripManagedBlock(text);
    // After stripping, anything left that is not blank / not the frontmatter we wrote ⇒ the user owns this file.
    const residue = stripped
        .replace(/^---[\s\S]*?---/, '') // our frontmatter block
        .replace(/\s+/g, '')
        .trim();
    return residue.length === 0;
}
// ── install / uninstall / rewrite ─────────────────────────────────────────────
/** Where evolver.mdc lives under a config root. */
export function cursorRulesPath(configRoot) {
    return join(configRoot, CURSOR_RULES_DIR, CURSOR_RULES_FILE);
}
/**
 * Write/refresh `.cursor/rules/evolver.mdc` from the current top genes. Non-destructive + idempotent:
 *   - a fresh install writes the full file (frontmatter + managed block);
 *   - a re-render only replaces the managed block, preserving frontmatter and any user prose in the same file;
 *   - re-running with an unchanged gene set produces identical bytes ⇒ we skip the write (a true no-op, so
 *     mtime/inode are untouched and nothing downstream sees a spurious change).
 * Symlink-hardened on every adapter-owned path; other `.cursor/rules/*.mdc` files are never read or written.
 */
export function installCursorRules(opts) {
    const rulesDir = join(opts.configRoot, CURSOR_RULES_DIR);
    const cursorDir = join(opts.configRoot, '.cursor');
    const filePath = cursorRulesPath(opts.configRoot);
    const maxGenes = opts.maxGenes ?? DEFAULT_CURSOR_MAX_GENES;
    assertNotSymlink(opts.configRoot, 'config root');
    assertNotSymlink(cursorDir, '.cursor');
    assertNotSymlink(rulesDir, '.cursor/rules');
    assertNotSymlink(filePath, '.cursor/rules/evolver.mdc');
    const block = renderManagedBlock(opts.genes, maxGenes);
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    const next = existing ? spliceManagedBlock(existing, block) : renderCursorRulesFile(opts.genes, maxGenes);
    // Idempotent: identical bytes ⇒ no write at all (no-op keeps the file's mtime/inode and avoids waking watchers).
    if (existing === next) {
        return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [], rewritten: false };
    }
    mkdirSync(rulesDir, { recursive: true });
    writeTextAtomic(filePath, next);
    return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [filePath], rewritten: true };
}
/**
 * Remove evolver's cursor injection. If evolver.mdc is evolver-only (we created it, no user prose), delete the
 * file; otherwise strip just the managed block and keep the user's content. Other rules files are untouched.
 */
export function uninstallCursorRules(opts) {
    const filePath = cursorRulesPath(opts.configRoot);
    assertNotSymlink(filePath, '.cursor/rules/evolver.mdc');
    if (!existsSync(filePath))
        return { ok: true, runtime: 'cursor', mode: 'uninstall', files: [] };
    const text = readFileSync(filePath, 'utf8');
    if (isEvolverOnly(text)) {
        unlinkSync(filePath);
        return { ok: true, runtime: 'cursor', mode: 'uninstall', files: [filePath] };
    }
    const { changed, text: stripped } = stripManagedBlock(text);
    if (!changed)
        return { ok: true, runtime: 'cursor', mode: 'uninstall', files: [] };
    writeTextAtomic(filePath, stripped.endsWith('\n') ? stripped : `${stripped}\n`);
    return { ok: true, runtime: 'cursor', mode: 'uninstall', files: [filePath] };
}
/** Convenience for the daemon rewrite trigger: rewrite the rules file to reflect the current top genes. Returns
 *  whether the file actually changed (so callers can avoid redundant downstream work / emissions). */
export function rewriteCursorRules(configRoot, genes, maxGenes) {
    return installCursorRules({ configRoot, genes, ...(maxGenes !== undefined ? { maxGenes } : {}) }).rewritten;
}
/** Whether cursor's injection file is currently installed at a config root (used to gate rewrite-on-change so we
 *  only maintain the file for users who opted in via `evolver setup-hooks --runtime=cursor`). */
export function cursorRulesInstalled(configRoot) {
    const filePath = cursorRulesPath(configRoot);
    try {
        if (lstatSync(filePath).isSymbolicLink())
            return false; // a symlink at our path is not a valid install
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return false;
        return false;
    }
    return readFileSync(filePath, 'utf8').includes(CURSOR_MANAGED_BEGIN);
}