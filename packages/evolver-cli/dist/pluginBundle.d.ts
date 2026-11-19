import { type PluginHost } from './pluginHosts.js';
import { type PluginRuntime } from './pluginRuntime.js';
export declare function validatePackedBundle(bundle: string, host: PluginHost): void;
/** A host-registered folder is trusted only as a valid packed bundle inside a release checkout this installer owns. */
export declare function isManagedPackedBundle(runtime: PluginRuntime, host: PluginHost, folder: string): boolean;
export declare function ensureAgentPluginBundle(runtime: PluginRuntime, host: PluginHost): Promise<string>;