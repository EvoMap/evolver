import type { PluginHost } from './pluginHosts.js';
import { type PluginRuntime } from './pluginRuntime.js';
/** The argv prefix that runs the host's own CLI, or undefined when it is not present on this machine. ZCode's CLI is
 * a Node script, never a `zcode` executable on PATH. */
export declare function hostLauncher(runtime: PluginRuntime, host: PluginHost): string[] | undefined;
/** What a preview shows when the host CLI is absent: the command a real install would run. */
export declare function expectedHostLauncher(runtime: PluginRuntime, host: PluginHost): string[];