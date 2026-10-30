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
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { sameRuntimePath } from './runtimePathIdentity.js';
import { SymlinkRefusedError } from './installerShared.js';
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
function cursorRulePaths(configRoot) {
    return {
        cursorDir: join(configRoot, '.cursor'),
        rulesDir: join(configRoot, CURSOR_RULES_DIR),
        filePath: cursorRulesPath(configRoot),
    };
}
function assertCursorRulePathsNotSymlink(configRoot, paths) {
    assertNotSymlink(configRoot, 'config root');
    assertNotSymlink(paths.cursorDir, '.cursor');
    assertNotSymlink(paths.rulesDir, '.cursor/rules');
    assertNotSymlink(paths.filePath, '.cursor/rules/evolver.mdc');
}
function cleanupAtomicTemp(filePath) {
    try {
        const stat = lstatSync(filePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) {
            return new Error(`Refusing to clean non-file atomic temp path: ${filePath}`);
        }
        unlinkSync(filePath);
        return undefined;
    }
    catch (error) {
        return error.code === 'ENOENT' ? undefined : error;
    }
}
function writeTextAtomic(filePath, text, beforeCommit) {
    const tmp = join(dirname(filePath), `${basename(filePath)}.${randomUUID()}.tmp`);
    let writeCompleted = false;
    let renameCompleted = false;
    let operationFailed = false;
    let operationError;
    let cleanupError;
    try {
        writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
        writeCompleted = true;
        beforeCommit?.();
        assertNotSymlink(filePath, '.cursor/rules/evolver.mdc');
        renameSync(tmp, filePath);
        renameCompleted = true;
    }
    catch (error) {
        operationFailed = true;
        operationError = error;
    }
    finally {
        const collidedBeforeWrite = !writeCompleted && operationError?.code === 'EEXIST';
        if (!renameCompleted && !collidedBeforeWrite)
            cleanupError = cleanupAtomicTemp(tmp);
    }
    if (operationFailed)
        throw operationError;
    if (cleanupError !== undefined)
        throw cleanupError;
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
    const { text: stripped } = stripManagedBlock(text.replace(/\r\n/g, '\n'));
    // After stripping, anything left that is not blank / not the frontmatter we wrote ⇒ the user owns this file.
    return stripped.trim() === frontmatter().trim();
}
// ── install / uninstall / rewrite ─────────────────────────────────────────────
/** Where evolver.mdc lives under a config root. */
export function cursorRulesPath(configRoot) {
    return join(configRoot, CURSOR_RULES_DIR, CURSOR_RULES_FILE);
}
function loadableCursorRules(text) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (frontmatter === undefined || Buffer.byteLength(frontmatter) > 64 * 1024)
        return false;
    try {
        const document = parseDocument(frontmatter, { uniqueKeys: true });
        if (document.errors.length)
            return false;
        const value = document.toJS({ maxAliasCount: 100 });
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            && Object.hasOwn(value, 'alwaysApply') && value['alwaysApply'] === true;
    }
    catch {
        return false;
    }
}
function managedCursorRules(text) {
    return loadableCursorRules(text)
        && text.indexOf(CURSOR_MANAGED_BEGIN) >= 0
        && text.indexOf(CURSOR_MANAGED_END) > text.indexOf(CURSOR_MANAGED_BEGIN);
}
function assertCursorTarget(filePath, targetPath) {
    if (targetPath !== undefined && !sameRuntimePath(targetPath, filePath)) {
        throw new Error('Cursor lifecycle target is not the managed rules file');
    }
}
function assertCursorSnapshot(filePath, expected) {
    const actual = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    if (actual !== expected)
        throw new Error('Cursor rules changed while applying the confirmed plan');
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
    const paths = cursorRulePaths(opts.configRoot);
    assertCursorTarget(paths.filePath, opts.targetPath);
    assertCursorRulePathsNotSymlink(opts.configRoot, paths);
    if (existsSync(paths.filePath)) {
        const existing = readFileSync(paths.filePath, 'utf8');
        const next = spliceManagedBlock(existing, renderManagedBlock(opts.genes, opts.maxGenes ?? DEFAULT_CURSOR_MAX_GENES));
        if (loadableCursorRules(existing) && (opts.preserveExisting && managedCursorRules(existing) || next === existing)
            && !readCursorUninstallRecovery(paths) && !cursorMutationLeases.has(cursorMutationKey(paths))) {
            assertCursorRulePathsNotSymlink(opts.configRoot, paths);
            assertCursorSnapshot(paths.filePath, existing);
            return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [], rewritten: false,
                alreadyInstalled: true, verified: true, ...(opts.dryRun ? { dryRun: true } : {}) };
        }
    }
    if (!existsSync(paths.cursorDir)) {
        if (opts.dryRun)
            return installCursorRulesWithinLease(opts);
        mkdirSync(paths.cursorDir, { recursive: true });
    }
    if (opts.dryRun)
        return installCursorRulesWithinLease(opts);
    return withCursorMutation(paths, () => installCursorRulesWithinLease(opts));
}
function installCursorRulesWithinLease(opts) {
    const paths = cursorRulePaths(opts.configRoot);
    const { rulesDir, filePath } = paths;
    const maxGenes = opts.maxGenes ?? DEFAULT_CURSOR_MAX_GENES;
    assertCursorTarget(filePath, opts.targetPath);
    assertCursorRulePathsNotSymlink(opts.configRoot, paths);
    const unfinished = readCursorUninstallRecovery(paths);
    if (unfinished)
        throw cursorUninstallFailure(new Error('Cursor uninstall recovery is pending; retry removal before installing'), unfinished);
    const block = renderManagedBlock(opts.genes, maxGenes);
    assertCursorRulePathsNotSymlink(opts.configRoot, paths);
    const snapshot = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    const existing = snapshot ?? '';
    if (snapshot !== null && !loadableCursorRules(existing)) {
        throw new Error('Cursor rules are not alwaysApply; review the existing frontmatter before installing');
    }
    if (opts.preserveExisting && existing) {
        if (managedCursorRules(existing)) {
            return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [], rewritten: false, alreadyInstalled: true, verified: true, ...(opts.dryRun ? { dryRun: true } : {}) };
        }
    }
    const next = existing ? spliceManagedBlock(existing, block) : renderCursorRulesFile(opts.genes, maxGenes);
    if (existing === next) {
        return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [], rewritten: false, alreadyInstalled: true, verified: true, ...(opts.dryRun ? { dryRun: true } : {}) };
    }
    if (opts.dryRun) {
        return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [filePath], rewritten: false, dryRun: true };
    }
    mkdirSync(rulesDir, { recursive: true });
    writeTextAtomic(filePath, next, () => {
        assertCursorRulePathsNotSymlink(opts.configRoot, paths);
        assertCursorSnapshot(filePath, snapshot);
    });
    return { ok: true, runtime: 'cursor', mode: 'cursor-rules', files: [filePath], rewritten: true, verified: true };
}
const cursorMutationLeases = new Map();
function cursorDirectoryIdentity(path) {
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino <= 0n)
        throw new Error(`Unsafe Cursor mutation directory: ${path}`);
    return { dev: String(info.dev), ino: String(info.ino) };
}
function readCursorMutationOwner(generation) {
    try {
        cursorDirectoryIdentity(generation);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const path = join(generation, 'owner.json'), value = readCursorRecoveryJson(path);
    if (Object.keys(value).sort().join(',') !== 'pid,token' || !Number.isSafeInteger(value['pid']) || Number(value['pid']) < 1
        || typeof value['token'] !== 'string' || !/^[a-f0-9-]{36}$/.test(value['token']) || lstatSync(path, { bigint: true }).nlink !== 1n) {
        throw new Error('Invalid Cursor mutation owner');
    }
    return { pid: Number(value['pid']), token: value['token'] };
}
function cursorMutationReleased(generation) {
    try {
        cursorDirectoryIdentity(join(generation, 'released'));
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function releaseCursorMutation(paths, lease) {
    if (!sameCursorIdentity(cursorDirectoryIdentity(paths.cursorDir), lease.directory))
        throw new Error('Cursor mutation root changed');
    const owner = readCursorMutationOwner(lease.generation);
    if (owner?.pid !== lease.pid || owner.token !== lease.token)
        throw new Error('Cursor mutation owner changed');
    try {
        mkdirSync(join(lease.generation, 'released'), { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        cursorMutationReleased(lease.generation);
    }
    syncCursorDirectory(lease.generation);
}
function cursorMutationKey(paths) {
    const canonical = realpathSync.native(paths.cursorDir);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
function withCursorMutation(paths, operation) {
    const key = cursorMutationKey(paths);
    const retained = cursorMutationLeases.get(key);
    if (retained) {
        if (retained.active)
            throw Object.assign(new Error('Cursor mutation is already active'), { code: 'CURSOR_OPERATION_BUSY' });
        releaseCursorMutation(paths, retained);
        cursorMutationLeases.delete(key);
    }
    const directory = cursorDirectoryIdentity(paths.cursorDir), visited = new Set();
    let generation = join(paths.cursorDir, '.evolver-cursor.lock'), lease;
    while (!lease) {
        if (!sameCursorIdentity(cursorDirectoryIdentity(paths.cursorDir), directory) || visited.has(generation))
            throw new Error('Cursor mutation generation changed');
        const owner = readCursorMutationOwner(generation);
        if (owner) {
            visited.add(generation);
            if (!cursorMutationReleased(generation)) {
                try {
                    process.kill(owner.pid, 0);
                    throw Object.assign(new Error('Cursor mutation is busy'), { code: 'CURSOR_OPERATION_BUSY' });
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        throw error;
                }
            }
            generation = join(paths.cursorDir, `.evolver-cursor.${owner.token}.next`);
            continue;
        }
        const token = randomUUID(), candidate = join(paths.cursorDir, `.evolver-cursor.${token}.candidate`);
        mkdirSync(candidate, { mode: 0o700 });
        const candidateIdentity = cursorDirectoryIdentity(candidate);
        try {
            writeSyncedCursorFile(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, token }) + '\n');
            syncCursorDirectory(candidate);
            try {
                renameSync(candidate, generation);
            }
            catch (error) {
                if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code ?? '')
                    || !readCursorMutationOwner(generation))
                    throw error;
                continue;
            }
            lease = { directory, generation, pid: process.pid, token, active: true };
        }
        finally {
            if (existsSync(candidate) && sameCursorIdentity(cursorDirectoryIdentity(candidate), candidateIdentity)) {
                rmSync(candidate, { recursive: true });
            }
        }
    }
    cursorMutationLeases.set(key, lease);
    let result, primary, failed = false;
    try {
        result = operation();
    }
    catch (error) {
        primary = error;
        failed = true;
    }
    lease.active = false;
    try {
        releaseCursorMutation(paths, lease);
        cursorMutationLeases.delete(key);
    }
    catch (cleanup) {
        if (failed) {
            const error = new AggregateError([primary, cleanup], 'Cursor mutation and lease cleanup failed; recovery retained', { cause: primary });
            throw Object.assign(error, { backups: primary?.backups,
                recoveryPaths: primary?.recoveryPaths });
        }
        return { ...result, warnings: [...(result.warnings ?? []), '操作结果已保存，内部恢复锁清理未完成；下次实际操作会先重试释放。'] };
    }
    if (failed)
        throw primary;
    return result;
}
function cursorPendingPath(paths) {
    return join(paths.cursorDir, '.evolver-uninstall.pending.json');
}
function cursorFileIdentity(path) {
    const info = lstatSync(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || info.ino <= 0n)
        throw new Error(`Unsafe Cursor recovery file: ${path}`);
    return { dev: String(info.dev), ino: String(info.ino) };
}
function sameCursorIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}
function cursorSha(text) { return createHash('sha256').update(text).digest('hex'); }
function syncCursorDirectory(path) {
    let fd;
    const failures = [];
    try {
        fd = openSync(path, constants.O_RDONLY);
        fsyncSync(fd);
    }
    catch (error) {
        const code = error.code;
        // Match the existing platform contract: unsupported directory sync does not
        // replace file fsync, and actual I/O failures must still be reported.
        if (!(code === 'EINVAL' || process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')))
            failures.push(error);
    }
    finally {
        if (fd !== undefined)
            try {
                closeSync(fd);
            }
            catch (error) {
                failures.push(error);
            }
    }
    if (failures.length === 1)
        throw failures[0];
    if (failures.length)
        throw new AggregateError(failures, 'Cursor directory sync and close failed', { cause: failures[0] });
}
function writeSyncedCursorFile(path, text, mode = 0o600) {
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx', mode });
    const identity = cursorFileIdentity(path), fd = openSync(path, 'r+');
    const failures = [];
    try {
        const info = fstatSync(fd, { bigint: true });
        if (!info.isFile() || String(info.ino) !== identity.ino
            || String(info.dev) !== identity.dev && !(process.platform === 'win32' && identity.dev === '0' && info.dev > 0n)) {
            throw new Error(`Cursor recovery file changed while opening: ${path}`);
        }
        fsyncSync(fd);
        if (!sameCursorIdentity(cursorFileIdentity(path), identity))
            throw new Error(`Cursor recovery file changed: ${path}`);
    }
    catch (error) {
        failures.push(error);
    }
    finally {
        try {
            closeSync(fd);
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (failures.length === 1)
        throw failures[0];
    if (failures.length)
        throw new AggregateError(failures, 'Cursor recovery write and close failed', { cause: failures[0] });
}
function readCursorRecoveryJson(path) {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096n || before.nlink < 1n || before.nlink > 2n) {
        throw new Error(`Unsafe Cursor recovery record: ${path}`);
    }
    const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length > 4096) {
        throw new Error(`Cursor recovery record changed: ${path}`);
    }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`Invalid Cursor recovery record: ${path}`);
    return value;
}
function validCursorIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const identity = value;
    return Object.keys(identity).sort().join(',') === 'dev,ino' && typeof identity['dev'] === 'string'
        && /^\d{1,30}$/.test(identity['dev']) && typeof identity['ino'] === 'string'
        && /^\d{1,30}$/.test(identity['ino']) && BigInt(identity['ino']) > 0n;
}
function assertCursorRecoveryDirectory(recovery) {
    const info = lstatSync(recovery.directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()
        || !sameCursorIdentity({ dev: String(info.dev), ino: String(info.ino) }, recovery.intent.directory)
        || process.platform !== 'win32' && (info.uid !== BigInt(process.getuid()) || (info.mode & 63n) !== 0n)) {
        throw new Error(`Cursor recovery directory changed: ${recovery.directory}`);
    }
}
function readCursorUninstallRecovery(paths) {
    const pending = cursorPendingPath(paths);
    try {
        lstatSync(pending);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const value = readCursorRecoveryJson(pending);
    if (Object.keys(value).sort().join(',') !== 'backupDir,directory,id,original,originalSha,remainingSha,schema'
        || value['schema'] !== 'evolver.cursor-uninstall.v1' || typeof value['id'] !== 'string'
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value['id'])
        || typeof value['backupDir'] !== 'string' || !/^\.evolver-uninstall-[a-zA-Z0-9]{6,64}$/.test(value['backupDir'])
        || !validCursorIdentity(value['directory']) || !validCursorIdentity(value['original'])
        || typeof value['originalSha'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['originalSha'])
        || value['remainingSha'] !== null && (typeof value['remainingSha'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['remainingSha']))) {
        throw new Error(`Invalid pending Cursor uninstall: ${pending}`);
    }
    const intent = value, directory = join(paths.cursorDir, intent.backupDir);
    const recovery = { intent, directory, pending, journal: join(directory, 'uninstall.intent.json'),
        backup: join(directory, 'evolver.mdc.retained'), prepared: join(directory, 'remaining-rule.tmp') };
    assertCursorRecoveryDirectory(recovery);
    if (!sameCursorIdentity(cursorFileIdentity(pending), cursorFileIdentity(recovery.journal))
        || lstatSync(pending, { bigint: true }).nlink !== 2n
        || JSON.stringify(readCursorRecoveryJson(recovery.journal)) !== JSON.stringify(value)) {
        throw new Error(`Cursor pending ownership changed: ${pending}`);
    }
    return recovery;
}
function cursorUninstallFailure(primary, recovery, cleanup = []) {
    const message = primary instanceof Error ? primary.message : String(primary);
    const retained = recovery ? `; original content retained at ${recovery.backup}; recovery record ${recovery.pending}` : '';
    const error = cleanup.length ? new AggregateError([primary, ...cleanup], `${message}${retained}; Cursor cleanup unconfirmed`, { cause: primary })
        : new Error(`${message}${retained}`, { cause: primary });
    return Object.assign(error, { backups: [recovery?.backup, recovery?.displaced].filter((path) => path !== undefined && existsSync(path)),
        recoveryPaths: recovery ? [recovery.directory, recovery.pending] : [] });
}
function prepareCursorUninstall(paths, text, remaining, original) {
    const directory = mkdtempSync(join(paths.cursorDir, '.evolver-uninstall-'));
    const info = lstatSync(directory, { bigint: true });
    const intent = { schema: 'evolver.cursor-uninstall.v1', id: randomUUID(), backupDir: basename(directory),
        directory: { dev: String(info.dev), ino: String(info.ino) }, original,
        originalSha: cursorSha(text), remainingSha: remaining === null ? null : cursorSha(remaining) };
    const recovery = { intent, directory, pending: cursorPendingPath(paths), journal: join(directory, 'uninstall.intent.json'),
        backup: join(directory, 'evolver.mdc.retained'), prepared: join(directory, 'remaining-rule.tmp') };
    try {
        if (remaining !== null)
            writeSyncedCursorFile(recovery.prepared, remaining, 0o666);
        writeSyncedCursorFile(recovery.journal, JSON.stringify(intent) + '\n');
        syncCursorDirectory(directory);
        return recovery;
    }
    catch (error) {
        throw cursorUninstallFailure(error, recovery);
    }
}
function recordCursorRecoveryValue(recovery, name, value) {
    assertCursorRecoveryDirectory(recovery);
    const path = join(recovery.directory, name);
    if (existsSync(path)) {
        if (JSON.stringify(readCursorRecoveryJson(path)) !== JSON.stringify(value))
            throw new Error('Cursor recovery outcome differs');
        syncCursorDirectory(recovery.directory);
        return undefined;
    }
    const temporary = join(recovery.directory, `completion.${randomUUID()}.tmp`);
    writeSyncedCursorFile(temporary, JSON.stringify(value) + '\n');
    linkSync(temporary, path);
    syncCursorDirectory(recovery.directory);
    return cleanupAtomicTemp(temporary);
}
function recordCursorUninstallOutcome(recovery, outcome, rollback = false) {
    return recordCursorRecoveryValue(recovery, rollback ? 'rollback.completion.json' : 'completion.json', { schema: 'evolver.cursor-uninstall-completion.v1', id: recovery.intent.id, outcome });
}
function recordCursorRollbackIntent(recovery) {
    const captured = recovery.captured;
    const value = captured && !sameCursorIdentity(captured, recovery.intent.original)
        ? { schema: 'evolver.cursor-uninstall-rollback.v2', id: recovery.intent.id, retained: captured }
        : { schema: 'evolver.cursor-uninstall-rollback.v1', id: recovery.intent.id };
    return recordCursorRecoveryValue(recovery, 'rollback.intent.json', value);
}
function cursorRollbackRequested(recovery) {
    const path = join(recovery.directory, 'rollback.intent.json');
    if (!existsSync(path))
        return false;
    const value = readCursorRecoveryJson(path);
    const captured = value['schema'] === 'evolver.cursor-uninstall-rollback.v2';
    if (Object.keys(value).sort().join(',') !== (captured ? 'id,retained,schema' : 'id,schema')
        || !captured && value['schema'] !== 'evolver.cursor-uninstall-rollback.v1' || value['id'] !== recovery.intent.id
        || captured && !validCursorIdentity(value['retained']))
        throw new Error('Invalid Cursor rollback intent');
    if (captured)
        recovery.captured = value['retained'];
    return true;
}
function clearCursorPending(paths, recovery) {
    assertCursorRecoveryDirectory(recovery);
    const current = readCursorUninstallRecovery(paths);
    if (current?.intent.id !== recovery.intent.id)
        throw new Error('Cursor pending ownership changed before cleanup');
    unlinkSync(recovery.pending);
    syncCursorDirectory(paths.cursorDir);
}
function restoreCursorOriginal(configRoot, paths, recovery, rollbackPostimage = false) {
    assertCursorRulePathsNotSymlink(configRoot, paths);
    assertCursorRecoveryDirectory(recovery);
    const retained = cursorFileIdentity(recovery.backup);
    if (!sameCursorIdentity(retained, recovery.captured ?? recovery.intent.original))
        throw new Error('Cursor retained original identity changed');
    if (existsSync(paths.filePath) && !sameCursorIdentity(cursorFileIdentity(paths.filePath), retained)) {
        if (!rollbackPostimage || recovery.intent.remainingSha === null || !existsSync(recovery.prepared)
            || !sameCursorIdentity(cursorFileIdentity(paths.filePath), cursorFileIdentity(recovery.prepared))
            || cursorSha(readFileSync(paths.filePath)) !== recovery.intent.remainingSha) {
            throw new Error('Cursor recovery path is occupied; concurrent content will not be overwritten');
        }
        const prepared = cursorFileIdentity(recovery.prepared);
        const directory = mkdtempSync(join(recovery.directory, 'rollback-'));
        const displaced = join(directory, 'displaced.mdc');
        recovery.displaced = displaced;
        // Capture rather than compare-and-unlink: even a raced-in editor inode is retained.
        renameSync(paths.filePath, displaced);
        try {
            if (!sameCursorIdentity(cursorFileIdentity(displaced), prepared)
                || cursorSha(readFileSync(displaced)) !== recovery.intent.remainingSha) {
                throw new Error('Cursor rollback capture is occupied; concurrent content will not be overwritten');
            }
            linkSync(recovery.backup, paths.filePath);
            syncCursorDirectory(directory);
            syncCursorDirectory(recovery.directory);
            syncCursorDirectory(paths.rulesDir);
            return;
        }
        catch (primary) {
            const cleanup = [];
            if (!existsSync(paths.filePath)) {
                try {
                    linkSync(displaced, paths.filePath);
                    syncCursorDirectory(paths.rulesDir);
                }
                catch (error) {
                    cleanup.push(error);
                }
            }
            if (cleanup.length)
                throw new AggregateError([primary, ...cleanup], 'Cursor rollback capture recovery unconfirmed', { cause: primary });
            throw primary;
        }
    }
    try {
        linkSync(recovery.backup, paths.filePath);
    }
    catch (error) {
        if (error.code !== 'EEXIST'
            || !sameCursorIdentity(cursorFileIdentity(paths.filePath), retained))
            throw error;
    }
    syncCursorDirectory(paths.rulesDir);
}
function recoverCursorUninstall(configRoot, paths, dryRun = false) {
    const recovery = readCursorUninstallRecovery(paths);
    if (!recovery)
        return { backups: [], warnings: [] };
    const warnings = [];
    const completed = (outcome, rollback = false) => {
        const cleanup = recordCursorUninstallOutcome(recovery, outcome, rollback);
        if (cleanup !== undefined)
            warnings.push(`恢复记录的临时清理未完成，原数据保持保留：${recovery.directory}`);
    };
    const backups = existsSync(recovery.backup) ? [recovery.backup] : [];
    if (dryRun)
        return { backups, warnings, result: { ok: false, runtime: 'cursor', mode: 'uninstall', files: [paths.filePath],
                verified: false, dryRun: true, backups, warnings: ['上次 Cursor 移除尚未完成；实际重试会先恢复原文件，预演不会改文件。'] } };
    let outcome;
    try {
        const completion = join(recovery.directory, 'completion.json');
        if (cursorRollbackRequested(recovery)) {
            if (existsSync(recovery.backup))
                restoreCursorOriginal(configRoot, paths, recovery, true);
            else if (!existsSync(paths.filePath) || !sameCursorIdentity(cursorFileIdentity(paths.filePath), recovery.intent.original)) {
                throw new Error('Cursor rollback original is missing or changed');
            }
            outcome = 'rolled_back';
            completed(outcome, true);
        }
        else if (existsSync(completion)) {
            const value = readCursorRecoveryJson(completion);
            if (Object.keys(value).sort().join(',') !== 'id,outcome,schema' || value['schema'] !== 'evolver.cursor-uninstall-completion.v1'
                || value['id'] !== recovery.intent.id || !['committed', 'rolled_back'].includes(String(value['outcome']))) {
                throw new Error('Invalid Cursor uninstall completion');
            }
            outcome = value['outcome'];
            if (outcome === 'rolled_back' && !existsSync(paths.filePath)) {
                if (!existsSync(recovery.backup) || !sameCursorIdentity(cursorFileIdentity(recovery.backup), recovery.intent.original)) {
                    throw new Error('Cursor rollback original is missing or changed');
                }
                restoreCursorOriginal(configRoot, paths, recovery);
            }
        }
        else if (!existsSync(recovery.backup)) {
            if (!existsSync(paths.filePath) || !sameCursorIdentity(cursorFileIdentity(paths.filePath), recovery.intent.original)) {
                throw new Error('Cursor recovery original is missing');
            }
            outcome = 'rolled_back';
            completed(outcome);
        }
        else {
            if (!sameCursorIdentity(cursorFileIdentity(recovery.backup), recovery.intent.original))
                throw new Error('Cursor retained original identity changed');
            const active = existsSync(paths.filePath), unchanged = cursorSha(readFileSync(recovery.backup)) === recovery.intent.originalSha;
            const published = active && recovery.intent.remainingSha !== null && existsSync(recovery.prepared)
                && sameCursorIdentity(cursorFileIdentity(paths.filePath), cursorFileIdentity(recovery.prepared))
                && cursorSha(readFileSync(paths.filePath)) === recovery.intent.remainingSha;
            if (unchanged && (published || !active && recovery.intent.remainingSha === null))
                outcome = 'committed';
            else if (!active || sameCursorIdentity(cursorFileIdentity(paths.filePath), recovery.intent.original)) {
                restoreCursorOriginal(configRoot, paths, recovery);
                outcome = 'rolled_back';
            }
            else
                throw new Error('Cursor recovery path is occupied; concurrent content will not be overwritten');
            completed(outcome);
        }
        clearCursorPending(paths, recovery);
    }
    catch (error) {
        throw cursorUninstallFailure(error, recovery);
    }
    const temporaryCleanup = cleanupAtomicTemp(recovery.prepared);
    if (temporaryCleanup !== undefined)
        warnings.push(`临时文件清理未完成，恢复后的用户规则保持不变：${recovery.prepared}`);
    // Historical retained inodes are never replayed after their intent is consumed.
    return { backups, warnings };
}
/** Retain the original inode, durably record intent, and publish only an exclusive postimage. */
export function uninstallCursorRules(opts) {
    const paths = cursorRulePaths(opts.configRoot);
    assertCursorTarget(paths.filePath, opts.targetPath);
    assertCursorRulePathsNotSymlink(opts.configRoot, paths);
    if (opts.dryRun || !existsSync(paths.cursorDir))
        return uninstallCursorRulesWithinLease(opts);
    if (!cursorMutationLeases.has(cursorMutationKey(paths)) && !readCursorUninstallRecovery(paths)) {
        const snapshot = existsSync(paths.filePath) ? readFileSync(paths.filePath, 'utf8') : null;
        if ((snapshot === null || !stripManagedBlock(snapshot).changed) && !readCursorUninstallRecovery(paths)) {
            assertCursorRulePathsNotSymlink(opts.configRoot, paths);
            assertCursorSnapshot(paths.filePath, snapshot);
            return { ok: true, runtime: 'cursor', mode: 'uninstall', files: [], verified: true };
        }
    }
    return withCursorMutation(paths, () => uninstallCursorRulesWithinLease(opts));
}
function uninstallCursorRulesWithinLease(opts) {
    const paths = cursorRulePaths(opts.configRoot), { filePath } = paths;
    assertCursorTarget(filePath, opts.targetPath);
    assertCursorRulePathsNotSymlink(opts.configRoot, paths);
    const recovered = recoverCursorUninstall(opts.configRoot, paths, opts.dryRun);
    if (recovered.result)
        return recovered.result;
    const result = (files, backups = recovered.backups, warnings = recovered.warnings) => ({
        ok: true, runtime: 'cursor', mode: 'uninstall', files, verified: true,
        ...(backups.length ? { backups } : {}), ...(warnings.length ? { warnings } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
    });
    if (!existsSync(filePath))
        return result([]);
    const original = cursorFileIdentity(filePath);
    const text = readFileSync(filePath, 'utf8'), { changed, text: stripped } = stripManagedBlock(text);
    if (!sameCursorIdentity(cursorFileIdentity(filePath), original))
        throw new Error('Cursor rules changed while reading the uninstall plan');
    if (!changed)
        return result([]);
    if (opts.dryRun)
        return { ok: true, runtime: 'cursor', mode: 'uninstall', files: [filePath], dryRun: true };
    let recovery, claimed = false, moved = false, completionCleanup;
    try {
        const remaining = isEvolverOnly(text) ? null : stripped.endsWith('\n') ? stripped : `${stripped}\n`;
        recovery = prepareCursorUninstall(paths, text, remaining, original);
        assertCursorRulePathsNotSymlink(opts.configRoot, paths);
        assertCursorSnapshot(filePath, text);
        if (!sameCursorIdentity(cursorFileIdentity(filePath), recovery.intent.original))
            throw new Error('Cursor rules identity changed while uninstalling');
        linkSync(recovery.journal, recovery.pending);
        claimed = true;
        syncCursorDirectory(paths.cursorDir);
        renameSync(filePath, recovery.backup);
        moved = true;
        // Bind the inode actually captured before rejecting a raced-in editor replacement.
        recovery.captured = cursorFileIdentity(recovery.backup);
        if (!sameCursorIdentity(recovery.captured, recovery.intent.original)
            || cursorSha(readFileSync(recovery.backup)) !== recovery.intent.originalSha)
            throw new Error('Cursor rules changed while uninstalling');
        if (remaining !== null) {
            assertCursorRulePathsNotSymlink(opts.configRoot, paths);
            if (cursorSha(readFileSync(recovery.prepared)) !== recovery.intent.remainingSha)
                throw new Error('Cursor prepared user rules changed');
            linkSync(recovery.prepared, filePath);
            if (!sameCursorIdentity(cursorFileIdentity(filePath), cursorFileIdentity(recovery.prepared))
                || cursorSha(readFileSync(filePath)) !== recovery.intent.remainingSha)
                throw new Error('Cursor published user rules changed');
        }
        syncCursorDirectory(paths.rulesDir);
        completionCleanup = recordCursorUninstallOutcome(recovery, 'committed');
    }
    catch (primary) {
        const cleanup = [];
        if (recovery && claimed) {
            try {
                // A caught failure requests rollback before any recovery mutation; retry cannot infer commit from its postimage.
                const intentError = recordCursorRollbackIntent(recovery);
                if (intentError !== undefined)
                    cleanup.push(intentError);
                if (moved)
                    restoreCursorOriginal(opts.configRoot, paths, recovery, true);
                const completionError = recordCursorUninstallOutcome(recovery, 'rolled_back', true);
                if (completionError !== undefined)
                    cleanup.push(completionError);
                clearCursorPending(paths, recovery);
            }
            catch (error) {
                cleanup.push(error);
            }
        }
        throw cursorUninstallFailure(primary, recovery, cleanup);
    }
    const warnings = [...recovered.warnings, '已移除 Cursor 注入；原文件已保留备份，确认不再需要后可自行删除。'];
    if (completionCleanup !== undefined)
        warnings.push(`恢复记录的临时清理未完成：${recovery.directory}`);
    const pendingCleanup = cleanupAtomicTemp(recovery.prepared);
    if (pendingCleanup !== undefined)
        warnings.push(`临时文件清理未完成，已提交的用户规则保持不变：${recovery.prepared}`);
    try {
        clearCursorPending(paths, recovery);
    }
    catch {
        warnings.push(`恢复记录清理未完成，可重试继续；原文件保留在 ${recovery.backup}`);
    }
    return result([filePath], [...recovered.backups, recovery.backup], warnings);
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
    return managedCursorRules(readFileSync(filePath, 'utf8'));
}