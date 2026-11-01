import { type PluginInstallOptions } from './pluginHosts.js';
import { type PluginRuntime } from './pluginRuntime.js';
/**
 * The dsh CLI runs the pnpm on PATH, while the dsh app uses its bundled pnpm. A profile installed by another
 * pnpm major or into another store makes pnpm fail with ERR_PNPM_UNEXPECTED_STORE.
 */
export declare function assertDshProfileStoreMatches(runtime: PluginRuntime, options: PluginInstallOptions): Promise<void>;