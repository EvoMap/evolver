import type { InstallOptions } from './installer.js';
import { type JsonMcpRuntimeResolution, type JsonMcpRuntimeSpec } from './jsonMcpInstaller.js';
type OpenCodePathOptions = Pick<InstallOptions, 'configRoot' | 'scope' | 'homeDir' | 'xdgConfigHome' | 'opencodeConfig' | 'opencodeConfigDir'>;
type OpenCodeManagedPathOptions = Pick<InstallOptions, 'opencodePlatform' | 'opencodeProgramData' | 'opencodeUsername'>;
export declare function resolveOpenCodeManagedConfigDir(opts?: OpenCodeManagedPathOptions): string;
export declare function resolveOpenCodeManagedPreferencePaths(opts?: OpenCodeManagedPathOptions): string[];
/** Resolve the OpenCode file that is active at the requested scope.
 * OpenCode layers project files from the worktree root down to the current directory, or from the filesystem root
 * outside Git, then .opencode directories in reverse order. JSONC follows JSON at every location. Global,
 * explicit, home, and managed layers retain their surrounding precedence. A JSONC path is writable only when its
 * contents are strict JSON;
 * comment/trailing-comma syntax is rejected by the shared strict parser so setup never rewrites it lossy.
 */
export declare function resolveOpenCodeConfig(opts: OpenCodePathOptions): JsonMcpRuntimeResolution;
export declare const OPENCODE_SPEC: JsonMcpRuntimeSpec;
export declare const installOpenCode: (plan: import("./injection.js").InjectionPlan, opts: InstallOptions) => import("./installer.js").InstallResult;
export declare const uninstallOpenCode: (runtime: import("./injection.js").RuntimeId, opts: import("./installer.js").UninstallOptions) => import("./installer.js").InstallResult;
export {};