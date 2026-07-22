import { type InstallScope } from '@evomap/evolver-mcp';
import { assetstore } from '@evomap/evolver-core';
import { maybeEmitNonGitWorkspaceNotice } from './nonGitWorkspaceNotice.js';
interface SetupHooksDeps {
    emitNonGitWorkspaceNotice?: typeof maybeEmitNonGitWorkspaceNotice;
    runtimeAvailable?: (runtime: 'opencode' | 'kiro', configRoot: string, scope: InstallScope) => boolean;
}
export declare function commandNamesForPath(command: string, platform: NodeJS.Platform, pathExt: string | undefined): string[];
export declare function safeSetupOperationError(error: unknown): string;
export declare function safeSetupResultError(error: unknown): string;
export declare function runSetupHooks(argv: readonly string[], store?: assetstore.AssetStoreProvider, review?: assetstore.ReviewLedger, deps?: SetupHooksDeps): Promise<number>;
export {};