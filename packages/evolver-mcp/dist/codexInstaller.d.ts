import type { RuntimeId, InjectionPlan } from './injection.js';
import { type InstallResult, type InstallOptions } from './installerShared.js';
/** The MCP server id evolver registers under [mcp_servers.evolver] / removes on uninstall. */
export declare const CODEX_MCP_SERVER_ID = "evolver";
export declare const CODEX_PROJECT_REGISTRATION_PRESENT_WARNING = "codex_project_registration_present: the requested project still contains an Evolver registration; if this came from the legacy user/global scope bug, remove it explicitly with --runtime=codex --scope=project --uninstall --root=<project>";
export declare const CODEX_PROJECT_REGISTRATION_UNREADABLE_WARNING = "codex_project_registration_unreadable: the requested project config could not be inspected safely; no project file was modified";
type CodexConfigRaceHook = (path: string, attempt: number) => void;
export declare function _setCodexConfigRaceHookForTest(hook?: CodexConfigRaceHook): void;
/** The [mcp_servers.evolver] table from a plan's launch command. env omitted when empty (no `[..env]` table). */
export declare function codexMcpServerEntry(server: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}): Record<string, unknown>;
/** A single [[hooks.SessionStart]] entry that runs `command` at session start. Shape matches codex's hooks schema. */
export declare function codexSessionStartHook(command: string): Record<string, unknown>;
/** UserPromptSubmit has no matcher in current Codex; five seconds keeps the prompt path fail-open and bounded. */
export declare function codexUserPromptSubmitHook(command: string): Record<string, unknown>;
/**
 * Merge evolver's codex config into the user's existing parsed TOML. Idempotent + non-destructive:
 *  - [mcp_servers] : set our `evolver` server, keep every other server the user registered.
 *  - [[hooks.SessionStart]] : drop any prior evolver-owned entry, keep all user entries, append ours fresh.
 * The user's unrelated tables (model, approval_policy, other hook events, …) pass through untouched.
 */
export declare function mergeCodexConfig(existing: Record<string, unknown>, mcpServer: Record<string, unknown>, sessionStartHook: Record<string, unknown>, userPromptSubmitHook?: Record<string, unknown>): Record<string, unknown>;
/** Strip evolver's MCP server + SessionStart hook from parsed codex TOML (uninstall). Returns [changed, data]. */
export declare function stripCodexManaged(data: Record<string, unknown>): {
    changed: boolean;
    data: Record<string, unknown>;
};
/**
 * Execute a codex InjectionPlan against the requested scope: project writes <root>/.codex/config.toml, while
 * user writes $CODEX_HOME/config.toml or ~/.codex/config.toml. Both carry the MCP registration and Codex-native
 * lifecycle hooks. Idempotent (re-running without --force is a no-op) and symlink-safe.
 */
export declare function installCodex(plan: InjectionPlan, opts: InstallOptions): InstallResult;
/** Remove Evolver's MCP registration and hooks from the requested Codex scope, leaving user content intact. */
export declare function uninstallCodex(runtime: RuntimeId, opts: Pick<InstallOptions, 'configRoot' | 'scope' | 'homeDir' | 'codexHome'>): InstallResult;
export {};