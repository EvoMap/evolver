import { createConnection, createServer } from 'node:net';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { RootOperationError } from './rootEventOperations.js';
import { EventStore } from './eventStore.js';
import { rootEvent } from './eventSchema.js';
import { archiveRootEvents, inspectRootEventArchive, localRootEventHistoryVersion, planRootEventArchive, rootEventArchiveDir } from './eventArchive.js';
import { AssetCallLog } from '../hub/assetCallLog.js';
import { markProtectedAuditServiceProcess, ProtectedAuditUnavailableError } from './protectedAuditRpc.js';
import { ProtectedAuditFrameReceiver } from './protectedAuditFrame.js';
import { contextDeliveryStatus, prepareContextDelivery, recoverContextDeliveries, snapshotContextDelivery } from '../ops/geneContextDeliveryJournal.js';
import { GeneContextObservationIndex } from '../ops/geneContextObservationIndex.js';
import { durableObservationIntents } from '../ops/contextObservationSettlement.js';
import { Ingestor } from './ingest.js';
import { captureProtectedAuditHealth } from './protectedAuditReady.js';
import { acquireProtectedAuditStartupOwner } from './protectedAuditStartup.js';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_READ_SNAPSHOT_BYTES = Math.min(512 * 1024 * 1024, Math.max(1024, Number(process.env['EVOLVER_PROTECTED_AUDIT_SNAPSHOT_LIMIT_BYTES']) || 512 * 1024 * 1024));
const MAX_READ_SOURCE_BYTES = 256 * 1024 * 1024;
const readSnapshots = new Map();
const MAX_READ_SNAPSHOTS = 4;
const serial = new Map();
const deliveryOwners = new Map();
const MAX_DELIVERY_OWNERS = 64;
const indexOwners = new Map();
const pendingRequests = new WeakMap();
const closingPublications = new WeakSet();
const observationOwners = new Map();
const completedObservationOwners = new Map();
const MAX_INDEX_OWNERS = 64;
const MAX_OBSERVATION_OWNERS = 64;
// Each transport is one request per socket. Capabilities therefore have a
// bounded idle lease; a dead caller cannot hold a SQLite/index lock forever.
// The shorter override is used by the native crash regression only.
const OWNER_IDLE_MS = Math.min(120_000, Math.max(1_000, Number(process.env['EVOLVER_PROTECTED_AUDIT_OWNER_IDLE_MS']) || 120_000));
function reapOwners(path) {
    const now = Date.now();
    for (const [token, record] of indexOwners) {
        if (record.path !== path || now - record.touchedAt < OWNER_IDLE_MS)
            continue;
        record.index.close();
        indexOwners.delete(token);
    }
    for (const [token, record] of deliveryOwners) {
        if (record.path !== path || now - record.touchedAt < OWNER_IDLE_MS)
            continue;
        // The transport may have written output before dying. Unknown is durable;
        // it must never be converted to a fresh prepared attempt or replayed.
        record.owner.outputUnknown();
        record.owner.release();
        deliveryOwners.delete(token);
    }
}
function reapReadSnapshots() {
    const now = Date.now();
    for (const [token, snapshot] of readSnapshots) {
        if (now - snapshot.touchedAt >= 120_000)
            readSnapshots.delete(token);
    }
}
function assertReadSourceCapacity(path, kind) {
    let bytes = 0;
    const add = (file) => {
        try {
            const stat = lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
                throw new ProtectedAuditUnavailableError('read_source_untrusted');
            }
            bytes += stat.size;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    };
    add(path);
    if (kind === 'root') {
        const archive = rootEventArchiveDir(path);
        try {
            for (const name of readdirSync(archive)) {
                if (/^root-events-\d{16}-\d{16}\.jsonl$/.test(name))
                    add(join(archive, name));
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    if (bytes > MAX_READ_SOURCE_BYTES)
        throw new ProtectedAuditUnavailableError('read_source_bytes_capacity');
}
function startReadSnapshot(path, kind, value) {
    reapReadSnapshots();
    if (readSnapshots.size >= MAX_READ_SNAPSHOTS)
        throw new ProtectedAuditUnavailableError('read_snapshot_capacity');
    const encoded = JSON.stringify(value);
    const size = Buffer.byteLength(encoded);
    const held = [...readSnapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes.length, 0);
    if (size > MAX_READ_SNAPSHOT_BYTES || held + size > MAX_READ_SNAPSHOT_BYTES) {
        throw new ProtectedAuditUnavailableError('read_snapshot_bytes_capacity');
    }
    const bytes = Buffer.from(encoded);
    const token = randomUUID();
    readSnapshots.set(token, { path, kind, bytes, touchedAt: Date.now() });
    return { token, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        chunk: bytes.subarray(0, READ_CHUNK_BYTES).toString('base64') };
}
function readSnapshotPart(path, kind, payload, release) {
    reapReadSnapshots();
    const request = payload;
    const token = observationToken(request?.token);
    const snapshot = readSnapshots.get(token);
    if (!snapshot || snapshot.path !== path || snapshot.kind !== kind) {
        throw new ProtectedAuditUnavailableError('read_snapshot_missing');
    }
    if (release) {
        readSnapshots.delete(token);
        return true;
    }
    const offset = request?.offset;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) >= snapshot.bytes.length) {
        throw new ProtectedAuditUnavailableError('read_snapshot_offset_invalid');
    }
    snapshot.touchedAt = Date.now();
    return snapshot.bytes.subarray(Number(offset), Number(offset) + READ_CHUNK_BYTES).toString('base64');
}
function observationKey(value) {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw new ProtectedAuditUnavailableError('observation_identity_invalid');
    }
    return value;
}
function observationToken(value) {
    if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) {
        throw new ProtectedAuditUnavailableError('observation_owner_invalid');
    }
    return value;
}
/** Same-token retries are idempotent only for the exact reserved path/key.
 * The durable row, not a lost transport response, decides whether dispatch is
 * new, pending, or already committed. A token cannot be rebound to new input. */
export function reserveObservationIntent(path, key, token, store, now = Date.now()) {
    const active = observationOwners.get(token);
    if (active && (active.path !== path || active.key !== key)) {
        throw new ProtectedAuditUnavailableError('observation_owner_reused');
    }
    if (active && now - active.createdAt <= 120_000) {
        // A lost response must not turn the already admitted durable reservation
        // into a second dispatch. If the store cannot answer read-only, retain the
        // conservative pending state and its original owner.
        return active.store.lookup?.(key) ?? 'pending';
    }
    if (active)
        observationOwners.delete(token);
    for (const [id, owner] of observationOwners) {
        if (now - owner.createdAt > 120_000)
            observationOwners.delete(id);
    }
    for (const [id, owner] of completedObservationOwners) {
        if (now - owner.createdAt > 120_000)
            completedObservationOwners.delete(id);
    }
    const completed = completedObservationOwners.get(token);
    if (completed && (completed.path !== path || completed.key !== key)) {
        throw new ProtectedAuditUnavailableError('observation_owner_reused');
    }
    if (completed) {
        const state = store.lookup?.(key);
        if (state !== undefined)
            return state;
    }
    if (observationOwners.size >= MAX_OBSERVATION_OWNERS) {
        throw new ProtectedAuditUnavailableError('observation_owner_capacity');
    }
    const state = store.reserve(key);
    if (state === 'new') {
        completedObservationOwners.delete(token);
        observationOwners.set(token, { path, key, store, createdAt: now });
    }
    return state;
}
function canonical(value, depth = 0) {
    if (depth > 32)
        throw new ProtectedAuditUnavailableError('request_nesting_invalid');
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`;
}
function requestHash(value) {
    return createHash('sha256').update(canonical(value)).digest('hex');
}
async function ordered(key, body) {
    const before = serial.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolveDone => { release = resolveDone; });
    serial.set(key, current);
    await before;
    try {
        return await body();
    }
    finally {
        release();
        if (serial.get(key) === current)
            serial.delete(key);
    }
}
/** Reclaim expired capabilities from other logical homes before checking a
 * global owner limit. Queue each close on its own path so an in-flight index
 * observation or delivery projection cannot lose its owner mid-operation. */
async function reapExpiredOwnersAcrossPaths() {
    const now = Date.now(), paths = new Set();
    for (const record of [...indexOwners.values(), ...deliveryOwners.values()]) {
        if (now - record.touchedAt >= OWNER_IDLE_MS && !serial.has(record.path))
            paths.add(record.path);
    }
    await Promise.allSettled([...paths].map(path => ordered(path, async () => { reapOwners(path); })));
}
function secureAncestor(path, allowedUid) {
    let current = resolve(path);
    for (;;) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
            || (stat.uid !== 0 && stat.uid !== allowedUid))
            throw new ProtectedAuditUnavailableError('service_parent_untrusted');
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
}
/** The config is installed by the machine administrator and cannot be supplied from a user-owned path. */
export function readProtectedAuditServiceConfig(path) {
    if (process.platform === 'win32' || !isAbsolute(path))
        throw new ProtectedAuditUnavailableError('service_config_path_invalid');
    secureAncestor(dirname(path), 0);
    const stat = lstatSync(path);
    // The service identity must be able to read this administrator-owned file.
    // 0640 permits the dedicated service group, never the application group.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== process.getgid?.()
        || (stat.mode & 0o137) !== 0 || (stat.mode & 0o040) === 0 || stat.size > 4096) {
        throw new ProtectedAuditUnavailableError('service_config_untrusted');
    }
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (config.version !== 1 || !Number.isSafeInteger(config.serviceUid) || config.serviceUid < 1
        || !Number.isSafeInteger(config.clientGid) || config.clientGid < 1
        || !isAbsolute(config.socketPath) || !isAbsolute(config.storageRoot)
        || !isAbsolute(config.rootEventsPath) || !isAbsolute(config.assetCallLogPath)
        || [config.rootEventsPath, config.assetCallLogPath].some(name => resolve(name) !== name || name.includes('\0') || name.length > 4096)
        || (config.allowedRootPrefix !== undefined && (!isAbsolute(config.allowedRootPrefix)
            || resolve(config.allowedRootPrefix) !== config.allowedRootPrefix || config.allowedRootPrefix === '/'))
        || process.getuid?.() !== config.serviceUid)
        throw new ProtectedAuditUnavailableError('service_config_invalid');
    secureAncestor(dirname(config.socketPath), config.serviceUid);
    secureAncestor(dirname(config.storageRoot), config.serviceUid);
    const socketDir = lstatSync(dirname(config.socketPath));
    const storage = lstatSync(config.storageRoot);
    if (socketDir.uid !== config.serviceUid || (socketDir.mode & 0o007) !== 0
        || socketDir.gid !== config.clientGid || !storage.isDirectory() || storage.uid !== config.serviceUid
        || (storage.mode & 0o077) !== 0)
        throw new ProtectedAuditUnavailableError('service_directory_untrusted');
    return config;
}
function logicalPath(config, name, kind, create = true) {
    if (!isAbsolute(name) || resolve(name) !== name || name.length > 4096 || name.includes('\0')) {
        throw new ProtectedAuditUnavailableError('logical_path_invalid');
    }
    const prefix = config.allowedRootPrefix;
    const dynamic = prefix && name.startsWith(`${prefix}${sep}`)
        && name.endsWith(kind === 'root' ? `${sep}evolution${sep}root_events.jsonl` : `${sep}asset_call_log.jsonl`);
    if (name !== (kind === 'root' ? config.rootEventsPath : config.assetCallLogPath) && !dynamic) {
        throw new ProtectedAuditUnavailableError('logical_path_not_provisioned');
    }
    const digest = createHash('sha256').update(name).digest('hex');
    const path = join(config.storageRoot, `${kind}-${digest}`);
    if (!existsSync(path)) {
        if (!create)
            return join(path, kind === 'root' ? 'root_events.jsonl' : 'asset_call_log.jsonl');
        if (readdirSync(config.storageRoot).filter(entry => /^(?:root|call)-[a-f0-9]{64}$/.test(entry)).length >= 2048) {
            throw new ProtectedAuditUnavailableError('logical_namespace_capacity');
        }
        mkdirSync(path, { mode: 0o700 });
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== config.serviceUid || (stat.mode & 0o077) !== 0) {
        throw new ProtectedAuditUnavailableError('logical_store_untrusted');
    }
    return join(path, kind === 'root' ? 'root_events.jsonl' : 'asset_call_log.jsonl');
}
function validatedRootInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ProtectedAuditUnavailableError('root_event_invalid');
    const raw = value;
    if (raw.auditOperationId !== undefined || raw.auditRequestHash !== undefined || raw.experienceAuditNamespace !== undefined) {
        throw new ProtectedAuditUnavailableError('client_audit_identity_denied');
    }
    if (typeof raw.type !== 'string' || !raw.human || typeof raw.human.title !== 'string' || !raw.human.title
        || (raw.type.startsWith('decision.') && !raw.human.why)
        || (raw.actor?.kind === 'human' && !raw.actor.id))
        throw new ProtectedAuditUnavailableError('root_event_invalid');
    // Validate the envelope shape before accepting client-controlled bytes; the
    // service still mints seq/eventId/timestamp rather than trusting the caller.
    rootEvent.parse({ ...raw, seq: 0, eventId: '00000000000000000000000000', ts: new Date(0).toISOString() });
    return raw;
}
function validatedCallInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ProtectedAuditUnavailableError('call_entry_invalid');
    const entry = value;
    if (entry.audit_operation_id !== undefined || entry.audit_request_hash !== undefined) {
        throw new ProtectedAuditUnavailableError('client_audit_identity_denied');
    }
    if (!['hub_search_hit', 'hub_search_miss', 'asset_reuse', 'asset_reference', 'asset_publish', 'asset_publish_skip',
        'asset_inject', 'asset_inject_shadow', 'hub_review_submitted', 'hub_review_rejected', 'hub_review_failed'].includes(entry.action)) {
        throw new ProtectedAuditUnavailableError('call_entry_invalid');
    }
    return entry;
}
/** Stable identity of the service-owned active journal. The client receives no
 * private pathname or inode; it can only compare opaque generations. */
function protectedRootIdentity(path, serviceUid) {
    let stat;
    try {
        stat = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(serviceUid)
        || (stat.mode & 63n) !== 0n || stat.nlink !== 1n
        || stat.size > BigInt(MAX_READ_SOURCE_BYTES)) {
        throw new ProtectedAuditUnavailableError('root_identity_untrusted');
    }
    return createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`).digest('hex');
}
async function execute(config, request, connected, publication) {
    if (request.version !== 1 || typeof request.operationId !== 'string'
        || !/^(?:[-\w]{1,128}|sha256:[a-f0-9]{64})$(?![\s\S])/.test(request.operationId) || typeof request.method !== 'string'
        || typeof request.path !== 'string' || !Number.isFinite(request.deadlineAt)
        || Date.now() >= request.deadlineAt || !connected())
        throw new ProtectedAuditUnavailableError('request_invalid_or_expired');
    let materializeNamespace;
    const namespace = (kind, create) => {
        const path = logicalPath(config, request.path, kind, false);
        materializeNamespace = () => { logicalPath(config, request.path, kind, create); };
        return path;
    };
    const root = (create = true) => namespace('root', create);
    const call = (create = true) => namespace('call', create);
    const checkQueuedAdmission = () => {
        if (Date.now() >= request.deadlineAt)
            throw new ProtectedAuditUnavailableError('request_expired');
        if (!connected())
            throw new ProtectedAuditUnavailableError('request_disconnected');
    };
    const orderedRequest = async (path, body) => {
        // Cross-path maintenance acquires its own queue turns without holding this
        // request's path. Its original cleanup owners remain authoritative.
        if (request.method === 'prepare_delivery' || request.method === 'index_begin') {
            checkQueuedAdmission();
            await reapExpiredOwnersAcrossPaths();
            checkQueuedAdmission();
        }
        return ordered(path, async () => {
            // A complete frame may wait behind an actual operation. It has not yet
            // admitted new storage, snapshots or capability changes into this turn.
            checkQueuedAdmission();
            materializeNamespace?.();
            // Once entered, the original operation owns its settlement and cleanup;
            // losing the reply transport must not release that owner's resources.
            return body();
        });
    };
    const project = (path, authority, options) => {
        assertReadSourceCapacity(path, 'root');
        return EventStore.projectContextDelivery(authority, { path, ...options });
    };
    switch (request.method) {
        case 'append_experience_audit_v1': {
            const payload = request.payload;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)
                || Object.keys(payload).some(key => !['raw', 'expectedNamespace'].includes(key))
                || payload.expectedNamespace !== undefined && (typeof payload.expectedNamespace !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedNamespace)))
                throw new ProtectedAuditUnavailableError('invalid_experience_audit');
            const input = validatedRootInput(payload.raw), path = root();
            const p = input.payload;
            if (p?.['source'] !== 'experience-library' || typeof p['operationId'] !== 'string'
                || !['experience.operation.requested', 'actor.human.teach', 'actor.human.review.approve', 'actor.human.review.reject', 'experience.source.recovered'].includes(input.type))
                throw new ProtectedAuditUnavailableError('invalid_experience_audit');
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return new EventStore({ path }).appendExperienceAuditV1(input, request.operationId, request.deadlineAt, payload.expectedNamespace);
            });
        }
        case 'prepare_root_operation':
        case 'append_root_idempotent': {
            const payload = request.payload;
            if (!payload || (payload.legacyActivityId !== undefined && typeof payload.legacyActivityId !== 'string')
                || (payload.namespaceId !== undefined && typeof payload.namespaceId !== 'string'))
                throw new ProtectedAuditUnavailableError('root_event_invalid');
            const input = validatedRootInput(payload.raw), path = root();
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                const store = new EventStore({ path });
                const admission = { operationId: request.operationId, deadlineAt: request.deadlineAt,
                    ...(typeof payload.legacyActivityId === 'string' ? { legacyActivityId: payload.legacyActivityId } : {}),
                    ...(typeof payload.namespaceId === 'string' ? { namespaceId: payload.namespaceId } : {}) };
                return request.method === 'prepare_root_operation' ? store.prepareIdempotent(input, admission) : store.appendIdempotent(input, admission);
            });
        }
        case 'append_root':
        case 'append_root_bounded': {
            const input = validatedRootInput(request.payload), path = root();
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                try {
                    return await new EventStore({ path }).appendIdempotent(input, { operationId: request.operationId, deadlineAt: request.deadlineAt });
                }
                catch (error) {
                    if (error instanceof RootOperationError && error.reason === 'request_conflict')
                        throw new ProtectedAuditUnavailableError('operation_reused_with_new_payload');
                    throw error;
                }
            });
        }
        case 'read_root_start': {
            const path = root(false);
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return startReadSnapshot(path, 'root', new EventStore({ path }).readAll());
            });
        }
        case 'read_root_strict_start': {
            const path = root(false);
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return startReadSnapshot(path, 'root', new EventStore({ path }).readAllStrict());
            });
        }
        case 'root_identity': {
            const path = root(false);
            return orderedRequest(path, async () => {
                if (Date.now() >= request.deadlineAt)
                    throw new ProtectedAuditUnavailableError('request_expired');
                return protectedRootIdentity(path, config.serviceUid);
            });
        }
        case 'root_history_version': {
            const path = root(false);
            return orderedRequest(path, async () => {
                if (Date.now() >= request.deadlineAt)
                    throw new ProtectedAuditUnavailableError('request_expired');
                return localRootEventHistoryVersion(path, config.serviceUid, request.deadlineAt);
            });
        }
        case 'read_root_chunk': return readSnapshotPart(root(false), 'root', request.payload, false);
        case 'read_root_release': return readSnapshotPart(root(false), 'root', request.payload, true);
        case 'recover_root': {
            const path = root();
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return new EventStore({ path }).recover();
            });
        }
        case 'plan_root_archive': {
            const path = root(false);
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return planRootEventArchive({ path,
                    ...(request.payload === undefined ? {} : { keepEvents: Number(request.payload) }) });
            });
        }
        case 'archive_root': {
            const path = root();
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return archiveRootEvents({ path,
                    ...(request.payload === undefined ? {} : { keepEvents: Number(request.payload) }) });
            });
        }
        case 'inspect_root_archive': {
            const path = root(false);
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'root');
                return inspectRootEventArchive(path);
            });
        }
        case 'prepare_delivery': {
            const path = root();
            return orderedRequest(path, async () => {
                reapOwners(path);
                if (deliveryOwners.size >= MAX_DELIVERY_OWNERS)
                    throw new ProtectedAuditUnavailableError('delivery_owner_capacity');
                const raw = snapshotContextDelivery(validatedRootInput(request.payload), '00000000-0000-0000-0000-000000000000');
                assertReadSourceCapacity(path, 'root');
                const owner = prepareContextDelivery(raw, path, project, { deadlineAt: request.deadlineAt });
                deliveryOwners.set(owner.operationId, { path, owner, touchedAt: Date.now() });
                return { operationId: owner.operationId };
            });
        }
        case 'confirm_delivery_output':
        case 'unknown_delivery_output':
        case 'project_delivery':
        case 'release_delivery': {
            const path = root(), id = request.payload;
            if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
                throw new ProtectedAuditUnavailableError('delivery_identity_invalid');
            return orderedRequest(path, async () => {
                reapOwners(path);
                const record = deliveryOwners.get(id);
                if (!record || record.path !== path)
                    throw new ProtectedAuditUnavailableError('delivery_owner_missing');
                record.touchedAt = Date.now();
                const owner = record.owner;
                if (request.method === 'confirm_delivery_output') {
                    owner.confirmOutput();
                    return true;
                }
                if (request.method === 'unknown_delivery_output') {
                    owner.outputUnknown();
                    return true;
                }
                if (request.method === 'project_delivery') {
                    try {
                        return await owner.project({ deadlineAt: request.deadlineAt });
                    }
                    finally {
                        record.touchedAt = Date.now();
                    }
                }
                owner.release();
                deliveryOwners.delete(id);
                return true;
            });
        }
        case 'delivery_status': {
            const path = root(false);
            return orderedRequest(path, async () => contextDeliveryStatus(path));
        }
        case 'recover_deliveries': {
            const path = root();
            return orderedRequest(path, async () => recoverContextDeliveries(path, project, { deadlineAt: request.deadlineAt }));
        }
        case 'append_call': {
            const entry = validatedCallInput(request.payload), hash = requestHash(entry), path = call();
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'call');
                const store = new AssetCallLog(path);
                const prior = store.read().find(record => record.audit_operation_id === request.operationId);
                if (prior) {
                    if (prior.audit_request_hash !== hash)
                        throw new ProtectedAuditUnavailableError('operation_reused_with_new_payload');
                    return true;
                }
                const committed = await store.appendBounded({ ...entry, audit_operation_id: request.operationId,
                    audit_request_hash: hash }, { deadlineAt: request.deadlineAt });
                if (committed)
                    return true;
                // An ambiguous close/write failure is resolved only by an identity-bound
                // readback. A missing row is not interpreted as permission to replay.
                assertReadSourceCapacity(path, 'call');
                return store.read().some(record => record.audit_operation_id === request.operationId
                    && record.audit_request_hash === hash);
            });
        }
        case 'read_call_start': {
            const path = call(false);
            return orderedRequest(path, async () => {
                assertReadSourceCapacity(path, 'call');
                return startReadSnapshot(path, 'call', new AssetCallLog(path).read((request.payload ?? {})));
            });
        }
        case 'read_call_chunk': return readSnapshotPart(call(false), 'call', request.payload, false);
        case 'read_call_release': return readSnapshotPart(call(false), 'call', request.payload, true);
        case 'index_begin': {
            const path = root();
            return orderedRequest(path, async () => {
                reapOwners(path);
                if (indexOwners.size >= MAX_INDEX_OWNERS)
                    throw new ProtectedAuditUnavailableError('context_index_owner_capacity');
                const maxBytes = request.payload?.maxBytes;
                if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 0)) {
                    throw new ProtectedAuditUnavailableError('context_index_budget_invalid');
                }
                const index = new GeneContextObservationIndex(path, undefined, request.path);
                try {
                    const progress = index.beginTick(maxBytes);
                    if (progress.reason === 'busy') {
                        index.close();
                        return { progress };
                    }
                    const token = randomUUID();
                    indexOwners.set(token, { path, index, touchedAt: Date.now(), publication });
                    return { token, progress };
                }
                catch (error) {
                    try {
                        index.close();
                    }
                    catch { /* retain the original error */ }
                    throw error;
                }
            });
        }
        case 'index_observe': {
            const path = root(false);
            return orderedRequest(path, async () => {
                reapOwners(path);
                const payload = request.payload;
                const token = observationToken(payload?.token);
                const owner = indexOwners.get(token);
                if (!owner || owner.path !== path || owner.publication !== publication)
                    throw new ProtectedAuditUnavailableError('context_index_owner_missing');
                owner.touchedAt = Date.now();
                if (typeof payload?.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 1024
                    || (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1))) {
                    throw new ProtectedAuditUnavailableError('context_index_request_invalid');
                }
                try {
                    const observation = await owner.index.observeSession(payload.sessionId, new Ingestor({ path }), payload.limit, { deadlineAt: request.deadlineAt });
                    return { observation, progress: owner.index.currentProgress };
                }
                finally {
                    owner.touchedAt = Date.now();
                }
            });
        }
        case 'index_progress': {
            const path = root(false);
            return orderedRequest(path, async () => {
                reapOwners(path);
                const owner = indexOwners.get(observationToken(request.payload));
                if (!owner || owner.path !== path || owner.publication !== publication)
                    throw new ProtectedAuditUnavailableError('context_index_owner_missing');
                owner.touchedAt = Date.now();
                return owner.index.currentProgress;
            });
        }
        case 'index_end': {
            const path = root(false);
            return orderedRequest(path, async () => {
                reapOwners(path);
                const token = observationToken(request.payload), owner = indexOwners.get(token);
                if (!owner)
                    return true;
                if (owner.path !== path || owner.publication !== publication)
                    throw new ProtectedAuditUnavailableError('context_index_owner_mismatch');
                owner.index.close();
                indexOwners.delete(token);
                return true;
            });
        }
        case 'observation_lookup': {
            const path = root(false);
            return orderedRequest(path, async () => durableObservationIntents(path).lookup?.(observationKey(request.payload)));
        }
        case 'observation_reserve': {
            const path = root();
            return orderedRequest(path, async () => {
                const payload = request.payload;
                const key = observationKey(payload?.key), token = observationToken(payload?.token);
                const store = durableObservationIntents(path);
                return reserveObservationIntent(path, key, token, store);
            });
        }
        case 'observation_settle': {
            const path = root();
            return orderedRequest(path, async () => {
                const payload = request.payload;
                const key = observationKey(payload?.key), token = observationToken(payload?.token);
                const owner = observationOwners.get(token);
                const completed = completedObservationOwners.get(token);
                if (!owner && completed && completed.path === path && completed.key === key)
                    return completed.result;
                if (!owner || owner.path !== path || owner.key !== key
                    || !['committed', 'not_committed'].includes(String(payload?.outcome))) {
                    throw new ProtectedAuditUnavailableError('observation_owner_missing');
                }
                const result = owner.store.settle(key, payload.outcome);
                const outcome = result ?? 'settled';
                observationOwners.delete(token);
                completedObservationOwners.set(token, { path, key, result: outcome, createdAt: Date.now() });
                return outcome;
            });
        }
        default: throw new ProtectedAuditUnavailableError('method_denied');
    }
}
/** Internal framed dispatcher. Startup alone attests the OS principal/config;
 * this is not a public entry point and is never exported by the package barrel. */
export function serveSocket(config, socket, publication) {
    const receiver = new ProtectedAuditFrameReceiver(MAX_REQUEST_BYTES);
    let accepted = false;
    let disconnected = false;
    // A peer reset belongs to this connection. An admitted operation keeps its
    // real settlement/cleanup owner even when there is nobody left to reply to.
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { disconnected = true; });
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('data', chunk => {
        if (accepted) {
            socket.destroy();
            return;
        }
        let bytes;
        try {
            bytes = receiver.feed(chunk);
        }
        catch {
            socket.destroy();
            return;
        }
        if (!bytes)
            return;
        accepted = true;
        let request;
        try {
            const value = JSON.parse(bytes.toString('utf8'));
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                socket.destroy();
                return;
            }
            request = value;
        }
        catch {
            socket.destroy();
            return;
        }
        // No stored operation or readiness can pass before socket publication completes.
        const work = !publication.health || closingPublications.has(publication) ? Promise.reject(new ProtectedAuditUnavailableError('service_starting'))
            : request.method === 'health' ? Promise.resolve().then(() => {
                if (request.version !== 1 || typeof request.operationId !== 'string' || !/^[-\w]{1,128}$/.test(request.operationId)
                    || request.path !== config.socketPath || request.payload !== null || !Number.isFinite(request.deadlineAt)
                    || Date.now() >= request.deadlineAt || request.deadlineAt - Date.now() > 5000) {
                    throw new ProtectedAuditUnavailableError('health_request_invalid');
                }
                return publication.health;
            }) : execute(config, request, () => !disconnected && !socket.destroyed && !closingPublications.has(publication), publication);
        let pending = pendingRequests.get(publication);
        if (!pending) {
            pending = new Set();
            pendingRequests.set(publication, pending);
        }
        pending.add(work);
        void work.then(() => pending.delete(work), () => pending.delete(work));
        void work.then(value => ({ version: 1, operationId: request.operationId, ok: true, value }), error => ({ version: 1, operationId: request.operationId, ok: false,
            error: error instanceof Error ? error.message : 'service_error' })).then(reply => {
            if (socket.destroyed)
                return;
            const output = Buffer.from(JSON.stringify(reply));
            if (output.length > MAX_RESPONSE_BYTES) {
                socket.destroy();
                return;
            }
            const frame = Buffer.allocUnsafe(output.length + 4);
            frame.writeUInt32BE(output.length);
            output.copy(frame, 4);
            socket.end(frame);
        }, () => socket.destroy());
    });
}
/** Internal lifecycle binding shared by actual startup and the framed component
 * regression. Transport close alone does not settle disconnected storage work. */
export function bindProtectedAuditServiceShutdown(server, publication, releaseStartup) {
    const close = server.close.bind(server);
    let transportClosed = false, cleanup;
    server.once('close', () => { transportClosed = true; });
    const shutdown = async () => {
        closingPublications.add(publication);
        publication.health = undefined;
        if (!transportClosed)
            await new Promise((resolveDone, rejectDone) => close(error => error ? rejectDone(error) : resolveDone()));
        // No new request can enter this publication. Await original promises even
        // after their sockets disappear; never substitute a timeout for settlement.
        await Promise.allSettled([...(pendingRequests.get(publication) ?? [])]);
        const failures = [];
        for (const [token, record] of indexOwners) {
            if (record.publication !== publication)
                continue;
            try {
                record.index.close();
                indexOwners.delete(token);
            }
            catch (error) {
                failures.push(error);
            }
        }
        if (failures.length)
            throw new AggregateError(failures, 'protected_audit_unavailable: index_cleanup_unknown');
        releaseStartup();
        pendingRequests.delete(publication);
    };
    server.close = callback => {
        const attempt = cleanup ??= shutdown();
        void attempt.then(() => { callback?.(); }, error => {
            // A later close retries these exact retained owners, including the startup
            // fd. Concurrent callers share one attempt and its original error.
            if (cleanup === attempt)
                cleanup = undefined;
            callback?.(error instanceof Error ? error : new Error('protected_audit_unavailable: index_cleanup_unknown'));
        });
        return server;
    };
}
export async function startProtectedAuditService(configPath) {
    const config = readProtectedAuditServiceConfig(configPath);
    markProtectedAuditServiceProcess(configPath);
    const health = captureProtectedAuditHealth(configPath, config);
    // Startup lock, SQLite, JSONL and archive files created by this dedicated
    // process stay private even outside systemd/launchd or under a restrictive mask.
    process.umask(0o077);
    const owner = acquireProtectedAuditStartupOwner(config.socketPath, config.serviceUid);
    const publication = {};
    let server, publishedSocket;
    const removeOwnedSocket = () => {
        owner.assert();
        if (!publishedSocket)
            return;
        try {
            const current = lstatSync(config.socketPath);
            if (current.dev === publishedSocket.dev && current.ino === publishedSocket.ino)
                unlinkSync(config.socketPath);
            else
                throw new ProtectedAuditUnavailableError('socket_replaced');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    };
    try {
        if (existsSync(config.socketPath)) {
            owner.assert();
            const old = lstatSync(config.socketPath);
            if (!old.isSocket() || old.uid !== config.serviceUid)
                throw new ProtectedAuditUnavailableError('socket_existing_untrusted');
            const live = await new Promise(resolveLive => {
                const probe = createConnection(config.socketPath);
                let result = true;
                const finish = (value) => { result = value; probe.destroy(); };
                probe.once('close', () => resolveLive(result));
                probe.setTimeout(250, () => finish(true));
                probe.once('connect', () => finish(true));
                probe.once('error', error => {
                    const code = error.code;
                    // Node reports a stale Unix socket as ECONNREFUSED; Bun can report
                    // ENOENT for that same absent listener. Both require the unchanged
                    // owned socket inode below. Permission, timeout and unknown errors
                    // never authorize removing an existing socket.
                    finish(code !== 'ECONNREFUSED' && code !== 'ENOENT');
                });
            });
            if (live)
                throw new ProtectedAuditUnavailableError('socket_already_running');
            const current = lstatSync(config.socketPath);
            if (current.dev !== old.dev || current.ino !== old.ino)
                throw new ProtectedAuditUnavailableError('socket_replaced');
            owner.assert();
            unlinkSync(config.socketPath);
        }
        owner.assert();
        server = createServer(socket => serveSocket(config, socket, publication));
        const listening = server;
        await new Promise((resolveReady, rejectReady) => {
            listening.once('error', rejectReady);
            listening.listen(config.socketPath, () => { listening.off('error', rejectReady); resolveReady(); });
        });
        publishedSocket = lstatSync(config.socketPath);
        if (!publishedSocket.isSocket() || publishedSocket.uid !== config.serviceUid) {
            throw new ProtectedAuditUnavailableError('socket_publication_untrusted');
        }
        owner.assert();
        chownSync(config.socketPath, config.serviceUid, config.clientGid);
        chmodSync(config.socketPath, 0o660);
        const socket = lstatSync(config.socketPath);
        if (!socket.isSocket() || socket.uid !== config.serviceUid || socket.gid !== config.clientGid
            || (socket.mode & 0o007) !== 0)
            throw new ProtectedAuditUnavailableError('socket_publication_untrusted');
        if (socket.dev !== publishedSocket.dev || socket.ino !== publishedSocket.ino)
            throw new ProtectedAuditUnavailableError('socket_replaced');
        owner.assert();
        publication.health = health;
        bindProtectedAuditServiceShutdown(listening, publication, () => { removeOwnedSocket(); owner.release(); });
        return listening;
    }
    catch (error) {
        publication.health = undefined;
        if (server?.listening) {
            try {
                await new Promise((resolveDone, rejectDone) => server.close(closeError => closeError ? rejectDone(closeError) : resolveDone()));
            }
            catch (cleanup) {
                throw new AggregateError([error, cleanup], 'protected_audit_unavailable: startup_cleanup_unknown');
            }
        }
        try {
            removeOwnedSocket();
            owner.release();
        }
        catch (cleanup) {
            throw new AggregateError([error, cleanup], 'protected_audit_unavailable: startup_cleanup_unknown');
        }
        throw error;
    }
}