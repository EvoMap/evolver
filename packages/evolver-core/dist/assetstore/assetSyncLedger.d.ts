import type { AssetKind } from './provider.js';
export declare const ASSET_SYNC_INVENTORY_MAX_SEGMENTS = 24;
export declare const ASSET_SYNC_INVENTORY_MAX_ITEMS_PER_SEGMENT = 10000;
export declare const ASSET_SYNC_INVENTORY_MAX_UNIQUE_ITEMS = 240000;
export declare const ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES: number;
export type AssetSyncSource = 'hub';
export type AssetSyncScope = 'purchased' | 'published';
export interface AssetSyncRecord {
    assetId: string;
    type: Extract<AssetKind, 'Gene' | 'Capsule'>;
    source: AssetSyncSource;
    scope: AssetSyncScope;
    syncedAt: string;
    remoteAssetId: string;
    /** Opaque sync identity hash. Legacy records omit it and are not used for identity-scoped reconciliation. */
    runKey?: string;
    /** Parameter-independent remote inventory identity used for reconciliation across sync runs. */
    inventoryKey?: string;
    logicalId?: string;
    status?: string;
    forced?: true;
    collisionWithAssetId?: string;
}
export type AssetSyncRunState = 'started' | 'progress' | 'completed';
export type AssetSyncRunOutcome = 'imported' | 'already_local' | 'failed' | 'remote_missing';
export interface AssetSyncRunRecord {
    recordType: 'run';
    runId: string;
    runKey: string;
    state: AssetSyncRunState;
    remoteAssetId?: string;
    outcome?: AssetSyncRunOutcome;
    reason?: string;
    /** Ordered candidate IDs selected when this run was started. */
    plan?: readonly string[];
    syncedAt: string;
}
export interface AssetSyncRunSnapshot extends AssetSyncRunRecord {
    readonly processed: ReadonlyMap<string, AssetSyncRunRecord>;
}
export type AssetSyncInventoryOutcome = 'imported' | 'already_local' | 'blocked' | 'failed' | 'pending';
export interface AssetSyncInventoryCursorFingerprints {
    readonly purchased: string | null;
    readonly published: string | null;
}
export interface AssetSyncInventoryItem {
    readonly remoteAssetId: string;
    readonly outcome: AssetSyncInventoryOutcome;
}
export interface AssetSyncInventorySegmentRecord {
    readonly recordType: 'inventory_scan';
    readonly scanId: string;
    readonly inventoryKey: string;
    readonly scope: 'purchased' | 'published' | 'all';
    readonly index: number;
    readonly inputCursorFingerprints: AssetSyncInventoryCursorFingerprints;
    readonly nextCursorFingerprints: AssetSyncInventoryCursorFingerprints;
    readonly items: readonly AssetSyncInventoryItem[];
    readonly anonymousBlocked: number;
    /** This segment must be replayed from its input cursor before the scan may advance. */
    readonly cursorHeld?: true;
    /** Multi-segment batches are applied only after every physical segment is present. */
    readonly batchId?: string;
    readonly batchIndex?: number;
    readonly batchSize?: number;
    readonly syncedAt: string;
}
export type AssetSyncInventoryBatch = Omit<AssetSyncInventorySegmentRecord, 'recordType' | 'syncedAt' | 'batchId' | 'batchIndex' | 'batchSize'> & {
    syncedAt?: string;
};
export interface AssetSyncInventorySnapshot {
    readonly scanId: string;
    readonly inventoryKey: string;
    readonly scope: 'purchased' | 'published' | 'all';
    readonly segmentCount: number;
    readonly nextCursorFingerprints: AssetSyncInventoryCursorFingerprints;
    readonly outcomes: ReadonlyMap<string, AssetSyncInventoryOutcome>;
    readonly anonymousBlocked: number;
    readonly complete: boolean;
    /** Physical segment index whose input cursor must be replayed before this scan can advance. */
    readonly retryIndex?: number;
}
export declare class AssetSyncLedger {
    private readonly now;
    private readonly path;
    private readonly lockPath;
    private readonly index;
    private readonly runKeyIndex;
    private readonly inventoryKeyIndex;
    private fileState;
    private loaded;
    constructor(baseDir: string, now?: () => number);
    append(rec: Omit<AssetSyncRecord, 'syncedAt'> & {
        syncedAt?: string;
    }): AssetSyncRecord;
    appendRun(rec: Omit<AssetSyncRunRecord, 'recordType' | 'syncedAt'> & {
        syncedAt?: string;
    }): AssetSyncRunRecord;
    appendInventorySegment(rec: Omit<AssetSyncInventorySegmentRecord, 'recordType' | 'syncedAt'> & {
        syncedAt?: string;
    }): AssetSyncInventorySegmentRecord | null;
    appendInventoryBatch(rec: AssetSyncInventoryBatch): readonly AssetSyncInventorySegmentRecord[] | null;
    replaceInventoryRetryBatch(rec: AssetSyncInventoryBatch): readonly AssetSyncInventorySegmentRecord[] | null;
    clearInventoryScan(inventoryKey: string): void;
    runRecords(runId: string): AssetSyncRunRecord[];
    latestIncompleteRun(runKey: string): AssetSyncRunSnapshot | undefined;
    latestInventoryScan(inventoryKey: string): AssetSyncInventorySnapshot | undefined;
    get(assetId: string): AssetSyncRecord | null;
    getForRunKey(runKey: string, assetId: string): AssetSyncRecord | null;
    list(): AssetSyncRecord[];
    listForRunKey(runKey: string): AssetSyncRecord[];
    listForInventoryKey(inventoryKey: string): AssetSyncRecord[];
    private rebuildIndex;
    private refreshUnderLock;
    private withFreshRead;
    private readRunRecordsUnderLock;
    private latestInventorySnapshotUnderLock;
}