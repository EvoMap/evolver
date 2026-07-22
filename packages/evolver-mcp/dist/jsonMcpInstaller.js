import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EmptySharedConfigError, SymlinkRefusedError, UnparseableConfigError, } from './installer.js';
const CONFIG_MODE = 0o600;
const DIR_MODE = 0o700;
const BACKUP_VERSION = 1;
const ENV_FILE_KEY = 'EVOLVER_ENV_FILE';
let beforeReplaceHookForTest;
let afterReplaceHookForTest;
let beforeBackupRemoveHookForTest;
export function _setJsonMcpBeforeReplaceHookForTest(hook) {
    beforeReplaceHookForTest = hook;
}
export function _setJsonMcpAfterReplaceHookForTest(hook) {
    afterReplaceHookForTest = hook;
}
export function _setJsonMcpBeforeBackupRemoveHookForTest(hook) {
    beforeBackupRemoveHookForTest = hook;
}
function removeBackup(path) {
    beforeBackupRemoveHookForTest?.(path);
    rmSync(path);
}
export class McpConfigConflictError extends Error {
    diff;
    constructor(runtime, path, expected, actual) {
        const diff = { path: String(sanitizeForError(path, 'path')), expected: sanitizeForError(expected), actual: sanitizeForError(actual) };
        super(`[setup-hooks] refusing to overwrite ${runtime} config: existing Evolver entry conflicts:\n${JSON.stringify(diff, null, 2)}`);
        this.name = 'McpConfigConflictError';
        this.diff = diff;
    }
}
export class McpConfigShapeError extends Error {
    constructor(runtime, path, detail) {
        super(`[setup-hooks] refusing to overwrite ${runtime} config (${path}): ${detail}. Fix the config, then rerun.`);
        this.name = 'McpConfigShapeError';
    }
}
export class McpConfigOwnershipError extends Error {
    constructor(runtime, detail) {
        super(`[setup-hooks] refusing to modify ${runtime} configuration: ${detail}. Review the managed backup and runtime config before retrying.`);
        this.name = 'McpConfigOwnershipError';
    }
}
export class McpConfigVerificationError extends Error {
    runtime;
    path;
    restored = false;
    constructor(runtime, path) {
        super(`[setup-hooks] ${runtime} config read-back verification failed (${path}); rollback could not be confirmed.`);
        this.runtime = runtime;
        this.path = path;
        this.name = 'McpConfigVerificationError';
    }
    markRestored() {
        this.restored = true;
        this.message = `[setup-hooks] ${this.runtime} config read-back verification failed (${this.path}); the previous config was restored.`;
    }
}
export class McpConfigChangedError extends Error {
    constructor(runtime, path) {
        super(`[setup-hooks] refusing to overwrite ${runtime} config (${path}): the file changed after it was read. Review the current config and rerun.`);
        this.name = 'McpConfigChangedError';
    }
}
export class McpServerValidationError extends Error {
    constructor(message) {
        super(`[setup-hooks] ${message}`);
        this.name = 'McpServerValidationError';
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function digest(raw) {
    return createHash('sha256').update(raw).digest('hex');
}
function stableEqual(left, right) {
    if (Object.is(left, right))
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => stableEqual(value, right[index]));
    }
    if (!isObject(left) || !isObject(right))
        return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && stableEqual(left[key], right[key]));
}
function resolveRuntimeConfig(spec, opts) {
    if (spec.resolveConfig)
        return spec.resolveConfig(opts);
    return {
        configPath: spec.configPath(opts),
        safeRoot: spec.safeRoot?.(opts) ?? (opts.scope === 'user' ? (opts.homeDir ?? homedir()) : opts.configRoot),
        conflictingPaths: spec.conflictingPaths?.(opts) ?? [],
    };
}
function resolveInstallRuntimeConfig(spec, opts) {
    const resolution = resolveRuntimeConfig(spec, opts);
    const candidates = resolution.installDiscoveryPaths
        ?? resolution.uninstallCandidatePaths
        ?? [resolution.configPath];
    if (candidates.length < 2)
        return resolution;
    const discoveryResolution = resolution.installSafeRoot
        ? { ...resolution, safeRoot: resolution.installSafeRoot }
        : resolution;
    const { managedCandidates: backupCandidates, orphanBackupErrors } = inspectManagedCandidates(spec, discoveryResolution, candidates);
    // The active target still fails closed on an orphan backup during validation. An inactive backup only proves
    // ownership while its config still contains the Evolver entry that installation would be retargeted to.
    const managedCandidates = backupCandidates.filter((candidate) => candidateIsActiveOrConfigured(spec, candidate, resolution.configPath));
    const activeBackupError = orphanBackupErrors.find(({ candidate }) => resolve(candidate) === resolve(resolution.configPath));
    if (managedCandidates.length > 1) {
        throw new McpConfigOwnershipError(spec.runtime, 'multiple managed backup candidates exist; remove the ambiguity before retrying');
    }
    if (managedCandidates.length === 0) {
        if (activeBackupError)
            throw activeBackupError.error;
        return resolution;
    }
    const managedPath = managedCandidates[0];
    if (resolve(managedPath) === resolve(resolution.configPath))
        return resolution;
    return {
        ...discoveryResolution,
        configPath: managedPath,
        managedRetarget: true,
        topologyCandidatePaths: candidates,
        ...(existsSync(resolution.configPath)
            && dirname(resolve(resolution.configPath)) === dirname(resolve(managedPath))
            ? { activePrecedencePath: resolution.configPath }
            : {}),
    };
}
function resolveUninstallRuntimeConfig(spec, opts) {
    const resolution = resolveRuntimeConfig(spec, opts);
    const candidates = resolution.uninstallDiscoveryPaths
        ?? resolution.uninstallCandidatePaths
        ?? [resolution.configPath];
    if (candidates.length < 2)
        return resolution;
    const discoveryResolution = resolution.uninstallSafeRoot
        ? { ...resolution, safeRoot: resolution.uninstallSafeRoot }
        : resolution;
    const { managedCandidates, orphanBackupErrors } = inspectManagedCandidates(spec, discoveryResolution, candidates);
    const uninstallCandidates = managedCandidates.filter((candidate) => candidateIsActiveOrConfigured(spec, candidate, resolution.configPath));
    const activeBackupError = orphanBackupErrors.find(({ candidate }) => resolve(candidate) === resolve(resolution.configPath));
    if (uninstallCandidates.length > 1) {
        throw new McpConfigOwnershipError(spec.runtime, 'multiple managed backup candidates exist; remove the ambiguity before retrying');
    }
    if (uninstallCandidates.length === 0) {
        if (activeBackupError)
            throw activeBackupError.error;
        return resolution;
    }
    const configPath = uninstallCandidates[0];
    return {
        ...discoveryResolution,
        configPath,
        conflictingPaths: resolution.uninstallConflictingPaths?.(configPath) ?? resolution.conflictingPaths,
    };
}
function inspectManagedCandidates(spec, resolution, candidates) {
    const managedCandidates = [];
    const orphanBackupErrors = [];
    for (const candidate of candidates) {
        assertSafeParents(spec.runtime, resolution.safeRoot, candidate);
        try {
            if (readBackup(candidate))
                managedCandidates.push(candidate);
        }
        catch (error) {
            if (!(error instanceof McpConfigShapeError) || candidateContainsEvolver(spec, candidate))
                throw error;
            orphanBackupErrors.push({ candidate, error });
        }
    }
    return { managedCandidates, orphanBackupErrors };
}
function candidateContainsEvolver(spec, configPath) {
    if (!existsSync(configPath))
        return false;
    const snapshot = readSnapshot(spec.runtime, configPath);
    const container = validateContainer(spec.runtime, configPath, snapshot.data, spec.containerKey);
    return Object.prototype.hasOwnProperty.call(container, 'evolver');
}
function sanitizeHeaderArgument(value) {
    const headerFlag = value.match(/(^|[\s"'`;=,|&([{])(--header(?=$|[=\s])|-H(?=$|[=\s])|-H(?=[A-Za-z][A-Za-z-]*\s*:))/i);
    if (headerFlag?.index !== undefined) {
        const flagStart = headerFlag.index + headerFlag[1].length;
        const flag = headerFlag[2];
        const suffix = value.slice(flagStart + flag.length);
        return `${value.slice(0, flagStart)}${flag}${suffix.startsWith('=') ? '=' : ' '}<redacted>`;
    }
    const sensitive = value.match(/(^|[\s"'`;=,|&([{])((?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:)/i);
    if (sensitive?.index === undefined)
        return undefined;
    return `${value.slice(0, sensitive.index)}${sensitive[1]}${sensitive[2]} <redacted>`;
}
function sanitizeForError(value, key = '') {
    if (isSensitiveName(key) || key === 'env' || key === 'environment') {
        return '<redacted>';
    }
    if (Array.isArray(value)) {
        let redactNextSecret = false;
        let redactNextHeader = false;
        return value.map((item) => {
            if (redactNextSecret || redactNextHeader) {
                redactNextSecret = false;
                redactNextHeader = false;
                return '<redacted>';
            }
            if (typeof item === 'string' && /^--?(?:api[-_]?key|password|passwd|secret|token|private[-_]?key|credential|access[-_]?key|client[-_]?secret|passphrase)$/i.test(item)) {
                redactNextSecret = true;
            }
            else if (typeof item === 'string' && /^(?:-H|--header)$/i.test(item)) {
                redactNextHeader = true;
            }
            return sanitizeForError(item, key);
        });
    }
    if (isObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeForError(childValue, childKey)]));
    }
    if (typeof value !== 'string')
        return value;
    const sanitizedHeader = sanitizeHeaderArgument(value);
    if (sanitizedHeader)
        return sanitizedHeader;
    if (/url|uri|endpoint/i.test(key))
        return '<url>';
    if (/\bBearer\s+\S+/i.test(value)
        || /--?(?:api[-_]?key|password|passwd|secret|token|private[-_]?key|credential|access[-_]?key|client[-_]?secret|passphrase)(?:=|\s+)\S+/i.test(value)) {
        return '<redacted>';
    }
    if (/[a-z][a-z\d+.-]*:\/\/[^\s"'`<>]+/i.test(value)) {
        return value.replace(/[a-z][a-z\d+.-]*:\/\/[^\s"'`<>]+/gi, '<url>');
    }
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /=(?:\/|[A-Za-z]:[\\/])/.test(value))
        return '<absolute-path>';
    return value;
}
function isSensitiveName(name) {
    const normalized = name.replace(/[^a-z\d]/gi, '').toLowerCase();
    return normalized === 'sig'
        || normalized === 'auth'
        || ['token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'signature', 'authorization',
            'apikey', 'accesskey', 'privatekey', 'clientsecret', 'cookie', 'setcookie']
            .some((fragment) => normalized.includes(fragment));
}
function isSensitiveQueryName(name) {
    const normalized = name.replace(/[^a-z\d]/gi, '').toLowerCase();
    return normalized === 'key'
        || normalized === 'sig'
        || normalized === 'auth'
        || normalized === 'code'
        || ['token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'signature', 'authorization',
            'apikey', 'accesskey', 'privatekey', 'clientsecret', 'cookie', 'setcookie']
            .some((suffix) => normalized.endsWith(suffix));
}
function statIfExists(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function assertSafePath(path, label) {
    const stat = statIfExists(path);
    if (stat?.isSymbolicLink())
        throw new SymlinkRefusedError(label, path);
}
function assertSafeParents(runtime, configRoot, path) {
    const resolvedRoot = resolve(configRoot);
    const resolvedPath = resolve(path);
    const relativePath = relative(resolvedRoot, resolvedPath);
    if (relativePath === ''
        || isAbsolute(relativePath)
        || relativePath === '..'
        || relativePath.startsWith(`..${sep}`)) {
        throw new McpConfigOwnershipError(runtime, 'configuration path is not contained by its safe root');
    }
    assertSafePath(resolvedRoot, 'config root');
    let current = resolvedRoot;
    for (const segment of relativePath.split(sep).slice(0, -1)) {
        current = join(current, segment);
        assertSafePath(current, 'runtime config directory');
    }
    assertSafePath(resolvedPath, 'runtime config file');
    assertSafePath(backupPath(resolvedPath), 'runtime config backup');
}
function candidateIsActiveOrConfigured(spec, candidate, activeConfigPath) {
    return (resolve(candidate) === resolve(activeConfigPath) || candidateContainsEvolver(spec, candidate));
}
function readSnapshot(runtime, path) {
    if (!existsSync(path))
        return { data: {}, raw: null, mode: CONFIG_MODE };
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim())
        throw new EmptySharedConfigError(`${runtime} MCP config`, path, runtime);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new UnparseableConfigError(`${runtime} MCP config`, path, runtime);
    }
    if (!isObject(parsed))
        throw new McpConfigShapeError(runtime, path, 'the top-level JSON value must be an object');
    return { data: parsed, raw, mode: statSync(path).mode & 0o777 };
}
function readRawIfExists(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function assertUnchanged(runtime, path, expectedRaw) {
    assertSafePath(path, 'runtime config file');
    if (readRawIfExists(path) !== expectedRaw)
        throw new McpConfigChangedError(runtime, path);
}
function captureConfigTopology(runtime, resolution) {
    const paths = [...new Set(resolution.topologyCandidatePaths ?? [])];
    const candidates = paths.map((path) => {
        assertSafeParents(runtime, resolution.safeRoot, path);
        const raw = readRawIfExists(path);
        assertSafeParents(runtime, resolution.safeRoot, path);
        return { path, raw };
    });
    if (candidates.length > 0 && !resolution.managedRetarget) {
        const observedActive = [...candidates].reverse().find((candidate) => candidate.raw !== null)?.path
            ?? candidates[0].path;
        if (resolve(observedActive) !== resolve(resolution.configPath)) {
            throw new McpConfigChangedError(runtime, observedActive);
        }
    }
    return {
        candidates: candidates.filter((candidate) => resolve(candidate.path) !== resolve(resolution.configPath)),
    };
}
function assertConfigTopologyUnchanged(runtime, safeRoot, snapshot) {
    for (const candidate of snapshot.candidates) {
        assertSafeParents(runtime, safeRoot, candidate.path);
        const raw = readRawIfExists(candidate.path);
        assertSafeParents(runtime, safeRoot, candidate.path);
        if (raw !== candidate.raw)
            throw new McpConfigChangedError(runtime, candidate.path);
    }
}
function atomicWrite(path, raw, mode, beforeRename) {
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
        writeFileSync(tempPath, raw, { encoding: 'utf8', mode, flag: 'wx' });
        chmodSync(tempPath, mode);
        beforeRename?.();
        renameSync(tempPath, path);
    }
    finally {
        rmSync(tempPath, { force: true });
    }
}
function guardedAtomicWrite(runtime, safeRoot, path, raw, mode, expectedRaw, additionalGuard) {
    atomicWrite(path, raw, mode, () => {
        beforeReplaceHookForTest?.(path);
        assertSafeParents(runtime, safeRoot, path);
        assertUnchanged(runtime, path, expectedRaw);
        additionalGuard?.();
    });
}
function guardedRemove(runtime, safeRoot, path, expectedRaw, additionalGuard) {
    beforeReplaceHookForTest?.(path);
    assertSafeParents(runtime, safeRoot, path);
    assertUnchanged(runtime, path, expectedRaw);
    additionalGuard?.();
    rmSync(path);
}
function backupPath(configPath) {
    return `${configPath}.evolver-backup.json`;
}
function backupRaw(record) {
    return `${JSON.stringify(record, null, 2)}\n`;
}
function createBackup(configPath, originalRaw, installedRaw, installedEntry) {
    const path = backupPath(configPath);
    const record = {
        version: BACKUP_VERSION,
        originalExists: originalRaw !== null,
        originalRaw,
        installedDigest: digest(installedRaw),
        installedEntry,
    };
    const raw = backupRaw(record);
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
        writeFileSync(tempPath, raw, { encoding: 'utf8', mode: CONFIG_MODE, flag: 'wx' });
        chmodSync(tempPath, CONFIG_MODE);
        linkSync(tempPath, path);
    }
    catch (error) {
        if (error.code === 'EEXIST') {
            throw new McpConfigChangedError('Evolver backup', path);
        }
        throw error;
    }
    finally {
        rmSync(tempPath, { force: true });
    }
    return { record, raw };
}
function replaceBackup(configPath, current, nextRecord) {
    const path = backupPath(configPath);
    const raw = backupRaw(nextRecord);
    guardedAtomicWrite('Evolver backup', dirname(path), path, raw, CONFIG_MODE, current.raw);
    return { record: nextRecord, raw };
}
function assertBackupUnchanged(configPath, expectedRaw) {
    const path = backupPath(configPath);
    assertSafePath(path, 'runtime config backup');
    if (readRawIfExists(path) !== expectedRaw)
        throw new McpConfigChangedError('Evolver backup', path);
}
function removeBackupIfUnchanged(configPath, expectedRaw) {
    const path = backupPath(configPath);
    assertSafePath(path, 'runtime config backup');
    if (readRawIfExists(path) === expectedRaw)
        rmSync(path);
}
function readBackup(configPath) {
    const path = backupPath(configPath);
    if (!existsSync(path))
        return undefined;
    const raw = readFileSync(path, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new McpConfigShapeError('Evolver backup', path, 'backup metadata is not valid JSON');
    }
    if (!isObject(parsed) || parsed['version'] !== BACKUP_VERSION || typeof parsed['originalExists'] !== 'boolean'
        || (parsed['originalRaw'] !== null && typeof parsed['originalRaw'] !== 'string')
        || typeof parsed['installedDigest'] !== 'string' || !/^[a-f\d]{64}$/.test(parsed['installedDigest'])
        || (Object.prototype.hasOwnProperty.call(parsed, 'installedEntry') && !isObject(parsed['installedEntry']))
        || (parsed['originalExists'] !== (parsed['originalRaw'] !== null))) {
        throw new McpConfigShapeError('Evolver backup', path, 'invalid backup metadata');
    }
    return { record: parsed, raw };
}
function parseBackupOriginal(runtime, configPath, backup) {
    if (backup.originalRaw === null)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(backup.originalRaw);
    }
    catch {
        throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'original config is not valid JSON');
    }
    if (!isObject(parsed)) {
        throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'original config must be a JSON object');
    }
    return parsed;
}
function validateExistingBackupForInstall(spec, configPath, snapshot, expected, actual, force) {
    const backup = readBackup(configPath);
    if (!backup)
        return undefined;
    if (snapshot.raw === null || actual === undefined) {
        throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'stale backup exists without an installed Evolver entry');
    }
    const original = parseBackupOriginal(spec.runtime, configPath, backup.record);
    const originalContainer = validateContainer(spec.runtime, backupPath(configPath), original, spec.containerKey);
    const hasInstalledEntry = Object.prototype.hasOwnProperty.call(backup.record, 'installedEntry');
    const currentDigestMatches = digest(snapshot.raw) === backup.record.installedDigest;
    if ('evolver' in originalContainer && !hasInstalledEntry) {
        throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'an original Evolver entry requires managed-entry metadata');
    }
    if (currentDigestMatches && hasInstalledEntry && !stableEqual(actual, backup.record.installedEntry)) {
        throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'installed entry does not match the current configuration');
    }
    if (force && actual !== undefined)
        return backup;
    const unrelatedConfigMatches = stableEqual(withoutEvolver(snapshot.data, spec.containerKey), withoutEvolver(original, spec.containerKey));
    if (!currentDigestMatches) {
        if (!unrelatedConfigMatches && !stableEqual(actual, expected)) {
            throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'stale backup does not match the current Evolver installation');
        }
        return backup;
    }
    if (!unrelatedConfigMatches) {
        throw new McpConfigShapeError('Evolver backup', backupPath(configPath), 'backup contents do not match the installed configuration');
    }
    return backup;
}
function validateContainer(runtime, path, data, key) {
    const value = data[key];
    if (value === undefined)
        return {};
    if (!isObject(value))
        throw new McpConfigShapeError(runtime, path, `${key} must be a JSON object`);
    return value;
}
function validateServer(server) {
    if (!server.command.trim())
        throw new McpServerValidationError('MCP server command must not be empty');
    const commandLine = [server.command, ...(server.args ?? [])].join(' ');
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(commandLine)
        || /(?:^|\s)--?(?:api[-_]?key|password|passwd|secret|token|private[-_]?key|credential|access[-_]?key|client[-_]?secret|passphrase)(?:=|\s+)\S+/i.test(commandLine)) {
        throw new McpServerValidationError('refusing inline secret-looking MCP command arguments; use EVOLVER_ENV_FILE');
    }
    for (const arg of server.args ?? []) {
        for (const match of arg.matchAll(/[a-z][a-z\d+.-]*:\/\/[^\s"'`<>]+/gi)) {
            let url;
            try {
                url = new URL(match[0]);
            }
            catch {
                continue;
            }
            if (url.username || url.password || [...url.searchParams.keys()].some(isSensitiveQueryName)) {
                throw new McpServerValidationError('refusing credential-bearing MCP server URL arguments; use EVOLVER_ENV_FILE');
            }
        }
    }
    const envKeys = Object.keys(server.env ?? {});
    if (envKeys.some((key) => key !== ENV_FILE_KEY)) {
        throw new McpServerValidationError(`refusing inline MCP environment values; only ${ENV_FILE_KEY} is allowed`);
    }
    const envFile = server.env?.[ENV_FILE_KEY]?.trim();
    if (envKeys.length > 0 && (!envFile || /[\0\r\n]/.test(envFile) || !looksLikeEnvFilePointer(envFile))) {
        throw new McpServerValidationError(`${ENV_FILE_KEY} must contain a file path, not a credential value`);
    }
}
function looksLikeEnvFilePointer(value) {
    return /[\\/]/.test(value)
        || /^[.~$%]/.test(value)
        || /\.(?:env|dotenv)(?:$|[._-])/i.test(value);
}
export function installJsonMcpRuntime(spec, plan, opts) {
    validateServer(opts.server);
    const resolution = resolveInstallRuntimeConfig(spec, opts);
    const { configPath, safeRoot } = resolution;
    assertSafeParents(spec.runtime, safeRoot, configPath);
    const topologySnapshot = captureConfigTopology(spec.runtime, resolution);
    for (const conflictingPath of resolution.conflictingPaths) {
        assertSafeParents(spec.runtime, safeRoot, conflictingPath);
        throw new McpConfigConflictError(spec.runtime, conflictingPath, 'a writable JSON config at the active precedence', 'JSONC config would override the Evolver-managed JSON target');
    }
    const expected = spec.entry(opts.server);
    const preflight = spec.installPreflight?.(resolution, opts, expected);
    if (preflight?.alreadyInstalled) {
        preflight.assertUnchanged();
        assertConfigTopologyUnchanged(spec.runtime, safeRoot, topologySnapshot);
        return {
            ok: true,
            runtime: plan.runtime,
            mode: plan.mode,
            files: [],
            ...(opts.dryRun ? { dryRun: true } : {}),
            alreadyInstalled: true,
            verified: true,
        };
    }
    const snapshot = readSnapshot(spec.runtime, configPath);
    const container = validateContainer(spec.runtime, configPath, snapshot.data, spec.containerKey);
    const actual = container['evolver'];
    const existingBackup = validateExistingBackupForInstall(spec, configPath, snapshot, expected, actual, opts.force === true);
    if (resolution.activePrecedencePath) {
        const activePath = resolution.activePrecedencePath;
        assertSafeParents(spec.runtime, safeRoot, activePath);
        const activeSnapshot = readSnapshot(spec.runtime, activePath);
        const activeContainer = validateContainer(spec.runtime, activePath, activeSnapshot.data, spec.containerKey);
        const activeActual = activeContainer['evolver'];
        if (stableEqual(activeActual, expected)) {
            assertConfigTopologyUnchanged(spec.runtime, safeRoot, topologySnapshot);
            return {
                ok: true,
                runtime: plan.runtime,
                mode: plan.mode,
                files: [],
                ...(opts.dryRun ? { dryRun: true } : {}),
                alreadyInstalled: true,
                verified: true,
            };
        }
        throw new McpConfigConflictError(spec.runtime, `${spec.containerKey}.evolver`, expected, activeActual === undefined ? '<missing>' : activeActual);
    }
    if (actual !== undefined && !stableEqual(actual, expected) && !opts.force) {
        throw new McpConfigConflictError(spec.runtime, `${spec.containerKey}.evolver`, expected, actual);
    }
    if (actual !== undefined && stableEqual(actual, expected)) {
        assertConfigTopologyUnchanged(spec.runtime, safeRoot, topologySnapshot);
        return {
            ok: true,
            runtime: plan.runtime,
            mode: plan.mode,
            files: [],
            ...(opts.dryRun ? { dryRun: true } : {}),
            alreadyInstalled: true,
            verified: true,
        };
    }
    const installed = { ...snapshot.data, [spec.containerKey]: { ...container, evolver: expected } };
    const installedRaw = `${JSON.stringify(installed, null, 2)}\n`;
    const backup = backupPath(configPath);
    if (opts.dryRun) {
        preflight?.assertUnchanged();
        assertConfigTopologyUnchanged(spec.runtime, safeRoot, topologySnapshot);
        return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [configPath], backups: [backup], dryRun: true };
    }
    const backupExisted = existingBackup !== undefined;
    let activeBackup = existingBackup;
    const previousBackup = existingBackup;
    let configReplaced = false;
    try {
        preflight?.assertUnchanged();
        if (!activeBackup) {
            activeBackup = createBackup(configPath, snapshot.raw, installedRaw, expected);
        }
        else {
            const currentWasUnmodified = snapshot.raw !== null && digest(snapshot.raw) === activeBackup.record.installedDigest;
            const nextRecord = {
                ...activeBackup.record,
                ...(currentWasUnmodified ? { installedDigest: digest(installedRaw) } : {}),
                installedEntry: expected,
            };
            if (!stableEqual(nextRecord, activeBackup.record)) {
                activeBackup = replaceBackup(configPath, activeBackup, nextRecord);
            }
        }
        const expectedBackupRaw = activeBackup.raw;
        guardedAtomicWrite(spec.runtime, safeRoot, configPath, installedRaw, snapshot.mode, snapshot.raw, () => {
            preflight?.assertUnchanged();
            assertBackupUnchanged(configPath, expectedBackupRaw);
            assertConfigTopologyUnchanged(spec.runtime, safeRoot, topologySnapshot);
        });
        configReplaced = true;
        afterReplaceHookForTest?.(configPath);
        preflight?.assertUnchanged();
        const verified = readSnapshot(spec.runtime, configPath).data;
        const verifiedContainer = validateContainer(spec.runtime, configPath, verified, spec.containerKey);
        if (!stableEqual(verifiedContainer['evolver'], expected))
            throw new McpConfigVerificationError(spec.runtime, configPath);
        assertBackupUnchanged(configPath, expectedBackupRaw);
        assertConfigTopologyUnchanged(spec.runtime, safeRoot, topologySnapshot);
    }
    catch (error) {
        const currentRaw = readRawIfExists(configPath);
        const installReachedConfig = currentRaw === installedRaw;
        let restored = currentRaw === snapshot.raw;
        if (installReachedConfig) {
            try {
                if (snapshot.raw === null)
                    guardedRemove(spec.runtime, safeRoot, configPath, installedRaw);
                else
                    guardedAtomicWrite(spec.runtime, safeRoot, configPath, snapshot.raw, snapshot.mode, installedRaw);
                restored = readRawIfExists(configPath) === snapshot.raw;
            }
            catch (rollbackError) {
                error.rollbackError = rollbackError;
            }
        }
        if (error instanceof McpConfigVerificationError && restored)
            error.markRestored();
        if (!configReplaced || restored) {
            if (!backupExisted && activeBackup) {
                removeBackupIfUnchanged(configPath, activeBackup.raw);
            }
            else if (previousBackup && activeBackup && activeBackup.raw !== previousBackup.raw) {
                try {
                    guardedAtomicWrite('Evolver backup', dirname(backupPath(configPath)), backupPath(configPath), previousBackup.raw, CONFIG_MODE, activeBackup.raw);
                }
                catch (rollbackError) {
                    error.backupRollbackError = rollbackError;
                }
            }
        }
        throw error;
    }
    return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [configPath], backups: [backup], verified: true };
}
function withoutEvolver(data, containerKey) {
    const container = validateContainer('runtime', '<config>', data, containerKey);
    const nextContainer = { ...container };
    delete nextContainer['evolver'];
    const next = { ...data };
    if (Object.keys(nextContainer).length > 0)
        next[containerKey] = nextContainer;
    else
        delete next[containerKey];
    return next;
}
export function uninstallJsonMcpRuntime(spec, runtime, opts) {
    const resolution = resolveUninstallRuntimeConfig(spec, opts);
    const { configPath, safeRoot } = resolution;
    assertSafeParents(spec.runtime, safeRoot, configPath);
    for (const conflictingPath of resolution.conflictingPaths) {
        assertSafeParents(spec.runtime, safeRoot, conflictingPath);
        throw new McpConfigConflictError(spec.runtime, conflictingPath, 'a writable JSON config at the active precedence', 'JSONC config would override the Evolver-managed JSON target');
    }
    const backup = readBackup(configPath);
    const backupFile = backupPath(configPath);
    if (!existsSync(configPath)) {
        if (!backup)
            return { ok: true, runtime, mode: 'uninstall', files: [], verified: true };
        if (opts.dryRun) {
            return { ok: true, runtime, mode: 'uninstall', files: [], backups: [backupFile], dryRun: true, verified: true };
        }
        assertBackupUnchanged(configPath, backup.raw);
        removeBackup(backupFile);
        return { ok: true, runtime, mode: 'uninstall', files: [], backups: [backupFile], verified: true };
    }
    const snapshot = readSnapshot(spec.runtime, configPath);
    const container = validateContainer(spec.runtime, configPath, snapshot.data, spec.containerKey);
    if (!('evolver' in container)) {
        if (!backup)
            return { ok: true, runtime, mode: 'uninstall', files: [], verified: true };
        if (opts.dryRun) {
            return { ok: true, runtime, mode: 'uninstall', files: [], backups: [backupFile], dryRun: true, verified: true };
        }
        assertBackupUnchanged(configPath, backup.raw);
        removeBackup(backupFile);
        return { ok: true, runtime, mode: 'uninstall', files: [], backups: [backupFile], verified: true };
    }
    const currentRaw = snapshot.raw;
    const backupGuard = backup ? () => assertBackupUnchanged(configPath, backup.raw) : undefined;
    let nextRaw = snapshot.raw;
    if (backup && digest(currentRaw) === backup.record.installedDigest) {
        const original = parseBackupOriginal(spec.runtime, configPath, backup.record);
        if (!stableEqual(withoutEvolver(snapshot.data, spec.containerKey), withoutEvolver(original, spec.containerKey))) {
            throw new McpConfigOwnershipError(spec.runtime, 'backup contents do not match the installed configuration');
        }
        nextRaw = backup.record.originalExists ? backup.record.originalRaw : null;
    }
    else {
        if (!backup) {
            throw new McpConfigOwnershipError(spec.runtime, 'an Evolver entry exists without a managed backup; ownership cannot be proven');
        }
        if (!Object.prototype.hasOwnProperty.call(backup.record, 'installedEntry')) {
            throw new McpConfigOwnershipError(spec.runtime, 'legacy backup metadata can only be restored when the installed configuration matches exactly');
        }
        if (!stableEqual(container['evolver'], backup.record.installedEntry)) {
            throw new McpConfigOwnershipError(spec.runtime, 'the managed Evolver entry was changed after installation; refusing to remove user changes');
        }
        const nextContainer = { ...container };
        const original = parseBackupOriginal(spec.runtime, configPath, backup.record);
        const originalContainer = validateContainer(spec.runtime, backupPath(configPath), original, spec.containerKey);
        if ('evolver' in originalContainer) {
            nextContainer['evolver'] = originalContainer['evolver'];
        }
        else {
            delete nextContainer['evolver'];
        }
        const next = { ...snapshot.data };
        if (Object.keys(nextContainer).length > 0)
            next[spec.containerKey] = nextContainer;
        else
            delete next[spec.containerKey];
        nextRaw = `${JSON.stringify(next, null, 2)}\n`;
    }
    if (opts.dryRun) {
        return {
            ok: true,
            runtime,
            mode: 'uninstall',
            files: [configPath],
            backups: backup ? [backupFile] : [],
            dryRun: true,
            verified: true,
        };
    }
    let configChanged = false;
    try {
        if (nextRaw === null) {
            guardedRemove(spec.runtime, safeRoot, configPath, snapshot.raw, backupGuard);
            configChanged = true;
        }
        else if (nextRaw !== snapshot.raw) {
            guardedAtomicWrite(spec.runtime, safeRoot, configPath, nextRaw, snapshot.mode, snapshot.raw, backupGuard);
            configChanged = true;
        }
        if (readRawIfExists(configPath) !== nextRaw) {
            throw new McpConfigVerificationError(spec.runtime, configPath);
        }
        if (backup) {
            assertSafePath(backupFile, 'runtime config backup');
            if (readRawIfExists(backupFile) !== backup.raw) {
                throw new McpConfigChangedError('Evolver backup', backupFile);
            }
            removeBackup(backupFile);
        }
    }
    catch (error) {
        if (configChanged && readRawIfExists(configPath) === nextRaw) {
            try {
                guardedAtomicWrite(spec.runtime, safeRoot, configPath, snapshot.raw, snapshot.mode, nextRaw, backupGuard);
                if (readRawIfExists(configPath) !== snapshot.raw) {
                    throw new McpConfigVerificationError(spec.runtime, configPath);
                }
            }
            catch (rollbackError) {
                error.rollbackError = rollbackError;
            }
        }
        throw error;
    }
    return { ok: true, runtime, mode: 'uninstall', files: [configPath], backups: backup ? [backupFile] : [], verified: true };
}