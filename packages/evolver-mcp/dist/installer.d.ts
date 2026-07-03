import { type RuntimeId, type McpServerCmd, type InjectionPlan } from './injection.js';
import { type CursorGene } from './cursorRulesInstaller.js';
/** Marks a config file as containing evolver-managed entries, so uninstall only removes what we added. */
export declare const MANAGED_MARKER = "_evolver_managed";
/** Default command the SessionStart hook runs to render + print the memory injection. The `--hook-stdin` flag opts
 *  the entrypoint into reading the runtime's SessionStart JSON from stdin (to capture session_id, #205); only the
 *  installed hook sets it, so a manual `evolver inject session-start` never reads stdin. */
export declare const DEFAULT_HOOK_COMMAND = "evolver inject session-start --hook-stdin";
/**
 * Where a claude-code install registers the evolver MCP server. This is the fix for "global install doesn't
 * actually globalize" (#290): Claude Code's MCP scopes are local / user / project, and a `.mcp.json` is the
 * PROJECT-scoped file — it only loads when that directory is the launch cwd. So writing `~/.mcp.json` does NOT
 * make evolver available from other projects. The real user (device-wide) scope is the top-level `mcpServers`
 * in `~/.claude.json`.
 *  - 'project' (default): register in <configRoot>/.mcp.json (cwd-scoped) — unchanged legacy behavior.
 *  - 'user': register in ~/.claude.json's top-level mcpServers so EVERY project's sessions discover evolver.
 * The SessionStart hook always lands in the matching .claude/settings.json (project: <configRoot>/.claude;
 * user: ~/.claude — which is already user-level). codex/cursor ignore this (codex's ~/.codex/config.toml is a
 * genuine global config, so its global path stays configRoot-driven).
 */
export type InstallScope = 'user' | 'project';
export interface InstallOptions {
    /** Runtime config root — the CC adapter writes <configRoot>/.mcp.json and <configRoot>/.claude/settings.json
     *  for PROJECT scope. For USER scope the MCP registration goes to ~/.claude.json instead (see `scope`). */
    configRoot: string;
    /** claude-code only: 'project' (default) writes <configRoot>/.mcp.json; 'user' registers the MCP in
     *  ~/.claude.json so it loads in every project (Claude Code's real user scope). Ignored by codex/cursor. */
    scope?: InstallScope;
    /** The MCP server launch command registered in .mcp.json (how the runtime starts the evolver MCP server). */
    server: McpServerCmd;
    /** Command the SessionStart hook runs to inject memory. Default 'evolver inject session-start'. */
    hookCommand?: string;
    /** Reinstall even if an evolver install is already present. */
    force?: boolean;
    /** Cursor only: the top genes to render into .cursor/rules/evolver.mdc. The daemon refreshes these on change;
     *  a one-shot `setup-hooks --runtime=cursor` install seeds the file (empty ⇒ a placeholder the daemon fills). */
    genes?: readonly CursorGene[];
    /** Cursor only: cap on genes rendered into the always-on rules body (token-tax bound). */
    maxGenes?: number;
}
export interface InstallResult {
    ok: boolean;
    runtime: RuntimeId;
    mode: string;
    /** Absolute paths written (install) or cleaned (uninstall). */
    files: string[];
    alreadyInstalled?: boolean;
    error?: string;
}
export declare class SymlinkRefusedError extends Error {
    constructor(label: string, path: string);
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
export declare class UnparseableConfigError extends Error {
    constructor(label: string, path: string);
}
/**
 * Thrown when a SHARED user config exists but is empty or whitespace-only. Claude Code writes these files with a
 * truncating write, so present-empty can be a concurrent-write window rather than a fresh config.
 */
export declare class EmptySharedConfigError extends Error {
    constructor(label: string, path: string);
}
type SharedConfigRaceHook = (path: string, attempt: number) => void;
export declare function _setSharedConfigRaceHookForTest(hook?: SharedConfigRaceHook): void;
export declare function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown>;
/**
 * deepMerge, but for `hooks.<event>` arrays keep the user's existing entries and only replace evolver-owned
 * ones — so reinstalling refreshes evolver's hook without clobbering a user's own SessionStart/Stop hooks.
 */
export declare function mergeHooksUnion(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown>;
/** Strip evolver-owned hook entries + the marker from a parsed config (uninstall). Returns [changed, data]. */
export declare function stripManaged(data: Record<string, unknown>): {
    changed: boolean;
    data: Record<string, unknown>;
};
/**
 * Execute an InjectionPlan against a runtime config root. Active runtimes:
 *  - claude-code (mcp-hooks): scope 'project' (default) writes/merges <root>/.mcp.json + <root>/.claude/settings.json;
 *    scope 'user' registers the MCP in ~/.claude.json (real user scope) + the SessionStart hook in ~/.claude/settings.json.
 *  - codex (mcp-plugin): writes/merges <root>/.codex/config.toml — [mcp_servers.evolver] + [[hooks.SessionStart]]
 *    (delegated to codexInstaller; TOML, not JSON). Same hybrid value (tool discovery + session-start injection).
 *  - cursor (cursor-rules): renders top genes into <root>/.cursor/rules/evolver.mdc (alwaysApply:true) — gene
 *    memory injection, not MCP tool discovery (delegated to cursorRulesInstaller). The daemon keeps it fresh.
 * Idempotent + symlink-safe; passive runtimes (kiro/opencode) return ok:false (nothing to inject).
 */
export declare function installInjection(plan: InjectionPlan, opts: InstallOptions): InstallResult;
/** Remove evolver's MCP registration + SessionStart hook from a CC config root (leaves user content intact).
 *  Pass the SAME scope used at install: 'user' cleans ~/.claude.json + ~/.claude/settings.json; 'project'
 *  (default) cleans <configRoot>/.mcp.json + <configRoot>/.claude/settings.json. stripManaged only removes
 *  the mcpServers.evolver entry (and any evolver-owned hooks/marker), so it is safe on the shared ~/.claude.json. */
export declare function uninstallInjection(runtime: RuntimeId, opts: {
    configRoot: string;
    scope?: InstallScope;
}): InstallResult;
/** Convenience: plan + install in one call for a runtime. */
export declare function setupRuntime(runtime: RuntimeId, opts: InstallOptions): InstallResult;
export {};