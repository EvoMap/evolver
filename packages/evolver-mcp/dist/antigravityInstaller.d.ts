import type { InjectionPlan, McpServerCmd, RuntimeId } from './injection.js';
import { type InstallOptions, type InstallResult, type UninstallOptions } from './installerShared.js';
export declare const ANTIGRAVITY_NAMESPACES: readonly ["antigravity", "antigravity-ide"];
export interface AntigravityConfigTarget {
    namespace: (typeof ANTIGRAVITY_NAMESPACES)[number];
    root: string;
    configPath: string;
}
export declare class AntigravityConfigShapeError extends Error {
    constructor(path: string, detail: string);
}
export declare class AntigravityPathTypeError extends Error {
    constructor(label: string, path: string);
}
export declare class AntigravitySecretRefusedError extends Error {
    constructor(detail: string);
}
/**
 * Resolve Antigravity's user-level config targets. Every existing runtime root is targeted. If neither namespace
 * exists, installation falls back to the canonical ~/.gemini/antigravity root. This function never creates paths.
 */
export declare function resolveAntigravityConfigTargets(homeDir?: string): AntigravityConfigTarget[];
export declare function antigravityMcpServerEntry(server: McpServerCmd): Record<string, unknown>;
export declare function mergeAntigravityConfig(current: Record<string, unknown>, serverEntry: Record<string, unknown>): Record<string, unknown>;
export declare function stripAntigravityManaged(current: Record<string, unknown>): {
    changed: boolean;
    data: Record<string, unknown>;
};
/** Install MCP tool discovery only. Antigravity has no verified SessionStart hook contract. */
export declare function installAntigravity(plan: InjectionPlan, opts: InstallOptions): InstallResult;
/** Remove only mcpServers.evolver. The shared config file and all unrelated user content always remain. */
export declare function uninstallAntigravity(runtime: RuntimeId, opts: UninstallOptions): InstallResult;