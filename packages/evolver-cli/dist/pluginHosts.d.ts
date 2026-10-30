export declare const AGENT_PLUGIN_REPOSITORY = "EvoMap/evolver-agent-plugin";
export declare const AGENT_PLUGIN_GIT_URL = "https://github.com/EvoMap/evolver-agent-plugin.git";
export declare const AGENT_PLUGIN_NAME = "evolver-plugin";
export declare const AGENT_PLUGIN_RELEASE = "release";
export type PluginScope = 'user' | 'project';
type PluginHostId = 'claude-code' | 'codex' | 'grok' | 'qoder' | 'antigravity' | 'opencode' | 'dsh' | 'cursor' | 'workbuddy' | 'mcp-generic';
export interface PluginHost {
    id: PluginHostId;
    label: string;
    command?: string;
    minimumVersion?: string;
    kind: 'marketplace' | 'bundle' | 'profile' | 'manual';
    scopes: readonly PluginScope[];
    management?: 'plugin' | 'plugins';
    marketplace?: string;
    manifest?: string;
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
}
export interface PluginCommandStep {
    name: string;
    command: string;
    args: readonly string[];
}
export declare function pluginInstallSteps(options: PluginInstallOptions, bundle?: string): PluginCommandStep[];
export declare function pluginRollbackInstructions(options: PluginInstallOptions, bundle?: string): string[];
export {};