import { assetstore, events } from '@evomap/evolver-core';
export declare const ASSET_SIDECAR_RECOVERY_USAGE: string;
type RecoveryEventWriter = Pick<events.Ingestor, 'ingest'>;
export interface AssetSidecarRecoveryCommandDeps {
    env?: Record<string, string | undefined>;
    assetsDir?: string;
    resolveAssetsDir?: () => string;
    recover?: typeof assetstore.recoverAssetSidecar;
    ingestor?: RecoveryEventWriter;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
export declare function runAssetSidecarRecoveryCommand(argv: readonly string[], deps?: AssetSidecarRecoveryCommandDeps): Promise<number>;
export {};