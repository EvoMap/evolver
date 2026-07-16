import { assetstore } from '@evomap/evolver-core';
import { maybeEmitNonGitWorkspaceNotice } from './nonGitWorkspaceNotice.js';
interface SetupHooksDeps {
    emitNonGitWorkspaceNotice?: typeof maybeEmitNonGitWorkspaceNotice;
}
export declare function runSetupHooks(argv: readonly string[], store?: assetstore.AssetStoreProvider, review?: assetstore.ReviewLedger, deps?: SetupHooksDeps): Promise<number>;
export {};