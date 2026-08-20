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
//   INSTALL  (validate target ownership; publish verified bytes atomically without replacement)
//   REGISTER (delegate to the lifecycle bootstrap transaction runner with absolute deadlines)
//
// Migration is a convenience, never an escalation: it is skipped when disabled
// (EVOLVER_BOOTSTRAP_MIGRATION=0|off), for root (non-win32), CI, containers, within a
// bootstrap-failure cooldown window, and on unsupported platforms. Clean failures degrade
// to the existing 'off + warning' startup; ambiguous child/process-tree ownership requires
// foreground exit. Clean failures use cooldown; ambiguous ownership writes a durable blocker
// that keeps later foreground startups fail-closed until signed lifecycle reconciliation
// proves a committed or cleanly rolled-back terminal outcome.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { chmod as fsChmod, link as fsLink, lstat, mkdir as fsMkdir, open as fsOpen, readFile as fsReadFile, realpath as fsRealpath, rename as fsRename, rm as fsRm, rmdir as fsRmdir, unlink as fsUnlink, writeFile as fsWriteFile, } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve as resolvePath, win32 } from 'node:path';
import { ops, util } from '@evomap/evolver-core';
import { SELF_UPDATE_FAILURE_CODES } from './failureCodes.js';
import { resolveSelfUpdatePublicKey } from './builtinKey.js';
import { downloadGithubReleaseArtifact, releaseAssetName, resolveGithubReleaseManifest, } from './releaseBinary.js';
import { preflightManagedStagedBinary } from './transaction.js';
import { getCurrentVersion } from './version.js';
import { looksLikeContainer, recentBootstrapFailure, recordBootstrapAttempt, resolveBootstrapStateDir, } from './bootstrap.js';
/** Canonical migration transaction state written next to the bootstrap attempt marker. */
const MIGRATION_STATE_FILE = 'migration.json';
// Keep the child transaction deadline shorter than its parent observation deadline so the
// child can durably roll back before process-tree containment becomes necessary.
const MIGRATION_REGISTER_TRANSACTION_BUDGET_MS = 180_000;
const MIGRATION_REGISTER_TIMEOUT_MS = 210_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_MIGRATION_DETAIL_LENGTH = 512;
const MAX_MIGRATION_STATE_BYTES = 16 * 1024;
const MIGRATION_LOCK_FILE = '.evolver-standalone-migration.lock';
const BOOTSTRAP_ATTEMPT_FILE = 'bootstrap-attempt.json';
const HOST_WINDOWS_SYSTEM_ROOT = process.env['SystemRoot']?.trim() || 'C:\\Windows';
/**
 * Migration install home — mirrors the CLI-side lifecyclePaths home resolution
 * (kept dependency-free across packages): EVOLVER_HOME ?? EVOMAP_HOME ?? ~/.evomap.
 */
export function resolveMigrationHome(env) {
    return resolvePath(env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap'));
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
function assertTrustedMigrationStateLeafSync(path, options = {}) {
    const existing = statMigrationStateLeafSync(path);
    if (options.assertStateFileTrust) {
        options.assertStateFileTrust(path);
    }
    else if (process.platform === 'win32') {
        assertWindowsMigrationAclTrusted([{ path, parentOnly: false }]);
    }
    else {
        const uid = resolveProcessUid();
        if ((uid !== undefined && existing.uid !== BigInt(uid)) || (existing.mode & 18n) !== 0n) {
            throw new Error('untrusted_migration_state_leaf');
        }
    }
    return existing;
}
function statMigrationStateLeafSync(path) {
    const existing = lstatSync(path, { bigint: true });
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1n) {
        throw new Error('unsafe_migration_state_leaf');
    }
    return existing;
}
function sameMigrationStateFileIdentity(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.nlink === 1n
        && right.nlink === 1n;
}
function sameMigrationStateFileSnapshot(left, right) {
    return sameMigrationStateFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
        && left.mode === right.mode
        && left.uid === right.uid
        && left.gid === right.gid;
}
function readBoundedMigrationStateFd(fd) {
    const bytes = Buffer.allocUnsafe(MAX_MIGRATION_STATE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (read === 0)
            break;
        offset += read;
    }
    if (offset > MAX_MIGRATION_STATE_BYTES)
        throw new Error('migration_state_too_large');
    return bytes.subarray(0, offset);
}
function readTrustedMigrationStateText(path, options = {}) {
    let initial;
    try {
        initial = assertTrustedMigrationStateLeafSync(path, options);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    if (initial.size > BigInt(MAX_MIGRATION_STATE_BYTES)) {
        throw new Error('migration_state_too_large');
    }
    const directory = dirname(resolvePath(path));
    if (options.assertStateDirectoryTrust) {
        options.assertStateDirectoryTrust(directory);
    }
    else {
        assertTrustedMigrationDirectoryChainSync(directory);
    }
    const beforeOpen = statMigrationStateLeafSync(path);
    if (!sameMigrationStateFileSnapshot(initial, beforeOpen)) {
        throw new Error('migration_state_leaf_changed');
    }
    const fd = openSync(path, 'r');
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!sameMigrationStateFileSnapshot(beforeOpen, opened)
            || opened.size > BigInt(MAX_MIGRATION_STATE_BYTES)) {
            throw new Error('migration_state_leaf_changed');
        }
        const raw = readBoundedMigrationStateFd(fd);
        const afterRead = statMigrationStateLeafSync(path);
        const afterFdRead = fstatSync(fd, { bigint: true });
        const finalPath = assertTrustedMigrationStateLeafSync(path, options);
        const finalFd = fstatSync(fd, { bigint: true });
        const confirmedRaw = readBoundedMigrationStateFd(fd);
        const confirmedPath = statMigrationStateLeafSync(path);
        const confirmedFd = fstatSync(fd, { bigint: true });
        if (!sameMigrationStateFileSnapshot(opened, afterRead)
            || !sameMigrationStateFileSnapshot(opened, afterFdRead)
            || !sameMigrationStateFileSnapshot(opened, finalPath)
            || !sameMigrationStateFileSnapshot(opened, finalFd)
            || !sameMigrationStateFileSnapshot(opened, confirmedPath)
            || !sameMigrationStateFileSnapshot(opened, confirmedFd)
            || finalFd.size !== BigInt(raw.byteLength)
            || confirmedFd.size !== BigInt(confirmedRaw.byteLength)
            || !raw.equals(confirmedRaw)) {
            throw new Error('migration_state_leaf_changed');
        }
        return raw.toString('utf8');
    }
    finally {
        closeSync(fd);
    }
}
const defaultWriteTextFile = (path, content) => {
    const directory = dirname(resolvePath(path));
    assertTrustedMigrationDirectoryChainSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertTrustedMigrationDirectoryChainSync(directory);
    if (migrationPathKey(realpathSync(directory)) !== migrationPathKey(directory)) {
        throw new Error('unsafe_migration_state_directory');
    }
    try {
        assertTrustedMigrationStateLeafSync(path);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
    const temporaryPath = join(directory, `.${parsePath(path).base}.${process.pid}.${randomUUID()}.tmp`);
    let fd;
    try {
        fd = openSync(temporaryPath, 'wx', 0o600);
        writeFileSync(fd, content, { encoding: 'utf8' });
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporaryPath, path);
        const published = lstatSync(path, { bigint: true });
        if (published.isSymbolicLink() || !published.isFile() || published.nlink !== 1n) {
            throw new Error('unsafe_migration_state_publication');
        }
        try {
            const directoryFd = openSync(directory, 'r');
            try {
                fsyncSync(directoryFd);
            }
            finally {
                closeSync(directoryFd);
            }
        }
        catch (error) {
            // Windows does not consistently allow directory handles; POSIX durability requires it.
            if (process.platform !== 'win32')
                throw error;
        }
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // Advisory state publication has already failed; cleanup is best effort.
            }
        }
        try {
            unlinkSync(temporaryPath);
        }
        catch {
            // Atomic temp names are owner-only inside a trusted directory; retry on next state write.
        }
    }
};
function resolveProcessUid() {
    const getuid = process.getuid;
    return typeof getuid === 'function' ? getuid.call(process) : undefined;
}
function sameMigrationInstallAnchor(left, right) {
    return left.phase === right.phase
        && left.temporaryPath === right.temporaryPath
        && left.size === right.size
        && left.sha256 === right.sha256
        && left.directoryCreated === right.directoryCreated
        && (left.phase === 'planned'
            || (right.phase !== 'planned'
                && left.device === right.device
                && left.inode === right.inode));
}
const MIGRATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIGRATION_DIGEST_RE = /^[0-9a-f]{64}$/;
const MIGRATION_UNSIGNED_INTEGER_RE = /^[0-9]+$/;
const MIGRATION_POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const MIGRATION_SIGNED_INTEGER_RE = /^-?[0-9]+$/;
function exactMigrationRecordKeys(record, expected) {
    const actual = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index]);
}
function exactMigrationTimestamp(value) {
    if (typeof value !== 'string')
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function boundedMigrationStateText(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function parseMigrationInstallAnchor(value, destPath) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const anchor = value;
    const phase = anchor['phase'];
    const expectedKeys = phase === 'planned'
        ? ['phase', 'temporaryPath', 'size', 'sha256', 'directoryCreated']
        : ['phase', 'temporaryPath', 'device', 'inode', 'size', 'sha256', 'directoryCreated'];
    if (!exactMigrationRecordKeys(anchor, expectedKeys))
        return undefined;
    const temporaryPath = anchor['temporaryPath'];
    const device = anchor['device'];
    const inode = anchor['inode'];
    const size = anchor['size'];
    const digest = anchor['sha256'];
    const directoryCreated = anchor['directoryCreated'];
    if (typeof temporaryPath !== 'string'
        || !isAbsolute(temporaryPath)
        || temporaryPath.length > 4_096
        || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(temporaryPath)
        || dirname(temporaryPath) !== dirname(destPath)
        || !parsePath(temporaryPath).base.startsWith(`.${parsePath(destPath).base}.`)
        || !parsePath(temporaryPath).base.endsWith('.migration')
        || typeof size !== 'number'
        || !Number.isSafeInteger(size)
        || size < 0
        || typeof digest !== 'string'
        || !MIGRATION_DIGEST_RE.test(digest)
        || typeof directoryCreated !== 'boolean') {
        return undefined;
    }
    if (phase === 'planned') {
        return { phase, temporaryPath, size, sha256: digest, directoryCreated };
    }
    if ((phase !== 'materialized' && phase !== 'cleanup')
        || typeof device !== 'string'
        || !MIGRATION_POSITIVE_INTEGER_RE.test(device)
        || typeof inode !== 'string'
        || !MIGRATION_POSITIVE_INTEGER_RE.test(inode)) {
        return undefined;
    }
    return { phase, temporaryPath, device, inode, size, sha256: digest, directoryCreated };
}
function parseMigrationInstallOwnership(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const ownership = value;
    if (!exactMigrationRecordKeys(ownership, ['disposition', 'preimage', 'directoryCreated'])
        || (ownership['disposition'] !== 'installed' && ownership['disposition'] !== 'converged')
        || (ownership['preimage'] !== 'absent' && ownership['preimage'] !== 'matching_target')
        || typeof ownership['directoryCreated'] !== 'boolean'
        || (ownership['disposition'] === 'installed' && ownership['preimage'] !== 'absent')
        || (ownership['disposition'] === 'converged'
            && (ownership['preimage'] !== 'matching_target' || ownership['directoryCreated']))) {
        return undefined;
    }
    return {
        disposition: ownership['disposition'],
        preimage: ownership['preimage'],
        directoryCreated: ownership['directoryCreated'],
    };
}
function parseMigrationTargetIdentity(value, destPath) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const identity = value;
    if (!exactMigrationRecordKeys(identity, ['path', 'device', 'inode', 'size', 'linkCount', 'mtimeNs', 'ctimeNs', 'sha256'])) {
        return undefined;
    }
    const path = identity['path'];
    const device = identity['device'];
    const inode = identity['inode'];
    const size = identity['size'];
    const linkCount = identity['linkCount'];
    const mtimeNs = identity['mtimeNs'];
    const ctimeNs = identity['ctimeNs'];
    const digest = identity['sha256'];
    if (path !== destPath
        || typeof device !== 'string'
        || !MIGRATION_UNSIGNED_INTEGER_RE.test(device)
        || typeof inode !== 'string'
        || !MIGRATION_UNSIGNED_INTEGER_RE.test(inode)
        || typeof size !== 'number'
        || !Number.isSafeInteger(size)
        || size < 0
        || linkCount !== 1
        || typeof mtimeNs !== 'string'
        || !MIGRATION_SIGNED_INTEGER_RE.test(mtimeNs)
        || typeof ctimeNs !== 'string'
        || !MIGRATION_SIGNED_INTEGER_RE.test(ctimeNs)
        || typeof digest !== 'string'
        || !MIGRATION_DIGEST_RE.test(digest)) {
        return undefined;
    }
    return {
        path: destPath,
        device,
        inode,
        size,
        linkCount: 1,
        mtimeNs,
        ctimeNs,
        sha256: digest,
    };
}
function parseCanonicalMigrationState(raw) {
    if (raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_MIGRATION_STATE_BYTES) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const record = parsed;
    const version = record['version'];
    const destPath = record['destPath'];
    const attemptedAt = record['attemptedAt'];
    if (record['schemaVersion'] !== 1
        || typeof version !== 'string'
        || version.length > 128
        || ops.normalizeConcreteVersion(version) !== version
        || typeof destPath !== 'string'
        || !isAbsolute(destPath)
        || destPath.length > 4_096
        || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(destPath)
        || !exactMigrationTimestamp(attemptedAt)) {
        return undefined;
    }
    const base = { schemaVersion: 1, version, destPath, attemptedAt };
    const baseKeys = ['schemaVersion', 'state', 'version', 'destPath', 'attemptedAt'];
    if (record['state'] === 'in_progress') {
        if (record['reason'] === undefined) {
            return exactMigrationRecordKeys(record, baseKeys) ? { ...base, state: 'in_progress' } : undefined;
        }
        return record['reason'] === 'install_recovered'
            && exactMigrationRecordKeys(record, [...baseKeys, 'reason'])
            ? { ...base, state: 'in_progress', reason: 'install_recovered' }
            : undefined;
    }
    if (record['state'] === 'failed') {
        return exactMigrationRecordKeys(record, [...baseKeys, 'reason'])
            && boundedMigrationStateText(record['reason'], 1_024)
            ? { ...base, state: 'failed', reason: record['reason'] }
            : undefined;
    }
    if (record['state'] === 'installing') {
        const installAnchor = parseMigrationInstallAnchor(record['installAnchor'], destPath);
        return installAnchor && exactMigrationRecordKeys(record, [...baseKeys, 'installAnchor'])
            ? { ...base, state: 'installing', installAnchor }
            : undefined;
    }
    const intentId = record['intentId'];
    const targetIdentity = parseMigrationTargetIdentity(record['targetIdentity'], destPath);
    const installOwnership = parseMigrationInstallOwnership(record['installOwnership']);
    const hasRegistrationBase = typeof intentId === 'string'
        && MIGRATION_UUID_RE.test(intentId)
        && targetIdentity !== undefined
        && installOwnership !== undefined;
    if (record['state'] === 'registering' || record['state'] === 'committed') {
        return hasRegistrationBase
            && exactMigrationRecordKeys(record, [...baseKeys, 'intentId', 'targetIdentity', 'installOwnership'])
            ? { ...base, state: record['state'], intentId, targetIdentity, installOwnership }
            : undefined;
    }
    if (record['state'] === 'rollback_pending') {
        return hasRegistrationBase
            && boundedMigrationStateText(record['reason'], 1_024)
            && exactMigrationRecordKeys(record, [...baseKeys, 'intentId', 'targetIdentity', 'installOwnership', 'reason'])
            ? {
                ...base,
                state: 'rollback_pending',
                intentId,
                targetIdentity,
                installOwnership,
                reason: record['reason'],
            }
            : undefined;
    }
    if (record['state'] === 'blocked') {
        return hasRegistrationBase
            && boundedMigrationStateText(record['reason'], 1_024)
            && exactMigrationRecordKeys(record, [...baseKeys, 'intentId', 'targetIdentity', 'installOwnership', 'reason'])
            ? {
                ...base,
                state: 'blocked',
                intentId,
                targetIdentity,
                installOwnership,
                reason: record['reason'],
            }
            : undefined;
    }
    if (record['state'] !== 'rolled_back'
        || !boundedMigrationStateText(record['reason'], 1_024)) {
        return undefined;
    }
    const installAnchor = parseMigrationInstallAnchor(record['installAnchor'], destPath);
    if (installAnchor
        && exactMigrationRecordKeys(record, [...baseKeys, 'reason', 'installAnchor'])) {
        return { ...base, state: 'rolled_back', reason: record['reason'], installAnchor };
    }
    return hasRegistrationBase
        && exactMigrationRecordKeys(record, [...baseKeys, 'reason', 'intentId', 'targetIdentity', 'installOwnership'])
        ? {
            ...base,
            state: 'rolled_back',
            reason: record['reason'],
            intentId,
            targetIdentity,
            installOwnership,
        }
        : undefined;
}
function inspectMigrationStartupState(env, options) {
    let raw;
    try {
        raw = readTrustedMigrationStateText(join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE), options);
    }
    catch (error) {
        return { classification: 'unsafe', canonicalPresent: true, detail: errorDetail(error) };
    }
    if (raw === undefined)
        return { classification: 'none', canonicalPresent: false };
    const record = parseCanonicalMigrationState(raw);
    if (!record) {
        return { classification: 'unsafe', canonicalPresent: true, detail: 'migration_state_invalid' };
    }
    if (record.state === 'rolled_back' || record.state === 'failed') {
        return { classification: 'none', canonicalPresent: true };
    }
    return { classification: 'retryable', canonicalPresent: true, record, raw };
}
function serializeMigrationState(record, options) {
    const payload = {
        schemaVersion: 1,
        ...record,
        attemptedAt: new Date(options.now ?? Date.now()).toISOString(),
    };
    return `${JSON.stringify(payload)}\n`;
}
function persistAuthoritativeMigrationState(env, record, options) {
    const payload = serializeMigrationState(record, options);
    const path = join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE);
    const write = options.writeFile ?? defaultWriteTextFile;
    write(path, payload);
    if (readTrustedMigrationStateText(path, options) !== payload) {
        throw new Error('migration_state_durability_unconfirmed');
    }
    return payload;
}
function assertAuthoritativeMigrationStateCurrent(env, expectedPayload, options) {
    if (readTrustedMigrationStateText(join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE), options)
        !== expectedPayload) {
        throw new Error('migration_registration_intent_changed');
    }
}
function writeMigrationState(env, record, options) {
    try {
        const payload = serializeMigrationState(record, options);
        const write = options.writeFile ?? defaultWriteTextFile;
        write(join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE), payload);
    }
    catch {
        // Pre-registration diagnostics are advisory; registration intent is persisted separately.
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
    const raw = err instanceof Error ? err.message : String(err);
    const normalized = raw
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return normalized.slice(0, MAX_MIGRATION_DETAIL_LENGTH) || 'unknown';
}
function registrationReason(reason) {
    const normalized = errorDetail(reason);
    return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : undefined;
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function migrationPathKey(path) {
    const resolved = resolvePath(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function trustedWindowsSystemExecutable(name) {
    if (!win32.isAbsolute(HOST_WINDOWS_SYSTEM_ROOT) || /[\r\n\0]/.test(HOST_WINDOWS_SYSTEM_ROOT)) {
        throw new Error('Windows SystemRoot is not an absolute trusted path');
    }
    return win32.join(HOST_WINDOWS_SYSTEM_ROOT, 'System32', name);
}
function windowsMigrationAclScript(checks) {
    const encodedChecks = Buffer.from(JSON.stringify(checks), 'utf8').toString('base64');
    return [
        `$ErrorActionPreference = 'Stop'`,
        'try {',
        `  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedChecks}'))`,
        '  $checks = $json | ConvertFrom-Json',
        ...windowsMigrationAclRules().map((line) => `  ${line}`),
        '} catch { exit 24 }',
    ].join('; ');
}
function windowsMigrationAclRules() {
    const d = String.fromCharCode(36);
    return [
        `${d}userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
        `${d}trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'`,
        ...windowsMigrationAclPermissionRules(d),
    ];
}
function windowsMigrationAclPermissionRules(d) {
    return [
        `${d}trustedOwners = @(${d}userSid, 'S-1-5-18', 'S-1-5-32-544', ${d}trustedInstaller)`,
        `${d}trustedWriters = @(${d}userSid, 'S-1-5-18', 'S-1-5-32-544', ${d}trustedInstaller, 'S-1-3-0', 'S-1-3-4')`,
        `${d}parentDanger = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership`,
        `${d}contentDanger = [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories`,
        ...windowsMigrationAclLoopRules(d),
    ];
}
function windowsMigrationAclLoopRules(d) {
    return [
        `foreach (${d}check in @(${d}checks)) {`,
        `  ${d}acl = Get-Acl -LiteralPath ${d}check.path`,
        `  ${d}owner = ${d}acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`,
        `  if (${d}trustedOwners -notcontains ${d}owner) { exit 21 }`,
        `  ${d}danger = if (${d}check.parentOnly) { ${d}parentDanger } else { ${d}parentDanger -bor ${d}contentDanger }`,
        `  foreach (${d}rule in @(${d}acl.Access)) {`,
        `    if (${d}rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }`,
        `    if ((${d}rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }`,
        `    if ((${d}rule.FileSystemRights -band ${d}danger) -eq 0) { continue }`,
        `    try { ${d}sid = ${d}rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { exit 22 }`,
        `    if (${d}trustedWriters -notcontains ${d}sid) { exit 23 }`,
        '  }',
        '}',
    ];
}
function assertWindowsMigrationAclTrusted(checks) {
    if (process.platform !== 'win32' || checks.length === 0)
        return;
    try {
        execFileSync(trustedWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', windowsMigrationAclScript(checks)], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    }
    catch (error) {
        throw new Error('migration Windows ACL chain is not trusted', { cause: error });
    }
}
function assertTrustedMigrationDirectoryChainSync(directory) {
    let current = resolvePath(directory);
    const root = parsePath(current).root;
    const windowsChecks = [];
    const uid = resolveProcessUid();
    let nearestExisting = true;
    let privateUserAnchor = false;
    for (;;) {
        let info;
        try {
            info = lstatSync(current);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            if (current === root)
                break;
            current = dirname(current);
            continue;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('unsafe_migration_state_directory');
        }
        if (process.platform === 'win32') {
            windowsChecks.push({ path: current, parentOnly: windowsChecks.length > 0 });
        }
        else {
            if (uid !== undefined && info.uid !== uid && (nearestExisting || info.uid !== 0)) {
                throw new Error('migration_state_directory_untrusted_owner');
            }
            const writableByOthers = (info.mode & 0o022) !== 0;
            const trustedStickyAncestor = !nearestExisting
                && privateUserAnchor
                && info.uid === 0
                && (info.mode & 0o1000) !== 0;
            if (writableByOthers && !trustedStickyAncestor) {
                throw new Error('migration_state_directory_group_or_world_writable');
            }
            if (info.uid === uid && (info.mode & 0o077) === 0)
                privateUserAnchor = true;
        }
        nearestExisting = false;
        if (current === root)
            break;
        current = dirname(current);
    }
    assertWindowsMigrationAclTrusted(windowsChecks);
}
function unresolvedLegacyMigrationOwnership(env, readFile) {
    try {
        const raw = readFile(join(resolveBootstrapStateDir(env), BOOTSTRAP_ATTEMPT_FILE));
        if (raw.length === 0 || raw.length > 4 * 1024)
            return false;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return false;
        const outcome = parsed['outcome'];
        return outcome === 'migration_ambiguous' || outcome === 'migrated' || outcome === 'completed';
    }
    catch {
        return false;
    }
}
async function assertTrustedMigrationDirectoryChain(directory, effectiveUid = resolveProcessUid()) {
    let current = resolvePath(directory);
    const root = parsePath(current).root;
    const windowsChecks = [];
    const uid = effectiveUid;
    let nearestExisting = true;
    let privateUserAnchor = false;
    for (;;) {
        let info;
        try {
            info = await lstat(current);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            if (current === root)
                break;
            current = dirname(current);
            continue;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('unsafe_migration_target_directory');
        }
        if (process.platform === 'win32') {
            windowsChecks.push({ path: current, parentOnly: windowsChecks.length > 0 });
        }
        else {
            if (uid !== undefined && info.uid !== uid && (nearestExisting || info.uid !== 0)) {
                throw new Error('migration_target_directory_untrusted_owner');
            }
            const writableByOthers = (info.mode & 0o022) !== 0;
            const trustedStickyAncestor = !nearestExisting
                && privateUserAnchor
                && info.uid === 0
                && (info.mode & 0o1000) !== 0;
            if (writableByOthers && !trustedStickyAncestor) {
                throw new Error('migration_target_directory_group_or_world_writable');
            }
            if (info.uid === uid && (info.mode & 0o077) === 0)
                privateUserAnchor = true;
        }
        nearestExisting = false;
        if (current === root)
            break;
        current = dirname(current);
    }
    assertWindowsMigrationAclTrusted(windowsChecks);
}
async function assertTrustedMigrationFile(path, effectiveUid = resolveProcessUid()) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error('destination_exists_unowned_or_invalid');
    }
    if (process.platform === 'win32') {
        assertWindowsMigrationAclTrusted([{ path, parentOnly: false }]);
        return;
    }
    const uid = effectiveUid;
    if (uid !== undefined && info.uid !== uid) {
        throw new Error('migration_target_file_untrusted_owner');
    }
    if ((info.mode & 0o022) !== 0) {
        throw new Error('migration_target_file_group_or_world_writable');
    }
}
async function ensureSafeMigrationTargetDirectory(home, directory, mkdir, assertDirectoryTrust) {
    const absoluteHome = resolvePath(home);
    const absoluteDirectory = resolvePath(directory);
    if (relative(absoluteHome, absoluteDirectory) !== 'bin') {
        throw new Error('migration_target_outside_home');
    }
    await ensureSafeMigrationDirectory(absoluteDirectory, mkdir, assertDirectoryTrust);
}
async function assertSafeExistingMigrationTargetDirectory(home, directory, assertDirectoryTrust) {
    const absoluteHome = resolvePath(home);
    const absoluteDirectory = resolvePath(directory);
    if (relative(absoluteHome, absoluteDirectory) !== 'bin') {
        throw new Error('migration_target_outside_home');
    }
    await assertDirectoryTrust(absoluteDirectory);
    let info;
    try {
        info = await lstat(absoluteDirectory);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return;
        throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('unsafe_migration_target_directory');
    }
    const canonicalDirectory = await fsRealpath(absoluteDirectory);
    if (migrationPathKey(canonicalDirectory) !== migrationPathKey(absoluteDirectory)) {
        throw new Error('unsafe_migration_target_directory');
    }
}
async function ensureSafeMigrationDirectory(directory, mkdir, assertDirectoryTrust) {
    const absoluteDirectory = resolvePath(directory);
    // Validate the existing ancestor before mkdir, then validate the complete canonical tree.
    // This rejects symlinked or non-directory components instead of writing through them.
    await assertDirectoryTrust(absoluteDirectory);
    await mkdir(absoluteDirectory, 0o700);
    await assertDirectoryTrust(absoluteDirectory);
    const canonicalDirectory = await fsRealpath(absoluteDirectory);
    if (migrationPathKey(canonicalDirectory) !== migrationPathKey(absoluteDirectory)) {
        throw new Error('unsafe_migration_target_directory');
    }
}
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
async function inspectExistingMigrationTarget(destPath, version, preflight, readBinary, expected, assertDirectoryTrust, assertFileTrust) {
    let before;
    try {
        before = await lstat(destPath, { bigint: true });
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || before.dev <= 0n || before.ino <= 0n) {
        throw new Error('destination_exists_unowned_or_invalid');
    }
    await assertDirectoryTrust(dirname(destPath));
    await assertFileTrust(destPath);
    if (before.nlink !== 1n)
        throw new Error('destination_exists_with_external_hardlink');
    if (before.size !== BigInt(expected.size))
        throw new Error('destination_exists_with_different_artifact');
    const existingBytes = await readBinary(destPath);
    if (existingBytes.byteLength !== expected.size || sha256(existingBytes) !== expected.sha256) {
        throw new Error('destination_exists_with_different_artifact');
    }
    try {
        await preflight(destPath, version);
    }
    catch (error) {
        throw new Error(`destination_exists_unowned_or_invalid:${errorDetail(error)}`, { cause: error });
    }
    await assertFileTrust(destPath);
    const after = await lstat(destPath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
        || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw new Error('destination_changed_during_validation');
    }
    return {
        path: resolvePath(destPath),
        device: before.dev.toString(),
        inode: before.ino.toString(),
        size: expected.size,
        linkCount: 1,
        mtimeNs: before.mtimeNs.toString(),
        ctimeNs: before.ctimeNs.toString(),
        sha256: expected.sha256,
    };
}
function sameMigrationTargetIdentity(left, right) {
    return left.path === right.path
        && left.device === right.device
        && left.inode === right.inode
        && left.size === right.size
        && left.linkCount === right.linkCount
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
        && left.sha256 === right.sha256;
}
function assertMigrationTargetIdentityShape(identity) {
    if (!isAbsolute(identity.path) || migrationPathKey(identity.path) !== migrationPathKey(resolvePath(identity.path))) {
        throw new Error('migration_target_identity_path_invalid');
    }
    if (!Number.isSafeInteger(identity.size) || identity.size < 0
        || identity.linkCount !== 1
        || !/^[0-9]+$/.test(identity.device)
        || !/^[0-9]+$/.test(identity.inode)
        || !/^-?[0-9]+$/.test(identity.mtimeNs)
        || !/^-?[0-9]+$/.test(identity.ctimeNs)
        || !/^[0-9a-f]{64}$/.test(identity.sha256)) {
        throw new Error('migration_target_identity_invalid');
    }
}
/**
 * Revalidate the complete signed executable identity immediately before lifecycle bootstrap
 * spawns it. Callers must not substitute the request's presentation object for this check.
 */
async function assertMigrationTargetIdentityCurrent(identity, expectedVersion, options = {}) {
    assertMigrationTargetIdentityShape(identity);
    const readBinary = options.readBinary ?? ((path) => fsReadFile(path));
    const preflight = options.preflightFn
        ?? ((path, version) => preflightManagedStagedBinary(path, version));
    const assertDirectoryTrust = options.assertDirectoryTrust ?? assertTrustedMigrationDirectoryChain;
    const assertFileTrust = options.assertFileTrust ?? assertTrustedMigrationFile;
    const current = await inspectExistingMigrationTarget(identity.path, expectedVersion, preflight, readBinary, { sha256: identity.sha256, size: identity.size }, assertDirectoryTrust, assertFileTrust);
    if (!current || !sameMigrationTargetIdentity(current, identity)) {
        throw new Error('migration_target_identity_changed');
    }
}
const MAX_MIGRATION_LOCK_BYTES = 4_096;
function assertMigrationLockSnapshotShape(snapshot) {
    if (snapshot.isSymbolicLink()
        || !snapshot.isFile()
        || snapshot.nlink !== 1n
        || snapshot.size > BigInt(MAX_MIGRATION_LOCK_BYTES)) {
        throw new Error('migration_lock_ownership_changed');
    }
}
function sameMigrationLockSnapshot(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.nlink === 1n
        && right.nlink === 1n
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function readBoundedMigrationLockFd(fd) {
    const bytes = Buffer.allocUnsafe(MAX_MIGRATION_LOCK_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (read === 0)
            break;
        offset += read;
    }
    if (offset > MAX_MIGRATION_LOCK_BYTES)
        throw new Error('migration_lock_ownership_changed');
    return bytes.subarray(0, offset);
}
function readMigrationLockAuthority(lockPath) {
    const beforeOpen = lstatSync(lockPath, { bigint: true });
    assertMigrationLockSnapshotShape(beforeOpen);
    const fd = openSync(lockPath, 'r');
    try {
        const opened = fstatSync(fd, { bigint: true });
        assertMigrationLockSnapshotShape(opened);
        if (!sameMigrationLockSnapshot(beforeOpen, opened)) {
            throw new Error('migration_lock_ownership_changed');
        }
        const firstBytes = readBoundedMigrationLockFd(fd);
        const afterFirstFd = fstatSync(fd, { bigint: true });
        const afterFirstPath = lstatSync(lockPath, { bigint: true });
        const secondBytes = readBoundedMigrationLockFd(fd);
        const finalFd = fstatSync(fd, { bigint: true });
        const finalPath = lstatSync(lockPath, { bigint: true });
        for (const snapshot of [afterFirstFd, afterFirstPath, finalFd, finalPath]) {
            assertMigrationLockSnapshotShape(snapshot);
            if (!sameMigrationLockSnapshot(opened, snapshot)) {
                throw new Error('migration_lock_ownership_changed');
            }
        }
        if (opened.size !== BigInt(firstBytes.byteLength)
            || finalFd.size !== BigInt(secondBytes.byteLength)
            || !firstBytes.equals(secondBytes)) {
            throw new Error('migration_lock_ownership_changed');
        }
        return { snapshot: opened, bytes: Buffer.from(firstBytes) };
    }
    finally {
        closeSync(fd);
    }
}
function assertMigrationLockOwnerRecord(bytes, owner) {
    let current;
    try {
        current = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new Error('migration_lock_ownership_changed');
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('migration_lock_ownership_changed');
    }
    const record = current;
    if (record['pid'] !== owner.pid
        || record['token'] !== owner.token
        || JSON.stringify(record['processStart']) !== JSON.stringify(owner.processStartIdentity)) {
        throw new Error('migration_lock_ownership_changed');
    }
}
async function withMigrationLock(directory, operation) {
    const lockPath = join(directory, MIGRATION_LOCK_FILE);
    let owner;
    try {
        owner = util.acquireLock(lockPath, { maxTries: 1, waitMs: 0 });
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null ? error.code : undefined;
        throw new Error(code === 'LOCK_TIMEOUT' ? 'migration_lock_busy' : `migration_lock_unsafe:${errorDetail(error)}`, {
            cause: error,
        });
    }
    let acquiredAuthority;
    try {
        acquiredAuthority = readMigrationLockAuthority(lockPath);
        assertMigrationLockOwnerRecord(acquiredAuthority.bytes, owner);
    }
    catch (error) {
        util.releaseLock(lockPath);
        throw error;
    }
    let completed = false;
    let value;
    let operationError;
    const assertOwnershipCurrent = () => {
        const currentAuthority = readMigrationLockAuthority(lockPath);
        if (!sameMigrationLockSnapshot(acquiredAuthority.snapshot, currentAuthority.snapshot)
            || !acquiredAuthority.bytes.equals(currentAuthority.bytes)) {
            throw new Error('migration_lock_ownership_changed');
        }
        assertMigrationLockOwnerRecord(currentAuthority.bytes, owner);
    };
    try {
        assertOwnershipCurrent();
        value = await operation(assertOwnershipCurrent);
        assertOwnershipCurrent();
        completed = true;
    }
    catch (error) {
        operationError = error;
    }
    const released = util.releaseLock(lockPath);
    if (!released.released
        || (released.reason !== 'released' && released.reason !== 'released_with_cleanup_error')) {
        throw new Error(`migration_lock_release_failed:${released.reason}`, { cause: operationError });
    }
    if (!completed)
        throw operationError;
    return value;
}
async function installVerifiedMigrationBinary(input) {
    const directory = dirname(input.destPath);
    // Read-only validation and convergence detection happen before the durable plan. The plan is
    // then published before mkdir or O_EXCL temporary-file creation touches the target namespace.
    await input.assertDirectoryTrust(directory);
    let directoryCreated = false;
    try {
        await lstat(directory);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
        directoryCreated = true;
    }
    const existingIdentity = await inspectExistingMigrationTarget(input.destPath, input.version, input.preflight, input.readBinary, { sha256: input.expectedSha256, size: input.bytes.byteLength }, input.assertDirectoryTrust, input.assertFileTrust);
    if (existingIdentity) {
        return { disposition: 'converged', targetIdentity: existingIdentity, directoryCreated: false };
    }
    const temporaryPath = join(directory, `.${parsePath(input.destPath).base}.${process.pid}.${randomUUID()}.migration`);
    const plannedAnchor = {
        phase: 'planned',
        temporaryPath,
        size: input.bytes.byteLength,
        sha256: input.expectedSha256,
        directoryCreated,
    };
    await input.publishInstallIntent(plannedAnchor);
    let publishedAnchor;
    let materializedAnchor;
    let concurrentIdentity;
    try {
        await ensureSafeMigrationTargetDirectory(input.home, directory, input.mkdir, input.assertDirectoryTrust);
        if (directoryCreated) {
            await input.syncDirectory(dirname(directory));
        }
        await input.writeBinary(temporaryPath, input.bytes, 0o755);
        await input.chmod(temporaryPath, 0o755);
        await input.syncFile(temporaryPath);
        const temporaryInfo = await input.stat(temporaryPath);
        const temporaryIdentity = await lstat(temporaryPath, { bigint: true });
        if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile()
            || temporaryIdentity.isSymbolicLink() || !temporaryIdentity.isFile()
            || temporaryIdentity.nlink !== 1n || temporaryIdentity.dev <= 0n || temporaryIdentity.ino <= 0n) {
            throw new Error('migration_temporary_not_owned_regular_file');
        }
        const publishedBytes = await input.readBinary(temporaryPath);
        if (publishedBytes.byteLength !== input.bytes.byteLength || sha256(publishedBytes) !== input.expectedSha256) {
            throw new Error('migration_temporary_hash_mismatch');
        }
        if (temporaryIdentity.size !== BigInt(input.bytes.byteLength)) {
            throw new Error('migration_temporary_size_mismatch');
        }
        materializedAnchor = {
            phase: 'materialized',
            temporaryPath,
            device: temporaryIdentity.dev.toString(),
            inode: temporaryIdentity.ino.toString(),
            size: input.bytes.byteLength,
            sha256: input.expectedSha256,
            directoryCreated,
        };
        await input.publishInstallIntent(materializedAnchor);
        try {
            await input.link(temporaryPath, input.destPath);
            publishedAnchor = {
                device: temporaryIdentity.dev,
                inode: temporaryIdentity.ino,
                size: temporaryIdentity.size,
            };
            await input.syncDirectory(directory);
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
            concurrentIdentity = await inspectExistingMigrationTarget(input.destPath, input.version, input.preflight, input.readBinary, { sha256: input.expectedSha256, size: input.bytes.byteLength }, input.assertDirectoryTrust, input.assertFileTrust);
            if (!concurrentIdentity)
                throw error;
        }
    }
    catch (error) {
        if (!materializedAnchor) {
            throw new Error(`migration_install_rollback_unconfirmed:planned_materialization_unconfirmed:${errorDetail(error)}`, { cause: error });
        }
        try {
            await removeMaterializedMigrationTemporaryFile({
                anchor: materializedAnchor,
                readBinary: input.readBinary,
                rename: input.rename,
                link: input.link,
                unlink: input.unlink,
                syncDirectory: input.syncDirectory,
                assertFileTrust: input.assertFileTrust,
            });
            if (publishedAnchor) {
                await rollbackPublishedMigrationTarget(input, publishedAnchor, materializedAnchor, directoryCreated);
            }
            else if (directoryCreated) {
                await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
            }
        }
        catch (rollbackError) {
            throw new Error(`migration_install_rollback_unconfirmed:${errorDetail(rollbackError)}`, { cause: error });
        }
        throw error;
    }
    try {
        // Remove our temporary hardlink before enforcing the final target's nlink=1 invariant.
        if (!materializedAnchor)
            throw new Error('migration_materialized_anchor_missing');
        await removeMaterializedMigrationTemporaryFile({
            anchor: materializedAnchor,
            readBinary: input.readBinary,
            rename: input.rename,
            link: input.link,
            unlink: input.unlink,
            syncDirectory: input.syncDirectory,
            assertFileTrust: input.assertFileTrust,
        });
    }
    catch (error) {
        throw new Error(`migration_install_rollback_unconfirmed:temporary_cleanup:${errorDetail(error)}`);
    }
    if (concurrentIdentity) {
        return { disposition: 'converged', targetIdentity: concurrentIdentity, directoryCreated: false };
    }
    if (!publishedAnchor)
        throw new Error('published_migration_target_missing');
    try {
        const installedIdentity = await inspectExistingMigrationTarget(input.destPath, input.version, input.preflight, input.readBinary, { sha256: input.expectedSha256, size: input.bytes.byteLength }, input.assertDirectoryTrust, input.assertFileTrust);
        if (!installedIdentity)
            throw new Error('published_migration_target_missing');
        return { disposition: 'installed', targetIdentity: installedIdentity, directoryCreated };
    }
    catch (error) {
        try {
            await rollbackPublishedMigrationTarget(input, publishedAnchor, materializedAnchor, directoryCreated);
        }
        catch (rollbackError) {
            throw new Error(`migration_install_rollback_unconfirmed:${errorDetail(rollbackError)}`, { cause: error });
        }
        throw error;
    }
}
function migrationTemporaryCleanupQuarantinePath(temporaryPath) {
    return `${temporaryPath}.cleanup`;
}
function migrationInstallTargetQuarantinePath(anchor) {
    return `${anchor.temporaryPath}.target-rollback`;
}
function migrationRegistrationTargetQuarantinePath(destPath, intentId) {
    return join(dirname(destPath), `.${parsePath(destPath).base}.${intentId}.rollback`);
}
async function migrationPathIdentity(path) {
    try {
        return await lstat(path, { bigint: true });
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
function sameMigrationFileId(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
async function inspectExactMigrationCleanupFile(input) {
    const before = await lstat(input.path, { bigint: true });
    await input.assertFileTrust(input.path);
    if (before.isSymbolicLink()
        || !before.isFile()
        || !input.allowedLinkCounts.includes(before.nlink)
        || before.dev.toString() !== input.expected.device
        || before.ino.toString() !== input.expected.inode
        || before.size !== BigInt(input.expected.size)) {
        throw new Error(input.identityError);
    }
    const bytes = await input.readBinary(input.path);
    if (bytes.byteLength !== input.expected.size || sha256(bytes) !== input.expected.sha256) {
        throw new Error(input.hashError);
    }
    const after = await lstat(input.path, { bigint: true });
    if (after.isSymbolicLink()
        || !after.isFile()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.nlink !== before.nlink
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs) {
        throw new Error(input.identityError);
    }
    return after;
}
async function restoreMismatchedMigrationQuarantine(input) {
    const directory = dirname(input.sourcePath);
    const sourceIdentity = await migrationPathIdentity(input.sourcePath);
    if (sourceIdentity && !sameMigrationFileId(sourceIdentity, input.quarantineIdentity)) {
        throw new Error(`${input.errorPrefix}_quarantine_preserved_canonical_occupied`, { cause: input.reason });
    }
    if (!sourceIdentity) {
        try {
            await input.link(input.quarantinePath, input.sourcePath);
            await input.syncDirectory(directory);
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
            throw new Error(`${input.errorPrefix}_quarantine_preserved_restore_conflict`, { cause: input.reason });
        }
    }
    const restoredIdentity = await migrationPathIdentity(input.sourcePath);
    const currentQuarantineIdentity = await migrationPathIdentity(input.quarantinePath);
    if (!restoredIdentity || !currentQuarantineIdentity
        || !sameMigrationFileId(restoredIdentity, currentQuarantineIdentity)
        || !sameMigrationFileId(currentQuarantineIdentity, input.quarantineIdentity)) {
        throw new Error(`${input.errorPrefix}_quarantine_preserved_restore_inconclusive`, { cause: input.reason });
    }
    await input.unlink(input.quarantinePath);
    await input.syncDirectory(directory);
    throw new Error(`${input.errorPrefix}_moved_object_restored`, { cause: input.reason });
}
async function quarantineAndRemoveExactMigrationFile(input) {
    const directory = dirname(input.sourcePath);
    let quarantineIdentity = await migrationPathIdentity(input.quarantinePath);
    if (quarantineIdentity) {
        try {
            quarantineIdentity = await inspectExactMigrationCleanupFile({
                path: input.quarantinePath,
                expected: input.expected,
                allowedLinkCounts: input.allowedLinkCounts,
                readBinary: input.readBinary,
                assertFileTrust: input.assertFileTrust,
                identityError: input.identityError,
                hashError: input.hashError,
            });
        }
        catch (error) {
            await restoreMismatchedMigrationQuarantine({
                sourcePath: input.sourcePath,
                quarantinePath: input.quarantinePath,
                quarantineIdentity,
                link: input.link,
                unlink: input.unlink,
                syncDirectory: input.syncDirectory,
                reason: error,
                errorPrefix: input.errorPrefix,
            });
        }
        const sourceIdentity = await migrationPathIdentity(input.sourcePath);
        if (sourceIdentity) {
            if (!sameMigrationFileId(sourceIdentity, quarantineIdentity)) {
                throw new Error(`${input.errorPrefix}_quarantine_preserved_canonical_occupied`);
            }
            await input.unlink(input.quarantinePath);
            await input.syncDirectory(directory);
            quarantineIdentity = undefined;
        }
        else {
            await inspectExactMigrationCleanupFile({
                path: input.quarantinePath,
                expected: input.expected,
                allowedLinkCounts: input.allowedLinkCounts,
                readBinary: input.readBinary,
                assertFileTrust: input.assertFileTrust,
                identityError: input.identityError,
                hashError: input.hashError,
            });
            await input.unlink(input.quarantinePath);
            await input.syncDirectory(directory);
            return;
        }
    }
    const sourceIdentity = await migrationPathIdentity(input.sourcePath);
    if (!sourceIdentity)
        return;
    await inspectExactMigrationCleanupFile({
        path: input.sourcePath,
        expected: input.expected,
        allowedLinkCounts: input.allowedLinkCounts,
        readBinary: input.readBinary,
        assertFileTrust: input.assertFileTrust,
        identityError: input.identityError,
        hashError: input.hashError,
    });
    if (await migrationPathIdentity(input.quarantinePath)) {
        throw new Error(`${input.errorPrefix}_quarantine_occupied`);
    }
    await input.rename(input.sourcePath, input.quarantinePath);
    await input.syncDirectory(directory);
    let movedIdentity = await migrationPathIdentity(input.quarantinePath);
    if (!movedIdentity)
        throw new Error(`${input.errorPrefix}_quarantine_missing_after_move`);
    try {
        movedIdentity = await inspectExactMigrationCleanupFile({
            path: input.quarantinePath,
            expected: input.expected,
            allowedLinkCounts: input.allowedLinkCounts,
            readBinary: input.readBinary,
            assertFileTrust: input.assertFileTrust,
            identityError: input.identityError,
            hashError: input.hashError,
        });
    }
    catch (error) {
        await restoreMismatchedMigrationQuarantine({
            sourcePath: input.sourcePath,
            quarantinePath: input.quarantinePath,
            quarantineIdentity: movedIdentity,
            link: input.link,
            unlink: input.unlink,
            syncDirectory: input.syncDirectory,
            reason: error,
            errorPrefix: input.errorPrefix,
        });
    }
    if (await migrationPathIdentity(input.sourcePath)) {
        throw new Error(`${input.errorPrefix}_quarantine_preserved_canonical_recreated`);
    }
    await inspectExactMigrationCleanupFile({
        path: input.quarantinePath,
        expected: input.expected,
        allowedLinkCounts: input.allowedLinkCounts,
        readBinary: input.readBinary,
        assertFileTrust: input.assertFileTrust,
        identityError: input.identityError,
        hashError: input.hashError,
    });
    await input.unlink(input.quarantinePath);
    await input.syncDirectory(directory);
}
async function removeMaterializedMigrationTemporaryFile(input) {
    await quarantineAndRemoveExactMigrationFile({
        sourcePath: input.anchor.temporaryPath,
        quarantinePath: migrationTemporaryCleanupQuarantinePath(input.anchor.temporaryPath),
        expected: input.anchor,
        allowedLinkCounts: [1n, 2n],
        readBinary: input.readBinary,
        rename: input.rename,
        link: input.link,
        unlink: input.unlink,
        syncDirectory: input.syncDirectory,
        assertFileTrust: input.assertFileTrust,
        identityError: 'migration_materialized_temporary_identity_changed',
        hashError: 'migration_materialized_temporary_hash_changed',
        errorPrefix: 'migration_materialized_temporary_cleanup',
    });
}
function parsePendingMigrationInstall(raw) {
    const record = parseCanonicalMigrationState(raw);
    if (!record)
        throw new Error('migration_install_journal_invalid');
    if (record.state !== 'installing')
        return undefined;
    return {
        version: record.version,
        destPath: record.destPath,
        anchor: record.installAnchor,
    };
}
async function recoverPendingMigrationInstall(input) {
    const initialAuthoritativePayload = readTrustedMigrationStateText(join(resolveBootstrapStateDir(input.env), MIGRATION_STATE_FILE), input.stateOptions);
    if (initialAuthoritativePayload === undefined)
        return false;
    let authoritativePayload = initialAuthoritativePayload;
    const pending = parsePendingMigrationInstall(authoritativePayload);
    if (!pending)
        return false;
    input.markCanonicalStateActive();
    const directory = dirname(pending.destPath);
    const storedHome = dirname(directory);
    const assertPendingCurrent = () => {
        input.assertOwnerCurrent();
        assertAuthoritativeMigrationStateCurrent(input.env, authoritativePayload, input.stateOptions);
    };
    assertPendingCurrent();
    await assertSafeExistingMigrationTargetDirectory(storedHome, directory, input.assertDirectoryTrust);
    const completeRecovery = () => {
        assertPendingCurrent();
        persistAuthoritativeMigrationState(input.env, {
            state: 'rolled_back',
            version: pending.version,
            destPath: pending.destPath,
            reason: 'install_recovered',
            installAnchor: pending.anchor,
        }, input.stateOptions);
    };
    if (pending.anchor.phase === 'planned') {
        let before;
        try {
            before = await lstat(pending.anchor.temporaryPath, { bigint: true });
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            if (pending.anchor.directoryCreated) {
                assertPendingCurrent();
                await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
                await input.syncDirectory(dirname(directory));
            }
            completeRecovery();
            return true;
        }
        await input.assertFileTrust(pending.anchor.temporaryPath);
        if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
            || before.dev <= 0n || before.ino <= 0n || before.size > BigInt(pending.anchor.size)) {
            throw new Error('migration_planned_temporary_unowned');
        }
        const bytes = await input.readBinary(pending.anchor.temporaryPath);
        const after = await lstat(pending.anchor.temporaryPath, { bigint: true });
        if (after.isSymbolicLink()
            || !after.isFile()
            || after.dev !== before.dev
            || after.ino !== before.ino
            || after.nlink !== before.nlink
            || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs
            || after.ctimeNs !== before.ctimeNs) {
            throw new Error('migration_planned_temporary_identity_changed');
        }
        if (bytes.byteLength !== Number(after.size)) {
            throw new Error('migration_planned_temporary_identity_changed');
        }
        const cleanupAnchor = {
            phase: 'cleanup',
            temporaryPath: pending.anchor.temporaryPath,
            device: after.dev.toString(),
            inode: after.ino.toString(),
            size: bytes.byteLength,
            sha256: sha256(bytes),
            directoryCreated: pending.anchor.directoryCreated,
        };
        assertPendingCurrent();
        authoritativePayload = persistAuthoritativeMigrationState(input.env, {
            state: 'installing',
            version: pending.version,
            destPath: pending.destPath,
            installAnchor: cleanupAnchor,
        }, input.stateOptions);
        await quarantineAndRemoveExactMigrationFile({
            sourcePath: cleanupAnchor.temporaryPath,
            quarantinePath: migrationTemporaryCleanupQuarantinePath(cleanupAnchor.temporaryPath),
            expected: cleanupAnchor,
            allowedLinkCounts: [1n],
            readBinary: input.readBinary,
            rename: input.rename,
            link: input.link,
            unlink: input.unlink,
            syncDirectory: input.syncDirectory,
            assertFileTrust: input.assertFileTrust,
            identityError: 'migration_planned_temporary_identity_changed',
            hashError: 'migration_planned_temporary_hash_changed',
            errorPrefix: 'migration_planned_temporary_cleanup',
        });
        if (pending.anchor.directoryCreated) {
            assertPendingCurrent();
            await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
            await input.syncDirectory(dirname(directory));
        }
        completeRecovery();
        return true;
    }
    if (pending.anchor.phase === 'cleanup') {
        await quarantineAndRemoveExactMigrationFile({
            sourcePath: pending.anchor.temporaryPath,
            quarantinePath: migrationTemporaryCleanupQuarantinePath(pending.anchor.temporaryPath),
            expected: pending.anchor,
            allowedLinkCounts: [1n],
            readBinary: input.readBinary,
            rename: input.rename,
            link: input.link,
            unlink: input.unlink,
            syncDirectory: input.syncDirectory,
            assertFileTrust: input.assertFileTrust,
            identityError: 'migration_planned_temporary_identity_changed',
            hashError: 'migration_planned_temporary_hash_changed',
            errorPrefix: 'migration_planned_temporary_cleanup',
        });
        if (pending.anchor.directoryCreated) {
            assertPendingCurrent();
            await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
            await input.syncDirectory(dirname(directory));
        }
        completeRecovery();
        return true;
    }
    const materializedAnchor = pending.anchor;
    assertPendingCurrent();
    await removeMaterializedMigrationTemporaryFile({
        anchor: materializedAnchor,
        readBinary: input.readBinary,
        rename: input.rename,
        link: input.link,
        unlink: input.unlink,
        syncDirectory: input.syncDirectory,
        assertFileTrust: input.assertFileTrust,
    });
    assertPendingCurrent();
    await rollbackPublishedMigrationTarget({
        destPath: pending.destPath,
        expectedSha256: materializedAnchor.sha256,
        readBinary: input.readBinary,
        rename: input.rename,
        link: input.link,
        unlink: input.unlink,
        rmdir: input.rmdir,
        syncDirectory: input.syncDirectory,
        assertFileTrust: input.assertFileTrust,
    }, {
        device: BigInt(materializedAnchor.device),
        inode: BigInt(materializedAnchor.inode),
        size: BigInt(materializedAnchor.size),
    }, materializedAnchor, false);
    if (materializedAnchor.directoryCreated) {
        assertPendingCurrent();
        await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
        await input.syncDirectory(dirname(directory));
    }
    completeRecovery();
    return true;
}
async function removeMigrationDirectoryIfEmpty(directory, rmdir) {
    try {
        await rmdir(directory);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY') && !isErrno(error, 'EEXIST')) {
            throw error;
        }
    }
}
async function rollbackPublishedMigrationTarget(input, anchor, materializedAnchor, directoryCreated) {
    await quarantineAndRemoveExactMigrationFile({
        sourcePath: input.destPath,
        quarantinePath: migrationInstallTargetQuarantinePath(materializedAnchor),
        expected: {
            device: anchor.device.toString(),
            inode: anchor.inode.toString(),
            size: Number(anchor.size),
            sha256: input.expectedSha256,
        },
        allowedLinkCounts: [1n],
        readBinary: input.readBinary,
        rename: input.rename,
        link: input.link,
        unlink: input.unlink,
        syncDirectory: input.syncDirectory,
        assertFileTrust: input.assertFileTrust,
        identityError: 'migration_install_rollback_identity_changed',
        hashError: 'migration_install_rollback_hash_changed',
        errorPrefix: 'migration_install_target_cleanup',
    });
    if (directoryCreated) {
        await removeMigrationDirectoryIfEmpty(dirname(input.destPath), input.rmdir);
        await input.syncDirectory(dirname(dirname(input.destPath)));
    }
}
async function cleanupInstalledMigrationBinary(input) {
    if (input.install.disposition !== 'installed')
        return;
    const directory = dirname(input.destPath);
    await input.assertAuthorityCurrent();
    await input.assertDirectoryTrust(directory);
    if (await migrationPathIdentity(input.destPath)) {
        const currentIdentity = await inspectExistingMigrationTarget(input.destPath, input.version, input.preflight, input.readBinary, { sha256: input.expectedSha256, size: input.install.targetIdentity.size }, input.assertDirectoryTrust, input.assertFileTrust);
        if (!currentIdentity || !sameMigrationTargetIdentity(currentIdentity, input.install.targetIdentity)) {
            throw new Error('migration_cleanup_target_identity_changed');
        }
    }
    await input.assertAuthorityCurrent();
    await quarantineAndRemoveExactMigrationFile({
        sourcePath: input.destPath,
        quarantinePath: input.quarantinePath,
        expected: input.install.targetIdentity,
        allowedLinkCounts: [1n],
        readBinary: input.readBinary,
        rename: input.rename,
        link: input.link,
        unlink: input.unlink,
        syncDirectory: input.syncDirectory,
        assertFileTrust: input.assertFileTrust,
        identityError: 'migration_cleanup_target_identity_changed',
        hashError: 'migration_cleanup_target_hash_changed',
        errorPrefix: 'migration_cleanup_target',
    });
    if (input.install.directoryCreated) {
        await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
        await input.syncDirectory(dirname(directory));
    }
}
function isCanonicalMigrationRegistrationState(record) {
    return record.state === 'registering' || record.state === 'blocked' || record.state === 'committed';
}
async function completeMigrationRollbackPending(input) {
    const assertCleanupAuthorityCurrent = async () => {
        await input.assertOwnerCurrent();
        assertAuthoritativeMigrationStateCurrent(input.env, input.expectedPayload, input.stateOptions);
    };
    const directory = dirname(input.record.destPath);
    const storedHome = dirname(directory);
    await assertCleanupAuthorityCurrent();
    await assertSafeExistingMigrationTargetDirectory(storedHome, directory, input.assertDirectoryTrust);
    if (input.record.installOwnership.disposition === 'installed') {
        const quarantinePath = migrationRegistrationTargetQuarantinePath(input.record.destPath, input.record.intentId);
        let targetPresent = true;
        try {
            await lstat(input.record.destPath);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            targetPresent = false;
        }
        const quarantinePresent = await migrationPathIdentity(quarantinePath) !== undefined;
        if (targetPresent || quarantinePresent) {
            await cleanupInstalledMigrationBinary({
                install: {
                    disposition: 'installed',
                    targetIdentity: input.record.targetIdentity,
                    directoryCreated: false,
                },
                destPath: input.record.destPath,
                version: input.record.version,
                expectedSha256: input.record.targetIdentity.sha256,
                quarantinePath,
                readBinary: input.readBinary,
                preflight: input.preflightFn,
                rename: input.rename,
                link: input.link,
                unlink: input.unlink,
                rmdir: input.rmdir,
                syncDirectory: input.syncDirectory,
                assertDirectoryTrust: input.assertDirectoryTrust,
                assertFileTrust: input.assertFileTrust,
                assertAuthorityCurrent: assertCleanupAuthorityCurrent,
            });
        }
        else if (!input.record.installOwnership.directoryCreated) {
            let directoryPresent = true;
            try {
                await lstat(directory);
            }
            catch (error) {
                if (!isErrno(error, 'ENOENT'))
                    throw error;
                directoryPresent = false;
            }
            await assertCleanupAuthorityCurrent();
            await input.syncDirectory(directoryPresent ? directory : dirname(directory));
        }
        if (input.record.installOwnership.directoryCreated) {
            await assertCleanupAuthorityCurrent();
            await removeMigrationDirectoryIfEmpty(directory, input.rmdir);
            await input.syncDirectory(dirname(directory));
        }
    }
    await assertCleanupAuthorityCurrent();
    persistAuthoritativeMigrationState(input.env, {
        state: 'rolled_back',
        version: input.record.version,
        destPath: input.record.destPath,
        intentId: input.record.intentId,
        targetIdentity: input.record.targetIdentity,
        installOwnership: input.record.installOwnership,
        reason: input.record.reason,
    }, input.stateOptions);
}
async function reconcileStoredMigrationInstall(input) {
    const { env, options, record, expectedPayload, stateOptions } = input;
    const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
    const failClosed = (reason, detail) => ({
        action: 'return',
        result: {
            outcome: 'failed',
            reason: `${code}:${reason}`,
            destPath: record.destPath,
            message: `one-time standalone migration recovery failed (${code}:${reason}:${errorDetail(detail)})`,
            requiresForegroundExit: true,
        },
    });
    const readBinary = options.readBinary ?? ((path) => fsReadFile(path));
    const rename = options.rename ?? ((from, to) => fsRename(from, to));
    const link = options.link ?? ((from, to) => fsLink(from, to));
    const unlink = options.unlink ?? ((path) => fsUnlink(path));
    const rmdir = options.rmdir ?? ((path) => fsRmdir(path));
    const uid = options.uid ?? resolveProcessUid();
    const assertDirectoryTrust = options.assertDirectoryTrust
        ?? ((directory) => assertTrustedMigrationDirectoryChain(directory, uid));
    const assertFileTrust = options.assertFileTrust
        ?? ((path) => assertTrustedMigrationFile(path, uid));
    const syncDirectory = options.syncDirectory ?? (async (path) => {
        let handle;
        try {
            handle = await fsOpen(path, 'r');
            await handle.sync();
        }
        catch (error) {
            if (process.platform !== 'win32')
                throw error;
        }
        finally {
            await handle?.close();
        }
    });
    try {
        return await withMigrationLock(resolveBootstrapStateDir(env), async (assertOwnerLeaseCurrent) => {
            assertOwnerLeaseCurrent();
            assertAuthoritativeMigrationStateCurrent(env, expectedPayload, stateOptions);
            const recovered = await recoverPendingMigrationInstall({
                env,
                stateOptions,
                readBinary,
                rename,
                link,
                unlink,
                rmdir,
                syncDirectory,
                assertDirectoryTrust,
                assertFileTrust,
                assertOwnerCurrent: assertOwnerLeaseCurrent,
                markCanonicalStateActive: () => undefined,
            });
            if (!recovered)
                return failClosed('stored_install_changed', 'stored installing state changed');
            return { action: 'retry_current' };
        });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'migration_lock_busy') {
            return failClosed('migration_in_progress', 'another live process owns migration recovery');
        }
        return failClosed('recovery_failed', errorDetail(error));
    }
}
async function reconcileStoredMigrationRollbackPending(input) {
    const { env, options, record, expectedPayload, stateOptions } = input;
    const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
    const failClosed = (reason, detail) => ({
        action: 'return',
        result: {
            outcome: 'failed',
            reason: `${code}:${reason}`,
            destPath: record.destPath,
            message: `one-time standalone migration rollback recovery failed (${code}:${reason}:${errorDetail(detail)})`,
            requiresForegroundExit: true,
        },
    });
    const readBinary = options.readBinary ?? ((path) => fsReadFile(path));
    const preflightFn = options.preflightFn
        ?? ((targetPath, expectedVersion) => preflightManagedStagedBinary(targetPath, expectedVersion, options.probe));
    const rename = options.rename ?? ((from, to) => fsRename(from, to));
    const link = options.link ?? ((from, to) => fsLink(from, to));
    const unlink = options.unlink ?? ((path) => fsUnlink(path));
    const rmdir = options.rmdir ?? ((path) => fsRmdir(path));
    const uid = options.uid ?? resolveProcessUid();
    const assertDirectoryTrust = options.assertDirectoryTrust
        ?? ((directory) => assertTrustedMigrationDirectoryChain(directory, uid));
    const assertFileTrust = options.assertFileTrust
        ?? ((path) => assertTrustedMigrationFile(path, uid));
    const syncDirectory = options.syncDirectory ?? (async (path) => {
        let handle;
        try {
            handle = await fsOpen(path, 'r');
            await handle.sync();
        }
        catch (error) {
            if (process.platform !== 'win32')
                throw error;
        }
        finally {
            await handle?.close();
        }
    });
    try {
        return await withMigrationLock(resolveBootstrapStateDir(env), async (assertOwnerLeaseCurrent) => {
            await completeMigrationRollbackPending({
                env,
                record,
                expectedPayload,
                stateOptions,
                readBinary,
                preflightFn,
                rename,
                link,
                unlink,
                rmdir,
                syncDirectory,
                assertDirectoryTrust,
                assertFileTrust,
                assertOwnerCurrent: assertOwnerLeaseCurrent,
            });
            return { action: 'retry_current' };
        });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'migration_lock_busy') {
            return failClosed('migration_in_progress', 'another live process owns migration rollback recovery');
        }
        return failClosed('rollback_cleanup_failed', errorDetail(error));
    }
}
async function reconcileStoredMigrationRegistration(input) {
    const { env, platform, options, record, expectedPayload, stateOptions } = input;
    const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
    const failed = (reason, message, _detail, requiresForegroundExit = false) => ({
        outcome: 'failed',
        reason,
        destPath: record.destPath,
        message,
        ...(requiresForegroundExit ? { requiresForegroundExit: true } : {}),
    });
    const timedOut = (reason, message, detail, requiresForegroundExit) => failed(reason, message, detail, requiresForegroundExit);
    const failClosed = (reason, detail) => ({
        action: 'return',
        result: {
            outcome: 'failed',
            reason: `${code}:${reason}`,
            destPath: record.destPath,
            message: `one-time standalone migration recovery failed (${code}:${reason}:${errorDetail(detail)})`,
            requiresForegroundExit: true,
        },
    });
    const timeoutMs = options.timeoutMs ?? MIGRATION_REGISTER_TIMEOUT_MS;
    const transactionBudgetMs = options.transactionBudgetMs ?? MIGRATION_REGISTER_TRANSACTION_BUDGET_MS;
    const readBinary = options.readBinary ?? ((path) => fsReadFile(path));
    const rename = options.rename ?? ((from, to) => fsRename(from, to));
    const link = options.link ?? ((from, to) => fsLink(from, to));
    const unlink = options.unlink ?? ((path) => fsUnlink(path));
    const rmdir = options.rmdir ?? ((path) => fsRmdir(path));
    const syncDirectory = options.syncDirectory ?? (async (path) => {
        let handle;
        try {
            handle = await fsOpen(path, 'r');
            await handle.sync();
        }
        catch (error) {
            if (process.platform !== 'win32')
                throw error;
        }
        finally {
            await handle?.close();
        }
    });
    const preflightFn = options.preflightFn
        ?? ((targetPath, expectedVersion) => preflightManagedStagedBinary(targetPath, expectedVersion, options.probe));
    const uid = options.uid ?? resolveProcessUid();
    const assertDirectoryTrust = options.assertDirectoryTrust
        ?? ((directory) => assertTrustedMigrationDirectoryChain(directory, uid));
    const assertFileTrust = options.assertFileTrust
        ?? ((path) => assertTrustedMigrationFile(path, uid));
    try {
        return await withMigrationLock(resolveBootstrapStateDir(env), async (assertOwnerLeaseCurrent) => {
            const assertStoredIntentCurrent = async () => {
                assertOwnerLeaseCurrent();
                assertAuthoritativeMigrationStateCurrent(env, expectedPayload, stateOptions);
            };
            const sealedIdentity = Object.freeze({ ...record.targetIdentity });
            const revalidateStoredTarget = () => assertMigrationTargetIdentityCurrent(sealedIdentity, record.version, { readBinary, preflightFn, assertDirectoryTrust, assertFileTrust });
            if (!Number.isSafeInteger(timeoutMs)
                || !Number.isSafeInteger(transactionBudgetMs)
                || timeoutMs <= transactionBudgetMs
                || timeoutMs > MAX_TIMER_DELAY_MS
                || transactionBudgetMs <= 0) {
                return failClosed('invalid_registration_timeout_contract', 'invalid registration timeout contract');
            }
            if (!options.registrationRunner) {
                return failClosed('registration_runner_unavailable', 'registration runner unavailable');
            }
            try {
                await assertStoredIntentCurrent();
                await revalidateStoredTarget();
            }
            catch (error) {
                return failClosed('stored_target_revalidation_failed', errorDetail(error));
            }
            const registration = await register(env, platform, record.version, record.destPath, sealedIdentity, revalidateStoredTarget, assertStoredIntentCurrent, options, timeoutMs, transactionBudgetMs, failed, timedOut);
            try {
                await assertStoredIntentCurrent();
            }
            catch (error) {
                return failClosed('stored_intent_changed', errorDetail(error));
            }
            const intentBase = {
                version: record.version,
                destPath: record.destPath,
                intentId: record.intentId,
                targetIdentity: sealedIdentity,
                installOwnership: record.installOwnership,
            };
            if (registration.outcome === 'migrated') {
                persistAuthoritativeMigrationState(env, { state: 'committed', ...intentBase }, stateOptions);
                recordBootstrapAttempt(env, { ok: true, reason: 'migrated', detail: record.destPath }, stateOptions);
                return { action: 'return', result: registration };
            }
            if (registration.requiresForegroundExit === true) {
                try {
                    persistAuthoritativeMigrationState(env, { state: 'blocked', ...intentBase, reason: registration.reason }, stateOptions);
                }
                catch {
                    // Preserve the exact prior active record when blocked-state publication is uncertain.
                }
                return { action: 'return', result: registration };
            }
            const rollbackPendingRecord = {
                state: 'rollback_pending',
                ...intentBase,
                reason: registration.reason,
            };
            let rollbackPendingPayload;
            try {
                await assertStoredIntentCurrent();
                rollbackPendingPayload = persistAuthoritativeMigrationState(env, rollbackPendingRecord, stateOptions);
            }
            catch (error) {
                return failClosed('rollback_intent_persistence_failed', errorDetail(error));
            }
            try {
                await completeMigrationRollbackPending({
                    env,
                    record: { ...intentBase, reason: registration.reason },
                    expectedPayload: rollbackPendingPayload,
                    stateOptions,
                    readBinary,
                    preflightFn,
                    rename,
                    link,
                    unlink,
                    rmdir,
                    syncDirectory,
                    assertDirectoryTrust,
                    assertFileTrust,
                    assertOwnerCurrent: assertOwnerLeaseCurrent,
                });
            }
            catch (error) {
                return failClosed('stored_target_cleanup_failed', errorDetail(error));
            }
            return { action: 'retry_current' };
        });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'migration_lock_busy') {
            return failClosed('migration_in_progress', 'another live process owns migration recovery');
        }
        return failClosed('stored_reconciliation_failed', errorDetail(error));
    }
}
/**
 * One-time migration of the npm/JS install shape to the standalone release binary.
 * Never throws: every failure/skip becomes a structured MigrationResult. Only a proven clean
 * failure may continue degraded; ambiguous registration ownership requires foreground exit.
 */
export async function migrateToStandaloneBinary(env, platform = process.platform, options = {}) {
    const now = options.now ?? Date.now();
    const exists = options.exists ?? existsSync;
    const readText = options.readFile ?? defaultReadTextFile;
    const recordOptions = { now, ...(options.writeFile ? { writeFile: options.writeFile } : {}) };
    const stateOptions = {
        ...recordOptions,
        ...(options.assertStateDirectoryTrust
            ? { assertStateDirectoryTrust: options.assertStateDirectoryTrust }
            : {}),
        ...(options.assertStateFileTrust
            ? { assertStateFileTrust: options.assertStateFileTrust }
            : {}),
    };
    const startupState = inspectMigrationStartupState(env, stateOptions);
    if (startupState.classification === 'unsafe') {
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
        return {
            outcome: 'failed',
            reason: `${code}:migration_state_unsafe`,
            message: `one-time standalone migration failed (${code}:migration_state_unsafe:${startupState.detail})`,
            requiresForegroundExit: true,
        };
    }
    const hadPriorAmbiguity = startupState.classification === 'retryable'
        || (!startupState.canonicalPresent && unresolvedLegacyMigrationOwnership(env, readText));
    let ownerLeaseHeld = false;
    // A prior active canonical record remains the recovery authority until this owner publishes
    // a new authoritative install/registration transition. Advisory progress/failure writes must
    // never erase the only durable evidence of possible artifact or child ownership.
    let canonicalMutationStateActive = startupState.classification === 'retryable';
    const skipped = (reason, message) => {
        if (hadPriorAmbiguity) {
            return {
                outcome: 'failed',
                reason: `${SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED}:ambiguous_pending:${reason}`,
                message: 'one-time standalone migration cannot skip while registration ownership is unresolved',
                requiresForegroundExit: true,
            };
        }
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
    // A prior ambiguous attempt is retried through signed artifact validation and the durable
    // lifecycle reconciler. Until a registration succeeds, every new failure stays fail-closed.
    if (!hadPriorAmbiguity && recentBootstrapFailure(env, readText, now)) {
        return skipped('cooldown', 'one-time standalone migration skipped (recent bootstrap failure cooldown)');
    }
    if (startupState.classification === 'retryable'
        && startupState.record.state === 'installing') {
        const reconciliation = await reconcileStoredMigrationInstall({
            env,
            options,
            record: startupState.record,
            expectedPayload: startupState.raw,
            stateOptions,
        });
        if (reconciliation.action === 'return')
            return reconciliation.result;
        // Recovery used the exact stored version/destination transaction and durably terminalized
        // it. Re-read the environment only after that authority has been released.
        return migrateToStandaloneBinary(env, platform, options);
    }
    if (startupState.classification === 'retryable'
        && startupState.record.state === 'rollback_pending') {
        const reconciliation = await reconcileStoredMigrationRollbackPending({
            env,
            options,
            record: startupState.record,
            expectedPayload: startupState.raw,
            stateOptions,
        });
        if (reconciliation.action === 'return')
            return reconciliation.result;
        // Cleanup is idempotently complete and terminal state is durable; only now may the current
        // version/home request replace the old transaction authority.
        return migrateToStandaloneBinary(env, platform, options);
    }
    if (startupState.classification === 'retryable'
        && isCanonicalMigrationRegistrationState(startupState.record)) {
        const reconciliation = await reconcileStoredMigrationRegistration({
            env,
            platform,
            options,
            record: startupState.record,
            expectedPayload: startupState.raw,
            stateOptions,
        });
        if (reconciliation.action === 'return')
            return reconciliation.result;
        // The exact old transaction is now durably rolled back. Re-read canonical state before
        // beginning the current version/home request so no stale in-memory authority crosses it.
        return migrateToStandaloneBinary(env, platform, options);
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
    const migrationHome = resolveMigrationHome(env);
    const destPath = join(migrationHome, 'bin', assetName);
    const fail = (reason, message, attemptDetail, requiresForegroundExit = false, preserveCanonicalState = false) => {
        const mustExit = requiresForegroundExit || hadPriorAmbiguity;
        if (ownerLeaseHeld) {
            recordBootstrapAttempt(env, {
                ok: false,
                reason: mustExit ? 'migration_ambiguous' : 'migration_failed',
                detail: attemptDetail ?? reason,
            }, recordOptions);
            if (!canonicalMutationStateActive && !preserveCanonicalState && !mustExit) {
                writeMigrationState(env, { state: 'failed', version, destPath, reason }, options);
            }
        }
        return {
            outcome: 'failed',
            reason,
            destPath,
            message,
            ...(mustExit ? { requiresForegroundExit: true } : {}),
        };
    };
    const failTimeout = (reason, message, attemptDetail, requiresForegroundExit = true) => {
        const mustExit = requiresForegroundExit || hadPriorAmbiguity;
        if (ownerLeaseHeld) {
            recordBootstrapAttempt(env, {
                ok: false,
                reason: mustExit ? 'migration_ambiguous' : 'migration_timeout',
                detail: attemptDetail,
            }, recordOptions);
            if (!canonicalMutationStateActive && !mustExit) {
                writeMigrationState(env, { state: 'failed', version, destPath, reason }, options);
            }
        }
        return {
            outcome: 'failed',
            reason,
            destPath,
            message,
            ...(mustExit ? { requiresForegroundExit: true } : {}),
        };
    };
    const timeoutMs = options.timeoutMs ?? MIGRATION_REGISTER_TIMEOUT_MS;
    const transactionBudgetMs = options.transactionBudgetMs ?? MIGRATION_REGISTER_TRANSACTION_BUDGET_MS;
    if (!options.registrationRunner) {
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
        return fail(`${code}:registration_runner_unavailable`, `one-time standalone migration failed (${code}:registration_runner_unavailable)`, `${code}: registration_runner_unavailable`);
    }
    if (!Number.isSafeInteger(timeoutMs)
        || !Number.isSafeInteger(transactionBudgetMs)
        || timeoutMs <= transactionBudgetMs
        || timeoutMs > MAX_TIMER_DELAY_MS
        || transactionBudgetMs <= 0) {
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
        return fail(`${code}:invalid_registration_timeout_contract`, `one-time standalone migration failed (${code}:invalid_registration_timeout_contract)`, `${code}: invalid_registration_timeout_contract`);
    }
    const readBinary = options.readBinary ?? ((path) => fsReadFile(path));
    const writeBinary = options.writeBinary
        ?? ((path, content, mode) => fsWriteFile(path, content, { mode, flag: 'wx' }));
    const mkdir = options.mkdir ?? ((path, mode) => fsMkdir(path, { recursive: true, mode }).then(() => undefined));
    const rm = options.rm ?? ((path) => fsRm(path, { recursive: true, force: true }));
    const unlink = options.unlink ?? ((path) => fsUnlink(path));
    const rmdir = options.rmdir ?? ((path) => fsRmdir(path));
    const chmod = options.chmod ?? ((path, mode) => fsChmod(path, mode));
    const syncFile = options.syncFile ?? (async (path) => {
        const handle = await fsOpen(path, 'r+');
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    });
    const syncDirectory = options.syncDirectory ?? (async (path) => {
        let handle;
        try {
            handle = await fsOpen(path, 'r');
            await handle.sync();
        }
        catch (error) {
            // Windows does not expose reliable directory fsync handles; the executable is fsynced.
            if (process.platform !== 'win32')
                throw error;
        }
        finally {
            await handle?.close();
        }
    });
    const stat = options.stat ?? ((path) => lstat(path));
    const link = options.link ?? ((from, to) => fsLink(from, to));
    const rename = options.rename ?? ((from, to) => fsRename(from, to));
    const preflightFn = options.preflightFn
        ?? ((targetPath, expectedVersion) => preflightManagedStagedBinary(targetPath, expectedVersion, options.probe));
    const downloadFn = options.downloadFn ?? downloadGithubReleaseArtifact;
    const verifyFn = options.verifyFn
        ?? ((manifest, downloaded, publicKey) => ops.verifySelectedManifestArtifact(manifest, downloaded, publicKey));
    const assertDirectoryTrust = options.assertDirectoryTrust
        ?? ((directory) => assertTrustedMigrationDirectoryChain(directory, uid));
    const assertFileTrust = options.assertFileTrust
        ?? ((path) => assertTrustedMigrationFile(path, uid));
    // Pure contract and read-only target validation precede even lock-namespace creation.
    try {
        await assertSafeExistingMigrationTargetDirectory(migrationHome, dirname(destPath), assertDirectoryTrust);
    }
    catch (err) {
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
        return fail(`${code}:${errorDetail(err)}`, `one-time standalone migration failed (${code})`, `${code}: ${errorDetail(err)}`);
    }
    const migrationLockDirectory = resolveBootstrapStateDir(env);
    try {
        await ensureSafeMigrationDirectory(migrationLockDirectory, mkdir, assertDirectoryTrust);
    }
    catch (err) {
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
        return fail(`${code}:${errorDetail(err)}`, `one-time standalone migration failed (${code})`, `${code}: ${errorDetail(err)}`);
    }
    try {
        return await withMigrationLock(migrationLockDirectory, async (assertOwnerLeaseCurrent) => {
            ownerLeaseHeld = true;
            try {
                const recoveredInstall = await recoverPendingMigrationInstall({
                    env,
                    stateOptions,
                    readBinary,
                    rename,
                    link,
                    unlink,
                    rmdir,
                    syncDirectory,
                    assertDirectoryTrust,
                    assertFileTrust,
                    assertOwnerCurrent: assertOwnerLeaseCurrent,
                    markCanonicalStateActive: () => {
                        canonicalMutationStateActive = true;
                    },
                });
                if (recoveredInstall)
                    canonicalMutationStateActive = true;
            }
            catch (error) {
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
                return fail(`${code}:recovery_failed`, `one-time standalone migration failed (${code}:recovery_failed)`, `${code}: recovery_failed:${errorDetail(error)}`, true);
            }
            // Revalidate after acquiring ownership so the read-before-mutation check cannot go stale.
            try {
                await assertSafeExistingMigrationTargetDirectory(migrationHome, dirname(destPath), assertDirectoryTrust);
            }
            catch (err) {
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
                return fail(`${code}:${errorDetail(err)}`, `one-time standalone migration failed (${code})`, `${code}: ${errorDetail(err)}`);
            }
            if (!canonicalMutationStateActive) {
                writeMigrationState(env, { state: 'in_progress', version, destPath }, options);
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
                const detail = errorDetail(verification.reason);
                return fail(`${code}:${detail}`, `one-time standalone migration failed (${code})`, `${code}: ${detail}`);
            }
            let stagedBytes;
            let expectedSha256;
            try {
                const stagedStat = await stat(download.stagedPath);
                if (stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
                    throw new Error('staged_artifact_not_regular_file');
                }
                stagedBytes = await readBinary(download.stagedPath);
                const selected = download.artifacts.length === 1 && download.artifacts[0]?.path === assetName
                    ? download.artifacts[0]
                    : undefined;
                expectedSha256 = selected?.sha256 ?? (selected?.bytes ? sha256(selected.bytes) : '');
                if (!/^[0-9a-f]{64}$/.test(expectedSha256) || sha256(stagedBytes) !== expectedSha256) {
                    throw new Error('staged_artifact_hash_mismatch');
                }
                // Preflight the staged binary for real (`--version` + `proxy --help`) before install.
                await preflightFn(download.stagedPath, version);
            }
            catch (err) {
                await rmSafe(rm, stagedDir);
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_VERIFY_FAILED;
                const detail = `preflight:${errorDetail(err)}`;
                return fail(`${code}:${detail}`, `one-time standalone migration failed (${code})`, `${code}: ${detail}`);
            }
            await rmSafe(rm, stagedDir);
            // The same lease spans INSTALL -> identity revalidation -> REGISTER -> conditional cleanup.
            // A second process must never register the target while this owner can still roll it back.
            let installResult;
            let installAnchor;
            try {
                installResult = await installVerifiedMigrationBinary({
                    home: migrationHome,
                    destPath,
                    version,
                    bytes: stagedBytes,
                    expectedSha256,
                    mkdir,
                    writeBinary,
                    readBinary,
                    chmod,
                    syncFile,
                    syncDirectory,
                    stat,
                    link,
                    rename,
                    unlink,
                    rmdir,
                    preflight: preflightFn,
                    assertDirectoryTrust,
                    assertFileTrust,
                    publishInstallIntent: async (anchor) => {
                        const previousAnchor = installAnchor;
                        const installingRecord = {
                            state: 'installing',
                            version,
                            destPath,
                            installAnchor: anchor,
                        };
                        const expectedPayload = serializeMigrationState(installingRecord, recordOptions);
                        assertOwnerLeaseCurrent();
                        try {
                            persistAuthoritativeMigrationState(env, installingRecord, stateOptions);
                            installAnchor = anchor;
                            canonicalMutationStateActive = true;
                        }
                        catch (error) {
                            try {
                                const expectedPublished = readTrustedMigrationStateText(join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE), stateOptions) === expectedPayload;
                                if (expectedPublished) {
                                    canonicalMutationStateActive = true;
                                    installAnchor = anchor;
                                }
                                else if (previousAnchor) {
                                    canonicalMutationStateActive = true;
                                    installAnchor = previousAnchor;
                                }
                                else {
                                    canonicalMutationStateActive = false;
                                }
                            }
                            catch {
                                canonicalMutationStateActive = true;
                                installAnchor = previousAnchor ?? anchor;
                            }
                            throw error;
                        }
                    },
                });
            }
            catch (err) {
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
                const detail = errorDetail(err);
                let ambiguous = detail.startsWith('migration_install_rollback_unconfirmed:');
                let rollbackTerminalized = false;
                if (canonicalMutationStateActive && installAnchor && !ambiguous) {
                    try {
                        assertOwnerLeaseCurrent();
                        persistAuthoritativeMigrationState(env, { state: 'rolled_back', version, destPath, installAnchor, reason: detail }, stateOptions);
                        rollbackTerminalized = true;
                    }
                    catch {
                        ambiguous = true;
                    }
                }
                return fail(`${code}:${detail}`, `one-time standalone migration failed (${code})`, `${code}: ${detail}`, ambiguous || (canonicalMutationStateActive && !rollbackTerminalized));
            }
            let registrationIdentity;
            try {
                const currentIdentity = await inspectExistingMigrationTarget(destPath, version, preflightFn, readBinary, { sha256: expectedSha256, size: stagedBytes.byteLength }, assertDirectoryTrust, assertFileTrust);
                if (!currentIdentity || !sameMigrationTargetIdentity(currentIdentity, installResult.targetIdentity)) {
                    throw new Error('migration_target_identity_changed_before_registration');
                }
                registrationIdentity = currentIdentity;
            }
            catch (error) {
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
                return fail(`${code}:target_identity_changed`, `one-time standalone migration failed (${code}:target_identity_changed)`, `${code}: target_identity_changed:${errorDetail(error)}`, true);
            }
            // REGISTER: delegate to the ordinary lifecycle bootstrap transaction runner.
            const sealedRegistrationIdentity = Object.freeze({ ...registrationIdentity });
            const revalidateTarget = () => assertMigrationTargetIdentityCurrent(sealedRegistrationIdentity, version, { readBinary, preflightFn, assertDirectoryTrust, assertFileTrust });
            const intentId = randomUUID();
            const intentBase = {
                version,
                destPath,
                intentId,
                targetIdentity: sealedRegistrationIdentity,
                installOwnership: {
                    disposition: installResult.disposition,
                    preimage: installResult.disposition === 'installed' ? 'absent' : 'matching_target',
                    directoryCreated: installResult.directoryCreated,
                },
            };
            const registeringRecord = { state: 'registering', ...intentBase };
            const expectedIntentPayload = serializeMigrationState(registeringRecord, recordOptions);
            let registrationIntentPayload;
            try {
                assertOwnerLeaseCurrent();
                registrationIntentPayload = persistAuthoritativeMigrationState(env, registeringRecord, stateOptions);
                canonicalMutationStateActive = true;
            }
            catch (error) {
                let intentRollbackTerminalized = false;
                let intentAuthorityAmbiguous = false;
                let currentAuthoritativePayload;
                try {
                    currentAuthoritativePayload = readTrustedMigrationStateText(join(resolveBootstrapStateDir(env), MIGRATION_STATE_FILE), stateOptions);
                }
                catch {
                    canonicalMutationStateActive = true;
                    intentAuthorityAmbiguous = true;
                }
                if (!intentAuthorityAmbiguous && currentAuthoritativePayload === expectedIntentPayload) {
                    canonicalMutationStateActive = true;
                    try {
                        assertOwnerLeaseCurrent();
                        const rollbackPendingPayload = persistAuthoritativeMigrationState(env, { state: 'rollback_pending', ...intentBase, reason: 'intent_persistence_failed' }, stateOptions);
                        await completeMigrationRollbackPending({
                            env,
                            record: { ...intentBase, reason: 'intent_persistence_failed' },
                            expectedPayload: rollbackPendingPayload,
                            stateOptions,
                            readBinary,
                            preflightFn,
                            rename,
                            link,
                            unlink,
                            rmdir,
                            syncDirectory,
                            assertDirectoryTrust,
                            assertFileTrust,
                            assertOwnerCurrent: assertOwnerLeaseCurrent,
                        });
                        intentRollbackTerminalized = true;
                    }
                    catch (cleanupError) {
                        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
                        return fail(`${code}:cleanup_failed`, `one-time standalone migration failed (${code}:cleanup_failed)`, `${code}: cleanup_failed:${errorDetail(cleanupError)}`, true, true);
                    }
                }
                else if (!intentAuthorityAmbiguous && currentAuthoritativePayload !== undefined) {
                    const currentRecord = parseCanonicalMigrationState(currentAuthoritativePayload);
                    if (currentRecord?.state !== 'installing'
                        || currentRecord.version !== version
                        || currentRecord.destPath !== destPath
                        || !installAnchor
                        || !sameMigrationInstallAnchor(currentRecord.installAnchor, installAnchor)) {
                        canonicalMutationStateActive = true;
                        intentAuthorityAmbiguous = true;
                    }
                    else {
                        canonicalMutationStateActive = true;
                        try {
                            const recovered = await recoverPendingMigrationInstall({
                                env,
                                stateOptions,
                                readBinary,
                                rename,
                                link,
                                unlink,
                                rmdir,
                                syncDirectory,
                                assertDirectoryTrust,
                                assertFileTrust,
                                assertOwnerCurrent: assertOwnerLeaseCurrent,
                                markCanonicalStateActive: () => {
                                    canonicalMutationStateActive = true;
                                },
                            });
                            if (!recovered)
                                throw new Error('migration_install_journal_changed');
                            intentRollbackTerminalized = true;
                        }
                        catch (cleanupError) {
                            const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
                            return fail(`${code}:cleanup_failed`, `one-time standalone migration failed (${code}:cleanup_failed)`, `${code}: cleanup_failed:${errorDetail(cleanupError)}`, true, true);
                        }
                    }
                }
                else if (!intentAuthorityAmbiguous) {
                    // The installed artifact cannot be deleted without a durable transaction record.
                    canonicalMutationStateActive = true;
                    intentAuthorityAmbiguous = true;
                }
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
                return fail(`${code}:intent_persistence_failed`, `one-time standalone migration failed (${code}:intent_persistence_failed)`, `${code}: intent_persistence_failed:${errorDetail(error)}`, intentAuthorityAmbiguous || !intentRollbackTerminalized, true);
            }
            const assertRegistrationIntentCurrent = async () => {
                assertOwnerLeaseCurrent();
                assertAuthoritativeMigrationStateCurrent(env, registrationIntentPayload, stateOptions);
            };
            const registration = await register(env, platform, version, destPath, sealedRegistrationIdentity, revalidateTarget, assertRegistrationIntentCurrent, options, timeoutMs, transactionBudgetMs, fail, failTimeout);
            if (registration.outcome === 'failed' && registration.requiresForegroundExit === true) {
                try {
                    assertOwnerLeaseCurrent();
                    persistAuthoritativeMigrationState(env, { state: 'blocked', ...intentBase, reason: registration.reason }, stateOptions);
                }
                catch {
                    // Preserve the already durable registering intent if blocked-state publication fails.
                }
                return registration;
            }
            if (registration.outcome === 'failed') {
                try {
                    await assertRegistrationIntentCurrent();
                    const rollbackPendingPayload = persistAuthoritativeMigrationState(env, { state: 'rollback_pending', ...intentBase, reason: registration.reason }, stateOptions);
                    canonicalMutationStateActive = true;
                    await completeMigrationRollbackPending({
                        env,
                        record: { ...intentBase, reason: registration.reason },
                        expectedPayload: rollbackPendingPayload,
                        stateOptions,
                        readBinary,
                        preflightFn,
                        rename,
                        link,
                        unlink,
                        rmdir,
                        syncDirectory,
                        assertDirectoryTrust,
                        assertFileTrust,
                        assertOwnerCurrent: assertOwnerLeaseCurrent,
                    });
                    canonicalMutationStateActive = false;
                }
                catch (error) {
                    const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_INSTALL_FAILED;
                    return fail(`${code}:cleanup_failed`, `one-time standalone migration failed (${code}:cleanup_failed)`, `${code}: cleanup_failed:${errorDetail(error)}`, true);
                }
                return registration;
            }
            try {
                assertOwnerLeaseCurrent();
                persistAuthoritativeMigrationState(env, { state: 'committed', ...intentBase }, stateOptions);
                canonicalMutationStateActive = false;
            }
            catch (error) {
                const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
                return fail(`${code}:commit_persistence_failed`, `one-time standalone migration failed (${code}:commit_persistence_failed)`, `${code}: commit_persistence_failed:${errorDetail(error)}`, true);
            }
            recordBootstrapAttempt(env, { ok: true, reason: 'migrated', detail: destPath }, recordOptions);
            return registration;
        });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'migration_lock_busy') {
            return {
                outcome: 'failed',
                reason: `${SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED}:migration_in_progress`,
                destPath,
                message: 'one-time standalone migration is already owned by another live process',
                requiresForegroundExit: true,
            };
        }
        const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
        return fail(`${code}:owner_lease_failed`, `one-time standalone migration failed (${code}:owner_lease_failed)`, `${code}: owner_lease_failed:${errorDetail(error)}`, true, true);
    }
}
async function register(env, platform, version, destPath, targetIdentity, revalidateTarget, assertRegistrationIntentCurrent, options, timeoutMs, transactionBudgetMs, fail, failTimeout) {
    const code = SELF_UPDATE_FAILURE_CODES.MIGRATION_REGISTER_FAILED;
    const runner = options.registrationRunner;
    if (!runner) {
        return fail(`${code}:registration_runner_unavailable`, `one-time standalone migration failed (${code}:registration_runner_unavailable)`, `${code}: registration_runner_unavailable`);
    }
    let startedAtMs;
    try {
        startedAtMs = (options.clock ?? Date.now)();
    }
    catch (error) {
        return fail(`${code}:registration_clock_failed`, `one-time standalone migration failed (${code}:registration_clock_failed)`, `${code}: registration_clock_failed:${errorDetail(error)}`);
    }
    const transactionDeadlineMs = startedAtMs + transactionBudgetMs;
    const parentDeadlineMs = startedAtMs + timeoutMs;
    if (!Number.isSafeInteger(startedAtMs)
        || startedAtMs < 0
        || !Number.isSafeInteger(transactionDeadlineMs)
        || !Number.isSafeInteger(parentDeadlineMs)) {
        return fail(`${code}:invalid_registration_deadline`, `one-time standalone migration failed (${code}:invalid_registration_deadline)`, `${code}: invalid_registration_deadline`);
    }
    const request = Object.freeze({
        env: Object.freeze({ ...env, EVOLVER_SELF_UPDATE_TARGET_PATH: destPath }),
        platform,
        version,
        startedAtMs,
        transactionDeadlineMs,
        parentDeadlineMs,
        transactionBudgetMs,
        timeoutMs,
        targetIdentity,
        revalidateTarget,
        assertRegistrationIntentCurrent,
        // Registration must execute the verified standalone binary, never the npm/JS Node entry.
        execPath: destPath,
        ...(options.exists !== undefined ? { exists: options.exists } : {}),
        ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
        ...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
        ...(options.spawnFn !== undefined ? { spawnFn: options.spawnFn } : {}),
    });
    let registration;
    try {
        registration = await runner(request);
    }
    catch (error) {
        return fail(`${code}:runner_threw`, `one-time standalone migration failed (${code}:runner_threw)`, errorDetail(`${code}: runner_threw:${errorDetail(error)}`), true);
    }
    if (!registration
        || typeof registration.ok !== 'boolean'
        || typeof registration.reason !== 'string'
        || registrationReason(registration.reason) === undefined
        || (registration.detail !== undefined && typeof registration.detail !== 'string')
        || (registration.requiresForegroundExit !== undefined && registration.requiresForegroundExit !== true)) {
        return fail(`${code}:invalid_reconciliation_result`, `one-time standalone migration failed (${code}:invalid_reconciliation_result)`, `${code}: invalid_reconciliation_result`, true);
    }
    const safeReason = registrationReason(registration.reason);
    if (!safeReason) {
        return fail(`${code}:invalid_reconciliation_result`, `one-time standalone migration failed (${code}:invalid_reconciliation_result)`, `${code}: invalid_reconciliation_result`, true);
    }
    const safeDetail = registration.detail === undefined ? undefined : errorDetail(registration.detail);
    if (!registration.ok) {
        const ownershipAmbiguous = registration.requiresForegroundExit === true
            || ['ambiguous', 'blocked', 'signal', 'termination_unconfirmed', 'timeout'].includes(safeReason);
        const detail = safeDetail ? `:${safeDetail}` : '';
        if (safeReason === 'timeout') {
            return failTimeout('migration_register_timeout', `one-time standalone migration failed (${code}:timeout)`, errorDetail(`${code}: timeout${detail}`), true);
        }
        return fail(`${code}:${safeReason}`, `one-time standalone migration failed (${code}:${safeReason})`, errorDetail(`${code}: ${safeReason}${detail}`), ownershipAmbiguous);
    }
    const lockReleaseUnconfirmed = safeReason === 'bootstrapped_lock_release_unconfirmed';
    if ((safeReason !== 'bootstrapped' && !lockReleaseUnconfirmed)
        || (lockReleaseUnconfirmed && !safeDetail)
        || registration.requiresForegroundExit === true) {
        return fail(`${code}:invalid_success_reconciliation`, `one-time standalone migration failed (${code}:invalid_success_reconciliation)`, `${code}: invalid_success_reconciliation:${safeReason}`, true);
    }
    return {
        outcome: 'migrated',
        reason: 'migrated',
        destPath,
        message: `[evolver-proxy] self-update: installed standalone binary ${version} at ${destPath} and registered `
            + 'durable service supervision via `evolver lifecycle bootstrap`; handing over to the service manager '
            + 'and exiting so it can take the IPC port.'
            + (lockReleaseUnconfirmed
                ? ` The service commit is durable, but lifecycle lock release remains unconfirmed (${safeDetail}).`
                : ''),
    };
}