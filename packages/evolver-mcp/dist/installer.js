// Injection INSTALLER — the executor for planInjection (ported from v1 adapters/hookAdapter + claudeCode).
// planInjection() decides WHAT to wire (the .mcp.json config + that a SessionStart hook is needed); this
// module actually WRITES it to a runtime's config dir and can cleanly remove it. The marquee gap A#2: v2 had
// the plan but no executor, so "attach evolver to a real agent runtime" wasn't a thing you could run.
//
// MVP target = Claude Code (the hybrid the operator chose): register evolver as an MCP server in .mcp.json so
// the agent discovers evolver's tools, AND merge a SessionStart hook into .claude/settings.json so memory is
// pushed at session start (MCP alone can't push — the agent must pull). Hardened like v1: atomic writes
// (tmp+rename), refusal to follow a symlink at any adapter-owned path (a hostile workspace could redirect
// writes/unlinks outside the project), marker-managed so reinstall/uninstall only touch evolver's own entries,
// and a hooks-UNION merge that preserves the user's existing hooks.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { util } from '@evomap/evolver-core';
import { planInjection } from './injection.js';
// codex installer lives in its own module (TOML, different config path) but plugs into the same install/uninstall
// dispatch below. The import cycle (codexInstaller imports SymlinkRefusedError + types back) is ESM-safe: both
// sides only reference the imported values inside function bodies, never at module-evaluation time.
import { installCodex, uninstallCodex } from './codexInstaller.js';
// cursor injection is a different mechanism again (a project rules file, not a config/MCP writer): it renders
// top genes into .cursor/rules/evolver.mdc. It plugs into the same install/uninstall dispatch below.
import { installCursorRules, uninstallCursorRules } from './cursorRulesInstaller.js';
import { installAntigravity, uninstallAntigravity } from './antigravityInstaller.js';
import { installOpenCode, uninstallOpenCode } from './opencodeInstaller.js';
import { installKiro, uninstallKiro } from './kiroInstaller.js';
/** Marks a config file as containing evolver-managed entries, so uninstall only removes what we added. */
export const MANAGED_MARKER = '_evolver_managed';
/** A hook entry is evolver-owned if any of its commands mention this — used to replace-not-duplicate on reinstall. */
const EVOLVER_HOOK_TAG = 'evolver';
/** Default command the SessionStart hook runs to render + print the memory injection. The `--hook-stdin` flag opts
 *  the entrypoint into reading the runtime's SessionStart JSON from stdin (to capture session_id, #205); only the
 *  installed hook sets it, so a manual `evolver inject session-start` never reads stdin. */
export const DEFAULT_HOOK_COMMAND = 'evolver inject session-start --hook-stdin';
const SHARED_USER_CONFIG_MODE = 0o600;
const SHARED_USER_DIR_MODE = 0o700;
const SHARED_USER_CONFIG_WRITE_RETRIES = 5;
export class SymlinkRefusedError extends Error {
    constructor(label, path) {
        super(`[setup-hooks] refusing to operate: ${label} ${path} is a symbolic link — evolver will not follow symlinks for adapter-owned paths (a hostile workspace could redirect writes/unlinks outside the project). Replace it with a real directory/file and rerun.`);
        this.name = 'SymlinkRefusedError';
    }
}
/**
 * Thrown when a SHARED user config (~/.claude.json or ~/.claude/settings.json) exists but does not parse as JSON.
 * These files are Claude Code's own state (projects/oauthAccount/userID/history/settings),
 * and user-scope install merges into them via a full-file atomic replace. The lenient readJson() returns {} on
 * a parse failure, which would make the merge emit ONLY evolver's entry and silently WIPE the whole file — a
 * realistic data-loss path because Claude Code writes these files non-atomically (a concurrent session can leave
 * one truncated). For the shared-config read we therefore refuse instead of clobbering. Project-scoped
 * .mcp.json/.claude/settings.json are evolver-owned, so their lenient fresh-start behavior stays unchanged.
 */
export class UnparseableConfigError extends Error {
    constructor(label, path, owner = 'Claude Code') {
        super(`[setup-hooks] refusing to overwrite ${label} (${path}): the file exists and is non-empty but is not valid JSON. This is ${owner}'s own shared config; merging into it would replace the whole file and could wipe its contents. Fix or remove the corrupt file, then rerun.`);
        this.name = 'UnparseableConfigError';
    }
}
/**
 * Thrown when a SHARED user config exists but is empty or whitespace-only. Claude Code writes these files with a
 * truncating write, so present-empty can be a concurrent-write window rather than a fresh config.
 */
export class EmptySharedConfigError extends Error {
    constructor(label, path, owner = 'Claude Code') {
        super(`[setup-hooks] refusing to overwrite ${label} (${path}): the file exists but is empty or contains only whitespace. ${owner} may be in the middle of a truncating write, and treating it as fresh config could wipe shared config data. Fix the empty file or retry after ${owner} finishes writing it.`);
        this.name = 'EmptySharedConfigError';
    }
}
// ── fs hardening ────────────────────────────────────────────────────────────
/** Refuse to read/write through a symlink at an adapter-owned path. Missing path is fine (install creates it). */
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
function readJson(path) {
    try {
        if (!existsSync(path))
            return {};
        const raw = readFileSync(path, 'utf8').trim();
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        return {}; // unparseable → start fresh (merge will re-add evolver entries)
    }
}
/**
 * Strict variant for SHARED user configs (Claude Code's own ~/.claude.json / ~/.claude/settings.json). Only
 * ENOENT is treated as {} so a fresh user-scope install works. A present empty/whitespace file is refused because
 * it can be Claude Code's truncating-write window; a present non-empty parse failure is refused because returning
 * {} would make the subsequent full-file atomic write clobber Claude Code's state. Use this only for the
 * shared-config read; project-scoped evolver-owned files keep the lenient readJson() above.
 */
function readJsonStrictShared(path, label) {
    return readJsonStrictSharedSnapshot(path, label).data;
}
function readJsonStrictSharedSnapshot(path, label) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return { data: {}, raw: null };
        throw e;
    }
    const trimmed = raw.trim();
    if (!trimmed)
        throw new EmptySharedConfigError(label, path);
    try {
        return { data: JSON.parse(trimmed), raw };
    }
    catch {
        throw new UnparseableConfigError(label, path);
    }
}
function readRawIfExists(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
}
function existingFileMode(path) {
    try {
        return statSync(path).mode & 0o777;
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return undefined;
        throw e;
    }
}
function sharedUserConfigWriteMode(path) {
    const existingMode = existingFileMode(path);
    return existingMode === undefined ? SHARED_USER_CONFIG_MODE : existingMode & 0o700;
}
function ensureSharedUserClaudeDir(path) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        mkdirSync(path, { recursive: true, mode: SHARED_USER_DIR_MODE });
        chmodSync(path, SHARED_USER_DIR_MODE);
        return;
    }
    if (st.isSymbolicLink())
        throw new SymlinkRefusedError('~/.claude', path);
    if (!st.isDirectory()) {
        mkdirSync(path, { recursive: true, mode: SHARED_USER_DIR_MODE });
        return;
    }
    const hardenedMode = (st.mode & 0o777) & 0o700;
    if (hardenedMode !== (st.mode & 0o777))
        chmodSync(path, hardenedMode);
}
function hardenSharedUserConfigFile(path, label) {
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
    if (!st.isFile())
        return;
    const currentMode = st.mode & 0o777;
    const hardenedMode = currentMode & 0o700;
    if (hardenedMode !== currentMode)
        chmodSync(path, hardenedMode);
}
function writeJsonAtomic(path, data, options = {}) {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(data, null, 2)}\n`;
    const mode = options.mode ?? existingFileMode(path);
    const restoreMode = process.platform === 'win32' ? mode : undefined;
    try {
        writeFileSync(tmp, content, mode === undefined
            ? { encoding: 'utf8', flag: 'wx' }
            : { encoding: 'utf8', flag: 'wx', mode });
        if (mode !== undefined)
            chmodSync(tmp, mode);
        if (process.platform === 'win32' && mode !== undefined && existsSync(path)) {
            chmodSync(path, mode | 0o200);
        }
        renameSync(tmp, path);
        if (mode !== undefined)
            chmodSync(path, mode);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        if (restoreMode !== undefined) {
            try {
                if (existsSync(path))
                    chmodSync(path, restoreMode);
            }
            catch (rollbackError) {
                e.rollbackError = rollbackError;
            }
        }
        throw e;
    }
}
let sharedConfigRaceHookForTest;
export function _setSharedConfigRaceHookForTest(hook) {
    sharedConfigRaceHookForTest = hook;
}
function writeSharedJsonWithRetry(path, label, update) {
    const lockPath = `${path}.evolver.lock`;
    util.acquireLock(lockPath);
    try {
        for (let attempt = 1; attempt <= SHARED_USER_CONFIG_WRITE_RETRIES; attempt++) {
            const snapshot = readJsonStrictSharedSnapshot(path, label);
            const next = update(snapshot.data);
            if (!next.changed)
                return false;
            sharedConfigRaceHookForTest?.(path, attempt);
            if (readRawIfExists(path) !== snapshot.raw)
                continue;
            writeJsonAtomic(path, next.data, { mode: sharedUserConfigWriteMode(path) });
            return true;
        }
    }
    finally {
        util.releaseLock(lockPath);
    }
    throw new Error(`[setup-hooks] refusing to overwrite ${label} (${path}): the file changed repeatedly while evolver was merging it. Rerun setup-hooks after Claude Code finishes writing this config.`);
}
// ── pure merge (exported for tests) ──────────────────────────────────────────
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// Prototype-pollution guard (#201): keys that, if merged via bracket assignment, can poison Object.prototype or a
// constructor. deepMerge writes config files and is an exported util — skip these regardless of caller trust so a
// future deepMerge(trusted, untrustedSource) can never pollute. JSON.parse/toml-parse surface __proto__ as an own key.
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function deepMerge(target, source) {
    const out = { ...target };
    for (const k of Object.keys(source)) {
        if (POLLUTION_KEYS.has(k))
            continue; // never merge a prototype-pollution key
        const s = source[k];
        const t = out[k];
        out[k] = isObj(s) && isObj(t) ? deepMerge(t, s) : s;
    }
    return out;
}
function collectCommands(entry) {
    if (!isObj(entry))
        return [];
    const out = [];
    if (typeof entry['command'] === 'string')
        out.push(entry['command']);
    const inner = entry['hooks'];
    if (Array.isArray(inner))
        for (const h of inner)
            if (isObj(h) && typeof h['command'] === 'string')
                out.push(h['command']);
    return out;
}
const isEvolverOwned = (entry) => collectCommands(entry).some((c) => c.includes(EVOLVER_HOOK_TAG));
/**
 * deepMerge, but for `hooks.<event>` arrays keep the user's existing entries and only replace evolver-owned
 * ones — so reinstalling refreshes evolver's hook without clobbering a user's own SessionStart/Stop hooks.
 */
export function mergeHooksUnion(target, source) {
    const result = deepMerge(target, source);
    const tHooks = target['hooks'];
    const sHooks = source['hooks'];
    if (isObj(tHooks) && isObj(sHooks)) {
        const merged = { ...(isObj(result['hooks']) ? result['hooks'] : {}) };
        for (const event of Object.keys(sHooks)) {
            if (POLLUTION_KEYS.has(event))
                continue; // same guard for the hooks-union branch
            const tArr = tHooks[event];
            const sArr = sHooks[event];
            if (Array.isArray(tArr) && Array.isArray(sArr)) {
                merged[event] = [...tArr.filter((e) => !isEvolverOwned(e)), ...sArr];
            }
        }
        result['hooks'] = merged;
    }
    return result;
}
/** Strip evolver-owned hook entries + the marker from a parsed config (uninstall). Returns [changed, data]. */
export function stripManaged(data) {
    let changed = false;
    const out = { ...data };
    const hooks = out['hooks'];
    if (isObj(hooks)) {
        const nextHooks = {};
        for (const event of Object.keys(hooks)) {
            const arr = hooks[event];
            if (Array.isArray(arr)) {
                const kept = arr.filter((e) => !isEvolverOwned(e));
                if (kept.length !== arr.length)
                    changed = true;
                if (kept.length > 0)
                    nextHooks[event] = kept;
            }
            else {
                nextHooks[event] = arr;
            }
        }
        if (Object.keys(nextHooks).length > 0)
            out['hooks'] = nextHooks;
        else {
            delete out['hooks'];
        }
    }
    // remove evolver MCP server registration
    const mcp = out['mcpServers'];
    if (isObj(mcp) && 'evolver' in mcp) {
        const next = { ...mcp };
        delete next['evolver'];
        changed = true;
        if (Object.keys(next).length > 0)
            out['mcpServers'] = next;
        else {
            delete out['mcpServers'];
        }
    }
    if (MANAGED_MARKER in out) {
        delete out[MANAGED_MARKER];
        changed = changed || true;
    }
    return { changed, data: out };
}
function sessionStartHookPatch(hookCommand) {
    return { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand }] }] } };
}
/** True when a parsed config already carries evolver's MCP registration (mcpServers.evolver) — the same entry
 *  stripManaged removes on uninstall. The "already installed" short-circuit checks this in addition to the hook
 *  marker so a user-scope upgrade is not declared complete off the settings marker alone while the MCP entry is
 *  still missing (the hook and the MCP live in DIFFERENT files for user scope, so a legacy global install left
 *  ~/.claude/settings.json marked but ~/.claude.json without mcpServers.evolver — #290 would stay unfixed). */
function hasEvolverMcpRegistration(config) {
    const mcp = config['mcpServers'];
    return isObj(mcp) && 'evolver' in mcp;
}
/**
 * Resolve the claude-code config targets for a scope. USER scope anchors at the home dir and is self-contained
 * (it does NOT depend on configRoot): the MCP goes to ~/.claude.json's top-level mcpServers — Claude Code's real
 * user scope — NOT ~/.mcp.json (a `.mcp.json` only loads when its dir is the launch cwd, so `~/.mcp.json` would
 * silently do nothing outside $HOME). The SessionStart hook lands in ~/.claude/settings.json (already user-level).
 * PROJECT scope keeps the legacy paths under configRoot.
 */
function claudeCodeTargets(scope, configRoot) {
    if (scope === 'user') {
        const claudeDir = join(homedir(), '.claude');
        return {
            mcpConfigPath: join(homedir(), '.claude.json'),
            mcpIsSharedUserConfig: true,
            claudeDir,
            settingsPath: join(claudeDir, 'settings.json'),
        };
    }
    const claudeDir = join(configRoot, '.claude');
    return {
        mcpConfigPath: join(configRoot, '.mcp.json'),
        mcpIsSharedUserConfig: false,
        claudeDir,
        settingsPath: join(claudeDir, 'settings.json'),
    };
}
// ── install / uninstall ───────────────────────────────────────────────────────
/**
 * Execute an InjectionPlan against a runtime config root. Active runtimes:
 *  - claude-code (mcp-hooks): scope 'project' (default) writes/merges <root>/.mcp.json + <root>/.claude/settings.json;
 *    scope 'user' registers the MCP in ~/.claude.json (real user scope) + the SessionStart hook in ~/.claude/settings.json.
 *  - codex (mcp-plugin): writes/merges <root>/.codex/config.toml — [mcp_servers.evolver] + [[hooks.SessionStart]]
 *    (delegated to codexInstaller; TOML, not JSON). Same hybrid value (tool discovery + session-start injection).
 *  - cursor (cursor-rules): renders top genes into <root>/.cursor/rules/evolver.mdc (alwaysApply:true) — gene
 *    memory injection, not MCP tool discovery (delegated to cursorRulesInstaller). The daemon keeps it fresh.
 *  - antigravity (mcp-config): writes mcpServers.evolver to every existing user-level Antigravity config root,
 *    or the canonical root when none exists. MCP tool discovery only; no SessionStart hook is installed.
 * Idempotent + symlink-safe; passive runtimes (kiro/opencode) return ok:false (nothing to inject).
 */
export function installInjection(plan, opts) {
    if (plan.mode === 'passive') {
        return { ok: false, runtime: plan.runtime, mode: plan.mode, files: [], error: `passive runtime ${plan.runtime}: no tool injection` };
    }
    if (plan.runtime === 'codex') {
        return installCodex(plan, opts);
    }
    if (plan.runtime === 'cursor') {
        return installCursorRules({ configRoot: opts.configRoot, genes: opts.genes ?? [], ...(opts.maxGenes !== undefined ? { maxGenes: opts.maxGenes } : {}) });
    }
    if (plan.runtime === 'antigravity') {
        return installAntigravity(plan, opts);
    }
    if (plan.runtime === 'opencode') {
        return installOpenCode(plan, opts);
    }
    if (plan.runtime === 'kiro') {
        return installKiro(plan, opts);
    }
    if (plan.runtime !== 'claude-code') {
        return { ok: false, runtime: plan.runtime, mode: plan.mode, files: [], error: `installer not yet implemented for ${plan.runtime} (supported: claude-code, codex, cursor, antigravity, opencode, kiro)` };
    }
    const hookCommand = opts.hookCommand ?? DEFAULT_HOOK_COMMAND;
    const scope = opts.scope ?? 'project';
    const { mcpConfigPath, mcpIsSharedUserConfig, claudeDir, settingsPath } = claudeCodeTargets(scope, opts.configRoot);
    const mcpLabel = mcpIsSharedUserConfig ? '~/.claude.json' : '.mcp.json';
    const settingsLabel = mcpIsSharedUserConfig ? '~/.claude/settings.json' : '.claude/settings.json';
    // project scope owns configRoot; user scope writes only home-anchored paths, so configRoot is irrelevant there.
    if (scope === 'project')
        assertNotSymlink(opts.configRoot, 'config root');
    assertNotSymlink(mcpConfigPath, mcpLabel);
    assertNotSymlink(claudeDir, mcpIsSharedUserConfig ? '~/.claude' : '.claude');
    assertNotSymlink(settingsPath, settingsLabel);
    // For the SHARED user config (~/.claude.json + ~/.claude/settings.json) read strictly: a present, non-empty,
    // unparseable file aborts the install (UnparseableConfigError) instead of being treated as {} and clobbered by
    // the full-file atomic write below. Project-scoped evolver-owned files keep the lenient readJson fresh-start.
    const readConfig = mcpIsSharedUserConfig
        ? (p, label) => readJsonStrictShared(p, label)
        : (p, _label) => readJson(p);
    if (mcpIsSharedUserConfig) {
        ensureSharedUserClaudeDir(claudeDir);
        hardenSharedUserConfigFile(mcpConfigPath, mcpLabel);
        hardenSharedUserConfigFile(settingsPath, settingsLabel);
    }
    const existingSettings = readConfig(settingsPath, settingsLabel);
    const existingMcp = readConfig(mcpConfigPath, mcpLabel);
    // "Already installed" requires BOTH the SessionStart hook marker AND evolver's MCP registration. Keying off the
    // settings marker alone missed user-scope upgrades: a legacy global install stamped ~/.claude/settings.json but
    // registered the MCP in ~/.mcp.json (never ~/.claude.json), so a non-force reinstall returned alreadyInstalled
    // and left #290 unfixed. The hook and the MCP live in different files for user scope, so check both.
    if (!opts.force && existingSettings[MANAGED_MARKER] === true && hasEvolverMcpRegistration(existingMcp)) {
        return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [], alreadyInstalled: true };
    }
    // MCP server registration. project → <root>/.mcp.json (stamped _evolver_managed). user → ~/.claude.json's
    // top-level mcpServers (Claude Code's real user scope); we do NOT stamp the marker into ~/.claude.json because
    // it's Claude Code's own shared config, so uninstall keys off the mcpServers.evolver entry there instead.
    if (mcpIsSharedUserConfig) {
        writeSharedJsonWithRetry(mcpConfigPath, mcpLabel, (current) => ({
            changed: true,
            data: deepMerge(current, plan.config),
        }));
    }
    else {
        const mcpMerged = deepMerge(existingMcp, plan.config);
        mcpMerged[MANAGED_MARKER] = true;
        writeJsonAtomic(mcpConfigPath, mcpMerged);
    }
    // .claude/settings.json ← SessionStart hook (hooks-union preserves the user's own hooks). For user scope this
    // is ~/.claude/settings.json, which is already Claude Code's user-level hook config.
    if (mcpIsSharedUserConfig)
        ensureSharedUserClaudeDir(claudeDir);
    else
        mkdirSync(claudeDir, { recursive: true });
    if (mcpIsSharedUserConfig) {
        writeSharedJsonWithRetry(settingsPath, settingsLabel, (current) => {
            const settingsMerged = mergeHooksUnion(current, sessionStartHookPatch(hookCommand));
            settingsMerged[MANAGED_MARKER] = true;
            return { changed: true, data: settingsMerged };
        });
    }
    else {
        const settingsMerged = mergeHooksUnion(existingSettings, sessionStartHookPatch(hookCommand));
        settingsMerged[MANAGED_MARKER] = true;
        writeJsonAtomic(settingsPath, settingsMerged);
    }
    return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [mcpConfigPath, settingsPath] };
}
/** Remove evolver's MCP registration + SessionStart hook from a CC config root (leaves user content intact).
 *  Pass the SAME scope used at install: 'user' cleans ~/.claude.json + ~/.claude/settings.json; 'project'
 *  (default) cleans <configRoot>/.mcp.json + <configRoot>/.claude/settings.json. stripManaged only removes
 *  the mcpServers.evolver entry (and any evolver-owned hooks/marker), so it is safe on the shared ~/.claude.json. */
export function uninstallInjection(runtime, opts) {
    if (runtime === 'codex') {
        return uninstallCodex(runtime, opts);
    }
    if (runtime === 'cursor') {
        return uninstallCursorRules(opts);
    }
    if (runtime === 'antigravity') {
        return uninstallAntigravity(runtime, opts);
    }
    if (runtime === 'opencode') {
        return uninstallOpenCode(runtime, opts);
    }
    if (runtime === 'kiro') {
        return uninstallKiro(runtime, opts);
    }
    if (runtime !== 'claude-code') {
        return { ok: false, runtime, mode: 'n/a', files: [], error: `uninstall not implemented for ${runtime}` };
    }
    const scope = opts.scope ?? 'project';
    const { mcpConfigPath, mcpIsSharedUserConfig, settingsPath } = claudeCodeTargets(scope, opts.configRoot);
    const cleaned = [];
    const targets = [
        [mcpConfigPath, mcpIsSharedUserConfig ? '~/.claude.json' : '.mcp.json'],
        [settingsPath, mcpIsSharedUserConfig ? '~/.claude/settings.json' : '.claude/settings.json'],
    ];
    for (const [path, label] of targets) {
        assertNotSymlink(path, label);
        if (!existsSync(path))
            continue;
        if (mcpIsSharedUserConfig) {
            const changed = writeSharedJsonWithRetry(path, label, (current) => stripManaged(current));
            if (changed)
                cleaned.push(path);
        }
        else {
            const { changed, data } = stripManaged(readJson(path));
            if (changed) {
                writeJsonAtomic(path, data);
                cleaned.push(path);
            }
        }
    }
    return { ok: true, runtime, mode: 'uninstall', files: cleaned };
}
/** Convenience: plan + install in one call for a runtime. */
export function setupRuntime(runtime, opts) {
    return installInjection(planInjection(runtime, opts.server), opts);
}