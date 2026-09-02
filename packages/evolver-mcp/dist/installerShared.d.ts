import type { McpServerCmd, RuntimeId } from './injection.js';
/** Minimal gene projection consumed by the Cursor rules renderer. */
export interface CursorGene {
    id: string;
    category?: string;
    hint?: string;
}
/** Default command used by runtimes that support a SessionStart hook. The flag enables session-id capture. */
export declare const DEFAULT_HOOK_COMMAND = "evolver inject session-start --hook-stdin";
export declare const DEFAULT_PROMPT_RECALL_HOOK_COMMAND = "evolver inject prompt-recall --hook-stdin";
export declare const EVOLVER_HOOK_STATUS = "evolver-managed-hook";
/** Bind custom-command ownership to that exact command without adding undocumented hook-schema fields. */
export declare function evolverManagedHookStatus(command: string): string;
/** Remove only Evolver-owned handlers, retaining user handlers that share the same matcher group. */
export declare function stripEvolverHookEntries(entries: readonly unknown[], trustManagedStatus?: boolean, managedCommands?: ReadonlySet<string>): {
    changed: boolean;
    entries: unknown[];
};
/** Runtime configuration scope. Project is the default when omitted. */
export type InstallScope = 'user' | 'project';
export interface InstallOptions {
    /** Runtime config root. Runtime-specific user scopes may resolve their own home-anchored paths. */
    configRoot: string;
    /** Claude Code scope. Other runtimes may also use this to select project or user configuration. */
    scope?: InstallScope;
    /** The MCP server launch command registered in the runtime configuration. */
    server: McpServerCmd;
    /** claude-code/codex only: store-stable absolute Node executable for the managed evox-product bridge entry's
     *  shim, resolved by the install chain so a package-manager-local process.execPath is never persisted (#1068).
     *  Omitted by callers without a resolved path; the bridge then falls back to the current process executable. */
    productBridgeNodePath?: string;
    /** Command the SessionStart hook runs to inject memory. */
    hookCommand?: string;
    /** Command the UserPromptSubmit hook runs. Default is local-only, default-off prompt recall. */
    promptRecallHookCommand?: string;
    /** Reinstall even if an Evolver install is already present. */
    force?: boolean;
    /** Plan and validate without writing config or backup files. */
    dryRun?: boolean;
    /** Cursor only: genes rendered into the managed project rules file. */
    genes?: readonly CursorGene[];
    /** Cursor only: cap on genes rendered into the always-on rules body. */
    maxGenes?: number;
    /** Antigravity only: override the user home used to resolve ~/.gemini config roots. */
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
}
export declare class SymlinkRefusedError extends Error {
    constructor(label: string, path: string);
}
export declare class UnparseableConfigError extends Error {
    constructor(label: string, path: string, owner?: string);
}
export declare class EmptySharedConfigError extends Error {
    constructor(label: string, path: string, owner?: string);
}
/** Refuse to read or write through a symlink at an adapter-owned path. */
export declare function assertNotSymlink(path: string, label: string): void;