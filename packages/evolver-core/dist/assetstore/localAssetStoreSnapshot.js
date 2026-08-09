import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { AssetStoreReadLimitError, readRegularBuffer, UnsafeAssetStorePathError, } from './assetStoreStorage.js';
import { parseProvenanceRecord, CorruptAssetSidecarError, } from './assetSidecarRecords.js';
import { frozenAssetRecordsEqual, FrozenAssetIdCollisionError } from './provider.js';
const PROVENANCE_FILE = 'provenance.jsonl';
const LOCK_FILE = '.assetstore.lock';
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
export class CorruptLocalAssetStoreError extends Error {
    reason;
    file;
    row;
    code = 'CORRUPT_LOCAL_ASSET_STORE';
    constructor(reason, file, row) {
        super(`corrupt local asset store: ${reason}${file ? `/${file}` : ''}${row ? `/${row}` : ''}`);
        this.reason = reason;
        this.file = file;
        this.row = row;
        this.name = 'CorruptLocalAssetStoreError';
    }
}
export class LocalAssetStoreSnapshotLimitError extends Error {
    reason;
    file;
    code = 'LOCAL_ASSET_STORE_SNAPSHOT_LIMIT';
    constructor(reason, file) {
        super(`local asset store snapshot limit exceeded: ${reason}${file ? `/${file}` : ''}`);
        this.reason = reason;
        this.file = file;
        this.name = 'LocalAssetStoreSnapshotLimitError';
    }
}
export class LocalAssetStoreSnapshotChangedError extends Error {
    reason;
    code = 'LOCAL_ASSET_STORE_SNAPSHOT_CHANGED';
    constructor(reason) {
        super(`local asset store snapshot changed: ${reason}`);
        this.reason = reason;
        this.name = 'LocalAssetStoreSnapshotChangedError';
    }
}
class SnapshotMap {
    #values;
    constructor(entries) {
        this.#values = new Map(entries);
        Object.freeze(this);
    }
    get size() { return this.#values.size; }
    get(key) { return this.#values.get(key); }
    has(key) { return this.#values.has(key); }
    entries() { return this.#values.entries(); }
    keys() { return this.#values.keys(); }
    values() { return this.#values.values(); }
    [Symbol.iterator]() { return this.#values[Symbol.iterator](); }
    forEach(callbackfn, thisArg) {
        for (const [key, value] of this.#values)
            callbackfn.call(thisArg, value, key, this);
    }
}
const metadataBySnapshot = new WeakMap();
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function boundedPositiveInt(value, fallback) {
    return value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.max(1, Math.floor(value));
}
function statFingerprint(stat) {
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function directoryFingerprint(path) {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink())
            throw new UnsafeAssetStorePathError('base_directory', 'symlink');
        if (!stat.isDirectory())
            throw new UnsafeAssetStorePathError('base_directory', 'not_directory');
        return statFingerprint(stat);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return 'missing';
        throw error;
    }
}
function optionalFileFingerprint(path, role) {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink())
            throw new UnsafeAssetStorePathError(role, 'symlink');
        if (!stat.isFile())
            throw new UnsafeAssetStorePathError(role, 'not_regular_file');
        return statFingerprint(stat);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return 'missing';
        throw error;
    }
}
function captureState(baseDir) {
    const root = directoryFingerprint(baseDir);
    const files = new Map();
    if (root === 'missing') {
        for (const kind of Object.keys(LOCAL_ASSET_FILES))
            files.set(kind, 'missing');
        files.set('provenance', 'missing');
        return { root, lock: 'missing', files };
    }
    for (const [kind, file] of Object.entries(LOCAL_ASSET_FILES)) {
        files.set(kind, optionalFileFingerprint(join(baseDir, file), 'asset_file'));
    }
    files.set('provenance', optionalFileFingerprint(join(baseDir, PROVENANCE_FILE), 'asset_file'));
    return {
        root,
        lock: optionalFileFingerprint(join(baseDir, LOCK_FILE), 'lock_file'),
        files,
    };
}
function recaptureState(baseDir) {
    try {
        return captureState(baseDir);
    }
    catch (error) {
        if (error instanceof UnsafeAssetStorePathError) {
            throw new LocalAssetStoreSnapshotChangedError('changed');
        }
        throw error;
    }
}
function statesEqual(left, right) {
    if (left.root !== right.root || left.lock !== right.lock || left.files.size !== right.files.size)
        return false;
    for (const [file, fingerprint] of left.files) {
        if (right.files.get(file) !== fingerprint)
            return false;
    }
    return true;
}
function snapshotFingerprint(baseDir, state) {
    const fileState = [...state.files.entries()];
    const digest = createHash('sha256')
        .update(JSON.stringify([baseDir, state.root, state.lock, fileState]))
        .digest('hex');
    return `sha256:${digest}`;
}
function decodeStrict(bytes, file) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw new CorruptLocalAssetStoreError('invalid_utf8', file);
    }
}
function assertTerminated(raw, file) {
    if (raw.length > 0 && !raw.endsWith('\n'))
        throw new CorruptLocalAssetStoreError('unterminated', file);
}
function immutableJson(value) {
    if (!value || typeof value !== 'object')
        return value;
    const pending = [value];
    const seen = new Set();
    while (pending.length > 0) {
        const current = pending.pop();
        if (seen.has(current))
            continue;
        seen.add(current);
        for (const item of Object.values(current)) {
            if (item && typeof item === 'object')
                pending.push(item);
        }
        Object.freeze(current);
    }
    return value;
}
function parseAssetFile(bytes, kind, file, assets, consumeRecord) {
    const raw = decodeStrict(bytes, file);
    assertTerminated(raw, file);
    let row = 0;
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        row += 1;
        consumeRecord();
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            throw new CorruptLocalAssetStoreError('invalid_json', file, row);
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new CorruptLocalAssetStoreError('invalid_record', file, row);
        }
        const candidate = value;
        if (candidate['type'] !== kind
            || typeof candidate['asset_id'] !== 'string'
            || !candidate['asset_id']
            || candidate['asset_id'] !== candidate['asset_id'].trim()) {
            throw new CorruptLocalAssetStoreError('invalid_record', file, row);
        }
        const record = candidate;
        const existing = assets.get(record.asset_id);
        if (existing && !frozenAssetRecordsEqual(existing, record)) {
            throw new FrozenAssetIdCollisionError(record.asset_id);
        }
        if (!existing)
            assets.set(record.asset_id, immutableJson(record));
    }
    return row;
}
function parseProvenanceFile(bytes, consumeRecord) {
    const raw = decodeStrict(bytes, PROVENANCE_FILE);
    const records = new Map();
    let rows = 0;
    if (raw.length > 0 && !raw.endsWith('\n')) {
        throw new CorruptAssetSidecarError('provenance', 'unterminated');
    }
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        rows += 1;
        consumeRecord();
        let record;
        try {
            record = parseProvenanceRecord(JSON.parse(line));
        }
        catch {
            record = null;
        }
        if (!record)
            throw new CorruptAssetSidecarError('provenance', 'invalid_row');
        records.set(record.assetId, immutableJson(record));
    }
    return { records: new SnapshotMap(records), rows };
}
function readTrackedFile(path, file, maxFileBytes) {
    try {
        return readRegularBuffer(path, maxFileBytes) ?? Buffer.alloc(0);
    }
    catch (error) {
        if (error instanceof AssetStoreReadLimitError) {
            throw new LocalAssetStoreSnapshotLimitError('file_bytes', file);
        }
        if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'EISDIR')) {
            throw new LocalAssetStoreSnapshotChangedError('changed');
        }
        if (error instanceof UnsafeAssetStorePathError && error.reason === 'path_changed') {
            throw new LocalAssetStoreSnapshotChangedError('changed');
        }
        throw error;
    }
}
/**
 * Read a bounded, strict target-store snapshot without creating the directory, a lock, or any other file.
 * Writers are detected through the lock/root/file fingerprints; callers must revalidate before apply.
 */
export function readLocalAssetStoreSnapshot(baseDir, options = {}, deps = {}) {
    const resolvedBaseDir = resolve(baseDir);
    const maxFileBytes = boundedPositiveInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    const maxTotalBytes = boundedPositiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    const maxRecords = boundedPositiveInt(options.maxRecords, DEFAULT_MAX_RECORDS);
    const before = captureState(resolvedBaseDir);
    if (before.lock !== 'missing')
        throw new LocalAssetStoreSnapshotChangedError('lock_present');
    const buffers = new Map();
    let totalBytes = 0;
    if (before.root !== 'missing') {
        for (const [kind, file] of Object.entries(LOCAL_ASSET_FILES)) {
            const bytes = readTrackedFile(join(resolvedBaseDir, file), file, maxFileBytes);
            totalBytes += bytes.length;
            if (totalBytes > maxTotalBytes)
                throw new LocalAssetStoreSnapshotLimitError('total_bytes');
            buffers.set(kind, bytes);
        }
        const provenanceBytes = readTrackedFile(join(resolvedBaseDir, PROVENANCE_FILE), PROVENANCE_FILE, maxFileBytes);
        totalBytes += provenanceBytes.length;
        if (totalBytes > maxTotalBytes)
            throw new LocalAssetStoreSnapshotLimitError('total_bytes');
        buffers.set('provenance', provenanceBytes);
    }
    deps.beforeVerify?.();
    const after = recaptureState(resolvedBaseDir);
    if (after.lock !== 'missing' || !statesEqual(before, after)) {
        throw new LocalAssetStoreSnapshotChangedError(after.lock !== 'missing' ? 'lock_present' : 'changed');
    }
    let records = 0;
    const consumeRecords = (count) => {
        records += count;
        if (records > maxRecords)
            throw new LocalAssetStoreSnapshotLimitError('records');
    };
    const assets = new Map();
    let assetRows = 0;
    for (const [kind, file] of Object.entries(LOCAL_ASSET_FILES)) {
        assetRows += parseAssetFile(buffers.get(kind) ?? Buffer.alloc(0), kind, file, assets, () => consumeRecords(1));
    }
    const parsedProvenance = parseProvenanceFile(buffers.get('provenance') ?? Buffer.alloc(0), () => consumeRecords(1));
    const snapshot = Object.freeze({
        exists: before.root !== 'missing',
        fingerprint: snapshotFingerprint(resolvedBaseDir, before),
        assets: new SnapshotMap(assets),
        provenance: parsedProvenance.records,
        stats: Object.freeze({
            bytes: totalBytes,
            assetRows,
            provenanceRows: parsedProvenance.rows,
            uniqueAssets: assets.size,
        }),
    });
    metadataBySnapshot.set(snapshot, { baseDir: resolvedBaseDir, state: before });
    return snapshot;
}
/** Fail closed when the target store changed between planning and apply. Performs reads only. */
export function assertLocalAssetStoreSnapshotCurrent(snapshot) {
    const metadata = metadataBySnapshot.get(snapshot);
    if (!metadata)
        throw new LocalAssetStoreSnapshotChangedError('invalid_snapshot');
    const current = recaptureState(metadata.baseDir);
    if (current.lock !== 'missing' || !statesEqual(metadata.state, current)) {
        throw new LocalAssetStoreSnapshotChangedError(current.lock !== 'missing' ? 'lock_present' : 'changed');
    }
}