import { type PluginCommandStep, type PluginInstallOptions } from './pluginHosts.js';
import { type PluginInstallStatus, type PluginRuntime } from './pluginRuntime.js';
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
}
export declare function installAgentPlugin(runtime: PluginRuntime, options: PluginInstallOptions): Promise<AgentPluginInstallResult>;