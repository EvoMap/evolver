import { assetstore, events } from '@evomap/evolver-core';
type TrustEventWriter = Pick<events.Ingestor, 'ingest'>;
export interface AssetTrustDeps {
    env?: Record<string, string | undefined>;
    store?: assetstore.AssetStoreProvider;
    provenance?: assetstore.ProvenanceStore;
    ingestor?: TrustEventWriter;
    assetsDir?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
export interface AssetTrustView {
    assetId: string;
    type: assetstore.AssetKind;
    logicalId?: string;
    source: assetstore.ProvenanceSource | 'local_default';
    trusted: boolean;
    at?: string;
    decision?: assetstore.ProvenanceDecision;
    decidedBy?: string;
    reason?: string;
}
export declare function runAssetTrustCommand(argv: readonly string[], deps?: AssetTrustDeps): Promise<number>;
export {};