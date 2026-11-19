import { type PluginCommandStep, type PluginHost, type PluginInstallOptions } from './pluginHosts.js';
import { type PluginRuntime } from './pluginRuntime.js';
export declare const ZCODE_LOCAL_PLUGIN = "evolver-plugin@evolver-zcode-local";
/** A ZCode local-folder install of this plugin, which would run the same hooks as the evomap install. */
export interface ZcodeLocalInstall {
    uninstall?: string;
    removeMarketplace?: string;
    keptMarketplace?: string;
}
export interface ZcodeMigrationReport {
    uninstalled?: string;
    removedMarketplace?: string;
}
export declare function zcodeLocalInstall(runtime: PluginRuntime, host: PluginHost, pluginIds: readonly string[], markets: readonly Record<string, unknown>[]): ZcodeLocalInstall | undefined;
export declare const zcodeMigrationPending: (local: ZcodeLocalInstall | undefined) => boolean;
export declare function zcodeMigrationSteps(options: PluginInstallOptions, local: ZcodeLocalInstall): PluginCommandStep[];
export declare const ZCODE_MIGRATION_PREVIEW: ZcodeLocalInstall;
export declare const ZCODE_MIGRATION_PREVIEW_NOTE = "uninstall-local and remove-local-marketplace run only when evolver-plugin@evolver-zcode-local is installed or its marketplace points into Evolver's release cache.";
export declare function zcodeMigrationReport(local: ZcodeLocalInstall | undefined, completed: readonly string[]): {
    migrated?: ZcodeMigrationReport;
};
export declare function zcodeKeptMarketplaceWarning(local: ZcodeLocalInstall | undefined): string[];