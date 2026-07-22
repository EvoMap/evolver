import type { InstallOptions } from './installer.js';
import { type JsonMcpRuntimeResolution, type JsonMcpRuntimeSpec } from './jsonMcpInstaller.js';
type KiroPathOptions = Pick<InstallOptions, 'configRoot' | 'scope' | 'homeDir' | 'kiroHome'>;
/** Resolve only Kiro's base mcp.json contract; custom agent JSON is intentionally out of scope. */
export declare function resolveKiroConfig(opts: KiroPathOptions): JsonMcpRuntimeResolution;
export declare const KIRO_SPEC: JsonMcpRuntimeSpec;
export declare function kiroConfigRoot({ configRoot, scope, homeDir, kiroHome }: Pick<InstallOptions, 'configRoot' | 'scope' | 'homeDir' | 'kiroHome'>): string;
export declare const installKiro: (plan: import("./injection.js").InjectionPlan, opts: InstallOptions) => import("./installer.js").InstallResult;
export declare const uninstallKiro: (runtime: import("./injection.js").RuntimeId, opts: import("./installer.js").UninstallOptions) => import("./installer.js").InstallResult;
export {};