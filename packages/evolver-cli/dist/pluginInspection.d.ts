import { type PluginInstallOptions, type PluginHost } from './pluginHosts.js';
import { type ZcodeLocalInstall } from './pluginZcodeMigration.js';
import { type PluginRuntime } from './pluginRuntime.js';
export interface InstalledAgentPlugin {
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    scope?: string;
    path?: string;
    raw: Record<string, unknown>;
}
/** A host registration snapshot; only verifyPluginManifest confirms a usable installed artifact. */
export interface PluginInspection {
    installed?: InstalledAgentPlugin;
    marketplacePresent: boolean;
    conflicts: string[];
    /** Native commands the user can run to remove a conflicting standalone plugin; never run automatically. */
    migrations: string[];
    zcodeLocal?: ZcodeLocalInstall;
}
export declare function installedPluginsFromJson(value: unknown, host: PluginHost): InstalledAgentPlugin[];
export declare function verifyPluginManifest(runtime: PluginRuntime, options: PluginInstallOptions, plugin: InstalledAgentPlugin, installAnswer?: unknown): string;
export declare function inspectOpenCodePlugin(runtime: PluginRuntime, options: PluginInstallOptions): PluginInspection;
/** `bundle` is the release checkout's dist folder, which a `script` host's own status command needs. */
export declare function inspectAgentPlugin(runtime: PluginRuntime, options: PluginInstallOptions, bundle?: string): Promise<PluginInspection>;