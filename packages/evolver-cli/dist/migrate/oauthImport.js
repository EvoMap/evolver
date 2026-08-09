// V1 oauth_token.json to V2 token.json explicit offline converter (Refs #697).
// Product decision for this slice: migration runs only when the operator invokes this command.
// Re-login remains the supported fallback when conversion fails or tokens are unusable.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CredentialStore, CredentialStoreError, machineFingerprint, resolveMachineId, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { publicOAuthTokenPath } from '../login.js';
import { resolveIdentityHome } from '../identityHome.js';
const MAX_OAUTH_JSON_BYTES = 256 * 1024;
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonBlank(value) {
    if (typeof value !== 'string')
        return undefined;
    const t = value.trim();
    return t.length > 0 ? t : undefined;
}
function secretString(value) {
    if (typeof value !== 'string' || value.trim().length === 0)
        return undefined;
    return value;
}
function pickString(obj, keys) {
    for (const key of keys) {
        const v = nonBlank(obj[key]);
        if (v)
            return v;
    }
    return undefined;
}
function pickSecret(obj, keys) {
    for (const key of keys) {
        const value = secretString(obj[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
/** Normalize expires fields: ms epoch preferred; accept seconds epoch or expires_in relative. */
export function normalizeExpiresAt(raw, nowMs) {
    const expAt = raw['expiresAt'] ?? raw['expires_at'] ?? raw['expiry'] ?? raw['exp'];
    if (typeof expAt === 'number' && Number.isFinite(expAt) && expAt > 0) {
        // Heuristic: values < 1e12 are seconds.
        return expAt < 1e12 ? Math.floor(expAt * 1000) : Math.floor(expAt);
    }
    if (typeof expAt === 'string' && expAt.trim()) {
        const asNum = Number(expAt);
        if (Number.isFinite(asNum) && asNum > 0) {
            return asNum < 1e12 ? Math.floor(asNum * 1000) : Math.floor(asNum);
        }
        const parsed = Date.parse(expAt);
        if (Number.isFinite(parsed))
            return parsed;
    }
    const expiresIn = raw['expiresInMs'] ?? raw['expires_in_ms'] ?? raw['expires_in'] ?? raw['expiresIn'];
    if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
        // expires_in is usually seconds; expiresInMs is ms. Prefer key name.
        if (raw['expiresInMs'] !== undefined || raw['expires_in_ms'] !== undefined) {
            return nowMs + Math.floor(expiresIn);
        }
        // bare expires_in / expiresIn → seconds (OAuth2)
        if (raw['expires_in'] !== undefined || raw['expiresIn'] !== undefined) {
            return nowMs + Math.floor(expiresIn * 1000);
        }
        return nowMs + Math.floor(expiresIn);
    }
    return undefined;
}
/**
 * Parse a V1 (or already-V2) OAuth JSON object into a V2 hub.Credential.
 * Accepts snake_case OAuth2, nested token objects, and V2 credential shape.
 */
export function parseV1OAuthJson(raw, nowMs = Date.now()) {
    if (!isPlainRecord(raw)) {
        throw new Error('oauth_json_not_object');
    }
    // Nested { token: { access_token, ... } } or { oauth: {...} }
    let body = raw;
    let shape = 'unknown';
    if (isPlainRecord(raw['token']) && !nonBlank(raw['token']) && !nonBlank(raw['access_token'])) {
        body = raw['token'];
        shape = 'nested';
    }
    else if (isPlainRecord(raw['oauth'])) {
        body = raw['oauth'];
        shape = 'nested';
    }
    const access = pickSecret(body, ['token', 'access_token', 'accessToken'])
        ?? pickSecret(raw, ['token', 'access_token', 'accessToken']);
    const refresh = pickSecret(body, ['refreshToken', 'refresh_token', 'refresh'])
        ?? pickSecret(raw, ['refreshToken', 'refresh_token', 'refresh']);
    const device = pickString(body, ['device', 'device_id', 'deviceId', 'fingerprint', 'machine_id'])
        ?? pickString(raw, ['device', 'device_id', 'deviceId', 'fingerprint', 'machine_id']);
    const kindRaw = pickString(body, ['kind']) ?? pickString(raw, ['kind']);
    if (kindRaw && kindRaw !== 'oauth_device_token') {
        throw new Error('oauth_unsupported_kind');
    }
    // Detect V2 shape
    if (body['kind'] === 'oauth_device_token' || raw['kind'] === 'oauth_device_token') {
        shape = 'v2-credential';
    }
    else if (body['access_token'] !== undefined || raw['access_token'] !== undefined || body['refresh_token'] !== undefined) {
        if (shape === 'unknown')
            shape = 'oauth2-snake';
    }
    else if (body['token'] !== undefined && typeof body['token'] === 'string') {
        if (shape === 'unknown')
            shape = 'v2-credential';
    }
    if (!access && !refresh) {
        throw new Error('oauth_missing_token');
    }
    const expiresAt = normalizeExpiresAt(body, nowMs) ?? normalizeExpiresAt(raw, nowMs);
    const id = pickString(body, ['id'])
        ?? pickString(raw, ['id'])
        ?? (device ? `oauth-${device.slice(0, 12)}` : 'oauth-migrated-v1');
    // The credential union requires a token. A refresh-only import uses a fixed
    // placeholder that must always be expired so authenticate() rotates before use.
    const token = access ?? 'migrated-pending-refresh';
    const effectiveExpiresAt = access ? expiresAt : nowMs - 1;
    const cred = {
        id,
        kind: 'oauth_device_token',
        token,
        ...(device ? { device } : {}),
        ...(effectiveExpiresAt !== undefined ? { expiresAt: effectiveExpiresAt } : {}),
        ...(refresh ? { refreshToken: refresh } : {}),
    };
    return {
        cred,
        shape,
        hasAccessToken: Boolean(access),
        hasRefreshToken: Boolean(refresh),
        hasExpires: expiresAt !== undefined,
        hasDevice: Boolean(device),
    };
}
export function defaultV1OAuthPath(opts = {}) {
    const env = opts.env ?? process.env;
    // V1 only honored EVOLVER_HOME. EVOMAP_HOME / EVOMAP_DIR are V2 identity
    // roots and must not redirect discovery away from the legacy credential.
    const home = nonBlank(env['EVOLVER_HOME']) ?? join(opts.homeDir ?? homedir(), '.evomap');
    return join(home, 'oauth_token.json');
}
class JsonSnapshotError extends Error {
    code;
    snapshot;
    constructor(code, snapshot) {
        super(code);
        this.code = code;
        this.snapshot = snapshot;
        this.name = 'JsonSnapshotError';
    }
}
function isErrno(error, code) {
    return error.code === code;
}
function optionalConstant(name) {
    return constants[name] ?? 0;
}
function sameFileIdentity(left, right) {
    const stableId = left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n;
    return stableId
        ? left.dev === right.dev && left.ino === right.ino
        : left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
}
function sameFileSnapshot(left, right) {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function sameTrustedSecuritySnapshot(left, right) {
    return sameFileIdentity(left, right)
        && left.ctimeNs === right.ctimeNs
        && left.mtimeNs === right.mtimeNs
        && left.size === right.size
        && left.mode === right.mode
        && left.uid === right.uid;
}
function readBoundedJsonText(fd, purpose) {
    const buffer = Buffer.allocUnsafe(MAX_OAUTH_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0)
            break;
        offset += bytesRead;
    }
    if (offset > MAX_OAUTH_JSON_BYTES) {
        throw new JsonSnapshotError(`oauth_${purpose}_too_large`);
    }
    return buffer.subarray(0, offset).toString('utf8');
}
function pathKey(path) {
    return process.platform === 'win32' ? path.toLowerCase() : path;
}
function readJsonSnapshot(path, purpose, hook) {
    let requested;
    try {
        requested = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            throw new JsonSnapshotError(`oauth_${purpose}_missing`);
        throw new JsonSnapshotError(`oauth_${purpose}_stat_failed`);
    }
    if (!requested.isFile() || requested.isSymbolicLink()) {
        throw new JsonSnapshotError(`oauth_${purpose}_not_regular_file`);
    }
    if (requested.size > BigInt(MAX_OAUTH_JSON_BYTES)) {
        throw new JsonSnapshotError(`oauth_${purpose}_too_large`);
    }
    let canonicalPath;
    let canonicalBefore;
    try {
        canonicalPath = realpathSync(path);
        canonicalBefore = lstatSync(canonicalPath, { bigint: true });
    }
    catch {
        throw new JsonSnapshotError(`oauth_${purpose}_changed`);
    }
    if (!canonicalBefore.isFile() || canonicalBefore.isSymbolicLink()
        || !sameFileSnapshot(requested, canonicalBefore)) {
        throw new JsonSnapshotError(`oauth_${purpose}_changed`);
    }
    hook?.('before-open', path);
    let fd;
    try {
        fd = openSync(canonicalPath, constants.O_RDONLY | optionalConstant('O_NOFOLLOW') | optionalConstant('O_NONBLOCK'));
    }
    catch (error) {
        if (isErrno(error, 'ELOOP'))
            throw new JsonSnapshotError(`oauth_${purpose}_not_regular_file`);
        throw new JsonSnapshotError(`oauth_${purpose}_changed`);
    }
    let opened;
    let text;
    try {
        opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameFileSnapshot(canonicalBefore, opened)) {
            throw new JsonSnapshotError(`oauth_${purpose}_changed`);
        }
        if (opened.size > BigInt(MAX_OAUTH_JSON_BYTES)) {
            throw new JsonSnapshotError(`oauth_${purpose}_too_large`);
        }
        hook?.('after-open', path);
        text = readBoundedJsonText(fd, purpose);
        hook?.('after-read', path);
        const afterFd = fstatSync(fd, { bigint: true });
        let afterPath;
        let afterCanonical;
        try {
            afterPath = lstatSync(path, { bigint: true });
            afterCanonical = realpathSync(path);
        }
        catch {
            throw new JsonSnapshotError(`oauth_${purpose}_changed`);
        }
        if (!afterPath.isFile() || afterPath.isSymbolicLink()
            || pathKey(afterCanonical) !== pathKey(canonicalPath)
            || !sameFileSnapshot(opened, afterFd)
            || !sameFileSnapshot(afterFd, afterPath)) {
            throw new JsonSnapshotError(`oauth_${purpose}_changed`);
        }
    }
    finally {
        closeSync(fd);
    }
    try {
        return { value: JSON.parse(text), canonicalPath, stat: opened };
    }
    catch {
        throw new JsonSnapshotError(`oauth_${purpose}_invalid_json`, { value: undefined, canonicalPath, stat: opened });
    }
}
function isUsableOAuthCredential(value) {
    if (!isPlainRecord(value) || value['kind'] !== 'oauth_device_token')
        return false;
    if (typeof value['id'] !== 'string' || value['id'].trim().length === 0)
        return false;
    if (typeof value['token'] !== 'string' || value['token'].trim().length === 0)
        return false;
    if (value['refreshToken'] !== undefined
        && (typeof value['refreshToken'] !== 'string' || value['refreshToken'].trim().length === 0))
        return false;
    if (value['expiresAt'] !== undefined
        && (typeof value['expiresAt'] !== 'number' || !Number.isFinite(value['expiresAt'])))
        return false;
    if (value['device'] !== undefined && typeof value['device'] !== 'string')
        return false;
    return true;
}
function inspectDestination(path) {
    let snapshot;
    try {
        snapshot = readJsonSnapshot(path, 'destination');
    }
    catch (error) {
        const code = error instanceof JsonSnapshotError ? error.code : 'oauth_destination_read_failed';
        if (code === 'oauth_destination_missing')
            return { status: 'absent' };
        return {
            status: 'invalid',
            code,
            ...(error instanceof JsonSnapshotError && error.snapshot !== undefined
                ? { snapshot: error.snapshot }
                : {}),
        };
    }
    if (!isUsableOAuthCredential(snapshot.value)) {
        return { status: 'invalid', code: 'oauth_destination_invalid_credential', snapshot };
    }
    return { status: 'valid', snapshot };
}
function validateTrustedSnapshot(path, snapshot, purpose) {
    try {
        const inspected = new CredentialStore(path).inspectTrustedExisting();
        if (inspected === null || !sameTrustedSecuritySnapshot(snapshot.stat, inspected)) {
            return `oauth_${purpose}_changed`;
        }
        return null;
    }
    catch {
        return purpose === 'source'
            ? 'oauth_source_untrusted'
            : 'oauth_destination_credential_store_refused';
    }
}
function validateTrustedDestinationParent(path) {
    try {
        new CredentialStore(path).inspectTrustedParentForCreate();
        return null;
    }
    catch {
        return 'oauth_destination_credential_store_refused';
    }
}
function validateStoredDestination(path) {
    try {
        const loaded = new CredentialStore(path).load();
        return isUsableOAuthCredential(loaded)
            ? null
            : 'oauth_destination_invalid_credential';
    }
    catch {
        return 'oauth_destination_credential_store_refused';
    }
}
/**
 * Convert V1 ~/.evomap/oauth_token.json into V2 token.json via CredentialStore.
 * Never prints secret values. Fail-closed on unsafe paths / missing tokens.
 */
export function migrateV1OAuth(options = {}) {
    const env = options.env ?? process.env;
    const homeDir = options.homeDir;
    const fromPath = resolve(options.fromPath ?? defaultV1OAuthPath({ env, homeDir }));
    const toPath = resolve(options.toPath ?? publicOAuthTokenPath({ env, homeDir }));
    const now = options.now ?? (() => Date.now());
    const nowMs = now();
    const emptyFields = {
        hasAccessToken: false,
        hasRefreshToken: false,
        hasExpires: false,
        hasDevice: false,
        shape: 'unknown',
    };
    if (pathKey(fromPath) === pathKey(toPath)) {
        return {
            status: 'refused',
            fromPath,
            toPath,
            sourceFields: emptyFields,
            message: 'oauth_source_destination_same_file',
        };
    }
    const destination = inspectDestination(toPath);
    if (options.dryRun && destination.status !== 'absent' && destination.snapshot !== undefined) {
        const destinationError = validateTrustedSnapshot(toPath, destination.snapshot, 'destination');
        if (destinationError !== null) {
            return {
                status: 'refused',
                fromPath,
                toPath,
                sourceFields: emptyFields,
                message: destinationError,
            };
        }
    }
    if (destination.status === 'invalid' && (!options.force || destination.snapshot === undefined)) {
        return {
            status: 'refused',
            fromPath,
            toPath,
            sourceFields: emptyFields,
            message: destination.code,
        };
    }
    if (destination.status === 'valid' && !options.force) {
        if (!options.dryRun) {
            const destinationError = validateStoredDestination(toPath);
            if (destinationError !== null) {
                return {
                    status: 'refused',
                    fromPath,
                    toPath,
                    sourceFields: emptyFields,
                    message: destinationError,
                };
            }
        }
        return {
            status: 'skipped_existing',
            fromPath,
            toPath,
            sourceFields: emptyFields,
            message: 'valid V2 OAuth credential already exists; pass --force to replace it',
        };
    }
    let sourceSnapshot;
    let parsed;
    try {
        sourceSnapshot = readJsonSnapshot(fromPath, 'source', options.sourceReadTestHook);
        options.beforeSourceTrustTestHook?.(fromPath);
        const sourceTrustError = validateTrustedSnapshot(fromPath, sourceSnapshot, 'source');
        if (sourceTrustError !== null)
            throw new JsonSnapshotError(sourceTrustError);
        parsed = parseV1OAuthJson(sourceSnapshot.value, nowMs);
    }
    catch (error) {
        const rawCode = error instanceof JsonSnapshotError
            ? error.code
            : error instanceof Error && /^oauth_[a-z_]+$/.test(error.message)
                ? error.message
                : 'oauth_parse_failed';
        const missing = rawCode === 'oauth_source_missing';
        return {
            status: missing ? 'source_missing' : 'invalid_source',
            fromPath,
            toPath,
            sourceFields: emptyFields,
            message: missing
                ? 'V1 oauth_token.json not found; run `evolver login` if Hub auth is required'
                : rawCode,
        };
    }
    if (destination.status !== 'absent' && destination.snapshot !== undefined
        && (pathKey(destination.snapshot.canonicalPath) === pathKey(sourceSnapshot.canonicalPath)
            || sameFileIdentity(destination.snapshot.stat, sourceSnapshot.stat))) {
        return {
            status: 'refused',
            fromPath,
            toPath,
            sourceFields: emptyFields,
            message: 'oauth_source_destination_same_file',
        };
    }
    const sourceFields = {
        hasAccessToken: parsed.hasAccessToken,
        hasRefreshToken: parsed.hasRefreshToken,
        hasExpires: parsed.hasExpires,
        hasDevice: parsed.hasDevice,
        shape: parsed.shape,
    };
    const accessExpired = parsed.cred.expiresAt !== undefined ? parsed.cred.expiresAt <= nowMs : false;
    if (options.dryRun) {
        if (destination.status === 'absent') {
            const destinationError = validateTrustedDestinationParent(toPath);
            if (destinationError !== null) {
                return {
                    status: 'refused',
                    fromPath,
                    toPath,
                    sourceFields,
                    accessExpired,
                    message: destinationError,
                };
            }
        }
        return {
            status: 'dry_run',
            fromPath,
            toPath,
            sourceFields,
            accessExpired,
            message: 'dry-run: source is valid; no credential or machine-id was written',
        };
    }
    let device;
    try {
        device = options.deviceFingerprint ?? machineFingerprint(resolveMachineId({
            softIdPath: join(resolveIdentityHome(env, homeDir), 'machine-id'),
        }).id);
        if (!/^[a-f0-9]{64}$/.test(device))
            throw new Error('invalid_device_fingerprint');
        const credential = {
            ...parsed.cred,
            id: `oauth-${device.slice(0, 12)}`,
            device,
        };
        options.beforeSaveTestHook?.(toPath);
        const store = new CredentialStore(toPath);
        const stored = options.force ? (store.save(credential), true) : store.saveIfAbsent(credential);
        if (!stored) {
            const incumbent = inspectDestination(toPath);
            if (incumbent.status !== 'valid') {
                return {
                    status: 'refused',
                    fromPath,
                    toPath,
                    sourceFields,
                    accessExpired,
                    message: incumbent.status === 'invalid'
                        ? incumbent.code
                        : 'oauth_destination_changed',
                };
            }
            const incumbentError = validateStoredDestination(toPath);
            if (incumbentError !== null) {
                return {
                    status: 'refused',
                    fromPath,
                    toPath,
                    sourceFields,
                    accessExpired,
                    message: incumbentError,
                };
            }
            return {
                status: 'skipped_existing',
                fromPath,
                toPath,
                sourceFields,
                accessExpired,
                message: 'concurrent writer published a valid V2 OAuth credential; migration did not overwrite it',
            };
        }
    }
    catch (error) {
        return {
            status: 'refused',
            fromPath,
            toPath,
            sourceFields,
            accessExpired,
            message: error instanceof CredentialStoreError
                ? 'oauth_destination_credential_store_refused'
                : 'oauth_credential_write_failed',
        };
    }
    const tips = [];
    if (!parsed.hasRefreshToken && accessExpired) {
        tips.push('access token appears expired and no refresh_token; run `evolver login` if Hub rejects it');
    }
    else if (!parsed.hasRefreshToken) {
        tips.push('no refresh_token in V1 file; re-login if Hub rejects it');
    }
    else if (accessExpired) {
        tips.push('access token expired; V2 will refresh via refresh_token on next Hub call');
    }
    return {
        status: 'migrated',
        fromPath,
        toPath,
        sourceFields,
        accessExpired,
        message: tips.length > 0
            ? `migrated OAuth credential to ${toPath} (${tips.join('; ')})`
            : `migrated OAuth credential to ${toPath}`,
    };
}
function formatOAuthMigrateReport(report) {
    const f = report.sourceFields;
    return [
        `oauth migrate: ${report.status}`,
        `  from: ${report.fromPath}`,
        `  to:   ${report.toPath}`,
        `  fields: access=${f.hasAccessToken} refresh=${f.hasRefreshToken} expires=${f.hasExpires} device=${f.hasDevice} shape=${f.shape}`,
        report.accessExpired !== undefined ? `  access_expired: ${report.accessExpired}` : '',
        `  ${report.message}`,
    ].filter(Boolean).join('\n') + '\n';
}
function parseMigrateOAuthArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i] ?? '';
        if (a === '--force')
            opts.force = true;
        else if (a === '--dry-run')
            opts.dryRun = true;
        else if (a === '--from') {
            const v = argv[++i];
            if (!v || v.startsWith('--'))
                return { error: 'migrate oauth --from requires a path' };
            opts.fromPath = v;
        }
        else if (a.startsWith('--from=')) {
            const value = a.slice('--from='.length);
            if (!value)
                return { error: 'migrate oauth --from requires a path' };
            opts.fromPath = value;
        }
        else if (a === '--to') {
            const v = argv[++i];
            if (!v || v.startsWith('--'))
                return { error: 'migrate oauth --to requires a path' };
            opts.toPath = v;
        }
        else if (a.startsWith('--to=')) {
            const value = a.slice('--to='.length);
            if (!value)
                return { error: 'migrate oauth --to requires a path' };
            opts.toPath = value;
        }
        else if (a === '--json')
            opts.json = true;
        else if (a === '--help' || a === '-h')
            return { error: 'help' };
        else
            return { error: 'unknown argument' };
    }
    return opts;
}
export async function runMigrateOAuthCommand(argv, io = {}) {
    const stdout = io.stdout ?? ((s) => { process.stdout.write(s); });
    const stderr = io.stderr ?? ((s) => { process.stderr.write(s); });
    const usage = [
        'Usage: evolver migrate oauth [--from <oauth_token.json>] [--to <token.json>] [--force] [--dry-run] [--json]',
        '',
        'Import V1 ~/.evomap/oauth_token.json into V2 token.json (CredentialStore).',
        'Does not print secret values. Re-login remains valid if migration is incomplete.',
        '',
    ].join('\n');
    const parsed = parseMigrateOAuthArgs(argv);
    if ('error' in parsed) {
        if (parsed.error === 'help') {
            stdout(usage);
            return 0;
        }
        stderr(`${parsed.error}\n${usage}`);
        return 1;
    }
    const json = Boolean(parsed.json);
    const env = io.env ?? process.env;
    const envLoad = loadEnvFileFromEnv(env);
    if (envLoad.error) {
        stderr('migrate oauth: failed to load EVOLVER_ENV_FILE\n');
        return 1;
    }
    const report = migrateV1OAuth({ ...parsed, env });
    if (json) {
        stdout(`${JSON.stringify(report, null, 2)}\n`);
    }
    else {
        stdout(formatOAuthMigrateReport(report));
    }
    if (report.status === 'migrated' || report.status === 'dry_run')
        return 0;
    if (report.status === 'skipped_existing')
        return 0;
    if (report.status === 'source_missing')
        return 2;
    return 1;
}