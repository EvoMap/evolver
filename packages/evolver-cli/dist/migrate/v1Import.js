import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { assetstore, mailbox, util, wire } from '@evomap/evolver-core';
import { mapV1Asset } from './fieldMap.js';
import { V1_GEP_SOURCE_LAYOUT, V1_GEP_WIRE_SOURCES } from './assetFormatMap.js';
import { LocalMemoryGraph, MemoryGraphBusyError, MemoryGraphImportStateRejectedError, resolveLocalMemoryUserId, } from '../localMemoryGraph.js';
const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_IMPORT_JSON_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_IMPORT_ASSET_BUFFER_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_IMPORT_ASSET_MAX_RECORDS = 100_000;
const DEFAULT_IMPORT_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_IMPORT_TOTAL_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_IMPORT_TOTAL_MAX_RECORDS = 200_000;
const JSONL_READ_CHUNK_BYTES = 64 * 1024;
const IMPORT_V1_PLAN_SCHEMA = 'evolver.migration.import-v1-plan.v1';
const IMPORT_V1_SOURCE_ROLES = [
    'gene-envelope', 'gene-jsonl', 'capsule-envelope', 'capsule-jsonl', 'event-jsonl',
    'mailbox-jsonl', 'memory-graph-jsonl', 'candidates-jsonl', 'failed-capsules-json',
];
const importV1PlanStates = new WeakMap();
function deepFreezeImportPlanValue(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) {
            deepFreezeImportPlanValue(nested);
        }
        Object.freeze(value);
    }
    return value;
}
function configuredImportLimit(name, fallback, hardMaximum) {
    const value = process.env[name];
    if (value === undefined || value === '')
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > hardMaximum) {
        throw new Error('migration_limit_invalid');
    }
    return parsed;
}
function maxJsonlLineBytes() {
    return configuredImportLimit('EVOLVER_IMPORT_JSONL_MAX_LINE_BYTES', DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES, 64 * 1024 * 1024);
}
function maxJsonBytes() {
    return configuredImportLimit('EVOLVER_IMPORT_JSON_MAX_BYTES', DEFAULT_IMPORT_JSON_MAX_BYTES, 256 * 1024 * 1024);
}
function maxAssetBufferBytes() {
    return configuredImportLimit('EVOLVER_IMPORT_ASSET_BUFFER_MAX_BYTES', DEFAULT_IMPORT_ASSET_BUFFER_MAX_BYTES, 512 * 1024 * 1024);
}
function maxAssetRecords() {
    return configuredImportLimit('EVOLVER_IMPORT_ASSET_MAX_RECORDS', DEFAULT_IMPORT_ASSET_MAX_RECORDS, 1_000_000);
}
function maxSourceBytes() {
    return configuredImportLimit('EVOLVER_IMPORT_SOURCE_MAX_BYTES', DEFAULT_IMPORT_SOURCE_MAX_BYTES, 512 * 1024 * 1024);
}
function maxTotalBytes() {
    return configuredImportLimit('EVOLVER_IMPORT_TOTAL_MAX_BYTES', DEFAULT_IMPORT_TOTAL_MAX_BYTES, 1024 * 1024 * 1024);
}
function maxTotalRecords() {
    return configuredImportLimit('EVOLVER_IMPORT_TOTAL_MAX_RECORDS', DEFAULT_IMPORT_TOTAL_MAX_RECORDS, 1_000_000);
}
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
function decodeImportUtf8(bytes, errorCode) {
    try {
        return fatalUtf8Decoder.decode(bytes);
    }
    catch {
        throw new Error(errorCode);
    }
}
function resolveV1SourceLayout(v1Dir) {
    const workspacePath = join(v1Dir, 'workspace');
    let workspaceStat;
    try {
        workspaceStat = lstatSync(workspacePath);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return {
                workspaceRoot: v1Dir,
                gepSourceDirs: [V1_GEP_SOURCE_LAYOUT.rootCurrent, V1_GEP_SOURCE_LAYOUT.legacy],
            };
        }
        throw new Error('migration_source_path_rejected');
    }
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
        throw new Error('migration_source_path_rejected');
    }
    try {
        const canonicalRoot = realpathSync(v1Dir);
        const canonicalWorkspace = realpathSync(workspacePath);
        if (!canonicalWorkspace.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`)) {
            throw new Error('migration_source_path_rejected');
        }
    }
    catch (error) {
        if (error instanceof Error && error.message === 'migration_source_path_rejected')
            throw error;
        throw new Error('migration_source_path_rejected');
    }
    return {
        workspaceRoot: workspacePath,
        gepSourceDirs: [V1_GEP_SOURCE_LAYOUT.workspaceCurrent, V1_GEP_SOURCE_LAYOUT.legacy],
    };
}
function resolveV1GepSource(v1Dir, sourceDirs, sourceBasename) {
    for (const sourceDir of sourceDirs) {
        const sourcePath = join(v1Dir, ...sourceDir, sourceBasename);
        const source = secureRegularFileWithin(v1Dir, sourcePath);
        if (source)
            return { source, basename: sourceBasename };
    }
    return null;
}
function* readV1JsonEnvelope(fd, envelopeKey) {
    const size = fstatSync(fd).size;
    if (size > maxJsonBytes())
        throw new Error('migration_v1_json_too_large');
    const buffer = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
        const bytesRead = readSync(fd, buffer, position, size - position, position);
        if (bytesRead === 0)
            throw new Error('migration_snapshot_changed');
        position += bytesRead;
    }
    const raw = decodeImportUtf8(buffer, 'migration_v1_json_invalid_utf8').trim();
    if (!raw)
        return;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('migration_v1_json_invalid');
    }
    const records = Array.isArray(parsed)
        ? parsed
        : isPlainRecord(parsed) && Array.isArray(parsed[envelopeKey])
            ? parsed[envelopeKey]
            : null;
    if (!records)
        throw new Error('migration_v1_json_invalid');
    for (const record of records) {
        if (!isPlainRecord(record))
            throw new Error('migration_v1_json_record_invalid');
        yield record;
    }
}
function v1LogicalId(record) {
    const id = record['id'];
    return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && id !== 0)
        ? String(id)
        : null;
}
function sourceRole(kind, format) {
    if (kind === 'Gene')
        return format === 'envelope' ? 'gene-envelope' : 'gene-jsonl';
    if (kind === 'Capsule')
        return format === 'envelope' ? 'capsule-envelope' : 'capsule-jsonl';
    return 'event-jsonl';
}
function snapshotForPlan(accumulator, resolvedSource, role, testHook, limit) {
    const sourceLimit = maxSourceBytes();
    const effectiveLimit = limit
        ? { maxBytes: Math.min(sourceLimit, limit.maxBytes), error: limit.error }
        : { maxBytes: sourceLimit, error: 'migration_v1_source_too_large' };
    const snapshot = createMigrationSnapshot(resolvedSource.source, accumulator.snapshotDir, resolvedSource.basename, testHook, effectiveLimit);
    const bytes = Number(snapshot.stat.size);
    const nextTotal = accumulator.totalBytes + bytes;
    if (nextTotal > maxTotalBytes()) {
        closeMigrationSnapshot(snapshot);
        throw new Error('migration_v1_total_bytes_too_large');
    }
    accumulator.totalBytes = nextTotal;
    accumulator.snapshots.push(snapshot);
    const report = {
        role,
        path: relative(accumulator.sourceRoot, resolvedSource.source.requestedPath).split(sep).join('/'),
        bytes,
        sha256: snapshot.digest,
        records: 0,
    };
    accumulator.sources.push(report);
    return { snapshot, report };
}
function countPlannedRecord(accumulator, source) {
    accumulator.totalRecords += 1;
    if (accumulator.totalRecords > maxTotalRecords())
        throw new Error('migration_v1_records_too_many');
    source.records += 1;
}
function assertExpectedV1Kind(record, kind) {
    if (record['type'] !== kind)
        throw new Error('migration_v1_asset_type_mismatch');
}
function validatedV1SchemaVersion(record) {
    const value = record['schema_version'];
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        throw new Error('migration_v1_schema_version_invalid');
    }
    return value;
}
function assertValidV1ValidationReport(record) {
    if (record['type'] !== 'ValidationReport'
        || typeof record['id'] !== 'string'
        || record['id'].length === 0
        || !Array.isArray(record['commands'])
        || typeof record['overall_ok'] !== 'boolean') {
        throw new Error('migration_v1_validation_report_invalid');
    }
    validatedV1SchemaVersion(record);
}
function addPlannedAsset(accumulator, kind, record) {
    assertExpectedV1Kind(record, kind);
    const sourceSchemaVersion = validatedV1SchemaVersion(record);
    const sourceSchemaVersionKey = sourceSchemaVersion ?? '(missing)';
    const mapped = mapV1Asset(kind, record);
    const validation = wire.validateWire(mapped.record);
    if (!validation.ok)
        throw new Error('migration_v1_wire_invalid');
    assetstore.assertCapsuleGeneBinding(mapped.record);
    const bytes = Buffer.byteLength(JSON.stringify({ record: mapped.record, dropped: mapped.dropped }), 'utf8');
    if (accumulator.assets.length >= maxAssetRecords())
        throw new Error('migration_v1_asset_records_too_many');
    if (accumulator.assetBytes > maxAssetBufferBytes() - bytes)
        throw new Error('migration_v1_asset_buffer_too_large');
    accumulator.assetBytes += bytes;
    accumulator.sourceSchemaVersions.set(sourceSchemaVersionKey, (accumulator.sourceSchemaVersions.get(sourceSchemaVersionKey) ?? 0) + 1);
    accumulator.assets.push({ kind, mapped, hashMatches: wire.verifyAssetId(mapped.record) });
}
async function planV1AssetKind(accumulator, sourceDirs, kind, testHook) {
    const spec = V1_GEP_WIRE_SOURCES[kind];
    if (!('envelope' in spec)) {
        const resolvedSource = resolveV1GepSource(accumulator.sourceRoot, sourceDirs, spec.jsonl);
        if (!resolvedSource)
            return;
        const { snapshot, report } = snapshotForPlan(accumulator, resolvedSource, sourceRole(kind, 'jsonl'), testHook);
        for await (const record of readJsonl(snapshot.fd)) {
            countPlannedRecord(accumulator, report);
            if (kind === 'EvolutionEvent' && record['type'] === 'ValidationReport') {
                assertValidV1ValidationReport(record);
                accumulator.validationReportRecords += 1;
                continue;
            }
            addPlannedAsset(accumulator, kind, record);
        }
        return;
    }
    const byId = new Map();
    let bufferedBytes = 0;
    const setById = (record) => {
        assertExpectedV1Kind(record, kind);
        const id = v1LogicalId(record);
        if (!id)
            throw new Error('migration_v1_logical_id_missing');
        const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
        const previous = byId.get(id);
        if (!previous && byId.size >= maxAssetRecords())
            throw new Error('migration_v1_asset_records_too_many');
        const nextBytes = bufferedBytes - (previous?.bytes ?? 0) + bytes;
        if (nextBytes > maxAssetBufferBytes())
            throw new Error('migration_v1_asset_buffer_too_large');
        byId.set(id, { record, bytes });
        bufferedBytes = nextBytes;
    };
    const envelope = resolveV1GepSource(accumulator.sourceRoot, sourceDirs, spec.envelope.basename);
    if (envelope) {
        const { snapshot, report } = snapshotForPlan(accumulator, envelope, sourceRole(kind, 'envelope'), testHook, { maxBytes: maxJsonBytes(), error: 'migration_v1_json_too_large' });
        for (const record of readV1JsonEnvelope(snapshot.fd, spec.envelope.key)) {
            countPlannedRecord(accumulator, report);
            setById(record);
        }
    }
    const jsonl = resolveV1GepSource(accumulator.sourceRoot, sourceDirs, spec.jsonl);
    if (jsonl) {
        const { snapshot, report } = snapshotForPlan(accumulator, jsonl, sourceRole(kind, 'jsonl'), testHook);
        for await (const record of readJsonl(snapshot.fd)) {
            countPlannedRecord(accumulator, report);
            setById(record);
        }
    }
    for (const { record } of byId.values())
        addPlannedAsset(accumulator, kind, record);
}
async function* readJsonl(source) {
    if (typeof source === 'string' && !existsSync(source))
        return;
    const maxLineBytes = maxJsonlLineBytes();
    const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
    let fd;
    let ownsFd = false;
    let position = 0;
    let parts = [];
    let lineBytes = 0;
    let dropping = false;
    const finish = function* () {
        if (dropping) {
            parts = [];
            lineBytes = 0;
            dropping = false;
            throw new Error('migration_v1_jsonl_line_too_large');
        }
        if (lineBytes === 0)
            return;
        const text = decodeImportUtf8(Buffer.concat(parts, lineBytes), 'migration_v1_jsonl_invalid_utf8').trim();
        parts = [];
        lineBytes = 0;
        if (!text)
            return;
        try {
            const parsed = JSON.parse(text);
            if (!isPlainRecord(parsed))
                throw new Error('migration_v1_jsonl_record_invalid');
            yield parsed;
        }
        catch (error) {
            if (error instanceof Error && error.message === 'migration_v1_jsonl_record_invalid')
                throw error;
            throw new Error('migration_v1_jsonl_invalid');
        }
    };
    try {
        if (typeof source === 'number') {
            fd = source;
        }
        else {
            fd = openSync(source, constants.O_RDONLY | noFollowFlag());
            ownsFd = true;
        }
        for (;;) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
            if (bytesRead === 0)
                break;
            position += bytesRead;
            let start = 0;
            for (let i = 0; i < bytesRead; i += 1) {
                if (buffer[i] !== 0x0a)
                    continue;
                const segment = buffer.subarray(start, i);
                if (!dropping) {
                    if (lineBytes + segment.length > maxLineBytes) {
                        parts = [];
                        lineBytes = 0;
                        dropping = true;
                    }
                    else {
                        parts.push(Buffer.from(segment));
                        lineBytes += segment.length;
                    }
                }
                for (const record of finish())
                    yield record;
                start = i + 1;
            }
            if (start < bytesRead && !dropping) {
                const segment = buffer.subarray(start, bytesRead);
                if (lineBytes + segment.length > maxLineBytes) {
                    parts = [];
                    lineBytes = 0;
                    dropping = true;
                }
                else {
                    parts.push(Buffer.from(segment));
                    lineBytes += segment.length;
                }
            }
        }
        for (const record of finish())
            yield record;
    }
    finally {
        if (ownsFd && fd !== undefined)
            closeSync(fd);
    }
}
function readSnapshotJson(snapshot) {
    const size = Number(snapshot.stat.size);
    if (size > maxJsonBytes())
        throw new Error('migration_v1_json_too_large');
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const bytesRead = readSync(snapshot.fd, buffer, offset, size - offset, offset);
        if (bytesRead === 0)
            throw new Error('migration_snapshot_changed');
        offset += bytesRead;
    }
    try {
        return JSON.parse(decodeImportUtf8(buffer, 'migration_v1_json_invalid_utf8'));
    }
    catch {
        throw new Error('migration_v1_json_invalid');
    }
}
function disposeImportV1PlanState(state) {
    if (state.disposed)
        return;
    state.disposed = true;
    let firstError;
    for (const snapshot of state.snapshots) {
        try {
            closeMigrationSnapshot(snapshot);
        }
        catch (error) {
            firstError ??= error;
        }
    }
    try {
        state.disposeTestHook?.('before-remove', state.snapshotDir);
    }
    catch (error) {
        firstError ??= error;
    }
    try {
        rmSync(state.snapshotDir, { recursive: true, force: true });
    }
    catch (error) {
        firstError ??= error;
    }
    if (firstError !== undefined)
        throw firstError;
}
function assertSafeMigrationTargetTreeUnchecked(path) {
    if (!existsSync(path))
        return;
    const rootStat = lstatSync(path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error('migration_output_path_rejected');
    const root = realpathSync(path);
    const pending = [];
    for (const candidate of [
        join(root, 'assets'),
        join(root, 'migration'),
        join(root, 'evolution'),
        join(root, 'proxy'),
    ]) {
        try {
            lstatSync(candidate);
            pending.push(candidate);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    let visited = 0;
    while (pending.length > 0) {
        const current = pending.pop();
        const currentStat = lstatSync(current, { bigint: true });
        if (currentStat.isSymbolicLink())
            throw new Error('migration_output_path_rejected');
        if (currentStat.isFile()) {
            if (currentStat.nlink > 1n)
                throw new Error('migration_output_hardlink_rejected');
            continue;
        }
        if (!currentStat.isDirectory())
            throw new Error('migration_output_path_rejected');
        if (!pathWithin(root, realpathSync(current)))
            throw new Error('migration_output_path_rejected');
        for (const name of readdirSync(current)) {
            visited += 1;
            if (visited > maxTotalRecords())
                throw new Error('migration_output_entries_too_many');
            pending.push(join(current, name));
        }
    }
}
function assertSafeMigrationTargetTree(path) {
    try {
        assertSafeMigrationTargetTreeUnchecked(path);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('migration_'))
            throw error;
        throw new Error('migration_output_path_rejected');
    }
}
async function readStableTargetJsonl(path) {
    if (!existsSync(path))
        return { records: [], fingerprint: { path, digest: null } };
    try {
        const targetLimit = { maxBytes: maxSourceBytes(), error: 'migration_target_too_large' };
        const before = hashRegularFile(path, 'migration_target_changed', targetLimit);
        const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
        const records = [];
        try {
            for await (const record of readJsonl(fd)) {
                if (records.length >= maxTotalRecords())
                    throw new Error('migration_target_records_too_many');
                records.push(record);
            }
        }
        finally {
            closeSync(fd);
        }
        const after = hashRegularFile(path, 'migration_target_changed', targetLimit);
        if (before.digest !== after.digest || !sameMigrationSourceSnapshot(before.stat, after.stat)) {
            throw new Error('migration_target_changed');
        }
        return { records, fingerprint: { path, digest: after.digest } };
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('migration_target_'))
            throw error;
        throw new Error('migration_target_jsonl_invalid');
    }
}
function assertTargetFileFingerprint(expected) {
    if (!existsSync(expected.path)) {
        if (expected.digest !== null)
            throw new Error('migration_target_changed');
        return;
    }
    if (expected.digest === null)
        throw new Error('migration_target_changed');
    const current = hashRegularFile(expected.path, 'migration_target_changed', {
        maxBytes: maxSourceBytes(),
        error: 'migration_target_too_large',
    });
    if (current.digest !== expected.digest)
        throw new Error('migration_target_changed');
}
async function planMigrationExtensions(outputRoot, assets) {
    const path = join(outputRoot, 'migration', 'v1_extensions.jsonl');
    const target = await readStableTargetJsonl(path);
    const byAssetId = new Map();
    for (const record of target.records) {
        const assetId = record['asset_id'];
        const dropped = record['dropped'];
        if (typeof assetId !== 'string' || !isPlainRecord(dropped))
            throw new Error('migration_target_jsonl_invalid');
        const previous = byAssetId.get(assetId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(dropped)) {
            throw new Error('migration_extension_content_conflict');
        }
        byAssetId.set(assetId, dropped);
    }
    let appends = 0;
    let deduped = 0;
    for (const planned of assets) {
        if (Object.keys(planned.mapped.dropped).length === 0)
            continue;
        const assetId = String(planned.mapped.record['asset_id'] ?? '');
        if (!assetId)
            throw new Error('migration_extension_asset_id_missing');
        const existing = byAssetId.get(assetId);
        if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(planned.mapped.dropped)) {
                throw new Error('migration_extension_content_conflict');
            }
            deduped += 1;
        }
        else {
            byAssetId.set(assetId, planned.mapped.dropped);
            appends += 1;
        }
    }
    return { appends, deduped, fingerprint: target.fingerprint };
}
function classifyPlannedAssets(target, plannedAssets) {
    const counts = {
        Gene: { candidates: 0, verified: 0, unverified: 0, frozen: 0, recomputed: 0, writes: 0, deduped: 0 },
        Capsule: { candidates: 0, verified: 0, unverified: 0, frozen: 0, recomputed: 0, writes: 0, deduped: 0 },
        EvolutionEvent: { candidates: 0, verified: 0, unverified: 0, frozen: 0, recomputed: 0, writes: 0, deduped: 0 },
    };
    const existingAssets = new Map(target.assets);
    const provenance = new Map(target.provenance);
    let provenanceCandidates = 0;
    let provenanceWrites = 0;
    let provenancePreserved = 0;
    for (const planned of plannedAssets) {
        const kindCounts = counts[planned.kind];
        kindCounts.candidates += 1;
        if (planned.hashMatches)
            kindCounts.verified += 1;
        else
            kindCounts.unverified += 1;
        if (planned.mapped.recomputed)
            kindCounts.recomputed += 1;
        else
            kindCounts.frozen += 1;
        const record = planned.mapped.record;
        const existing = existingAssets.get(record.asset_id) ?? null;
        if (planned.hashMatches) {
            if (existing && !assetstore.frozenAssetRecordsEqual(existing, record)) {
                throw new Error('migration_asset_id_collision');
            }
            if (existing)
                kindCounts.deduped += 1;
            else {
                kindCounts.writes += 1;
                existingAssets.set(record.asset_id, record);
            }
            continue;
        }
        provenanceCandidates += 1;
        const disposition = assetstore.planUnverifiedIngest(record, existing, provenance.get(record.asset_id) ?? null, assetstore.UNVERIFIED_V1_IMPORT_REASON, 'migrated');
        if (disposition.status === 'collision')
            throw new Error('migration_asset_id_collision');
        if (disposition.status === 'create') {
            kindCounts.writes += 1;
            existingAssets.set(record.asset_id, record);
        }
        else {
            kindCounts.deduped += 1;
        }
        if (disposition.status === 'preserve_trust')
            provenancePreserved += 1;
        if (disposition.provenanceAction !== 'none') {
            provenanceWrites += 1;
            provenance.set(record.asset_id, {
                assetId: record.asset_id,
                source: 'migrated',
                trusted: false,
                reason: assetstore.UNVERIFIED_V1_IMPORT_REASON,
                frozenContentId: disposition.frozenContentId,
                at: '',
            });
        }
    }
    return {
        assets: counts,
        provenance: { candidates: provenanceCandidates, writes: provenanceWrites, preserved: provenancePreserved },
    };
}
function planSourceOrder(source) {
    return IMPORT_V1_SOURCE_ROLES.indexOf(source.role);
}
export async function planImportV1(v1Dir, outDir, options = {}) {
    const roots = validateMigrationRoots(v1Dir, outDir);
    assertSafeMigrationTargetTree(roots.outputRoot);
    const workspace = options.workspace === undefined ? null : canonicalDirectory(options.workspace);
    if (options.workspace !== undefined && !workspace)
        throw new Error('migration_workspace_path_rejected');
    const memoryUserId = options.userId ?? resolveLocalMemoryUserId();
    const snapshotDir = mkdtempSync(join(tmpdir(), 'evolver-import-v1-plan-'));
    chmodSync(snapshotDir, 0o700);
    const accumulator = {
        sourceRoot: roots.sourceRoot,
        snapshotDir,
        snapshots: [],
        sources: [],
        assets: [],
        sourceSchemaVersions: new Map(),
        totalBytes: 0,
        totalRecords: 0,
        assetBytes: 0,
        validationReportRecords: 0,
    };
    let state;
    try {
        const sourceLayout = resolveV1SourceLayout(roots.sourceRoot);
        for (const kind of ['Gene', 'Capsule', 'EvolutionEvent']) {
            await planV1AssetKind(accumulator, sourceLayout.gepSourceDirs, kind, options.sourceSnapshotTestHook);
        }
        let mailboxSnapshot;
        let mailboxBatch;
        let mailboxPreview;
        const mailboxSource = secureRegularFileWithin(roots.sourceRoot, join(roots.sourceRoot, 'mailbox', 'messages.jsonl'));
        if (mailboxSource) {
            const planned = snapshotForPlan(accumulator, { source: mailboxSource, basename: 'mailbox_messages.jsonl' }, 'mailbox-jsonl', options.sourceSnapshotTestHook);
            mailboxSnapshot = planned.snapshot;
            mailboxBatch = mailbox.prepareMailboxJsonlImport(mailboxSnapshot.fd, {
                maxLineBytes: maxJsonlLineBytes(),
                maxBytes: maxSourceBytes(),
                maxRecords: maxTotalRecords(),
            });
            for (let index = 0; index < mailboxBatch.sourceRecords; index += 1) {
                countPlannedRecord(accumulator, planned.report);
            }
            mailboxPreview = Object.freeze({
                ...mailbox.previewPreparedMailboxImport(mailboxBatch, join(roots.outputRoot, 'proxy', 'mailbox.db')),
            });
        }
        let memorySnapshot;
        let memorySource;
        const memoryRecords = [];
        let memoryPlan;
        let memoryPlanDeferred = false;
        const securedMemoryGraph = secureRegularFileWithin(roots.sourceRoot, join(sourceLayout.workspaceRoot, 'memory', 'evolution', 'memory_graph.jsonl'));
        if (securedMemoryGraph) {
            const planned = snapshotForPlan(accumulator, { source: securedMemoryGraph, basename: 'memory_graph.jsonl' }, 'memory-graph-jsonl', options.sourceSnapshotTestHook);
            memorySnapshot = planned.snapshot;
            memorySource = securedMemoryGraph.canonicalPath;
            for await (const record of readJsonl(memorySnapshot.fd)) {
                countPlannedRecord(accumulator, planned.report);
                memoryRecords.push(record);
            }
            const graph = new LocalMemoryGraph({ dir: join(roots.outputRoot, 'evolution'), userId: memoryUserId });
            try {
                memoryPlan = graph.planV1Outcomes(workspace, memoryRecords, memorySource);
            }
            catch (error) {
                if (!(error instanceof MemoryGraphImportStateRejectedError) && !(error instanceof MemoryGraphBusyError))
                    throw error;
                memoryPlanDeferred = true;
                memoryPlan = graph.planV1Outcomes(null, memoryRecords, memorySource);
            }
            if (memoryPlan.rejected > 0)
                throw new Error('migration_v1_memory_record_invalid');
        }
        let candidatesFound = false;
        let candidateRecords = 0;
        const candidates = resolveV1GepSource(roots.sourceRoot, sourceLayout.gepSourceDirs, 'candidates.jsonl');
        if (candidates) {
            candidatesFound = true;
            const planned = snapshotForPlan(accumulator, candidates, 'candidates-jsonl', options.sourceSnapshotTestHook);
            for await (const _record of readJsonl(planned.snapshot.fd)) {
                countPlannedRecord(accumulator, planned.report);
                candidateRecords += 1;
            }
        }
        let failedCapsulesFound = false;
        let failedCapsuleRecords = 0;
        const failedCapsules = resolveV1GepSource(roots.sourceRoot, sourceLayout.gepSourceDirs, 'failed_capsules.json');
        if (failedCapsules) {
            failedCapsulesFound = true;
            const planned = snapshotForPlan(accumulator, failedCapsules, 'failed-capsules-json', options.sourceSnapshotTestHook, { maxBytes: maxJsonBytes(), error: 'migration_v1_json_too_large' });
            const parsed = readSnapshotJson(planned.snapshot);
            const records = isPlainRecord(parsed)
                && parsed['version'] === 1
                && Array.isArray(parsed['failed_capsules'])
                ? parsed['failed_capsules']
                : null;
            if (!records)
                throw new Error('migration_v1_json_invalid');
            for (const record of records) {
                if (!isPlainRecord(record))
                    throw new Error('migration_v1_json_record_invalid');
                assertExpectedV1Kind(record, 'Capsule');
                countPlannedRecord(accumulator, planned.report);
                failedCapsuleRecords += 1;
            }
        }
        if (accumulator.sources.length === 0)
            throw new Error('migration_v1_no_sources');
        let extensionCandidates = 0;
        for (const planned of accumulator.assets) {
            if (Object.keys(planned.mapped.dropped).length > 0)
                extensionCandidates += 1;
        }
        const targetAssets = assetstore.readLocalAssetStoreSnapshot(join(roots.outputRoot, 'assets'), {
            maxFileBytes: maxSourceBytes(),
            maxTotalBytes: maxTotalBytes(),
            maxRecords: maxTotalRecords(),
        });
        const assetPlan = classifyPlannedAssets(targetAssets, accumulator.assets);
        const extensionPlan = await planMigrationExtensions(roots.outputRoot, accumulator.assets);
        const sources = accumulator.sources
            .map((source) => ({ ...source }))
            .sort((left, right) => planSourceOrder(left) - planSourceOrder(right) || left.path.localeCompare(right.path));
        const sourceSchemaVersions = Object.fromEntries([...accumulator.sourceSchemaVersions.entries()].sort(([left], [right]) => left.localeCompare(right)));
        const reportWithoutDigest = {
            schema: IMPORT_V1_PLAN_SCHEMA,
            sourceSchemaVersions,
            targetAuthoringSchemaVersion: wire.SCHEMA_VERSION,
            sources,
            assets: assetPlan.assets,
            provenance: assetPlan.provenance,
            extensions: {
                candidates: extensionCandidates,
                appends: extensionPlan.appends,
                deduped: extensionPlan.deduped,
            },
            mailbox: {
                found: mailboxSnapshot !== undefined,
                candidates: mailboxBatch?.sourceRecords ?? 0,
                inserts: mailboxPreview?.insertedMessages ?? 0,
                updates: mailboxPreview?.updatedMessages ?? 0,
                protected: mailboxPreview?.protectedMessages ?? 0,
            },
            memoryGraph: {
                found: memorySnapshot !== undefined,
                candidates: memoryRecords.length,
                importable: memoryPlan?.importable ?? 0,
                deduped: memoryPlan?.duplicates ?? 0,
                rejected: memoryPlan?.rejected ?? 0,
                deferred: memoryPlan?.deferred ?? 0,
                disposition: memorySnapshot === undefined ? 'absent' : workspace && !memoryPlanDeferred ? 'import' : 'defer',
            },
            validationReports: {
                found: accumulator.validationReportRecords > 0,
                candidates: accumulator.validationReportRecords,
                disposition: accumulator.validationReportRecords > 0 ? 'preserve_source_no_v2_mapping' : 'absent',
            },
            candidates: {
                found: candidatesFound,
                candidates: candidateRecords,
                disposition: candidatesFound ? 'skip_non_wire' : 'absent',
            },
            failedCapsules: {
                found: failedCapsulesFound,
                candidates: failedCapsuleRecords,
                disposition: failedCapsulesFound ? 'preserve_manual_recovery' : 'absent',
            },
        };
        const report = deepFreezeImportPlanValue({
            ...reportWithoutDigest,
            planDigest: createHash('sha256').update(JSON.stringify(reportWithoutDigest)).digest('hex'),
        });
        state = {
            sourceRoot: roots.sourceRoot,
            outputRoot: roots.outputRoot,
            workspace,
            memoryUserId,
            snapshotDir,
            snapshots: accumulator.snapshots,
            assets: accumulator.assets,
            targetAssets,
            extensionTarget: extensionPlan.fingerprint,
            mailboxSnapshot,
            mailboxBatch,
            mailboxPreview,
            memorySnapshot,
            memorySource,
            memoryPlan,
            memoryPlanDeferred,
            candidatesFound,
            disposeTestHook: options.disposeTestHook,
            disposed: false,
            applied: false,
        };
        const plan = Object.freeze({
            report,
            dispose: () => disposeImportV1PlanState(state),
        });
        importV1PlanStates.set(plan, state);
        return plan;
    }
    catch (error) {
        const partial = state ?? {
            sourceRoot: roots.sourceRoot, outputRoot: roots.outputRoot, workspace, memoryUserId,
            snapshotDir, snapshots: accumulator.snapshots,
            assets: accumulator.assets,
            extensionTarget: { path: join(roots.outputRoot, 'migration', 'v1_extensions.jsonl'), digest: null },
            candidatesFound: false, disposeTestHook: options.disposeTestHook,
            memoryPlanDeferred: false, disposed: false, applied: false,
        };
        try {
            disposeImportV1PlanState(partial);
        }
        catch { /* preserve the planning failure */ }
        throw error;
    }
}
export async function applyImportV1Plan(plan, store, outDir, options = {}) {
    const state = importV1PlanStates.get(plan);
    if (!state || state.disposed || state.applied)
        throw new Error('migration_plan_invalid');
    const outputRoot = canonicalProspectiveDirectory(outDir);
    const requestedWorkspace = options.workspace === undefined ? null : canonicalDirectory(options.workspace);
    const requestedUserId = options.userId ?? resolveLocalMemoryUserId();
    if (outputRoot !== state.outputRoot
        || (store && canonicalProspectiveDirectory(store.baseDir) !== join(outputRoot, 'assets'))
        || requestedWorkspace !== state.workspace
        || requestedUserId !== state.memoryUserId) {
        throw new Error('migration_plan_target_mismatch');
    }
    assertSafeMigrationTargetTree(outputRoot);
    assertTargetFileFingerprint(state.extensionTarget);
    if (!state.targetAssets)
        throw new Error('migration_plan_invalid');
    assetstore.assertLocalAssetStoreSnapshotCurrent(state.targetAssets);
    options.outputRootTestHook?.('before-secure', outDir);
    const securedOutputRoot = secureOutputRoot(outDir, state.outputRoot);
    assertMigrationRootsDisjoint(state.sourceRoot, securedOutputRoot);
    assertSafeMigrationTargetTree(securedOutputRoot);
    assertTargetFileFingerprint(state.extensionTarget);
    assetstore.assertLocalAssetStoreSnapshotCurrent(state.targetAssets);
    let mailboxPath;
    if (state.mailboxSnapshot) {
        if (!state.mailboxBatch || !state.mailboxPreview)
            throw new Error('migration_plan_invalid');
        const proxyDir = ensureSafeOutputDirectory(securedOutputRoot, join(securedOutputRoot, 'proxy'));
        mailboxPath = join(proxyDir, 'mailbox.db');
        assertSafeMailboxTarget(mailboxPath);
        const currentPreview = mailbox.previewPreparedMailboxImport(state.mailboxBatch, mailboxPath);
        if (currentPreview.sourceRecords !== state.mailboxPreview.sourceRecords
            || currentPreview.insertedMessages !== state.mailboxPreview.insertedMessages
            || currentPreview.updatedMessages !== state.mailboxPreview.updatedMessages
            || currentPreview.protectedMessages !== state.mailboxPreview.protectedMessages) {
            throw new Error('migration_mailbox_target_changed');
        }
    }
    const evolutionDir = state.memorySnapshot && state.workspace && !state.memoryPlanDeferred
        ? ensureSafeOutputDirectory(securedOutputRoot, join(securedOutputRoot, 'evolution'))
        : undefined;
    const assetsDir = ensureSafeOutputDirectory(securedOutputRoot, join(securedOutputRoot, 'assets'));
    const migrationDir = ensureSafeOutputDirectory(securedOutputRoot, join(securedOutputRoot, 'migration'));
    state.applied = true;
    const targetStore = store ?? new assetstore.LocalJsonlProvider(assetsDir);
    const sidecarPath = join(migrationDir, 'v1_extensions.jsonl');
    const rep = {
        imported: { Gene: 0, Capsule: 0, EvolutionEvent: 0 }, frozen: 0, recomputed: 0, unverifiedFrozen: 0, deduped: 0,
        sidecarExtensions: 0, memoryGraphArchived: false, memoryGraphImported: 0, memoryGraphDeferred: false,
        candidatesSkipped: state.candidatesFound, mailboxFound: state.mailboxSnapshot !== undefined, mailboxImported: 0,
    };
    const provenance = new assetstore.ProvenanceStore(targetStore.baseDir);
    for (const planned of state.assets) {
        if (Object.keys(planned.mapped.dropped).length > 0) {
            const assetId = String(planned.mapped.record['asset_id'] ?? '');
            if (await ensureMigrationExtension(sidecarPath, assetId, planned.mapped.dropped, options.sidecarAppendTestHook)) {
                rep.sidecarExtensions += 1;
            }
        }
        const record = planned.mapped.record;
        const result = planned.hashMatches
            ? await targetStore.put(record)
            : await assetstore.ingestUnverified(targetStore, provenance, record, assetstore.UNVERIFIED_V1_IMPORT_REASON, 'migrated');
        if (result.stored) {
            rep.imported[planned.kind] += 1;
            if (!planned.hashMatches)
                rep.unverifiedFrozen += 1;
            if (planned.mapped.recomputed)
                rep.recomputed += 1;
            else
                rep.frozen += 1;
        }
        else {
            rep.deduped += 1;
        }
    }
    if (state.mailboxSnapshot) {
        if (!mailboxPath || !state.mailboxBatch)
            throw new Error('migration_plan_invalid');
        let target;
        try {
            assertSafeMailboxTarget(mailboxPath);
            target = new mailbox.MailboxStore({ path: mailboxPath });
            assertSafeMailboxTarget(mailboxPath);
            rep.mailboxImported = target.importPrepared(state.mailboxBatch);
        }
        finally {
            target?.close();
        }
    }
    if (state.memorySnapshot && state.memorySource) {
        archiveMemoryGraphSnapshot(state.memorySnapshot, migrationDir);
        rep.memoryGraphArchived = true;
        const workspace = state.workspace;
        if (!workspace || state.memoryPlanDeferred) {
            rep.memoryGraphDeferred = true;
        }
        else {
            const userId = state.memoryUserId;
            const marker = scopedMemoryGraphMarker(migrationDir, workspace, userId, state.memorySource, state.memorySnapshot.digest);
            if (!state.memoryPlan)
                throw new Error('migration_plan_invalid');
            const markerExists = hasSafeMemoryGraphMarker(marker);
            if (!evolutionDir)
                throw new Error('migration_plan_invalid');
            const graph = new LocalMemoryGraph({ dir: evolutionDir, userId });
            try {
                rep.memoryGraphImported = graph.applyV1OutcomePlan(state.memoryPlan);
            }
            catch (error) {
                if (!(error instanceof MemoryGraphImportStateRejectedError) && !(error instanceof MemoryGraphBusyError))
                    throw error;
                rep.memoryGraphDeferred = true;
            }
            if (!rep.memoryGraphDeferred && !markerExists) {
                writeMemoryGraphMarker(marker, `${rep.memoryGraphImported}\n`, options.memoryGraphMarkerTestHook);
            }
        }
    }
    return rep;
}
export async function importV1(v1Dir, store, outDir, options = {}) {
    const plan = await planImportV1(v1Dir, outDir, options);
    let report;
    try {
        report = await applyImportV1Plan(plan, store, outDir, options);
    }
    catch (error) {
        try {
            plan.dispose();
        }
        catch { /* preserve the primary failure */ }
        throw error;
    }
    try {
        plan.dispose();
    }
    catch {
        throw new Error('migration_cleanup_failed');
    }
    return report;
}
function canonicalDirectory(path) {
    try {
        const absolute = resolve(path);
        const stat = lstatSync(absolute);
        return stat.isDirectory() && !stat.isSymbolicLink() ? realpathSync(absolute) : null;
    }
    catch {
        return null;
    }
}
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pathWithin(root, candidate) {
    const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    const prefix = comparableRoot.endsWith(sep) ? comparableRoot : `${comparableRoot}${sep}`;
    return comparableCandidate === comparableRoot || comparableCandidate.startsWith(prefix);
}
function canonicalProspectiveDirectory(path) {
    let cursor = resolve(path);
    const missing = [];
    for (;;) {
        try {
            const stat = lstatSync(cursor);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error('migration_output_path_rejected');
            return resolve(realpathSync(cursor), ...missing.reverse());
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            const parent = dirname(cursor);
            if (parent === cursor)
                throw new Error('migration_output_path_rejected');
            missing.push(basename(cursor));
            cursor = parent;
        }
    }
}
function assertMigrationRootsDisjoint(sourceRoot, outputRoot) {
    if (pathWithin(sourceRoot, outputRoot) || pathWithin(outputRoot, sourceRoot)) {
        throw new Error('migration_output_overlaps_source');
    }
}
export function validateMigrationRoots(v1Dir, outDir) {
    const sourceRoot = canonicalDirectory(v1Dir);
    if (!sourceRoot)
        throw new Error('migration_source_path_rejected');
    const outputRoot = canonicalProspectiveDirectory(outDir);
    assertMigrationRootsDisjoint(sourceRoot, outputRoot);
    return { sourceRoot, outputRoot };
}
function secureOutputRoot(path, expectedRoot) {
    if (canonicalProspectiveDirectory(path) !== expectedRoot)
        throw new Error('migration_target_changed');
    const absolute = resolve(path);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('migration_output_path_rejected');
    const canonical = realpathSync(absolute);
    if (canonical !== expectedRoot)
        throw new Error('migration_target_changed');
    return canonical;
}
function ensureSafeOutputDirectory(root, requested) {
    const absolute = resolve(requested);
    if (!pathWithin(root, absolute))
        throw new Error('migration_output_path_rejected');
    const relative = absolute.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (const segment of relative) {
        const next = join(current, segment);
        try {
            const stat = lstatSync(next);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error('migration_output_path_rejected');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            mkdirSync(next, { mode: 0o700 });
            const created = lstatSync(next);
            if (!created.isDirectory() || created.isSymbolicLink())
                throw new Error('migration_output_path_rejected');
        }
        const canonical = realpathSync(next);
        if (!pathWithin(root, canonical))
            throw new Error('migration_output_path_rejected');
        current = canonical;
    }
    return current;
}
async function ensureMigrationExtension(path, assetId, dropped, testHook) {
    if (!assetId)
        throw new Error('migration_extension_asset_id_missing');
    const lockPath = `${path}.lock`;
    util.acquireLock(lockPath, { maxTries: 300, waitMs: 10 });
    let result;
    let operationError;
    try {
        result = await ensureMigrationExtensionLocked(path, assetId, dropped, testHook);
    }
    catch (error) {
        operationError = error;
    }
    const released = util.releaseLock(lockPath);
    if (!released.released)
        throw new Error('migration_extension_lock_release_failed');
    if (operationError !== undefined)
        throw operationError;
    return result;
}
async function ensureMigrationExtensionLocked(path, assetId, dropped, testHook) {
    if (existsSync(path)) {
        const before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
            throw new Error('migration_extension_path_rejected');
        }
        const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
        try {
            const opened = fstatSync(fd);
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
                throw new Error('migration_extension_path_rejected');
            }
            for await (const record of readJsonl(fd)) {
                if (record['asset_id'] !== assetId)
                    continue;
                if (JSON.stringify(record['dropped']) !== JSON.stringify(dropped)) {
                    throw new Error('migration_extension_content_conflict');
                }
                return false;
            }
        }
        finally {
            closeSync(fd);
        }
    }
    testHook?.('before-append', path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollowFlag(), 0o600);
    try {
        const opened = fstatSync(fd, { bigint: true });
        const atPath = lstatSync(path, { bigint: true });
        if (!opened.isFile()
            || !atPath.isFile()
            || atPath.isSymbolicLink()
            || opened.dev !== atPath.dev
            || opened.ino !== atPath.ino
            || opened.nlink > 1n
            || atPath.nlink > 1n) {
            throw new Error('migration_extension_path_rejected');
        }
        writeFileSync(fd, `${JSON.stringify({ asset_id: assetId, dropped })}\n`, 'utf8');
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    testHook?.('after-append', path);
    return true;
}
function scopedMemoryGraphMarker(migrationDir, workspace, userId, source, sourceDigest) {
    const scope = createHash('sha256').update(JSON.stringify({ workspace, userId, source, sourceDigest })).digest('hex');
    return join(migrationDir, `v1_memory_graph_import.${scope}.complete`);
}
function assertSafeMailboxTarget(path) {
    const safeFileExists = (candidate) => {
        try {
            const stat = lstatSync(candidate, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n) {
                throw new Error('migration_mailbox_path_rejected');
            }
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    };
    const databaseExists = safeFileExists(path);
    const walExists = safeFileExists(path + '-wal');
    const shmExists = safeFileExists(path + '-shm');
    const journalExists = safeFileExists(path + '-journal');
    if (journalExists || (!databaseExists && (walExists || shmExists))) {
        throw new Error('migration_mailbox_path_rejected');
    }
}
function hasSafeMemoryGraphMarker(path) {
    let fd;
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('migration_memory_graph_marker_path_rejected');
        fd = openSync(path, constants.O_RDONLY | noFollowFlag());
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size < 2 || opened.size > 64) {
            throw new Error('migration_memory_graph_marker_invalid');
        }
        const buffer = Buffer.alloc(opened.size);
        if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length || !/^(0|[1-9]\d*)\n$/.test(buffer.toString('utf8'))) {
            throw new Error('migration_memory_graph_marker_invalid');
        }
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function writeMemoryGraphMarker(path, content, testHook) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let fd;
    let operationError;
    try {
        fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
        if (!fstatSync(fd).isFile())
            throw new Error('migration_memory_graph_marker_path_rejected');
        const data = Buffer.from(content, 'utf8');
        let offset = 0;
        while (offset < data.length) {
            const written = writeSync(fd, data, offset, data.length - offset, offset);
            if (written <= 0)
                throw new Error('migration_memory_graph_marker_write_failed');
            offset += written;
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        testHook?.('before-publish', temporaryPath, path);
        try {
            linkSync(temporaryPath, path);
        }
        catch (error) {
            if (error.code !== 'EEXIST' || !hasSafeMemoryGraphMarker(path))
                throw error;
        }
        if (!hasSafeMemoryGraphMarker(path))
            throw new Error('migration_memory_graph_marker_invalid');
    }
    catch (error) {
        operationError = error;
    }
    let cleanupError;
    if (fd !== undefined) {
        try {
            closeSync(fd);
        }
        catch (error) {
            cleanupError = error;
        }
    }
    try {
        unlinkSync(temporaryPath);
    }
    catch (error) {
        if (error.code !== 'ENOENT' && cleanupError === undefined)
            cleanupError = error;
    }
    if (operationError !== undefined) {
        if (operationError instanceof Error && cleanupError !== undefined) {
            operationError.cleanupError = cleanupError;
        }
        throw operationError;
    }
    if (cleanupError !== undefined)
        throw cleanupError;
}
function secureRegularFileWithin(root, path) {
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(path);
    let rootStat;
    try {
        rootStat = lstatSync(absoluteRoot);
    }
    catch {
        throw new Error('migration_source_path_rejected');
    }
    let fileStat;
    try {
        fileStat = lstatSync(absolutePath, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw new Error('migration_source_path_rejected');
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error('migration_source_path_rejected');
    }
    try {
        const canonicalRoot = realpathSync(absoluteRoot);
        const canonicalPath = realpathSync(absolutePath);
        if (!canonicalPath.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`)) {
            throw new Error('migration_source_path_rejected');
        }
        return { requestedPath: absolutePath, canonicalPath, stat: fileStat };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'migration_source_path_rejected')
            throw error;
        throw new Error('migration_source_path_rejected');
    }
}
function sameMigrationSourceIdentity(left, right) {
    const hasStableFileId = left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n;
    if (hasStableFileId)
        return left.dev === right.dev && left.ino === right.ino;
    return left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
}
function sameMigrationSourceSnapshot(left, right) {
    return sameMigrationSourceIdentity(left, right)
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function noFollowFlag() {
    return process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number'
        ? constants.O_NOFOLLOW
        : 0;
}
function createMigrationSnapshot(source, snapshotDir, label, testHook, limit) {
    const snapshotDirStat = lstatSync(snapshotDir);
    if (!snapshotDirStat.isDirectory() || snapshotDirStat.isSymbolicLink()) {
        throw new Error('migration_snapshot_dir_rejected');
    }
    const snapshotPath = join(snapshotDir, `.${basename(label)}.${randomUUID()}.tmp`);
    testHook?.('before-open', source.requestedPath);
    const sourceFd = openSync(source.canonicalPath, constants.O_RDONLY | noFollowFlag());
    let writerFd;
    let readerFd;
    let snapshotIdentity;
    let completed = false;
    try {
        const opened = fstatSync(sourceFd, { bigint: true });
        if (!opened.isFile() || !sameMigrationSourceSnapshot(source.stat, opened)) {
            throw new Error('migration_source_changed');
        }
        if (limit && opened.size > BigInt(limit.maxBytes))
            throw new Error(limit.error);
        testHook?.('after-open', source.requestedPath);
        writerFd = openSync(snapshotPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
        snapshotIdentity = fstatSync(writerFd, { bigint: true });
        if (!snapshotIdentity.isFile())
            throw new Error('migration_snapshot_changed');
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let snapshotOffset = 0;
        for (;;) {
            const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            if (limit && snapshotOffset > limit.maxBytes - bytesRead)
                throw new Error(limit.error);
            digest.update(buffer.subarray(0, bytesRead));
            let offset = 0;
            while (offset < bytesRead) {
                const written = writeSync(writerFd, buffer, offset, bytesRead - offset, snapshotOffset + offset);
                if (written <= 0)
                    throw new Error('migration_snapshot_write_failed');
                offset += written;
            }
            snapshotOffset += bytesRead;
        }
        const afterRead = fstatSync(sourceFd, { bigint: true });
        const afterPath = lstatSync(source.requestedPath, { bigint: true });
        if (!sameMigrationSourceSnapshot(opened, afterRead)
            || !afterPath.isFile()
            || afterPath.isSymbolicLink()
            || !sameMigrationSourceSnapshot(afterRead, afterPath)
            || realpathSync(source.requestedPath) !== source.canonicalPath) {
            throw new Error('migration_source_changed');
        }
        fsyncSync(writerFd);
        snapshotIdentity = fstatSync(writerFd, { bigint: true });
        if (!snapshotIdentity.isFile() || snapshotIdentity.size !== opened.size) {
            throw new Error('migration_snapshot_changed');
        }
        closeSync(writerFd);
        writerFd = undefined;
        const expectedDigest = digest.digest('hex');
        readerFd = openSync(snapshotPath, constants.O_RDONLY | noFollowFlag());
        const reopened = hashOpenDescriptor(readerFd, 'migration_snapshot_changed');
        if (!sameMigrationSourceSnapshot(snapshotIdentity, reopened.stat) || reopened.digest !== expectedDigest) {
            throw new Error('migration_snapshot_changed');
        }
        testHook?.('after-snapshot', source.requestedPath, snapshotPath);
        const verified = hashOpenDescriptor(readerFd, 'migration_snapshot_changed');
        const atPath = lstatSync(snapshotPath, { bigint: true });
        if (!sameMigrationSourceSnapshot(reopened.stat, verified.stat)
            || verified.digest !== expectedDigest
            || !atPath.isFile()
            || atPath.isSymbolicLink()
            || !sameMigrationSourceSnapshot(verified.stat, atPath)) {
            throw new Error('migration_snapshot_changed');
        }
        chmodSync(snapshotPath, 0o400);
        if (process.platform !== 'win32')
            unlinkSync(snapshotPath);
        completed = true;
        return { fd: readerFd, path: snapshotPath, stat: verified.stat, digest: expectedDigest };
    }
    finally {
        closeSync(sourceFd);
        if (writerFd !== undefined)
            closeSync(writerFd);
        if (!completed && readerFd !== undefined)
            closeSync(readerFd);
        if (!completed) {
            try {
                const atPath = lstatSync(snapshotPath, { bigint: true });
                if (snapshotIdentity && atPath.isFile() && !atPath.isSymbolicLink()
                    && sameMigrationSourceIdentity(snapshotIdentity, atPath))
                    unlinkSync(snapshotPath);
            }
            catch {
                // Preserve the source/snapshot failure; cleanup is best-effort.
            }
        }
    }
}
function closeMigrationSnapshot(snapshot) {
    const current = fstatSync(snapshot.fd, { bigint: true });
    closeSync(snapshot.fd);
    try {
        const atPath = lstatSync(snapshot.path, { bigint: true });
        if (atPath.isFile() && !atPath.isSymbolicLink() && sameMigrationSourceIdentity(current, atPath)) {
            chmodSync(snapshot.path, 0o600);
            unlinkSync(snapshot.path);
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
function hashOpenDescriptor(fd, errorCode, limit) {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile())
        throw new Error(errorCode);
    if (limit && before.size > BigInt(limit.maxBytes))
        throw new Error(limit.error);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
        if (bytesRead === 0)
            break;
        if (limit && position > limit.maxBytes - bytesRead)
            throw new Error(limit.error);
        position += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameMigrationSourceSnapshot(before, after))
        throw new Error(errorCode);
    return { digest: hash.digest('hex'), stat: after };
}
function hashRegularFile(path, errorCode, limit) {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
        throw new Error(errorCode);
    const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameMigrationSourceSnapshot(before, opened))
            throw new Error(errorCode);
        const hashed = hashOpenDescriptor(fd, errorCode, limit);
        const afterPath = lstatSync(path, { bigint: true });
        if (!sameMigrationSourceSnapshot(opened, hashed.stat)
            || !afterPath.isFile()
            || afterPath.isSymbolicLink()
            || !sameMigrationSourceSnapshot(hashed.stat, afterPath)) {
            throw new Error(errorCode);
        }
        return hashed;
    }
    finally {
        closeSync(fd);
    }
}
function ensureArchiveContent(snapshot, path) {
    let existing;
    if (existsSync(path)) {
        existing = hashRegularFile(path, 'memory_graph_archive_path_rejected');
        if (existing.digest === snapshot.digest)
            return;
    }
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let fd;
    let tempStat;
    try {
        fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
        tempStat = fstatSync(fd, { bigint: true });
        if (!tempStat.isFile())
            throw new Error('memory_graph_archive_write_failed');
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        while (position < Number(snapshot.stat.size)) {
            const bytesRead = readSync(snapshot.fd, buffer, 0, buffer.length, position);
            if (bytesRead === 0)
                throw new Error('migration_snapshot_changed');
            let offset = 0;
            while (offset < bytesRead) {
                const written = writeSync(fd, buffer, offset, bytesRead - offset);
                if (written <= 0)
                    throw new Error('memory_graph_archive_write_failed');
                offset += written;
            }
            position += bytesRead;
        }
        fsyncSync(fd);
        const completedTemp = fstatSync(fd, { bigint: true });
        if (!sameMigrationSourceIdentity(tempStat, completedTemp)) {
            throw new Error('memory_graph_archive_write_failed');
        }
        closeSync(fd);
        fd = undefined;
        if (hashRegularFile(temp, 'memory_graph_archive_write_failed').digest !== snapshot.digest) {
            throw new Error('memory_graph_archive_write_failed');
        }
        if (existing) {
            const current = lstatSync(path, { bigint: true });
            if (!current.isFile() || current.isSymbolicLink())
                throw new Error('memory_graph_archive_path_rejected');
            if (!sameMigrationSourceSnapshot(existing.stat, current)) {
                if (hashRegularFile(path, 'memory_graph_archive_path_rejected').digest === snapshot.digest)
                    return;
                throw new Error('memory_graph_archive_content_conflict');
            }
            // Same-directory rename keeps the old archive visible until the verified replacement is published.
            renameSync(temp, path);
        }
        else {
            try {
                // Hard-link publication is a no-clobber atomic create for the common first-import case.
                linkSync(temp, path);
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                const incumbent = hashRegularFile(path, 'memory_graph_archive_path_rejected');
                if (incumbent.digest !== snapshot.digest) {
                    const current = lstatSync(path, { bigint: true });
                    if (!current.isFile() || current.isSymbolicLink()
                        || !sameMigrationSourceSnapshot(incumbent.stat, current)) {
                        throw new Error('memory_graph_archive_content_conflict');
                    }
                    renameSync(temp, path);
                }
            }
        }
        if (hashRegularFile(path, 'memory_graph_archive_path_rejected').digest !== snapshot.digest) {
            throw new Error('memory_graph_archive_content_conflict');
        }
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            const atPath = lstatSync(temp, { bigint: true });
            if (tempStat && atPath.isFile() && !atPath.isSymbolicLink()
                && sameMigrationSourceIdentity(tempStat, atPath))
                unlinkSync(temp);
        }
        catch {
            // Keep the archive result authoritative; the random, mode-0600 temp is safe to clean on a later run.
        }
    }
}
function archiveMemoryGraphSnapshot(snapshot, archiveDir) {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const archiveDirStat = lstatSync(archiveDir);
    if (!archiveDirStat.isDirectory() || archiveDirStat.isSymbolicLink()) {
        throw new Error('memory_graph_archive_path_rejected');
    }
    const versioned = join(archiveDir, `legacy_memory_graph.${snapshot.digest}.jsonl`);
    ensureArchiveContent(snapshot, versioned);
    const legacy = join(archiveDir, 'legacy_memory_graph.jsonl');
    ensureArchiveContent(snapshot, legacy);
}