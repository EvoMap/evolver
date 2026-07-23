import { assetstore, hub as hubNs } from '@evomap/evolver-core';
import { type AccountAssetListOptions, type AccountAssetListResult, type ConnectPublicOptions, type PublicHubCapability } from '@evomap/evolver-adapter-public';
type WritableLine = (line: string) => void;
export interface SyncAccountAssetLister {
    listAccountAssets(opts: AccountAssetListOptions): Promise<AccountAssetListResult>;
}
export interface SyncAccountAssetHub extends SyncAccountAssetLister {
    fetchAssetById(assetId: string): Promise<assetstore.AssetRecord | null>;
}
export interface SyncCliDeps {
    hub?: SyncAccountAssetLister | SyncAccountAssetHub;
    store?: assetstore.AssetStoreProvider;
    assetsDir?: string;
    provenance?: assetstore.ProvenanceStore;
    syncLedger?: assetstore.AssetSyncLedger;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    stdout?: WritableLine;
    stderr?: WritableLine;
    connectHub?: (opts: ConnectPublicOptions) => {
        hub: PublicHubCapability;
        auth: hubNs.AuthProvider;
    };
    connectPrivateHub?: (env: NodeJS.ProcessEnv) => Promise<SyncAccountAssetHub>;
    /** Opaque identity supplied by an injected Hub adapter; it is hashed again before any checkpoint write. */
    resumeIdentityFingerprint?: string;
}
export declare function runSyncCommand(argv: readonly string[], deps?: SyncCliDeps): Promise<number>;
export declare function preparePrivateSyncHub(runtime: {
    hub: unknown;
    hello(opts: {
        rotate: boolean;
        evolverVersion?: string;
    }): Promise<{
        ok: boolean;
    }>;
}): Promise<SyncAccountAssetHub>;
export {};