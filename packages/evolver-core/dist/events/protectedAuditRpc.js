import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProtectedAuditFrameReceiver } from './protectedAuditFrame.js';
/** The socket is an OS-owned trust boundary, not a caller-selected fallback path. */
export class ProtectedAuditUnavailableError extends Error {
    reason;
    constructor(reason, options) {
        super(`protected_audit_unavailable: ${reason}`, options);
        this.reason = reason;
        this.name = 'ProtectedAuditUnavailableError';
    }
}
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
let rpcChildCommand;
let serviceProcess = false;
let serviceRequired = false;
/** Set only with an administrator-owned service config naming this distinct UID. */
export function markProtectedAuditServiceProcess(configPath) {
    if (process.platform === 'win32' || !isAbsolute(configPath))
        throw new ProtectedAuditUnavailableError('service_identity_invalid');
    let parent = resolve(dirname(configPath));
    for (;;) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
            throw new ProtectedAuditUnavailableError('service_identity_parent_untrusted');
        }
        const next = dirname(parent);
        if (next === parent)
            break;
        parent = next;
    }
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o137) !== 0 || stat.size > 4096) {
        throw new ProtectedAuditUnavailableError('service_identity_config_untrusted');
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!Number.isSafeInteger(config.serviceUid) || config.serviceUid !== process.getuid?.() || config.serviceUid < 1) {
        throw new ProtectedAuditUnavailableError('service_identity_invalid');
    }
    serviceProcess = true;
}
export function isProtectedAuditServiceProcess() { return serviceProcess; }
/** The shipped CLI requires a separate-UID writer for every POSIX audit path. */
export function requireProtectedAuditServiceForProcess() { serviceRequired = true; }
/** The CLI registers a self-binary route, so clean Bun binaries need no loose JS helper. */
export function configureProtectedAuditRpcChildCommand(value) {
    if (!isAbsolute(value.command) || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
        throw new ProtectedAuditUnavailableError('sync_child_command_invalid');
    }
    rpcChildCommand = { command: value.command, args: [...value.args] };
}
function logicalClientPathAllowed(config, method, path) {
    const call = method === 'append_call' || method.startsWith('read_call');
    if (path === (call ? config.assetCallLogPath : config.rootEventsPath))
        return true;
    const prefix = config.allowedRootPrefix;
    return Boolean(prefix && isAbsolute(path) && resolve(path) === path && path.startsWith(`${prefix}${sep}`)
        && path.endsWith(call ? `${sep}asset_call_log.jsonl` : `${sep}evolution${sep}root_events.jsonl`));
}
export function protectedAuditClientConfigPath() {
    if (process.platform === 'linux')
        return '/etc/evolver/protected-audit-client.json';
    if (process.platform === 'darwin')
        return '/Library/Application Support/EvoMap/ProtectedAudit/client.json';
    return undefined;
}
function requiredMarkerPath() {
    const config = protectedAuditClientConfigPath();
    if (!config)
        return undefined;
    return resolve(dirname(config), 'protected-audit-required');
}
/** POSIX admission is fail-closed by default. Only privileged migration fixtures and Vite-isolated tests use local history. */
export function protectedAuditConfigured() {
    const path = protectedAuditClientConfigPath();
    if (path === undefined)
        return false;
    if (!existsSync(path)) {
        const marker = requiredMarkerPath();
        if (serviceProcess)
            return false;
        if (marker && existsSync(marker))
            throw new ProtectedAuditUnavailableError('required_service_disabled');
        const vitestOnly = import.meta.url.endsWith('/src/events/protectedAuditRpc.ts')
            && process.env.VITEST === 'true' && /^\d+$/.test(process.env.VITEST_WORKER_ID ?? '');
        if (serviceRequired || (!vitestOnly && process.getuid?.() !== 0)) {
            throw new ProtectedAuditUnavailableError('service_not_provisioned');
        }
        return false;
    }
    const config = clientConfig(true);
    if (config.serviceUid === process.getuid?.()) {
        if (!serviceProcess)
            throw new ProtectedAuditUnavailableError('principal_not_separated');
        return false;
    }
    return true;
}
function clientConfig(allowService = false) {
    const path = protectedAuditClientConfigPath();
    if (!path || !existsSync(path))
        throw new ProtectedAuditUnavailableError('client_config_missing');
    let parent = resolve(dirname(path));
    for (;;) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
            throw new ProtectedAuditUnavailableError('client_config_parent_untrusted');
        }
        const next = dirname(parent);
        if (next === parent)
            break;
        parent = next;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) {
        throw new ProtectedAuditUnavailableError('client_config_untrusted');
    }
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (config.version !== 1 || !Number.isSafeInteger(config.serviceUid) || config.serviceUid < 1
        || !Number.isSafeInteger(config.clientGid) || config.clientGid < 1
        || !isAbsolute(config.socketPath) || !isAbsolute(config.rootEventsPath)
        || !isAbsolute(config.assetCallLogPath) || (!allowService && process.getuid?.() === config.serviceUid)
        || (config.allowedRootPrefix !== undefined && (!isAbsolute(config.allowedRootPrefix)
            || resolve(config.allowedRootPrefix) !== config.allowedRootPrefix || config.allowedRootPrefix === '/'))
        || !(process.getgroups?.().includes(config.clientGid) || process.getgid?.() === config.clientGid)) {
        throw new ProtectedAuditUnavailableError('client_config_invalid');
    }
    return config;
}
/**
 * A socket in a client-writable parent can be swapped after checking it.
 * Every ancestor must be non-writable by the client, and the socket must be
 * owned by the configured service UID, which differs from this process UID.
 */
export function protectedAuditSocketPath() {
    if (process.platform === 'win32')
        throw new ProtectedAuditUnavailableError('posix_service_on_windows');
    const config = clientConfig();
    const path = config.socketPath;
    const serviceUid = config.serviceUid;
    const clientUid = process.getuid?.();
    if (clientUid === undefined || clientUid === serviceUid)
        throw new ProtectedAuditUnavailableError('principal_not_separated');
    let current = resolve(dirname(path));
    for (;;) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
            || stat.uid === clientUid || (stat.uid !== 0 && stat.uid !== serviceUid)) {
            throw new ProtectedAuditUnavailableError('socket_parent_untrusted');
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    const socket = lstatSync(path);
    if (!socket.isSocket() || socket.uid !== serviceUid || (socket.mode & 0o002) !== 0) {
        throw new ProtectedAuditUnavailableError('socket_identity_untrusted');
    }
    return path;
}
/**
 * One bounded request with a stable operation ID. Transport ambiguity is never
 * reported as a non-commit and must not trigger a blind replay by the caller.
 */
export function protectedAuditRpc(method, path, payload, options) {
    const socketPath = protectedAuditSocketPath();
    const config = clientConfig();
    if (!logicalClientPathAllowed(config, method, path)) {
        return Promise.reject(new ProtectedAuditUnavailableError('logical_path_not_provisioned'));
    }
    const operationId = options.operationId ?? randomUUID();
    if (!Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt || options.signal?.aborted) {
        return Promise.reject(new ProtectedAuditUnavailableError('admission_expired'));
    }
    const request = { version: 1, operationId, method, path, payload, deadlineAt: options.deadlineAt };
    return exchangeProtectedAuditFrame(socketPath, request, () => {
        if (protectedAuditSocketPath() !== socketPath)
            throw new ProtectedAuditUnavailableError('socket_replaced');
    }, options.signal);
}
/** Internal transport only. The public wrapper owns configuration, logical
 * path and OS-principal admission; its mandatory pre-write check is retained. */
export function exchangeProtectedAuditFrame(socketPath, request, verifyBeforeWrite, signal) {
    const { operationId, deadlineAt } = request;
    if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt || signal?.aborted) {
        return Promise.reject(new ProtectedAuditUnavailableError('admission_expired'));
    }
    const bytes = Buffer.from(JSON.stringify(request));
    if (bytes.length > MAX_REQUEST_BYTES)
        return Promise.reject(new ProtectedAuditUnavailableError('request_too_large'));
    const frame = Buffer.allocUnsafe(4 + bytes.length);
    frame.writeUInt32BE(bytes.length, 0);
    bytes.copy(frame, 4);
    return new Promise((resolveResult, rejectResult) => {
        let done = false;
        const receiver = new ProtectedAuditFrameReceiver(MAX_RESPONSE_BYTES);
        const socket = createConnection(socketPath);
        const finish = (error, result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            socket.destroy();
            if (error !== undefined)
                rejectResult(error);
            else
                resolveResult(result);
        };
        const abort = () => finish(new ProtectedAuditUnavailableError('transport_aborted_unknown'));
        const timer = setTimeout(() => finish(new ProtectedAuditUnavailableError('transport_timeout_unknown')), Math.max(1, Math.min(30_000, deadlineAt - Date.now())));
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('connect', () => {
            try {
                verifyBeforeWrite();
                if (Date.now() >= deadlineAt || signal?.aborted)
                    throw new ProtectedAuditUnavailableError('admission_expired');
                socket.write(frame);
            }
            catch (error) {
                finish(error);
            }
        });
        socket.on('data', chunk => {
            let received;
            try {
                received = receiver.feed(chunk);
            }
            catch (error) {
                finish(new ProtectedAuditUnavailableError('response_frame_invalid', { cause: error }));
                return;
            }
            if (!received)
                return;
            let reply;
            try {
                reply = JSON.parse(received.toString('utf8'));
            }
            catch {
                finish(new ProtectedAuditUnavailableError('response_invalid'));
                return;
            }
            if (reply === null || typeof reply !== 'object' || Array.isArray(reply)
                || reply.version !== 1 || reply.operationId !== operationId || typeof reply.ok !== 'boolean'
                || (reply.error !== undefined && typeof reply.error !== 'string')) {
                finish(new ProtectedAuditUnavailableError('response_identity_invalid'));
                return;
            }
            if (!reply.ok) {
                finish(new ProtectedAuditUnavailableError(reply.error ?? 'service_refused'));
                return;
            }
            finish(undefined, reply.value);
        });
        socket.once('error', error => finish(error));
        socket.once('close', () => finish(new ProtectedAuditUnavailableError('transport_closed_unknown')));
    });
}
/**
 * The public root-event and call-log readers are synchronous. A separate,
 * bounded client process performs the same authenticated socket protocol;
 * no socket callback can be starved by blocking the caller's event loop.
 */
export function protectedAuditRpcSync(method, path, payload, options) {
    if (!Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt) {
        throw new ProtectedAuditUnavailableError('admission_expired');
    }
    protectedAuditSocketPath();
    const request = {
        version: 1, operationId: options.operationId ?? randomUUID(), method, path, payload, deadlineAt: options.deadlineAt,
    };
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES)
        throw new ProtectedAuditUnavailableError('request_too_large');
    if (Date.now() >= options.deadlineAt)
        throw new ProtectedAuditUnavailableError('admission_expired');
    const child = rpcChildCommand ?? { command: process.execPath,
        args: [fileURLToPath(new URL('./protectedAuditRpcChild.js', import.meta.url)), '--internal-protected-audit-rpc-child'] };
    const result = spawnSync(child.command, [...child.args], {
        input, encoding: 'utf8', windowsHide: true,
        timeout: Math.max(1, Math.min(30_000, options.deadlineAt - Date.now())),
        maxBuffer: MAX_RESPONSE_BYTES + 4096,
        env: {},
    });
    if (result.error)
        throw new ProtectedAuditUnavailableError('sync_transport_unknown', { cause: result.error });
    let reply;
    try {
        reply = JSON.parse(result.stdout);
    }
    catch {
        throw new ProtectedAuditUnavailableError('sync_response_unknown');
    }
    if (result.status !== 0 || reply.ok !== true)
        throw new ProtectedAuditUnavailableError(reply.error ?? 'sync_response_unknown');
    return reply.value;
}
export function validateProtectedAuditRootIdentity(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw new ProtectedAuditUnavailableError('root_identity_invalid');
    }
    return value;
}
export function validateProtectedAuditHistoryVersion(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw new ProtectedAuditUnavailableError('root_history_version_invalid');
    }
    return value;
}
/** The service resolves the logical path inside its private namespace. */
export function protectedAuditRootIdentitySync(path) {
    return validateProtectedAuditRootIdentity(protectedAuditRpcSync('root_identity', path, null, { deadlineAt: Date.now() + 30_000 }));
}
/** A stable service-owned snapshot crosses the bounded frame in verified chunks. */
export function protectedAuditReadSnapshotSync(kind, path, options) {
    return readProtectedAuditSnapshotChunks(kind, (method, payload, deadlineAt) => protectedAuditRpcSync(method, path, payload, { deadlineAt }), options);
}
export function decodeSnapshotChunk(encoded, offset, size) {
    if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new ProtectedAuditUnavailableError('read_snapshot_chunk_invalid');
    }
    const chunk = Buffer.from(encoded, 'base64');
    if (chunk.length === 0 && offset < size || offset + chunk.length > size) {
        throw new ProtectedAuditUnavailableError('read_snapshot_length_invalid');
    }
    return chunk;
}
/** Internal chunk protocol. Its caller retains socket/principal authentication. */
export function readProtectedAuditSnapshotChunks(kind, request, options) {
    const deadlineAt = Date.now() + 30_000;
    const check = () => {
        if (Date.now() >= deadlineAt)
            throw new ProtectedAuditUnavailableError('read_snapshot_deadline');
    };
    const method = kind === 'root_strict' ? 'read_root_strict' : `read_${kind}`;
    const first = request(`${method}_start`, options, deadlineAt);
    validateProtectedAuditSnapshotHeader(first);
    const prefix = kind === 'call' ? 'read_call' : 'read_root';
    const parts = [];
    let offset = 0;
    try {
        for (;;) {
            check();
            const encoded = offset === 0 ? first.chunk : request(`${prefix}_chunk`, { token: first.token, offset }, deadlineAt);
            check();
            const chunk = decodeSnapshotChunk(encoded, offset, first.size);
            parts.push(chunk);
            offset += chunk.length;
            if (offset === first.size)
                break;
        }
        check();
        const bytes = Buffer.concat(parts, first.size);
        if (createHash('sha256').update(bytes).digest('hex') !== first.sha256) {
            throw new ProtectedAuditUnavailableError('read_snapshot_hash_invalid');
        }
        check();
        const value = JSON.parse(bytes.toString('utf8'));
        check();
        return value;
    }
    finally {
        // Cleanup has its own finite allowance; a spent read budget must not
        // suppress release of the exact service-owned token. It never renews reads.
        try {
            request(`${prefix}_release`, { token: first.token }, Date.now() + 30_000);
        }
        catch { /* Service expiry retains authority; cleanup failure is not readback corruption. */ }
    }
}
export function validateProtectedAuditSnapshotHeader(value) {
    const first = value;
    if (!first || typeof first.token !== 'string' || !/^[a-f0-9-]{36}$/.test(first.token)
        || !Number.isSafeInteger(first.size) || Number(first.size) < 2
        || typeof first.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(first.sha256)
        || typeof first.chunk !== 'string')
        throw new ProtectedAuditUnavailableError('read_snapshot_header_invalid');
}