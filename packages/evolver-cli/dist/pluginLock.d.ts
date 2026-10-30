import type { PluginInstallOptions } from './pluginHosts.js';
import { type PluginRuntime } from './pluginRuntime.js';
export declare function withOwnedPluginLock<T>(path: string, work: () => Promise<T>): Promise<T>;
export declare function withPluginInstallLock<T>(runtime: PluginRuntime, options: PluginInstallOptions, work: () => Promise<T>): Promise<T>;