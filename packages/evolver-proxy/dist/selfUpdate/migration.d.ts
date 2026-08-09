import { spawn } from 'node:child_process';
import { ops } from '@evomap/evolver-core';
import type { DownloadResult, ForceUpdateDirective } from './executor.js';
import { type ReleaseBinaryOptions } from './releaseBinary.js';
import { type StagedBinaryProbe } from './transaction.js';
type DownloadedArtifact = ops.DownloadedArtifact;
type VerifyResult = ops.VerifyResult;
type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Advisory migration state marker written next to the bootstrap attempt marker. */
export declare const MIGRATION_STATE_FILE = "migration.json";
/**
 * The CLI-side service activation itself spawns up to ~60s (lifecycle powershell/schtasks
 * activation), so a shorter timeout would kill the child mid-activation and leave the
 * installed binary registered as failed. Mirrors the bootstrap timeout rationale.
 */
export declare const MIGRATION_REGISTER_TIMEOUT_MS = 90000;
/** Minimal stat shape migration needs (symlink guard + regular-file check). */
export interface MigrationFileStat {
    isFile(): boolean;
    isSymbolicLink(): boolean;
}
export interface MigrationOptions {
    /** Arch override for release asset resolution (defaults to process.arch). */
    arch?: NodeJS.Architecture;
    exists?: (path: string) => boolean;
    /** Sync text read (bootstrap.ts mirror); used for container detection. */
    readFile?: (path: string) => string;
    /** Sync text write for advisory state markers (attempt marker + migration.json). */
    writeFile?: (path: string, content: string) => void;
    /** Async binary read of the staged artifact (install copy). */
    readBinary?: (path: string) => Promise<Buffer>;
    /** Async binary write with mode (install tmp copy). */
    writeBinary?: (path: string, content: Buffer, mode: number) => Promise<void>;
    /** Recursive mkdir with mode (install dest dir). */
    mkdir?: (path: string, mode: number) => Promise<void>;
    /** Force/recursive removal (staged tmp dir, leftover tmp copies). */
    rm?: (path: string) => Promise<void>;
    rename?: (from: string, to: string) => Promise<void>;
    chmod?: (path: string, mode: number) => Promise<void>;
    /** lstat-shaped stat for the staged-artifact symlink guard. */
    stat?: (path: string) => Promise<MigrationFileStat>;
    fetchFn?: FetchFn;
    /** Probe used by the default preflight (real execution of `--version` / `proxy --help`). */
    probe?: StagedBinaryProbe;
    spawnFn?: typeof spawn;
    now?: number;
    execPath?: string;
    /** Effective uid (tests / platforms without process.getuid). */
    uid?: number | undefined;
    /** Register-step timeout override (defaults to MIGRATION_REGISTER_TIMEOUT_MS). */
    timeoutMs?: number;
    /** High-level seam: download leg (defaults to downloadGithubReleaseArtifact). */
    downloadFn?: (targetVersion: string, directive: ForceUpdateDirective, opts: ReleaseBinaryOptions) => Promise<DownloadResult>;
    /** High-level seam: manifest verification (defaults to ops.verifySelectedManifestArtifact). */
    verifyFn?: (manifest: unknown, downloaded: readonly DownloadedArtifact[], publicKey: string) => VerifyResult;
    /** High-level seam: preflight (defaults to preflightManagedStagedBinary with options.probe). */
    preflightFn?: (targetPath: string, expectedVersion: string) => Promise<void>;
}
export interface MigrationResult {
    outcome: 'migrated' | 'skipped' | 'failed';
    /**
     * Structured reason: 'migrated' / 'disabled' / 'root_user' / 'ci_environment' /
     * 'container_environment' / 'cooldown' / 'unsupported_platform' /
     * 'invalid_version_override' / 'version_unresolvable' /
     * 'migration_download_failed:<detail>' / 'migration_verify_failed:<reason>' /
     * 'migration_install_failed:<detail>' / 'migration_register_failed:<detail>' /
     * 'migration_register_timeout'.
     */
    reason: string;
    destPath?: string;
    /** Operator-facing message (short phrase for skipped/failed; full line for migrated). */
    message: string;
}
/**
 * Migration install home — mirrors the CLI-side lifecyclePaths home resolution
 * (kept dependency-free across packages): EVOLVER_HOME ?? EVOMAP_HOME ?? ~/.evomap.
 */
export declare function resolveMigrationHome(env: NodeJS.ProcessEnv): string;
/** Migration install path for this platform: <home>/bin/<releaseAssetName>. Throws on unsupported platforms. */
export declare function resolveMigrationDestPath(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, arch?: NodeJS.Architecture): string;
/**
 * Resolve the migration target version: EVOLVER_BOOTSTRAP_MIGRATION_VERSION override
 * (normalized through the self-update version contract) wins, else the current package
 * version. Returns undefined when nothing normalizes to a concrete semver.
 */
export declare function resolveMigrationVersion(env: NodeJS.ProcessEnv): string | undefined;
/**
 * One-time migration of the npm/JS install shape to the standalone release binary.
 * Never throws: every failure/skip becomes a structured MigrationResult so degraded
 * startup can keep running with self-update off.
 */
export declare function migrateToStandaloneBinary(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, options?: MigrationOptions): Promise<MigrationResult>;
export {};