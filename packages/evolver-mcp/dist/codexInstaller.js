// Codex injection INSTALLER — the codex analogue of the Claude Code installer in installer.ts.
//
// Codex (the OpenAI CLI) loads its config from a TOML file, NOT JSON. User-level config lives at
// ~/.codex/config.toml; a project-scoped override lives at <project>/.codex/config.toml. We write the
// project-scoped file for project scope and the real user config for user scope. User scope honors CODEX_HOME,
// falling back to ~/.codex/config.toml. Codex supports the SAME injection hybrid CC does:
//   1. an MCP stdio server, registered under [mcp_servers.<name>]  → codex discovers evolver's tools, and
//   2. a SessionStart lifecycle hook, registered under [[hooks.SessionStart]] → memory is pushed at session
//      start (MCP alone can't push; the agent must pull — identical to the CC rationale).
// So a codex user gets the same value a CC user gets: tool discovery + session-start memory injection.
//
// Format sources (codex official docs, verified 2026-06):
//   - [mcp_servers.<id>] { command, args=[...], [mcp_servers.<id>.env] {K=V} }  (developers.openai.com/codex/mcp)
//   - [[hooks.SessionStart]] { matcher } + [[hooks.SessionStart.hooks]] { type="command", command, ... }
//     (developers.openai.com/codex/hooks) — only type:"command" handlers run today.
//
// Hardened exactly like the CC installer: atomic writes (tmp+rename), refusal to follow a symlink at any
// adapter-owned path, marker-managed so reinstall/uninstall only touch evolver's own entries, and a
// hooks-UNION merge that preserves the user's existing hooks. TOML round-trips through smol-toml (spec
// parser/serializer) so a user's hand-written config is preserved rather than clobbered.
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { util } from '@evomap/evolver-core';
import { commitSharedFile, SharedFileConflictError } from './sharedFileCommit.js';
import { SymlinkRefusedError, DEFAULT_HOOK_COMMAND, DEFAULT_PROMPT_RECALL_HOOK_COMMAND, evolverManagedHookStatus, stripEvolverHookEntries, } from './installerShared.js';
import { withCodexProductBridge, isOwnedProductBridge, restoreProductBridgeEntry, PRODUCT_BRIDGE_SERVER_ID } from './productBridge.js';
/** The MCP server id evolver registers under [mcp_servers.evolver] / removes on uninstall. */
export const CODEX_MCP_SERVER_ID = 'evolver';
export const CODEX_PROJECT_REGISTRATION_PRESENT_WARNING = 'codex_project_registration_present: the requested project still contains an Evolver registration; if this came from the legacy user/global scope bug, remove it explicitly with --runtime=codex --scope=project --uninstall --root=<project>';
export const CODEX_PROJECT_REGISTRATION_UNREADABLE_WARNING = 'codex_project_registration_unreadable: the requested project config could not be inspected safely; no project file was modified';
/** SessionStart matcher: codex fires `startup` on a fresh thread and `resume` on a resumed one — cover both. */
const SESSION_START_MATCHER = 'startup|resume';
const CONFIG_WRITE_RETRIES = 5;
const CODEX_CONFIG_MODE = 0o600;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// ── fs hardening (mirrors installer.ts) ──────────────────────────────────────
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
function readTomlSnapshot(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { data: {}, raw: null, mode: CODEX_CONFIG_MODE };
        throw error;
    }
    if (!raw.trim()) {
        throw new Error(`[setup-hooks] refusing to overwrite .codex/config.toml (${path}): the existing file is empty.`);
    }
    try {
        return { data: parseToml(raw), raw, mode: (statSync(path).mode & 0o777) & 0o700 };
    }
    catch (error) {
        throw new Error(`[setup-hooks] refusing to overwrite .codex/config.toml (${path}): the existing file is not valid TOML.`, { cause: error });
    }
}
function readRawIfExists(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
let codexConfigRaceHookForTest;
export function _setCodexConfigRaceHookForTest(hook) {
    codexConfigRaceHookForTest = hook;
}
function writeTomlWithRetry(path, update, assertSafe) {
    const lockPath = `${path}.evolver.lock`;
    assertSafe();
    util.acquireLock(lockPath);
    let operationResult = false;
    let operationFailed = false;
    let operationError;
    try {
        operationResult = (() => {
            for (let attempt = 1; attempt <= CONFIG_WRITE_RETRIES; attempt += 1) {
                assertSafe();
                const snapshot = readTomlSnapshot(path);
                const next = update(snapshot.data);
                if (!next.changed)
                    return false;
                codexConfigRaceHookForTest?.(path, attempt);
                assertSafe();
                if (readRawIfExists(path) !== snapshot.raw)
                    continue;
                assertSafe();
                try {
                    commitSharedFile({
                        path,
                        expectedRaw: snapshot.raw ?? undefined,
                        nextRaw: next.remove ? undefined : `${stringifyToml(next.data)}\n`,
                        mode: snapshot.mode,
                    });
                    return true;
                }
                catch (error) {
                    if (error instanceof SharedFileConflictError)
                        continue;
                    throw error;
                }
            }
            throw new Error(`[setup-hooks] refusing to overwrite .codex/config.toml (${path}): the file changed repeatedly while evolver was merging it.`);
        })();
    }
    catch (error) {
        operationFailed = true;
        operationError = error;
    }
    let releaseError;
    try {
        const released = util.releaseLock(lockPath);
        if (!released.released)
            releaseError = new util.LockReleaseError(released.reason);
    }
    catch (error) {
        releaseError = error;
    }
    if (operationFailed) {
        if (operationError instanceof Error && releaseError !== undefined) {
            operationError.lockReleaseError = releaseError;
        }
        throw operationError;
    }
    if (releaseError !== undefined)
        throw releaseError;
    return operationResult;
}
function codexConfigTarget(opts) {
    if ((opts.scope ?? 'project') === 'project') {
        const codexDir = join(opts.configRoot, '.codex');
        return {
            scope: 'project',
            configRoot: opts.configRoot,
            codexDir,
            configPath: join(codexDir, 'config.toml'),
            dirLabel: '.codex',
            configLabel: '.codex/config.toml',
        };
    }
    const configured = opts.codexHome?.trim();
    if (configured && !isAbsolute(configured)) {
        throw new Error('[setup-hooks] refusing to use CODEX_HOME: the path must be absolute.');
    }
    const codexDir = configured ? resolve(configured) : join(opts.homeDir ?? homedir(), '.codex');
    return {
        scope: 'user',
        codexDir,
        configPath: join(codexDir, 'config.toml'),
        dirLabel: configured ? '$CODEX_HOME' : '~/.codex',
        configLabel: configured ? '$CODEX_HOME/config.toml' : '~/.codex/config.toml',
    };
}
function codexPathGuard(target) {
    return () => {
        if (target.configRoot)
            assertNotSymlink(target.configRoot, 'config root');
        assertNotSymlink(target.codexDir, target.dirLabel);
        assertNotSymlink(target.configPath, target.configLabel);
        assertNotSymlink(`${target.configPath}.evolver.lock`, `${target.configLabel} lock`);
    };
}
function userScopeProjectWarnings(configRoot) {
    try {
        const projectTarget = codexConfigTarget({ configRoot, scope: 'project' });
        codexPathGuard(projectTarget)();
        if (!existsSync(projectTarget.configPath))
            return [];
        const config = readTomlSnapshot(projectTarget.configPath).data;
        return isObj(config['mcp_servers']) && CODEX_MCP_SERVER_ID in config['mcp_servers']
            ? [CODEX_PROJECT_REGISTRATION_PRESENT_WARNING]
            : [];
    }
    catch {
        return [CODEX_PROJECT_REGISTRATION_UNREADABLE_WARNING];
    }
}
// ── pure merge (exported for tests) ──────────────────────────────────────────
/** The [mcp_servers.evolver] table from a plan's launch command. env omitted when empty (no `[..env]` table). */
export function codexMcpServerEntry(server) {
    return {
        command: server.command,
        args: server.args ?? [],
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
}
/** A single [[hooks.SessionStart]] entry that runs `command` at session start. Shape matches codex's hooks schema. */
export function codexSessionStartHook(command) {
    return { matcher: SESSION_START_MATCHER, hooks: [{
                type: 'command', command, statusMessage: evolverManagedHookStatus(command),
            }] };
}
/** UserPromptSubmit has no matcher in current Codex; five seconds keeps the prompt path fail-open and bounded. */
export function codexUserPromptSubmitHook(command) {
    return { hooks: [{
                type: 'command', command, timeout: 5, statusMessage: evolverManagedHookStatus(command),
            }] };
}
function hookHasExactCommand(entry, command) {
    if (!isObj(entry) || !Array.isArray(entry['hooks']))
        return false;
    return entry['hooks'].some((handler) => isObj(handler) && handler['command'] === command);
}
function hookCommands(entries) {
    const commands = new Set();
    for (const entry of entries) {
        if (!isObj(entry) || !Array.isArray(entry['hooks']))
            continue;
        for (const handler of entry['hooks']) {
            if (isObj(handler) && typeof handler['command'] === 'string')
                commands.add(handler['command']);
        }
    }
    return commands;
}
/**
 * Merge evolver's codex config into the user's existing parsed TOML. Idempotent + non-destructive:
 *  - [mcp_servers] : set our `evolver` server, keep every other server the user registered.
 *  - [[hooks.SessionStart]] : drop any prior evolver-owned entry, keep all user entries, append ours fresh.
 * The user's unrelated tables (model, approval_policy, other hook events, …) pass through untouched.
 */
export function mergeCodexConfig(existing, mcpServer, sessionStartHook, userPromptSubmitHook) {
    const out = { ...existing };
    const mcpServers = isObj(out['mcp_servers']) ? { ...out['mcp_servers'] } : {};
    const trustManagedStatus = CODEX_MCP_SERVER_ID in mcpServers;
    const managedCommands = hookCommands(userPromptSubmitHook ? [sessionStartHook, userPromptSubmitHook] : [sessionStartHook]);
    mcpServers[CODEX_MCP_SERVER_ID] = mcpServer;
    out['mcp_servers'] = mcpServers;
    const hooks = isObj(out['hooks']) ? { ...out['hooks'] } : {};
    for (const event of Object.keys(hooks)) {
        const value = hooks[event];
        if (!Array.isArray(value))
            continue;
        const kept = stripEvolverHookEntries(value, trustManagedStatus, managedCommands).entries;
        if (kept.length > 0)
            hooks[event] = kept;
        else
            delete hooks[event];
    }
    const prior = Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : [];
    hooks['SessionStart'] = [...prior, sessionStartHook];
    if (userPromptSubmitHook) {
        const priorPrompt = Array.isArray(hooks['UserPromptSubmit']) ? hooks['UserPromptSubmit'] : [];
        hooks['UserPromptSubmit'] = [
            ...priorPrompt,
            userPromptSubmitHook,
        ];
    }
    out['hooks'] = hooks;
    return out;
}
/** Strip evolver's MCP server + SessionStart hook from parsed codex TOML (uninstall). Returns [changed, data]. */
export function stripCodexManaged(data) {
    let changed = false;
    const out = { ...data };
    const trustManagedStatus = isObj(out['mcp_servers'])
        && CODEX_MCP_SERVER_ID in out['mcp_servers'];
    if (isObj(out['mcp_servers'])) {
        const next = { ...out['mcp_servers'] };
        if (CODEX_MCP_SERVER_ID in next) {
            delete next[CODEX_MCP_SERVER_ID];
            changed = true;
        }
        if (PRODUCT_BRIDGE_SERVER_ID in next && isOwnedProductBridge(next[PRODUCT_BRIDGE_SERVER_ID])) {
            const restored = restoreProductBridgeEntry(next[PRODUCT_BRIDGE_SERVER_ID]);
            if (restored.restored)
                next[PRODUCT_BRIDGE_SERVER_ID] = restored.entry;
            else
                delete next[PRODUCT_BRIDGE_SERVER_ID];
            changed = true;
        }
        if (Object.keys(next).length > 0)
            out['mcp_servers'] = next;
        else
            delete out['mcp_servers'];
    }
    if (isObj(out['hooks'])) {
        const hooks = { ...out['hooks'] };
        for (const event of Object.keys(hooks)) {
            const value = hooks[event];
            if (!Array.isArray(value))
                continue;
            const stripped = stripEvolverHookEntries(value, trustManagedStatus);
            const kept = stripped.entries;
            if (stripped.changed)
                changed = true;
            if (kept.length > 0)
                hooks[event] = kept;
            else
                delete hooks[event];
        }
        if (Object.keys(hooks).length > 0)
            out['hooks'] = hooks;
        else
            delete out['hooks'];
    }
    return { changed, data: out };
}
/** True if evolver's MCP server is already registered in this parsed config (structural install marker). */
function codexAlreadyInstalled(cfg, sessionStartCommand, promptRecallCommand) {
    if (!isObj(cfg['mcp_servers']) || !(CODEX_MCP_SERVER_ID in cfg['mcp_servers']))
        return false;
    const hooks = cfg['hooks'];
    if (!isObj(hooks))
        return false;
    const sessionStart = Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : [];
    const promptSubmit = Array.isArray(hooks['UserPromptSubmit']) ? hooks['UserPromptSubmit'] : [];
    return sessionStart.some((entry) => hookHasExactCommand(entry, sessionStartCommand))
        && promptSubmit.some((entry) => hookHasExactCommand(entry, promptRecallCommand));
}
// ── install / uninstall ───────────────────────────────────────────────────────
/**
 * Execute a codex InjectionPlan against the requested scope: project writes <root>/.codex/config.toml, while
 * user writes $CODEX_HOME/config.toml or ~/.codex/config.toml. Both carry the MCP registration and Codex-native
 * lifecycle hooks. Idempotent (re-running without --force is a no-op) and symlink-safe.
 */
export function installCodex(plan, opts) {
    const hookCommand = opts.hookCommand ?? DEFAULT_HOOK_COMMAND;
    const promptRecallHookCommand = opts.promptRecallHookCommand ?? DEFAULT_PROMPT_RECALL_HOOK_COMMAND;
    const target = codexConfigTarget(opts);
    const warnings = target.scope === 'user' ? userScopeProjectWarnings(opts.configRoot) : [];
    const { codexDir, configPath } = target;
    const assertSafe = codexPathGuard(target);
    assertSafe();
    const mcpServer = codexMcpServerEntry(opts.server);
    const sessionStartHook = codexSessionStartHook(hookCommand);
    const userPromptSubmitHook = codexUserPromptSubmitHook(promptRecallHookCommand);
    mkdirSync(codexDir, { recursive: true, mode: 0o700 });
    const changed = writeTomlWithRetry(configPath, (current) => {
        if (!opts.force && codexAlreadyInstalled(current, hookCommand, promptRecallHookCommand)) {
            return withCodexProductBridge(current, false, opts.productBridgeNodePath);
        }
        return {
            changed: true,
            data: withCodexProductBridge(mergeCodexConfig(current, mcpServer, sessionStartHook, userPromptSubmitHook), opts.force === true, opts.productBridgeNodePath).data,
        };
    }, assertSafe);
    return {
        ok: true,
        runtime: plan.runtime,
        mode: plan.mode,
        files: changed ? [configPath] : [],
        ...(!changed ? { alreadyInstalled: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
/** Remove Evolver's MCP registration and hooks from the requested Codex scope, leaving user content intact. */
export function uninstallCodex(runtime, opts) {
    const target = codexConfigTarget(opts);
    const { configPath } = target;
    const assertSafe = codexPathGuard(target);
    assertSafe();
    if (!existsSync(configPath))
        return { ok: true, runtime, mode: 'uninstall', files: [] };
    const changed = writeTomlWithRetry(configPath, (current) => {
        const stripped = stripCodexManaged(current);
        return {
            ...stripped,
            remove: stripped.changed && Object.keys(stripped.data).length === 0,
        };
    }, assertSafe);
    return { ok: true, runtime, mode: 'uninstall', files: changed ? [configPath] : [] };
}