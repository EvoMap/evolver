import { type RuntimeId, type McpServerCmd, type InjectionPlan } from './injection.js';
import { type CursorGene } from './cursorRulesInstaller.js';
import type { InstallerTransactionSummary } from './installerTransaction.js';
import { type InstallComponents } from './installerShared.js';
export { EmptySharedConfigError, SymlinkRefusedError, UnparseableConfigError, resolveInstallComponents, type InstallComponents, } from './installerShared.js';
/** Marks a config file as containing evolver-managed entries, so uninstall only removes what we added. */
export declare const MANAGED_MARKER = "_evolver_managed";
/** Official command-handler metadata, also gives custom commands an ownership marker for reinstall/uninstall. */
export declare const EVOLVER_HOOK_STATUS = "Loading Evolver memory";
/** Default command the SessionStart hook runs to render + print the memory injection. The `--hook-stdin` flag opts
 *  the entrypoint into reading the runtime's SessionStart JSON from stdin (to capture session_id, #205); only the
 *  installed hook sets it, so a manual `evolver inject session-start` never reads stdin. */
export declare const DEFAULT_HOOK_COMMAND = "evolver inject session-start --hook-stdin";
/** Local-only prompt recall. The handler is default-off and reads stdin only when EVOLVER_RECALL_MODE opts in. */
export declare const DEFAULT_PROMPT_RECALL_HOOK_COMMAND = "evolver inject prompt-recall --hook-stdin";
/**
 * Where a claude-code install registers the evolver MCP server. This is the fix for "global install doesn't
 * actually globalize" (#290): Claude Code's MCP scopes are local / user / project, and a `.mcp.json` is the
 * PROJECT-scoped file — it only loads when that directory is the launch cwd. So writing `~/.mcp.json` does NOT
 * make evolver available from other projects. The real user (device-wide) scope is the top-level `mcpServers`
 * in `~/.claude.json`.
 *  - 'project' (default): register in <configRoot>/.mcp.json (cwd-scoped) — unchanged legacy behavior.
 *  - 'user': register in ~/.claude.json's top-level mcpServers so EVERY project's sessions discover evolver.
 * The SessionStart hook always lands in the matching .claude/settings.json (project: <configRoot>/.claude;
 * user: ~/.claude — which is already user-level). Codex resolves its own project/user targets; cursor ignores it.
 */
export type InstallScope = 'user' | 'project';
export interface InstallOptions {
    components?: InstallComponents;
    /** Runtime config root — the CC adapter writes <configRoot>/.mcp.json and <configRoot>/.claude/settings.json
     *  for PROJECT scope. For USER scope the MCP registration goes to ~/.claude.json instead (see `scope`). */
    configRoot: string;
    /** Runtime configuration scope. Codex project scope writes <configRoot>/.codex/config.toml, while user scope
     *  writes $CODEX_HOME/config.toml or ~/.codex/config.toml. */
    scope?: InstallScope;
    /** The MCP server launch command registered in .mcp.json (how the runtime starts the evolver MCP server). */
    server: McpServerCmd;
    /** claude-code/codex only: store-stable absolute Node executable for the managed evox-product bridge entry's
     *  shim, resolved by the install chain so a package-manager-local process.execPath is never persisted (#1068).
     *  Omitted by callers without a resolved path; the bridge then falls back to the current process executable. */
    productBridgeNodePath?: string;
    /** Command the SessionStart hook runs to inject memory. Default 'evolver inject session-start'. */
    hookCommand?: string;
    /** Command the UserPromptSubmit hook runs. Default is local-only, default-off prompt recall. */
    promptRecallHookCommand?: string;
    /** Reinstall even if an evolver install is already present. */
    force?: boolean;
    /** Plan and validate without writing config or backup files. */
    dryRun?: boolean;
    /** Exact config target. Omitted selects all adapter targets in a recoverable transaction. */
    targetPath?: string;
    /** Cursor only: the top genes to render into .cursor/rules/evolver.mdc. The daemon refreshes these on change;
     *  a one-shot `setup-hooks --runtime=cursor` install seeds the file (empty ⇒ a placeholder the daemon fills). */
    genes?: readonly CursorGene[];
    /** Cursor only: cap on genes rendered into the always-on rules body (token-tax bound). */
    maxGenes?: number;
    /** Antigravity only: override the user home used to resolve ~/.gemini config roots. Intended for hermetic
     *  embedding/tests; normal callers omit it. configRoot and scope do not affect Antigravity's user config. */
    homeDir?: string;
    /** Codex user scope only: direct replacement for ~/.codex, matching CODEX_HOME semantics. */
    codexHome?: string;
    /** Kiro user scope only: direct replacement for ~/.kiro, matching KIRO_HOME semantics. */
    kiroHome?: string;
    /** OpenCode user scope only: explicit XDG_CONFIG_HOME used to resolve the global config. */
    xdgConfigHome?: string;
    /** OpenCode user scope only: explicit OPENCODE_CONFIG file override. */
    opencodeConfig?: string;
    /** OpenCode user scope only: explicit OPENCODE_CONFIG_DIR override. */
    opencodeConfigDir?: string;
    /** OpenCode only: inline config loaded after project/custom-directory config. */
    opencodeConfigContent?: string;
    /** OpenCode only: mirrors truthy OPENCODE_DISABLE_PROJECT_CONFIG handling. */
    opencodeDisableProjectConfig?: boolean;
    /** OpenCode only: injectable managed-config directory for hermetic tests. */
    opencodeManagedConfigDir?: string;
    /** OpenCode only: injectable macOS managed-preference paths for hermetic tests. */
    opencodeManagedPreferencePaths?: readonly string[];
    /** OpenCode only: injectable platform used to resolve system managed paths. */
    opencodePlatform?: NodeJS.Platform;
    /** OpenCode only: injectable ProgramData used to resolve the Windows managed path. */
    opencodeProgramData?: string;
    /** OpenCode only: injectable username used to resolve macOS managed preferences. */
    opencodeUsername?: string;
}
export interface UninstallOptions {
    components?: InstallComponents;
    configRoot: string;
    scope?: InstallScope;
    /** Antigravity only: override the user home used to resolve ~/.gemini config roots. */
    homeDir?: string;
    /** Codex user scope only: direct replacement for ~/.codex, matching CODEX_HOME semantics. */
    codexHome?: string;
    /** Kiro user scope only: direct replacement for ~/.kiro, matching KIRO_HOME semantics. */
    kiroHome?: string;
    /** Validate and report the uninstall without changing config or backup files. */
    dryRun?: boolean;
    /** Exact config target. Omitted selects all adapter targets in a recoverable transaction. */
    targetPath?: string;
    /** OpenCode user scope only: explicit XDG_CONFIG_HOME used to resolve the global config. */
    xdgConfigHome?: string;
    /** OpenCode user scope only: explicit OPENCODE_CONFIG file override. */
    opencodeConfig?: string;
    /** OpenCode user scope only: explicit OPENCODE_CONFIG_DIR override. */
    opencodeConfigDir?: string;
}
export interface InstallResult {
    ok: boolean;
    runtime: RuntimeId;
    mode: string;
    /** Absolute paths written (install) or cleaned (uninstall). */
    files: string[];
    alreadyInstalled?: boolean;
    dryRun?: boolean;
    verified?: boolean;
    backups?: string[];
    warnings?: string[];
    error?: string;
    transaction?: InstallerTransactionSummary;
}
type SharedConfigRaceHook = (path: string, attempt: number) => void;
export declare function _setSharedConfigRaceHookForTest(hook?: SharedConfigRaceHook): void;
export declare function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown>;
/** Bind custom-command ownership to that exact command without adding undocumented hook-schema fields. */
export declare function evolverManagedHookStatus(command: string): string;
/** Remove only Evolver-owned handlers, retaining user handlers that share the same matcher group. */
export declare function stripEvolverHookEntries(entries: readonly unknown[], trustManagedStatus?: boolean, managedCommands?: ReadonlySet<string>): {
    changed: boolean;
    entries: unknown[];
};
/**
 * deepMerge, but for `hooks.<event>` arrays keep the user's existing entries and only replace evolver-owned
 * ones — so reinstalling refreshes evolver's hook without clobbering a user's own SessionStart/Stop hooks.
 */
export declare function mergeHooksUnion(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown>;
/** Strip evolver-owned hook entries + the marker from a parsed config (uninstall). Returns [changed, data]. */
export declare function stripManaged(data: Record<string, unknown>, components?: InstallComponents): {
    changed: boolean;
    data: Record<string, unknown>;
};
interface ClaudeTargets {
    /** File the evolver MCP server registration (mcpServers.evolver) is written to. */
    mcpConfigPath: string;
    /** True when mcpConfigPath is Claude Code's own shared ~/.claude.json (user scope) — we must NOT stamp the
     *  _evolver_managed marker into it (it's not ours to mark); uninstall keys off the mcpServers.evolver entry. */
    mcpIsSharedUserConfig: boolean;
    claudeDir: string;
    settingsPath: string;
}
/**
 * Resolve the claude-code config targets for a scope. USER scope anchors at the home dir and is self-contained
 * (it does NOT depend on configRoot): the MCP goes to ~/.claude.json's top-level mcpServers — Claude Code's real
 * user scope — NOT ~/.mcp.json (a `.mcp.json` only loads when its dir is the launch cwd, so `~/.mcp.json` would
 * silently do nothing outside $HOME). The SessionStart hook lands in ~/.claude/settings.json (already user-level).
 * PROJECT scope keeps the legacy paths under configRoot.
 */
export declare function claudeCodeTargets(scope: InstallScope, configRoot: string, homeDir?: string): ClaudeTargets;
/**
 * Execute an InjectionPlan against a runtime config root. Active runtimes:
 *  - claude-code (mcp-hooks): scope 'project' (default) writes/merges <root>/.mcp.json + <root>/.claude/settings.json;
 *    scope 'user' registers the MCP in ~/.claude.json (real user scope) + the SessionStart hook in ~/.claude/settings.json.
 *  - codex (mcp-plugin): project scope writes <root>/.codex/config.toml; user scope writes
 *    $CODEX_HOME/config.toml or ~/.codex/config.toml. Both use Codex-native MCP and lifecycle-hook tables.
 *  - cursor (cursor-rules): renders top genes into <root>/.cursor/rules/evolver.mdc (alwaysApply:true) — gene
 *    memory injection, not MCP tool discovery (delegated to cursorRulesInstaller). The daemon keeps it fresh.
 *  - antigravity (mcp-config): writes mcpServers.evolver to every existing user-level Antigravity config root,
 *    or the canonical root when none exists. MCP tool discovery only; no SessionStart hook is installed.
 * Idempotent + symlink-safe; passive runtimes (kiro/opencode) return ok:false (nothing to inject).
 */
export declare function installInjection(plan: InjectionPlan, opts: InstallOptions): InstallResult;
/** Remove evolver's MCP registration + SessionStart hook from a CC config root (leaves user content intact).
 *  Pass the SAME scope used at install: 'user' cleans ~/.claude.json + ~/.claude/settings.json; 'project'
 *  (default) cleans <configRoot>/.mcp.json + <configRoot>/.claude/settings.json. stripManaged only removes
 *  the mcpServers.evolver entry (and any evolver-owned hooks/marker), so it is safe on the shared ~/.claude.json. */
export declare function uninstallInjection(runtime: RuntimeId, opts: UninstallOptions): InstallResult;
/** Convenience: plan + install in one call for a runtime. */
export declare function setupRuntime(runtime: RuntimeId, opts: InstallOptions): InstallResult;