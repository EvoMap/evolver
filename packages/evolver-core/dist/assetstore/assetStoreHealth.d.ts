import { acquireLock, releaseLock } from '../util/fileLock.js';
import { type UnsafeAssetStorePathReason } from './assetStoreStorage.js';
import type { AssetKind } from './provider.js';
import { type AssetSidecarKind } from './assetSidecarRecords.js';
export type AssetStoreHealthStatus = 'healthy' | 'degraded' | 'unsafe' | 'unavailable';
export type AssetStoreFileStatus = 'missing' | 'ok' | 'degraded' | 'unsafe' | 'unavailable';
export interface AssetStoreFileHealth {
    kind: AssetKind;
    file: string;
    status: AssetStoreFileStatus;
    bytes: number;
    rows: number;
    validRows: number;
    uniqueAssets: number;
    duplicateRows: number;
    corruptRows: number;
    hashMismatchRows: number;
    schemaInvalidRows: number;
    unterminated: boolean;
    reason?: UnsafeAssetStorePathReason | 'base_directory' | 'lock_unavailable' | 'read_unavailable' | 'scan_limit_exceeded';
}
export interface AssetStoreHealthTotals {
    files: number;
    missingFiles: number;
    unsafeFiles: number;
    unavailableFiles: number;
    bytes: number;
    rows: number;
    validRows: number;
    uniqueAssets: number;
    duplicateRows: number;
    corruptRows: number;
    hashMismatchRows: number;
    schemaInvalidRows: number;
    unterminatedFiles: number;
}
export interface AssetStoreSidecarHealth {
    kind: AssetSidecarKind;
    file: string;
    status: AssetStoreFileStatus;
    bytes: number;
    rows: number;
    validRows: number;
    corruptRows: number;
    unterminated: boolean;
    reason?: AssetStoreFileHealth['reason'];
}
export interface AssetStoreSidecarHealthTotals {
    files: number;
    missingFiles: number;
    unsafeFiles: number;
    unavailableFiles: number;
    bytes: number;
    rows: number;
    validRows: number;
    corruptRows: number;
    unterminatedFiles: number;
}
export interface AssetStoreHealthReport {
    ok: boolean;
    status: AssetStoreHealthStatus;
    totals: AssetStoreHealthTotals;
    files: AssetStoreFileHealth[];
    sidecarTotals: AssetStoreSidecarHealthTotals;
    sidecars: AssetStoreSidecarHealth[];
}
export interface InspectLocalAssetStoreOptions {
    maxFileBytes?: number;
}
export interface InspectLocalAssetStoreDeps {
    acquireLock?: typeof acquireLock;
    releaseLock?: typeof releaseLock;
}
export declare const DEFAULT_ASSET_HEALTH_MAX_FILE_BYTES: number;
export declare function inspectLocalAssetStore(baseDir: string, opts?: InspectLocalAssetStoreOptions, deps?: InspectLocalAssetStoreDeps): AssetStoreHealthReport;