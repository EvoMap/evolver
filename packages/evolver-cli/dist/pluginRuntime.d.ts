import { exec } from '@evomap/evolver-core';
import type { PluginHost } from './pluginHosts.js';
export type PluginProcessResult = Awaited<ReturnType<typeof exec.spawnCapture>>;
export type PluginInstallStatus = 'installed' | 'already_installed' | 'dry_run' | 'manual_required' | 'host_missing' | 'unsupported_version' | 'unsupported_capability' | 'conflict' | 'failed' | 'invalid_arguments' | 'selection_required' | 'trust_required' | 'profile_store_mismatch';
export declare class PluginInstallError extends Error {
    readonly status: PluginInstallStatus;
    readonly instructions: readonly string[];
    constructor(status: PluginInstallStatus, message: string, instructions?: readonly string[]);
}
export interface PluginRuntime {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    cwd: string;
    available(command: string): boolean;
    run(command: string, args: readonly string[], cwd?: string, timeoutMs?: number): Promise<PluginProcessResult>;
}
export declare function pluginHome(runtime: PluginRuntime): string;
export declare function pluginExecutableAvailable(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean;
export declare function resolvePluginSpawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, standalone?: boolean): {
    cmd: string;
    args: string[];
};
export declare function createPluginRuntime(overrides?: Partial<PluginRuntime>): PluginRuntime;
export declare function checkedPluginCommand(runtime: PluginRuntime, command: string, args: readonly string[], cwd?: string, timeoutMs?: number): Promise<PluginProcessResult>;
export declare function pluginJson(text: string, label: string): unknown;
export declare function objectOf(value: unknown): Record<string, unknown> | undefined;
export declare function readPluginText(path: string, maxBytes?: number): string | undefined;
export declare function readPluginJson(path: string): Record<string, unknown> | undefined;
export declare function pluginVersionAtLeast(current: string, minimum: string): boolean;
export declare function checkPluginHostVersion(runtime: PluginRuntime, host: PluginHost): Promise<void>;
/** Only installer-owned descendants are written; a symlink may not redirect the cache or lock. */
export declare function assertPluginManagedPath(path: string): void;