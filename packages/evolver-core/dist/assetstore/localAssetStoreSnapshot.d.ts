import { type AssetRecord } from './provider.js';
import type { ProvenanceRecord } from './provenance.js';
export type CorruptLocalAssetStoreReason = 'invalid_utf8' | 'unterminated' | 'invalid_json' | 'invalid_record';
export declare class CorruptLocalAssetStoreError extends Error {
    readonly reason: CorruptLocalAssetStoreReason;
    readonly file?: string | undefined;
    readonly row?: number | undefined;
    readonly code = "CORRUPT_LOCAL_ASSET_STORE";
    constructor(reason: CorruptLocalAssetStoreReason, file?: string | undefined, row?: number | undefined);
}
export type LocalAssetStoreSnapshotLimitReason = 'file_bytes' | 'total_bytes' | 'records';
export declare class LocalAssetStoreSnapshotLimitError extends Error {
    readonly reason: LocalAssetStoreSnapshotLimitReason;
    readonly file?: string | undefined;
    readonly code = "LOCAL_ASSET_STORE_SNAPSHOT_LIMIT";
    constructor(reason: LocalAssetStoreSnapshotLimitReason, file?: string | undefined);
}
export type LocalAssetStoreSnapshotChangeReason = 'changed' | 'lock_present' | 'invalid_snapshot';
export declare class LocalAssetStoreSnapshotChangedError extends Error {
    readonly reason: LocalAssetStoreSnapshotChangeReason;
    readonly code = "LOCAL_ASSET_STORE_SNAPSHOT_CHANGED";
    constructor(reason: LocalAssetStoreSnapshotChangeReason);
}
export interface ReadLocalAssetStoreSnapshotOptions {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxRecords?: number;
}
export interface ReadLocalAssetStoreSnapshotDeps {
    /** Test seam invoked after every tracked file has been read but before the stable-read verification. */
    beforeVerify?: () => void;
}
export interface LocalAssetStoreSnapshot {
    readonly exists: boolean;
    readonly fingerprint: string;
    readonly assets: ReadonlyMap<string, AssetRecord>;
    readonly provenance: ReadonlyMap<string, ProvenanceRecord>;
    readonly stats: {
        readonly bytes: number;
        readonly assetRows: number;
        readonly provenanceRows: number;
        readonly uniqueAssets: number;
    };
}
/**
 * Read a bounded, strict target-store snapshot without creating the directory, a lock, or any other file.
 * Writers are detected through the lock/root/file fingerprints; callers must revalidate before apply.
 */
export declare function readLocalAssetStoreSnapshot(baseDir: string, options?: ReadLocalAssetStoreSnapshotOptions, deps?: ReadLocalAssetStoreSnapshotDeps): LocalAssetStoreSnapshot;
/** Fail closed when the target store changed between planning and apply. Performs reads only. */
export declare function assertLocalAssetStoreSnapshotCurrent(snapshot: LocalAssetStoreSnapshot): void;