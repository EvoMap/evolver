import { type PluginCommandStep, type PluginInstallOptions } from './pluginHosts.js';
import { type PluginInstallStatus, type PluginRuntime } from './pluginRuntime.js';
import { type ZcodeMigrationReport } from './pluginZcodeMigration.js';
export interface AgentPluginInstallResult {
    ok: boolean;
    status: PluginInstallStatus;
    host: string;
    scope: string;
    verified: boolean;
    requiresTrust: boolean;
    repository: string;
    commands: PluginCommandStep[];
    completed: string[];
    instructions: string[];
    rollback: string[];
    version?: string;
    installedPath?: string;
    error?: string;
    profile?: string;
    migrated?: ZcodeMigrationReport;
    warnings?: string[];
}
export declare function installAgentPlugin(runtime: PluginRuntime, options: PluginInstallOptions): Promise<AgentPluginInstallResult>;