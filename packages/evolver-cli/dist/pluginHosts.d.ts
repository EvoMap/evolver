export declare const AGENT_PLUGIN_REPOSITORY = "EvoMap/evolver-agent-plugin";
export declare const AGENT_PLUGIN_GIT_URL = "https://github.com/EvoMap/evolver-agent-plugin.git";
export declare const AGENT_PLUGIN_NAME = "evolver-plugin";
export declare const AGENT_PLUGIN_RELEASE = "release";
export declare const DSH_PLUGIN_SOURCE = "github:EvoMap/evolver-agent-plugin#release&path:dist/dsh";
export declare const ZCODE_LOCAL_MARKETPLACE = "evolver-zcode-local";
export declare function agentPluginRepositoryMatches(value: unknown): boolean;
export type PluginScope = 'user' | 'project';
type PluginHostId = 'claude-code' | 'codex' | 'grok' | 'qoder' | 'antigravity' | 'opencode' | 'dsh' | 'zcode' | 'kimi' | 'stepcode' | 'minimax' | 'cursor' | 'workbuddy' | 'mcp-generic';
export interface PluginHost {
    id: PluginHostId;
    label: string;
    command?: string;
    minimumVersion?: string;
    /** `script` runs the release checkout's own installer for the host. */
    kind: 'marketplace' | 'bundle' | 'script' | 'profile' | 'manual';
    scopes: readonly PluginScope[];
    /** Hosts whose adapter is accepted only on these platforms. */
    platforms?: readonly NodeJS.Platform[];
    management?: 'plugin' | 'plugins';
    marketplace?: string;
    /** What `marketplace add` registers when it is not the plugin repository itself. */
    marketplaceSource?: string;
    manifest?: string;
    packageName?: string;
    /** Files an installed (and packed) plugin must contain besides its manifest. */
    entries: readonly string[];
    /** The release checkout's installer, for `script` hosts. */
    installer?: string;
    /** Where the packed plugin sits inside the checkout path the host's inventory reports. */
    packedSubdir?: string;
    /** The host's installer refuses to install hooks/MCP/skills until the user passes its trust flag. */
    requiresTrust?: boolean;
    legacyNames: readonly string[];
    instructions: readonly string[];
}
export declare const PLUGIN_HOSTS: readonly PluginHost[];
export declare function pluginHostNamed(name: string): PluginHost | undefined;
export interface PluginInstallOptions {
    host: PluginHost;
    scope: PluginScope;
    root: string;
    profile: string;
    dryRun: boolean;
    trust: boolean;
    /** The host CLI's argv prefix: its command, or node plus a CLI script for hosts that ship one. */
    launcher: readonly string[];
}
export interface PluginCommandStep {
    name: string;
    command: string;
    args: readonly string[];
}
export declare function pluginInstallSteps(options: PluginInstallOptions, bundle?: string): PluginCommandStep[];
export declare function pluginRollbackInstructions(options: PluginInstallOptions, bundle?: string): string[];
export interface StandalonePlugin {
    id: string;
    name: string;
    scope?: string;
}
/**
 * The host's own removal command for an old plugin, keeping its data where the host has a flag for that.
 * Inventory values are host data, so a value that is not a plain argument never reaches a suggested command.
 */
export declare function standalonePluginRemoval(options: PluginInstallOptions, plugin: StandalonePlugin): string;
export {};