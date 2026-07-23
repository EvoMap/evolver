import type { AssetSyncInventorySegmentRecord, AssetSyncRecord, AssetSyncRunRecord } from './assetSyncLedger.js';
import type { ProvenanceRecord } from './provenance.js';
import type { ReviewRecord } from './reviewLedger.js';
export type AssetSidecarKind = 'provenance' | 'review' | 'asset-sync';
export type AssetSidecarCorruptionReason = 'invalid_row' | 'unterminated';
export interface ParsedSidecarJsonl<T> {
    records: T[];
    rows: number;
    validRows: number;
    corruptRows: number;
    unterminated: boolean;
}
export declare class CorruptAssetSidecarError extends Error {
    readonly sidecar: AssetSidecarKind;
    readonly reason: AssetSidecarCorruptionReason;
    readonly code = "CORRUPT_ASSET_SIDECAR";
    constructor(sidecar: AssetSidecarKind, reason: AssetSidecarCorruptionReason);
}
export declare function parseSidecarJsonl<T>(raw: string, parseRecord: (value: unknown) => T | null): ParsedSidecarJsonl<T>;
export declare function assertTrustSidecarHealthy<T>(sidecar: Extract<AssetSidecarKind, 'provenance' | 'review'>, parsed: ParsedSidecarJsonl<T>): void;
export declare function parseProvenanceRecord(value: unknown): ProvenanceRecord | null;
export declare function parseReviewRecord(value: unknown): ReviewRecord | null;
export declare function parseAssetSyncRecord(value: unknown): AssetSyncRecord | null;
export declare const ASSET_SYNC_INVENTORY_MAX_SEGMENT_BYTES: number;
export type AssetSyncSidecarRecord = AssetSyncRecord | AssetSyncRunRecord | AssetSyncInventorySegmentRecord;
export declare function parseAssetSyncRunRecord(value: unknown): AssetSyncRunRecord | null;
export declare function parseAssetSyncInventorySegmentRecord(value: unknown): AssetSyncInventorySegmentRecord | null;
export declare function parseAssetSyncSidecarRecord(value: unknown): AssetSyncSidecarRecord | null;