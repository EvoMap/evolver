import type { AssetKind } from './provider.js';
export type AssetSyncSource = 'hub';
export type AssetSyncScope = 'purchased' | 'published';
export interface AssetSyncRecord {
    assetId: string;
    type: Extract<AssetKind, 'Gene' | 'Capsule'>;
    source: AssetSyncSource;
    scope: AssetSyncScope;
    syncedAt: string;
    remoteAssetId: string;
    logicalId?: string;
    status?: string;
    forced?: true;
    collisionWithAssetId?: string;
}
export declare class AssetSyncLedger {
    private readonly now;
    private readonly path;
    private readonly lockPath;
    private readonly index;
    private fileState;
    private loaded;
    constructor(baseDir: string, now?: () => number);
    append(rec: Omit<AssetSyncRecord, 'syncedAt'> & {
        syncedAt?: string;
    }): AssetSyncRecord;
    get(assetId: string): AssetSyncRecord | null;
    list(): AssetSyncRecord[];
    private rebuildIndex;
    private refreshUnderLock;
    private withFreshRead;
}