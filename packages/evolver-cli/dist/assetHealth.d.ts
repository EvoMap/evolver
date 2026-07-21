import { assetstore } from '@evomap/evolver-core';
import { type AssetSidecarRecoveryCommandDeps } from './assetSidecarRecovery.js';
export interface AssetHealthDeps extends AssetSidecarRecoveryCommandDeps {
    inspect?: (assetsDir: string) => assetstore.AssetStoreHealthReport;
}
export declare function runAssetHealthCommand(argv: readonly string[], deps?: AssetHealthDeps): Promise<number>;