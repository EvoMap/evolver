import { type PluginHost } from './pluginHosts.js';
import { type PluginRuntime } from './pluginRuntime.js';
export declare function validatePackedBundle(bundle: string, host: PluginHost): void;
export declare function ensureAgentPluginBundle(runtime: PluginRuntime, host: PluginHost): Promise<string>;