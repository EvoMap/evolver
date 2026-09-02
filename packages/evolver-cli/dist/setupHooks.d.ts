import { type InstallScope } from '@evomap/evolver-mcp';
import { assetstore } from '@evomap/evolver-core';
import { maybeEmitNonGitWorkspaceNotice } from './nonGitWorkspaceNotice.js';
interface SetupHooksDeps {
    emitNonGitWorkspaceNotice?: typeof maybeEmitNonGitWorkspaceNotice;
    runtimeAvailable?: (runtime: 'opencode' | 'kiro', configRoot: string, scope: InstallScope) => boolean;
    /** Test seam proving service-only/manual paths do not resolve an unrelated MCP Node executable. */
    resolveMcpNodePath?: () => string;
}
export declare function commandNamesForPath(command: string, platform: NodeJS.Platform, pathExt: string | undefined): string[];
/** Paths under package-manager stores are volatile: the linked Node disappears on the next install/upgrade,
 *  so a persisted command pointing there breaks the generated MCP config. Exported for tests so the assertion
 *  regex cannot drift from the resolver's. */
export declare const VOLATILE_PACKAGE_MANAGER_NODE_PATH: RegExp;
export declare function resolveStableMcpNodePath(options?: {
    execPath?: string;
    platform?: NodeJS.Platform;
    /** Test-only fixed system candidates. Production callers must not derive these from environment input. */
    systemCandidates?: readonly string[];
}): string;
export declare function safeSetupOperationError(error: unknown): string;
export declare function safeSetupResultError(error: unknown): string;
export declare function runSetupHooks(argv: readonly string[], store?: assetstore.AssetStoreProvider, review?: assetstore.ReviewLedger, deps?: SetupHooksDeps): Promise<number>;
export {};