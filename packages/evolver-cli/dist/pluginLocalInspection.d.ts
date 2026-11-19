import { type PluginInstallOptions } from './pluginHosts.js';
import type { PluginInspection } from './pluginInspection.js';
import { type PluginRuntime } from './pluginRuntime.js';
/** Kimi and MiniMax are installed by the release checkout's own installer, whose `status` is the registration record. */
export declare function inspectScriptPlugin(runtime: PluginRuntime, options: PluginInstallOptions, bundle: string): Promise<PluginInspection>;
/** Step Code lists installed extension packages in its agent settings; local sources are folder paths. */
export declare function inspectStepCodePlugin(runtime: PluginRuntime, options: PluginInstallOptions): PluginInspection;