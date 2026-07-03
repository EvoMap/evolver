import type { RuntimeId, InjectionPlan } from './injection.js';
import { type InstallResult, type InstallOptions } from './installer.js';
/** The MCP server id evolver registers under [mcp_servers.evolver] / removes on uninstall. */
export declare const CODEX_MCP_SERVER_ID = "evolver";
/** The [mcp_servers.evolver] table from a plan's launch command. env omitted when empty (no `[..env]` table). */
export declare function codexMcpServerEntry(server: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}): Record<string, unknown>;
/** A single [[hooks.SessionStart]] entry that runs `command` at session start. Shape matches codex's hooks schema. */
export declare function codexSessionStartHook(command: string): Record<string, unknown>;
/**
 * Merge evolver's codex config into the user's existing parsed TOML. Idempotent + non-destructive:
 *  - [mcp_servers] : set our `evolver` server, keep every other server the user registered.
 *  - [[hooks.SessionStart]] : drop any prior evolver-owned entry, keep all user entries, append ours fresh.
 * The user's unrelated tables (model, approval_policy, other hook events, …) pass through untouched.
 */
export declare function mergeCodexConfig(existing: Record<string, unknown>, mcpServer: Record<string, unknown>, sessionStartHook: Record<string, unknown>): Record<string, unknown>;
/** Strip evolver's MCP server + SessionStart hook from parsed codex TOML (uninstall). Returns [changed, data]. */
export declare function stripCodexManaged(data: Record<string, unknown>): {
    changed: boolean;
    data: Record<string, unknown>;
};
/**
 * Execute a codex InjectionPlan against a project config root: write/merge <root>/.codex/config.toml with
 * the evolver MCP server registration + a SessionStart hook. Idempotent (re-running without --force is a
 * no-op once evolver is registered) and symlink-safe.
 */
export declare function installCodex(plan: InjectionPlan, opts: InstallOptions): InstallResult;
/** Remove evolver's MCP registration + SessionStart hook from a codex project config (leaves user content intact). */
export declare function uninstallCodex(runtime: RuntimeId, opts: {
    configRoot: string;
}): InstallResult;