import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { validateWire, verifyAssetId } from '../wire/index.js';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { assertOptionalRegularFile, isReliableAssetStoreLockRelease, readUtf8Regular, UnsafeAssetStorePathError, } from './assetStoreStorage.js';
import { parseAssetSyncSidecarRecord, parseProvenanceRecord, parseReviewRecord, parseSidecarJsonl, } from './assetSidecarRecords.js';
export const DEFAULT_ASSET_HEALTH_MAX_FILE_BYTES = 64 * 1024 * 1024;
const LOCAL_ASSET_SIDECARS = [
    { kind: 'provenance', file: 'provenance.jsonl', parseRecord: parseProvenanceRecord },
    { kind: 'review', file: 'review.jsonl', parseRecord: parseReviewRecord },
    { kind: 'asset-sync', file: 'asset-sync.jsonl', parseRecord: parseAssetSyncSidecarRecord },
];
function healthScanLimit(value) {
    if (value === undefined || !Number.isFinite(value))
        return DEFAULT_ASSET_HEALTH_MAX_FILE_BYTES;
    return Math.min(DEFAULT_ASSET_HEALTH_MAX_FILE_BYTES, Math.max(1, Math.floor(value)));
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function emptyFile(kind, file, status, reason) {
    return {
        kind,
        file,
        status,
        bytes: 0,
        rows: 0,
        validRows: 0,
        uniqueAssets: 0,
        duplicateRows: 0,
        corruptRows: 0,
        hashMismatchRows: 0,
        unverifiedRows: 0,
        schemaInvalidRows: 0,
        unterminated: false,
        ...(reason ? { reason } : {}),
    };
}
function allFiles(status, reason) {
    return Object.entries(LOCAL_ASSET_FILES)
        .map(([kind, file]) => emptyFile(kind, file, status, reason));
}
function emptySidecar(kind, file, status, reason) {
    return {
        kind,
        file,
        status,
        bytes: 0,
        rows: 0,
        validRows: 0,
        corruptRows: 0,
        unterminated: false,
        ...(reason ? { reason } : {}),
    };
}
function allSidecars(status, reason) {
    return LOCAL_ASSET_SIDECARS.map(({ kind, file }) => emptySidecar(kind, file, status, reason));
}
function summarize(files, sidecars) {
    const totals = {
        files: files.length,
        missingFiles: files.filter((file) => file.status === 'missing').length,
        unsafeFiles: files.filter((file) => file.status === 'unsafe').length,
        unavailableFiles: files.filter((file) => file.status === 'unavailable').length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        rows: files.reduce((sum, file) => sum + file.rows, 0),
        validRows: files.reduce((sum, file) => sum + file.validRows, 0),
        uniqueAssets: files.reduce((sum, file) => sum + file.uniqueAssets, 0),
        duplicateRows: files.reduce((sum, file) => sum + file.duplicateRows, 0),
        corruptRows: files.reduce((sum, file) => sum + file.corruptRows, 0),
        hashMismatchRows: files.reduce((sum, file) => sum + file.hashMismatchRows, 0),
        unverifiedRows: files.reduce((sum, file) => sum + file.unverifiedRows, 0),
        schemaInvalidRows: files.reduce((sum, file) => sum + file.schemaInvalidRows, 0),
        unterminatedFiles: files.filter((file) => file.unterminated).length,
    };
    const sidecarTotals = {
        files: sidecars.length,
        missingFiles: sidecars.filter((file) => file.status === 'missing').length,
        unsafeFiles: sidecars.filter((file) => file.status === 'unsafe').length,
        unavailableFiles: sidecars.filter((file) => file.status === 'unavailable').length,
        bytes: sidecars.reduce((sum, file) => sum + file.bytes, 0),
        rows: sidecars.reduce((sum, file) => sum + file.rows, 0),
        validRows: sidecars.reduce((sum, file) => sum + file.validRows, 0),
        corruptRows: sidecars.reduce((sum, file) => sum + file.corruptRows, 0),
        unterminatedFiles: sidecars.filter((file) => file.unterminated).length,
    };
    const status = totals.unsafeFiles > 0 || sidecarTotals.unsafeFiles > 0
        ? 'unsafe'
        : totals.unavailableFiles > 0 || sidecarTotals.unavailableFiles > 0
            ? 'unavailable'
            : totals.duplicateRows > 0
                || totals.corruptRows > 0
                || totals.hashMismatchRows > 0
                || totals.schemaInvalidRows > 0
                || totals.unterminatedFiles > 0
                || sidecarTotals.corruptRows > 0
                || sidecarTotals.unterminatedFiles > 0
                ? 'degraded'
                : 'healthy';
    return {
        ok: status === 'healthy',
        status,
        totals,
        files: [...files],
        sidecarTotals,
        sidecars: [...sidecars],
    };
}
function inspectFile(baseDir, kind, file, maxFileBytes, unverifiedIds) {
    try {
        const path = join(baseDir, file);
        const stat = assertOptionalRegularFile(path);
        if (stat === null)
            return emptyFile(kind, file, 'missing');
        if (stat.size > maxFileBytes) {
            return { ...emptyFile(kind, file, 'unavailable', 'scan_limit_exceeded'), bytes: stat.size };
        }
        const raw = readUtf8Regular(path);
        if (raw === null)
            return emptyFile(kind, file, 'unavailable', 'read_unavailable');
        const rows = raw.split('\n').filter((line) => line.trim().length > 0);
        const seen = new Set();
        let validRows = 0;
        let duplicateRows = 0;
        let corruptRows = 0;
        let hashMismatchRows = 0;
        let unverifiedRows = 0;
        let schemaInvalidRows = 0;
        for (const line of rows) {
            try {
                const value = JSON.parse(line);
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    corruptRows += 1;
                    continue;
                }
                const record = value;
                const assetId = typeof record['asset_id'] === 'string' ? record['asset_id'].trim() : '';
                if (!assetId || record['type'] !== kind) {
                    corruptRows += 1;
                    continue;
                }
                if (seen.has(assetId))
                    duplicateRows += 1;
                else
                    seen.add(assetId);
                if (!verifyAssetId(record)) {
                    // A hash mismatch is corruption UNLESS provenance says this id is an unverified hub reuse: the hub
                    // rewrote the delivered bytes and reuse froze them untrusted on purpose (#570). That is expected, not
                    // store rot, so it lands in the benign unverifiedRows bucket and never degrades the store.
                    if (unverifiedIds.has(assetId))
                        unverifiedRows += 1;
                    else
                        hashMismatchRows += 1;
                    continue;
                }
                if (kind !== 'AntiGene' && !validateWire(record).ok) {
                    schemaInvalidRows += 1;
                    continue;
                }
                validRows += 1;
            }
            catch {
                corruptRows += 1;
            }
        }
        const unterminated = raw.length > 0 && !raw.endsWith('\n');
        const status = duplicateRows > 0
            || corruptRows > 0
            || hashMismatchRows > 0
            || schemaInvalidRows > 0
            || unterminated
            ? 'degraded'
            : 'ok';
        return {
            kind,
            file,
            status,
            bytes: Buffer.byteLength(raw, 'utf8'),
            rows: rows.length,
            validRows,
            uniqueAssets: seen.size,
            duplicateRows,
            corruptRows,
            hashMismatchRows,
            unverifiedRows,
            schemaInvalidRows,
            unterminated,
        };
    }
    catch (error) {
        if (error instanceof UnsafeAssetStorePathError)
            return emptyFile(kind, file, 'unsafe', error.reason);
        return emptyFile(kind, file, 'unavailable', 'read_unavailable');
    }
}
/**
 * Asset ids marked in the provenance sidecar as an unverified hub reuse (reason `unverified_*`, evolver-v2#570).
 * Read directly from `<baseDir>/provenance.jsonl` — NOT via ProvenanceStore — because inspectLocalAssetStore
 * already holds the shared `.assetstore.lock`, and ProvenanceStore would try to re-acquire it. A missing or
 * unreadable sidecar yields an empty set: without provenance every mismatch stays classified as corruption.
 */
function readUnverifiedReuseIds(baseDir) {
    const raw = readUtf8Regular(join(baseDir, 'provenance.jsonl'));
    if (raw === null)
        return new Set();
    const ids = new Set();
    for (const record of parseSidecarJsonl(raw, parseProvenanceRecord).records) {
        if (record.trusted === false && typeof record.reason === 'string' && record.reason.startsWith('unverified_')) {
            ids.add(record.assetId);
        }
    }
    return ids;
}
function inspectSidecar(baseDir, definition, maxFileBytes) {
    const { kind, file, parseRecord } = definition;
    try {
        const path = join(baseDir, file);
        const stat = assertOptionalRegularFile(path);
        if (stat === null)
            return emptySidecar(kind, file, 'missing');
        if (stat.size > maxFileBytes) {
            return { ...emptySidecar(kind, file, 'unavailable', 'scan_limit_exceeded'), bytes: stat.size };
        }
        const raw = readUtf8Regular(path);
        if (raw === null)
            return emptySidecar(kind, file, 'unavailable', 'read_unavailable');
        const parsed = parseSidecarJsonl(raw, parseRecord);
        const status = parsed.corruptRows > 0 || parsed.unterminated ? 'degraded' : 'ok';
        return {
            kind,
            file,
            status,
            bytes: Buffer.byteLength(raw, 'utf8'),
            rows: parsed.rows,
            validRows: parsed.validRows,
            corruptRows: parsed.corruptRows,
            unterminated: parsed.unterminated,
        };
    }
    catch (error) {
        if (error instanceof UnsafeAssetStorePathError)
            return emptySidecar(kind, file, 'unsafe', error.reason);
        return emptySidecar(kind, file, 'unavailable', 'read_unavailable');
    }
}
function directoryState(baseDir) {
    try {
        const stat = lstatSync(baseDir);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            return 'unsafe';
        return 'safe';
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return 'missing';
        return 'unavailable';
    }
}
export function inspectLocalAssetStore(baseDir, opts = {}, deps = {}) {
    const state = directoryState(baseDir);
    if (state === 'missing')
        return summarize(allFiles('missing'), allSidecars('missing'));
    if (state === 'unsafe') {
        return summarize(allFiles('unsafe', 'base_directory'), allSidecars('unsafe', 'base_directory'));
    }
    if (state === 'unavailable') {
        return summarize(allFiles('unavailable', 'read_unavailable'), allSidecars('unavailable', 'read_unavailable'));
    }
    const lockPath = join(baseDir, '.assetstore.lock');
    try {
        assertOptionalRegularFile(lockPath, 'lock_file');
    }
    catch (error) {
        if (error instanceof UnsafeAssetStorePathError) {
            return summarize(allFiles('unsafe', error.reason), allSidecars('unsafe', error.reason));
        }
        return summarize(allFiles('unavailable', 'lock_unavailable'), allSidecars('unavailable', 'lock_unavailable'));
    }
    try {
        (deps.acquireLock ?? acquireLock)(lockPath);
    }
    catch {
        return summarize(allFiles('unavailable', 'lock_unavailable'), allSidecars('unavailable', 'lock_unavailable'));
    }
    const maxFileBytes = healthScanLimit(opts.maxFileBytes);
    // Read the unverified-reuse set once, under the lock we already hold, so every asset file classifies its
    // hash mismatches consistently against the same provenance snapshot.
    const unverifiedIds = readUnverifiedReuseIds(baseDir);
    let report;
    try {
        report = summarize(Object.entries(LOCAL_ASSET_FILES)
            .map(([kind, file]) => inspectFile(baseDir, kind, file, maxFileBytes, unverifiedIds)), LOCAL_ASSET_SIDECARS.map((definition) => inspectSidecar(baseDir, definition, maxFileBytes)));
    }
    catch {
        report = summarize(allFiles('unavailable', 'read_unavailable'), allSidecars('unavailable', 'read_unavailable'));
    }
    try {
        const released = (deps.releaseLock ?? releaseLock)(lockPath);
        if (!isReliableAssetStoreLockRelease(released)) {
            return summarize(allFiles('unavailable', 'lock_unavailable'), allSidecars('unavailable', 'lock_unavailable'));
        }
    }
    catch {
        return summarize(allFiles('unavailable', 'lock_unavailable'), allSidecars('unavailable', 'lock_unavailable'));
    }
    return report;
}