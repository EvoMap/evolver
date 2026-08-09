import type { InjectionPlan, McpServerCmd, RuntimeId } from './injection.js';
import { type InstallOptions, type InstallResult, type UninstallOptions } from './installerShared.js';
type BeforeReplaceHook = (path: string) => void;
export declare function _setJsonMcpBeforeReplaceHookForTest(hook?: BeforeReplaceHook): void;
export declare function _setJsonMcpAfterReplaceHookForTest(hook?: BeforeReplaceHook): void;
export declare function _setJsonMcpAfterSharedFileValidateHookForTest(hook?: BeforeReplaceHook): void;
export declare function _setJsonMcpBeforeBackupRemoveHookForTest(hook?: BeforeReplaceHook): void;
export declare function _setJsonMcpBeforeSharedFileCommitHookForTest(hook?: BeforeReplaceHook): void;
export interface JsonMcpRuntimeSpec {
    runtime: 'opencode' | 'kiro';
    configPath(opts: JsonMcpPathOptions): string;
    resolveConfig?(opts: JsonMcpPathOptions): JsonMcpRuntimeResolution;
    safeRoot?(opts: JsonMcpPathOptions): string;
    conflictingPaths?(opts: JsonMcpPathOptions): string[];
    containerKey: 'mcp' | 'mcpServers';
    entry(server: McpServerCmd): Record<string, unknown>;
    installPreflight?(resolution: JsonMcpRuntimeResolution, opts: InstallOptions, expected: Record<string, unknown>): JsonMcpInstallPreflight | undefined;
}
export interface JsonMcpInstallPreflight {
    alreadyInstalled?: boolean;
    assertUnchanged(): void;
}
type JsonMcpPathOptions = Pick<InstallOptions, 'configRoot' | 'scope' | 'homeDir' | 'kiroHome' | 'xdgConfigHome' | 'opencodeConfig' | 'opencodeConfigDir'>;
export interface JsonMcpRuntimeResolution {
    configPath: string;
    safeRoot: string;
    conflictingPaths: string[];
    /** An active sibling at the same precedence slot that must remain user-owned and read-only. */
    activePrecedencePath?: string;
    /** The writable target was retargeted to a uniquely managed config discovered outside the active path. */
    managedRetarget?: true;
    /** Runtime config candidates ordered from lowest to highest precedence; the first path is the default target. */
    topologyCandidatePaths?: string[];
    evidencePaths?: string[];
    /** Config locations that may contain a managed backup from an earlier active-precedence decision. */
    uninstallCandidatePaths?: string[];
    /** Broader locations used to reuse a managed target selected from an ancestor project directory. */
    installDiscoveryPaths?: string[];
    /** Safe root for install discovery and a selected managed target; does not affect default install writes. */
    installSafeRoot?: string;
    /** Broader read-only locations used only to discover managed backups during uninstall. */
    uninstallDiscoveryPaths?: string[];
    /** Safe root for uninstall discovery and a selected managed target; does not affect install writes. */
    uninstallSafeRoot?: string;
    /** Candidate-local conflicts that must be re-evaluated after uninstall retargeting. */
    uninstallConflictingPaths?: (configPath: string) => string[];
}
export declare class McpConfigConflictError extends Error {
    readonly diff: {
        path: string;
        expected: unknown;
        actual: unknown;
    };
    constructor(runtime: string, path: string, expected: unknown, actual: unknown);
}
export declare class McpConfigShapeError extends Error {
    constructor(runtime: string, path: string, detail: string);
}
export declare class McpConfigOwnershipError extends Error {
    constructor(runtime: string, detail: string);
}
export declare class McpConfigVerificationError extends Error {
    private readonly runtime;
    private readonly path;
    restored: boolean;
    constructor(runtime: string, path: string);
    markRestored(): void;
}
export declare class McpConfigChangedError extends Error {
    constructor(runtime: string, path: string);
}
export declare class McpServerValidationError extends Error {
    constructor(message: string);
}
declare function retrySharedConfigTransaction<T>(operation: () => T): T;
export declare const _retrySharedConfigTransactionForTest: typeof retrySharedConfigTransaction;
export declare function installJsonMcpRuntime(spec: JsonMcpRuntimeSpec, plan: InjectionPlan, opts: InstallOptions): InstallResult;
export declare function uninstallJsonMcpRuntime(spec: JsonMcpRuntimeSpec, runtime: RuntimeId, opts: UninstallOptions): InstallResult;
export {};