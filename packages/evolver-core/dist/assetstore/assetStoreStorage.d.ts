import type { Stats } from 'node:fs';
import { acquireLock, releaseLock, type ReleaseLockResult } from '../util/fileLock.js';
export type UnsafeAssetStorePathReason = 'symlink' | 'not_directory' | 'not_regular_file' | 'path_changed';
export type AssetStorePathRole = 'base_directory' | 'asset_file' | 'lock_file' | 'temp_file';
export declare class UnsafeAssetStorePathError extends Error {
    readonly role: AssetStorePathRole;
    readonly reason: UnsafeAssetStorePathReason;
    readonly code = "UNSAFE_ASSET_STORE_PATH";
    constructor(role: AssetStorePathRole, reason: UnsafeAssetStorePathReason);
}
export declare class AssetStoreReadLimitError extends Error {
    readonly code = "ASSET_STORE_READ_LIMIT";
    constructor();
}
export interface DurableWriteOptions {
    syncFile?: (fd: number) => void;
    syncDirectory?: (path: string) => void;
    onTempPath?: (path: string) => void;
    expectedFingerprint?: string;
    expectedDirectory?: AssetFileIdentity;
}
export declare const EXPERIENCE_BUNDLE_SCHEMA = "evolver.assetstore-experience.v3";
export declare class ExperienceRecoveryRequiredError extends Error {
    readonly code = "EXPERIENCE_RECOVERY_REQUIRED";
    constructor();
}
/** Every supported shared-lock writer must refuse an unfinished experience transaction. */
export declare function assertNoExperienceTransaction(baseDir: string): void;
export interface AssetStoreLockDeps {
    acquireLock?: typeof acquireLock;
    releaseLock?: typeof releaseLock;
    /** Only the experience coordinator may inspect/settle its own prepared manifest. */
    experienceRecovery?: boolean;
}
export declare function ensureAssetStoreDirectory(path: string): void;
/** Validate an existing store root without recreating a deleted or unmounted path. */
export declare function assertAssetStoreDirectory(path: string): void;
export declare function isReliableAssetStoreLockRelease(result: ReleaseLockResult): boolean;
/**
 * Run one synchronous asset-store critical section without hiding its primary failure.
 * A release failure is surfaced only after a successful operation; when both fail, the operation error wins.
 */
export declare function withAssetStoreLock<T>(lockPath: string, operation: () => T, deps?: AssetStoreLockDeps): T;
export declare function assertOptionalRegularFile(path: string, role?: AssetStorePathRole): Stats | null;
export declare function regularFileFingerprint(path: string): string;
export interface AssetFileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly birthtimeNs: bigint;
}
export declare function captureAssetStoreDirectoryIdentity(path: string): AssetFileIdentity;
export declare function assertAssetStoreDirectoryIdentity(path: string, expected: AssetFileIdentity): void;
export declare function captureRegularAssetFileIdentity(path: string): AssetFileIdentity;
export declare function assertOpenedRegularAssetFile(fd: number, path: string, expected?: AssetFileIdentity): void;
export declare function readRegularBuffer(path: string, maxBytes?: number, check?: () => void): Buffer | null;
export declare function readUtf8Regular(path: string, maxBytes?: number): string | null;
export declare function createBufferDurableExclusive(path: string, value: Buffer, opts?: DurableWriteOptions): void;
export declare function fsyncDirectoryBestEffort(path: string): void;
export declare function appendUtf8Durable(path: string, value: string, opts?: DurableWriteOptions): void;
export declare function replaceUtf8Durable(path: string, value: string, opts?: DurableWriteOptions): void;
/** Confirm the exact named projection on one descriptor before deleting its recovery intent. */
export declare function syncUtf8Regular(path: string, expected: string, opts?: Pick<DurableWriteOptions, 'syncFile' | 'expectedDirectory' | 'expectedFingerprint'>): void;
/** Remove one exact UTF-8 suffix and fsync the new file length; false means the suffix was not current. */
export declare function truncateUtf8SuffixDurable(path: string, suffix: string, opts?: Pick<DurableWriteOptions, 'syncFile'>): boolean;