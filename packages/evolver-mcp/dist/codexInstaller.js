// Codex injection INSTALLER — the codex analogue of the Claude Code installer in installer.ts.
//
// Codex (the OpenAI CLI) loads its config from a TOML file, NOT JSON. User-level config lives at
// ~/.codex/config.toml; a project-scoped override lives at <project>/.codex/config.toml. We write the
// project-scoped file (same containment posture as the CC adapter, which only ever touches the project root —
// never a user's global home config). Codex supports the SAME injection hybrid CC does:
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
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { SymlinkRefusedError, DEFAULT_HOOK_COMMAND } from './installer.js';
/** The MCP server id evolver registers under [mcp_servers.evolver] / removes on uninstall. */
export const CODEX_MCP_SERVER_ID = 'evolver';
/** A hook entry is evolver-owned if any command mentions this — used to replace-not-duplicate on reinstall. */
const EVOLVER_HOOK_TAG = 'evolver';
/** SessionStart matcher: codex fires `startup` on a fresh thread and `resume` on a resumed one — cover both. */
const SESSION_START_MATCHER = 'startup|resume';
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
function readToml(path) {
    try {
        if (!existsSync(path))
            return {};
        const raw = readFileSync(path, 'utf8').trim();
        return raw ? parseToml(raw) : {};
    }
    catch {
        return {}; // unparseable → start fresh (merge re-adds evolver entries; a broken file isn't silently kept)
    }
}
function writeTomlAtomic(path, data) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${stringifyToml(data)}\n`, 'utf8');
    renameSync(tmp, path);
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
    return { matcher: SESSION_START_MATCHER, hooks: [{ type: 'command', command }] };
}
const hookIsEvolverOwned = (entry) => {
    if (!isObj(entry))
        return false;
    const inner = entry['hooks'];
    if (!Array.isArray(inner))
        return false;
    return inner.some((h) => isObj(h) && typeof h['command'] === 'string' && h['command'].includes(EVOLVER_HOOK_TAG));
};
/**
 * Merge evolver's codex config into the user's existing parsed TOML. Idempotent + non-destructive:
 *  - [mcp_servers] : set our `evolver` server, keep every other server the user registered.
 *  - [[hooks.SessionStart]] : drop any prior evolver-owned entry, keep all user entries, append ours fresh.
 * The user's unrelated tables (model, approval_policy, other hook events, …) pass through untouched.
 */
export function mergeCodexConfig(existing, mcpServer, sessionStartHook) {
    const out = { ...existing };
    const mcpServers = isObj(out['mcp_servers']) ? { ...out['mcp_servers'] } : {};
    mcpServers[CODEX_MCP_SERVER_ID] = mcpServer;
    out['mcp_servers'] = mcpServers;
    const hooks = isObj(out['hooks']) ? { ...out['hooks'] } : {};
    const prior = Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : [];
    hooks['SessionStart'] = [...prior.filter((e) => !hookIsEvolverOwned(e)), sessionStartHook];
    out['hooks'] = hooks;
    return out;
}
/** Strip evolver's MCP server + SessionStart hook from parsed codex TOML (uninstall). Returns [changed, data]. */
export function stripCodexManaged(data) {
    let changed = false;
    const out = { ...data };
    if (isObj(out['mcp_servers']) && CODEX_MCP_SERVER_ID in out['mcp_servers']) {
        const next = { ...out['mcp_servers'] };
        delete next[CODEX_MCP_SERVER_ID];
        changed = true;
        if (Object.keys(next).length > 0)
            out['mcp_servers'] = next;
        else
            delete out['mcp_servers'];
    }
    if (isObj(out['hooks'])) {
        const hooks = { ...out['hooks'] };
        if (Array.isArray(hooks['SessionStart'])) {
            const arr = hooks['SessionStart'];
            const kept = arr.filter((e) => !hookIsEvolverOwned(e));
            if (kept.length !== arr.length)
                changed = true;
            if (kept.length > 0)
                hooks['SessionStart'] = kept;
            else
                delete hooks['SessionStart'];
        }
        if (Object.keys(hooks).length > 0)
            out['hooks'] = hooks;
        else
            delete out['hooks'];
    }
    return { changed, data: out };
}
/** True if evolver's MCP server is already registered in this parsed config (structural install marker). */
function codexAlreadyInstalled(cfg) {
    return isObj(cfg['mcp_servers']) && CODEX_MCP_SERVER_ID in cfg['mcp_servers'];
}
// ── install / uninstall ───────────────────────────────────────────────────────
/**
 * Execute a codex InjectionPlan against a project config root: write/merge <root>/.codex/config.toml with
 * the evolver MCP server registration + a SessionStart hook. Idempotent (re-running without --force is a
 * no-op once evolver is registered) and symlink-safe.
 */
export function installCodex(plan, opts) {
    const hookCommand = opts.hookCommand ?? DEFAULT_HOOK_COMMAND;
    const codexDir = join(opts.configRoot, '.codex');
    const configPath = join(codexDir, 'config.toml');
    assertNotSymlink(opts.configRoot, 'config root');
    assertNotSymlink(codexDir, '.codex');
    assertNotSymlink(configPath, '.codex/config.toml');
    const existing = readToml(configPath);
    if (!opts.force && codexAlreadyInstalled(existing)) {
        return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [], alreadyInstalled: true };
    }
    const mcpServer = codexMcpServerEntry(opts.server);
    const sessionStartHook = codexSessionStartHook(hookCommand);
    const merged = mergeCodexConfig(existing, mcpServer, sessionStartHook);
    mkdirSync(codexDir, { recursive: true });
    writeTomlAtomic(configPath, merged);
    return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [configPath] };
}
/** Remove evolver's MCP registration + SessionStart hook from a codex project config (leaves user content intact). */
export function uninstallCodex(runtime, opts) {
    const configPath = join(opts.configRoot, '.codex', 'config.toml');
    assertNotSymlink(configPath, '.codex/config.toml');
    if (!existsSync(configPath))
        return { ok: true, runtime, mode: 'uninstall', files: [] };
    const { changed, data } = stripCodexManaged(readToml(configPath));
    if (!changed)
        return { ok: true, runtime, mode: 'uninstall', files: [] };
    writeTomlAtomic(configPath, data);
    return { ok: true, runtime, mode: 'uninstall', files: [configPath] };
}