// One-time npm/JS → standalone binary migration for the DEFAULT self-update policy.
//
// The npm/JS install shape has no replaceable standalone binary target, so the supervision
// bootstrap (bootstrap.ts) refuses to register a supervised instance for it (it would crash
// at self-update target resolution on every startup). Instead, the first degraded startup
// may ONCE download the signed standalone release binary for this platform into the user's
// evolver home (`<home>/bin`, mirroring the CLI-side lifecyclePaths home) and hand over:
//
//   RESOLVE  (version / asset name / dest path)
//   DOWNLOAD (signed manifest + binary staged under tmpdir)
//   VERIFY   (ed25519 manifest signature + sha256 + real preflight probe)
//   INSTALL  (atomic copy into <home>/bin; unverified bytes are never written)
//   REGISTER (spawn `evolver lifecycle bootstrap` with EVOLVER_SELF_UPDATE_TARGET_PATH=dest)
//
// Migration is a convenience, never an escalation: it is skipped when disabled
// (EVOLVER_BOOTSTRAP_MIGRATION=0|off), for root (non-win32), CI, containers, within a
// bootstrap-failure cooldown window, and on unsupported platforms. Every failure degrades
// back to the existing 'off + warning' startup and records a bootstrap attempt marker so
// the cooldown applies. All I/O is injectable for tests.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod as fsChmod, lstat, mkdir as fsMkdir, readFile as fsReadFile, rename as fsRename, rm as fsRm, writeFile as fsWriteFile, } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ops } from '@evomap/evolver-core';
import { SELF_UPDATE_FAILURE_CODES } from './failureCodes.js';
import { resolveSelfUpdatePublicKey } from './builtinKey.js';
import { downloadGithubReleaseArtifact, releaseAssetName, resolveGithubReleaseManifest, } from './releaseBinary.js';
import { preflightManagedStagedBinary } from './transaction.js';
import { getCurrentVersion } from './version.js';
import { looksLikeContainer, recentBootstrapFailure, recordBootstrapAttempt, resolveBootstrapCliInvocation, resolveBootstrapStateDir, } from './bootstrap.js';
/** Advisory migration state marker written next to the bootstrap attempt marker. */
export const MIGRATION_STATE_FILE = 'migration.json';
/**
 * The CLI-side service activation itself spawns up to ~60s (lifecycle powershell/schtasks
 * activation), so a shorter timeout would kill the child mid-activation and leave the
 * installed binary registered as failed. Mirrors the bootstrap timeout rationale.
 */
export const MIGRATION_REGISTER_TIMEOUT_MS = 90_000;
/**
 * Migration install home — mirrors the CLI-side lifecyclePaths home resolution
 * (kept dependency-free across packages): EVOLVER_HOME ?? EVOMAP_HOME ?? ~/.evomap.
 */
export function resolveMigrationHome(env) {
    return env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
}
/** Migration install path for this platform: <home>/bin/<releaseAssetName>. Throws on unsupported platforms. */
export function resolveMigrationDestPath(env, platform = process.platform, arch = process.arch) {
    return join(resolveMigrationHome(env), 'bin', releaseAssetName(platform, arch));
}
/**
 * Resolve the migration target version: EVOLVER_BOOTSTRAP_MIGRATION_VERSION override
 * (normalized through the self-update version contract) wins, else the current package
 * version. Returns undefined when nothing normalizes to a concrete semver.
 */
export function resolveMigrationVersion(env) {
    const override = env['EVOLVER_BOOTSTRAP_MIGRATION_VERSION']?.trim();
    if (override)
        return ops.normalizeRequiredVersion(override);
    return ops.normalizeConcreteVersion(getCurrentVersion());
}
const defaultReadTextFile = (path) => readFileSync(path, 'utf8');
const defaultWriteTextFile = (path, content) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
};
function resolveProcessUid() {
    const getuid = process.getuid;
    return typeof getuid === 'function' ? getuid.call(process) : undefined;
}
/** Best-effort advisory migration state log; never throws — bookkeeping must not break startup. */
function writeMigrationState(env, record, options) {
    try {
        const payload = { ...record, attemptedAt: new Date(options.now ?? Date.now()).toISOString() };
        const write = options.writeFile ?? defaultWriteTextFile;
        write(join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE), `${JSON.stringify(payload)}\n`);
    }
    catch {
        // State log is advisory; startup continues regardless.
    }
}
async function rmSafe(rm, path) {
    try {
        await rm(path);
    }
    catch {
        // Best-effort cleanup only.
    }
}
function errorDetail(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
/** Spawn `evolver lifecycle bootstrap` with the migration target bound; bounded timeout. */
function registerMigratedBinary(env, destPath, options, exists) {
    const invocation = resolveBootstrapCliInvocation({ execPath: options.execPath, exists });
    if (!invocation)
        return Promise.resolve({ ok: false, reason: 'cli_not_found' });
    // resolveBootstrapCliInvocation already targets `lifecycle bootstrap`; normalize the tail
    // explicitly while preserving any CLI entry prefix (node <cli.js> ...).
    const args = [...invocation.args.slice(0, Math.max(0, invocation.args.length - 2)), 'lifecycle', 'bootstrap'];
    const spawnFn = options.spawnFn ?? spawn;
    const childEnv = { ...env, EVOLVER_SELF_UPDATE_TARGET_PATH: destPath };
    const timeoutMs = options.timeoutMs ?? MIGRATION_REGISTER_TIMEOUT_MS;
    return new Promise((resolvePromise) => {
        let child;
        try {
            const spawnOptions = { stdio: 'ignore', windowsHide: true, env: childEnv };
            child = spawnFn(invocation.command, args, spawnOptions);
        }
        catch (error) {
            resolvePromise({ ok: false, reason: 'failed', detail: errorDetail(error) });
            return;
        }
        let settled = false;
        const settle = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(outcome);
        };
        const timer = setTimeout(() => {
            child.kill();
            settle({ ok: false, reason: 'timeout' });
        }, timeoutMs);
        child.once('error', (error) => {
            settle({ ok: false, reason: 'failed', detail: error.message });
        });
        child.once('exit', (code) => {
            if (code === 0)
                settle({ ok: true, reason: 'registered' });
            else
                settle({ ok: false, reason: 'failed', detail: `exit ${code ?? 'null'}` });
        });
    });
}
/**
 * One-time migration of the npm/JS install shape to the standalone release binary.
 * Never throws: every failure/skip becomes a structured MigrationResult so degraded
 * startup can keep running with self-update off.
 */
export async function migrateToStandaloneBinary(env, platform = process.platform, options = {}) {
    const now = options.now ?? Date.now();
    const exists = options.exists ?? existsSync;
    const readText = options.readFile ?? defaultReadTextFile;
    const recordOptions = { now, ...(options.writeFile ? { writeFile: options.writeFile } : {}) };
    const skipped = (reason, message) => {
        writeMigrationState(env, { state: 'skipped', reason }, options);
        return { outcome: 'skipped', reason, message };
    };
    // Gate order: switch → root → CI → container → cooldown. shouldBootstrap returns
    // unsupported_install_shape BEFORE its own CI/container checks, so migration must
    // re-check every environment guard itself.
    const migrationSwitch = env['EVOLVER_BOOTSTRAP_MIGRATION']?.trim();
    if (migrationSwitch === '0' || migrationSwitch === 'off') {
        return skipped('disabled', 'one-time standalone migration disabled (EVOLVER_BOOTSTRAP_MIGRATION)');
    }
    const uid = options.uid ?? resolveProcessUid();
    if (platform !== 'win32' && uid === 0) {
        return skipped('root_user', 'one-time standalone migration skipped for root');
    }
    const ci = env['CI']?.trim();
    if (ci && ci.toLowerCase() !== 'false' && ci !== '0') {
        return skipped('ci_environment', 'one-time standalone migration skipped in CI');
    }
    if (platform === 'linux' && looksLikeContainer(exists, readText)) {
        return skipped('container_environment', 'one-time standalone migration skipped in a container');
    }
    if (recentBootstrapFailure(env, readText, now)) {
        return skipped('cooldown', 'one-time standalone migration skipped (recent bootstrap failure cooldown)');
    }
    // RESOLVE: version, asset name, dest path.
    const version = resolveMigrationVersion(env);
    if (!version) {
        const overrideSet = Boolean(env['EVOLVER_BOOTSTRAP_MIGRATION_VERSION']?.trim());
        const reason = overrideSet ? 'invalid_version_override' : 'version_unresolvable';
        return skipped(reason, `one-time standalone migration skipped (${reason})`);
    }
    let assetName;
    try {
        assetName = releaseAssetName(platform, options.arch ?? process.arch);
    }
    catch {
        // Unsupported platform (e.g. win-arm64): skip without recording a cooldown-worthy attempt.
        return skipped('unsupported_platform', `one-time standalone migration skipped (unsupported platform ${platform}/${options.arch ?? process.arch})`);
    }
    const destPath = join(resolveMigrationHome(env), 'bin', assetName);
    writeMigrationState(env, { state: 'in_progress', version, destPath }, options);
    const fail = (reason, message, attemptDetail) => {
        recordBootstrapAttempt(env, { ok: false, reason: 'migration_failed', detail: attemptDetail ?? reason }, recordOptions);
        writeMigrationState(env, { state: 'failed', version, destPath, reason }, options);
        return { outcome: 'failed', reason, destPath, message };
    };
    const failTimeout = (reason, message, attemptDetail) => {
        recordBootstrapAttempt(env, { ok: false, reason: 'migration_timeout', detail: attemptDetail }, recordOptions);
        writeMigrationState(env, { state: 'failed', version, destPath, reason }, options);
        return { outcome: 'failed', reason, destPath, message };
    };
    const readBinary = options.readBinary ?? ((path) => fsReadFile(path));
    const writeBinary = options.writeBinary
        ?? ((path, content, mode) => fsWriteFile(path, content, { mode }));
    const mkdir = options.mkdir ?? ((path, mode) => fsMkdir(path, { recursive: true, mode }).then(() => undefined));
    const rm = options.rm ?? ((path) => fsRm(path, { recursive: true, force: true }));
    const rename = options.rename ?? ((from, to) => fsRename(from, to));
    const chmod = options.chmod ?? ((path, mode) => fsChmod(path, mode));
    const stat = options.stat ?? ((path) => lstat(path));
    const preflightFn = options.preflightFn
        ?? ((targetPath, expectedVersion) => preflightManagedStagedBinary(targetPath, expectedVersion, options.probe));
    const downloadFn = options.downloadFn ?? downloadGithubReleaseArtifact;
    const verifyFn = options.verifyFn
        ?? ((manifest, downloaded, publicKey) => ops.verifySelectedManifestArtifact(manifest, downloaded, publicKey));
    // Fast path: an existing dest that passes the real preflight only needs registration.
    if (exists(destPath)) {
        try {
            await preflightFn(destPath, version);
            return register(env, version, destPath, options, exists, recordOptions, fail, failTimeout, writeMigrationState);
        }
        catch {
            // Existing binary is unusable — fall through and download a fresh copy over it.
        }
    }
    // DOWNLOAD: signed manifest + staged binary under tmpdir.
    const directive = { required_version: version };
    const releaseOpts = {
        env,
        platform,
        arch: options.arch,
        fetchFn: options.fetchFn,
        requireSignedManifest: true,
    };
    let manifest;
    let download;
    try {
        manifest = await resolveGithubReleaseManifest(directive, releaseOpts);
        download = await downloadFn(version, directive, releaseOpts);
    }
    catch (err) {
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_DOWNLOAD_FAILED;
        return fail(`${code}:${errorDetail(err)}`, `one-time standalone migration failed (${code})`, `${code}: ${errorDetail(err)}`);
    }
    const stagedDir = dirname(download.stagedPath);
    // VERIFY: ed25519 signature over the complete manifest + sha256 of the staged bytes.
    // Fail closed: unverified bytes are NEVER written into the user's home.
    const verification = verifyFn(manifest, download.artifacts, resolveSelfUpdatePublicKey(env));
    if (!verification.ok) {
        await rmSafe(rm, stagedDir);
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_VERIFY_FAILED;
        return fail(`${code}:${verification.reason}`, `one-time standalone migration failed (${code})`, `${code}: ${verification.reason}`);
    }
    // Preflight the staged binary for real (`--version` + `proxy --help`) before install.
    try {
        await preflightFn(download.stagedPath, version);
    }
    catch (err) {
        await rmSafe(rm, stagedDir);
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_VERIFY_FAILED;
        const detail = `preflight:${errorDetail(err)}`;
        return fail(`${code}:${detail}`, `one-time standalone migration failed (${code})`, `${code}: ${detail}`);
    }
    // INSTALL: atomic copy into <home>/bin (verified bytes only).
    try {
        await mkdir(dirname(destPath), 0o700);
        const stagedStat = await stat(download.stagedPath);
        if (stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
            throw new Error('staged_artifact_not_regular_file');
        }
        const bytes = await readBinary(download.stagedPath);
        const tmpDest = `${destPath}.tmp`;
        try {
            await writeBinary(tmpDest, bytes, 0o755);
            await chmod(tmpDest, 0o755);
            await rename(tmpDest, destPath);
        }
        catch (err) {
            await rmSafe(rm, tmpDest);
            throw err;
        }
    }
    catch (err) {
        await rmSafe(rm, stagedDir);
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
        return fail(`${code}:${errorDetail(err)}`, `one-time standalone migration failed (${code})`, `${code}: ${errorDetail(err)}`);
    }
    finally {
        await rmSafe(rm, stagedDir);
    }
    // REGISTER: hand the installed binary to `evolver lifecycle bootstrap`.
    return register(env, version, destPath, options, exists, recordOptions, fail, failTimeout, writeMigrationState);
}
async function register(env, version, destPath, options, exists, recordOptions, fail, failTimeout, writeState) {
    const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
    const registration = await registerMigratedBinary(env, destPath, options, exists);
    if (registration.reason === 'cli_not_found') {
        return fail(`${code}:cli_not_found`, `one-time standalone migration failed (${code}:cli_not_found)`, `${code}: cli_not_found`);
    }
    if (registration.reason === 'timeout') {
        return failTimeout('migration_register_timeout', `one-time standalone migration failed (${code}:timeout)`, `${code}: timeout`);
    }
    if (!registration.ok) {
        const detail = registration.detail ?? 'unknown';
        return fail(`${code}:${detail}`, `one-time standalone migration failed (${code})`, `${code}: ${detail}`);
    }
    recordBootstrapAttempt(env, { ok: true, reason: 'migrated', detail: destPath }, recordOptions);
    writeState(env, { state: 'migrated', version, destPath }, options);
    return {
        outcome: 'migrated',
        reason: 'migrated',
        destPath,
        message: `[evolver-proxy] self-update: installed standalone binary ${version} at ${destPath} and registered `
            + 'durable service supervision via `evolver lifecycle bootstrap`; handing over to the service manager '
            + 'and exiting so it can take the IPC port.',
    };
}