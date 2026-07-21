import { type ReleaseLockReason } from '../util/fileLock.js';
import { type AssetStoreLockDeps } from './assetStoreStorage.js';
import { type AssetSidecarKind } from './assetSidecarRecords.js';
export type { AssetSidecarKind } from './assetSidecarRecords.js';
export type AssetSidecarRecoveryFailureReason = 'sidecar_missing' | 'sidecar_not_degraded' | 'replacement_missing' | 'replacement_too_large' | 'replacement_invalid_utf8' | 'replacement_invalid' | 'replacement_unterminated' | 'valid_history_missing' | 'corrective_record_required' | 'unsafe_corrective_record' | 'acknowledgement_required' | 'sidecar_too_large' | 'sidecar_changed' | 'replacement_changed' | 'backup_conflict';
export declare class AssetSidecarRecoveryError extends Error {
    readonly reason: AssetSidecarRecoveryFailureReason;
    readonly code = "ASSET_SIDECAR_RECOVERY_FAILED";
    constructor(reason: AssetSidecarRecoveryFailureReason);
}
export interface AssetSidecarRecoveryFileReport {
    rows: number;
    validRows: number;
    corruptRows: number;
    unterminated: boolean;
    digest: string;
}
export interface AssetSidecarReplacementReport extends AssetSidecarRecoveryFileReport {
    preservedValidRows: number;
    addedRecords: number;
    correctiveRecords: number;
}
export interface AssetSidecarRecoveryReport {
    mode: 'preview' | 'write';
    sidecar: AssetSidecarKind;
    changed: boolean;
    wouldWrite: boolean;
    acknowledgementRequired: boolean;
    current: AssetSidecarRecoveryFileReport;
    replacement: AssetSidecarReplacementReport;
    backupId?: string;
    lockReleaseWarning?: ReleaseLockReason;
}
export interface RecoverAssetSidecarOptions {
    baseDir: string;
    sidecar: AssetSidecarKind;
    replacementPath: string;
    write?: boolean;
    acknowledgeCorruptHistory?: boolean;
    maxFileBytes?: number;
    deps?: {
        beforeBackup?: () => void;
        beforeReplace?: () => void;
        lock?: AssetStoreLockDeps;
    };
}
export declare const DEFAULT_SIDECAR_RECOVERY_MAX_FILE_BYTES: number;
export declare function recoverAssetSidecar(opts: RecoverAssetSidecarOptions): AssetSidecarRecoveryReport;