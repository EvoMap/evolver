import { type spawn } from 'node:child_process';
import { ops } from '@evomap/evolver-core';
import type { DownloadResult, ForceUpdateDirective } from './executor.js';
import { type ReleaseBinaryOptions } from './releaseBinary.js';
import { type StagedBinaryProbe } from './transaction.js';
type DownloadedArtifact = ops.DownloadedArtifact;
type VerifyResult = ops.VerifyResult;
type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Minimal stat shape migration needs (symlink guard + regular-file check). */
interface MigrationFileStat {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    isDirectory?(): boolean;
    size?: number;
}
interface MigrationTargetIdentity {
    path: string;
    device: string;
    inode: string;
    size: number;
    linkCount: 1;
    mtimeNs: string;
    ctimeNs: string;
    sha256: string;
}
/**
 * Registration is delegated to the same transaction runner used by ordinary first-run
 * bootstrap. The absolute deadlines are part of this request so an adapter cannot silently
 * restart either observation budget during registration and reconciliation.
 */
export interface MigrationRegistrationRequest {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    version: string;
    startedAtMs: number;
    transactionDeadlineMs: number;
    parentDeadlineMs: number;
    transactionBudgetMs: number;
    timeoutMs: number;
    /** Exact signed target identity the runner must revalidate before spawning the child. */
    targetIdentity: Readonly<MigrationTargetIdentity>;
    /** Sealed verifier over the original identity/dependencies; call immediately before spawn. */
    revalidateTarget: () => Promise<void>;
    /** Sealed durable-intent verifier; call immediately before target revalidation and spawn. */
    assertRegistrationIntentCurrent: () => Promise<void>;
    execPath: string;
    exists?: (path: string) => boolean;
    readFile?: (path: string) => string;
    writeFile?: (path: string, content: string) => void;
    spawnFn?: typeof spawn;
}
interface MigrationRegistrationOutcome {
    ok: boolean;
    reason: string;
    detail?: string;
    /** The runner could not prove child/process-tree ownership or a clean rollback. */
    requiresForegroundExit?: true;
}
export type MigrationRegistrationRunner = (request: MigrationRegistrationRequest) => Promise<MigrationRegistrationOutcome>;
export interface MigrationOptions {
    /** Arch override for release asset resolution (defaults to process.arch). */
    arch?: NodeJS.Architecture;
    exists?: (path: string) => boolean;
    /** Sync text read (bootstrap.ts mirror); used for container detection. */
    readFile?: (path: string) => string;
    /** Sync text write seam for attempt markers and canonical migration state. */
    writeFile?: (path: string, content: string) => void;
    /** Async binary read of the staged artifact (install copy). */
    readBinary?: (path: string) => Promise<Buffer>;
    /** Async binary write with mode (install tmp copy). */
    writeBinary?: (path: string, content: Buffer, mode: number) => Promise<void>;
    /** Recursive mkdir with mode (install dest dir). */
    mkdir?: (path: string, mode: number) => Promise<void>;
    /** Force/recursive removal (staged tmp dir, leftover tmp copies). */
    rm?: (path: string) => Promise<void>;
    /** Owner-verified installed target removal after a proven clean registration rollback. */
    unlink?: (path: string) => Promise<void>;
    /** Remove a transaction-created empty bin directory after clean rollback. */
    rmdir?: (path: string) => Promise<void>;
    chmod?: (path: string, mode: number) => Promise<void>;
    /** Flush staged executable data/metadata before namespace publication. */
    syncFile?: (path: string) => Promise<void>;
    /** Flush target namespace mutations; Windows may use a documented no-op fallback. */
    syncDirectory?: (path: string) => Promise<void>;
    /** lstat-shaped stat for the staged-artifact symlink guard. */
    stat?: (path: string) => Promise<MigrationFileStat>;
    /** Atomic no-replace publication seam. */
    link?: (from: string, to: string) => Promise<void>;
    /** Atomic same-directory move used by exact rollback quarantine. */
    rename?: (from: string, to: string) => Promise<void>;
    fetchFn?: FetchFn;
    /** Probe used by the default preflight (real execution of `--version` / `proxy --help`). */
    probe?: StagedBinaryProbe;
    spawnFn?: typeof spawn;
    now?: number;
    /** Clock used to bind the registration runner to absolute deadlines. */
    clock?: () => number;
    execPath?: string;
    /** Effective uid (tests / platforms without process.getuid). */
    uid?: number | undefined;
    /** Parent register timeout; must exceed transactionBudgetMs. */
    timeoutMs?: number;
    /** Child transaction budget; defaults to MIGRATION_REGISTER_TRANSACTION_BUDGET_MS. */
    transactionBudgetMs?: number;
    /** Durable reconciliation + process-tree-contained registration runner. */
    registrationRunner?: MigrationRegistrationRunner;
    /** Test seam for platform ownership/ACL validation; production uses strict host checks. */
    assertDirectoryTrust?: (directory: string) => void | Promise<void>;
    /** Test seam for executable ownership/ACL validation; production uses strict host checks. */
    assertFileTrust?: (path: string) => void | Promise<void>;
    /** Sync test seam for canonical state-directory ownership/ACL validation. */
    assertStateDirectoryTrust?: (directory: string) => void;
    /** Sync test seam for canonical state-file ownership/ACL validation. */
    assertStateFileTrust?: (path: string) => void;
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
    /** Registration ownership is ambiguous, so the foreground proxy must not continue. */
    requiresForegroundExit?: true;
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
 * Never throws: every failure/skip becomes a structured MigrationResult. Only a proven clean
 * failure may continue degraded; ambiguous registration ownership requires foreground exit.
 */
export declare function migrateToStandaloneBinary(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, options?: MigrationOptions): Promise<MigrationResult>;
export {};