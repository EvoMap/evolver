import { ops } from '@evomap/evolver-core';
import type { DownloadResult, ForceUpdateDirective } from './executor.js';
type UpdateManifest = ops.UpdateManifest;
type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface ReleaseBinaryOptions {
    env?: Record<string, string | undefined>;
    fetchFn?: FetchFn;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    tmpDir?: string;
    targetPath?: string;
    processExecPath?: string;
    requireSignedManifest?: boolean;
    maxPrimaryBinaryBytes?: number;
    maxExtractedTarballBytes?: number;
}
/**
 * Hard ceiling for primary release binaries. The binary is buffered before its
 * manifest hash is verified, so an unbounded response could exhaust memory
 * before the verification gate runs. 128MiB leaves headroom above current
 * single-platform binaries while bounding that pre-verification allocation.
 */
export declare const MAX_PRIMARY_BINARY_BYTES: number;
/** Release metadata is untrusted and buffered before parsing or verification. */
export declare const MAX_RELEASE_METADATA_BYTES: number;
/**
 * Hard ceiling for Channel 1b tarball downloads. A compromised/corrupt release
 * could advertise a multi-GB tar.gz and OOM us because tarballBytes is buffered
 * before extraction. 64MB is well above any real single-platform precompiled
 * release tarball today.
 */
export declare const MAX_TARBALL_BYTES: number;
/**
 * Hard ceiling for the decompressed tar stream. This is intentionally larger
 * than the compressed-body cap so normal binary tarballs still fit, while gzip
 * bombs fail before the extractor accumulates unbounded output in memory.
 */
export declare const MAX_EXTRACTED_TARBALL_BYTES: number;
export declare function isStandaloneReleaseBinaryName(name: string): boolean;
export declare function requiredVersionForRelease(raw: unknown): string;
export declare function releaseAssetName(platform?: NodeJS.Platform, arch?: NodeJS.Architecture): string;
export declare function resolveGithubReleaseManifest(directive: ForceUpdateDirective, opts?: ReleaseBinaryOptions): Promise<UpdateManifest>;
export declare function downloadGithubReleaseArtifact(targetVersion: string, directive: ForceUpdateDirective, opts?: ReleaseBinaryOptions): Promise<DownloadResult>;
/**
 * Channel 1b: download the same release's `<assetName>.tar.gz` and extract the
 * binary file matching `assetName` (or its basename). The tarball MUST contain
 * an entry that matches the asset name — anything else and we fail closed with
 * `fallback_missing_binary` (no half-extracted state).
 *
 * Note: we do NOT use `codeload.github.com/.../tar.gz` here. Codeload returns
 * the SOURCE tree, which has no compiled binary; V2 ships a single binary, so
 * the fallback only restores the DOWNLOAD leg, not an "install from source"
 * leg. If a deployment wants the source-tree fallback V1 had, that is a
 * separate, signed channel that doesn't exist yet in V2.
 *
 * The returned DownloadResult is shape-compatible with the primary path: same
 * `artifacts[].path` (assetName) and a sha256 over the EXTRACTED binary bytes,
 * so the executor's verifyManifest gate still enforces signature + hash before
 * any atomicReplace.
 */
export declare function downloadGithubReleaseTarball(version: string, assetName: string, directive: ForceUpdateDirective, opts: ReleaseBinaryOptions, primaryError: unknown): Promise<DownloadResult>;
export declare function atomicReplaceExecutable(stagedPath: string, opts?: ReleaseBinaryOptions): Promise<void>;
export declare function resolveSelfUpdateTarget(opts?: ReleaseBinaryOptions): {
    path: string;
    explicit: boolean;
};
export declare function assertSelfUpdateProcessTargetBound(options: ReleaseBinaryOptions, allowUnresolvedTarget?: boolean): void;
export declare function selfUpdateProcessTargetBindable(options: ReleaseBinaryOptions): boolean;
export {};