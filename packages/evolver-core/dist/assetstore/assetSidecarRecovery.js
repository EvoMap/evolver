import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalize } from '../wire/index.js';
import { LockReleaseError } from '../util/fileLock.js';
import { AssetStoreReadLimitError, assertAssetStoreDirectory, createBufferDurableExclusive, fsyncDirectoryBestEffort, readRegularBuffer, regularFileFingerprint, replaceUtf8Durable, withAssetStoreLock, } from './assetStoreStorage.js';
import { parseAssetSyncSidecarRecord, parseProvenanceRecord, parseReviewRecord, } from './assetSidecarRecords.js';
export class AssetSidecarRecoveryError extends Error {
    reason;
    code = 'ASSET_SIDECAR_RECOVERY_FAILED';
    constructor(reason) {
        super(`asset sidecar recovery failed: ${reason}`);
        this.reason = reason;
        this.name = 'AssetSidecarRecoveryError';
    }
}
export const DEFAULT_SIDECAR_RECOVERY_MAX_FILE_BYTES = 64 * 1024 * 1024;
function recoveryFileLimit(value) {
    if (value === undefined || !Number.isFinite(value))
        return DEFAULT_SIDECAR_RECOVERY_MAX_FILE_BYTES;
    return Math.min(DEFAULT_SIDECAR_RECOVERY_MAX_FILE_BYTES, Math.max(1, Math.floor(value)));
}
const SIDECAR_FILES = {
    provenance: 'provenance.jsonl',
    review: 'review.jsonl',
    'asset-sync': 'asset-sync.jsonl',
};
const RECORD_PARSERS = {
    provenance: parseProvenanceRecord,
    review: parseReviewRecord,
    'asset-sync': parseAssetSyncSidecarRecord,
};
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function readBounded(path, limit, role) {
    try {
        const before = regularFileFingerprint(path);
        if (before === 'missing') {
            throw new AssetSidecarRecoveryError(role === 'sidecar' ? 'sidecar_missing' : 'replacement_missing');
        }
        const value = readRegularBuffer(path, limit);
        if (value === null) {
            throw new AssetSidecarRecoveryError(role === 'sidecar' ? 'sidecar_missing' : 'replacement_missing');
        }
        const after = regularFileFingerprint(path);
        if (before !== after) {
            throw new AssetSidecarRecoveryError(role === 'sidecar' ? 'sidecar_changed' : 'replacement_changed');
        }
        return { bytes: value, fingerprint: after };
    }
    catch (error) {
        if (error instanceof AssetStoreReadLimitError) {
            throw new AssetSidecarRecoveryError(role === 'sidecar' ? 'sidecar_too_large' : 'replacement_too_large');
        }
        throw error;
    }
}
function parseCurrent(bytes, sidecar) {
    const hex = digest(bytes);
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { bytes, text, parsed: parseRecoveryJsonl(text, RECORD_PARSERS[sidecar]), digest: `sha256:${hex}` };
    }
    catch {
        return {
            bytes,
            text: null,
            parsed: {
                records: [],
                rows: bytes.length > 0 ? 1 : 0,
                validRows: 0,
                corruptRows: bytes.length > 0 ? 1 : 0,
                unterminated: bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a,
            },
            digest: `sha256:${hex}`,
        };
    }
}
function parseReplacement(bytes, sidecar) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw new AssetSidecarRecoveryError('replacement_invalid_utf8');
    }
    const parsed = parseRecoveryJsonl(text, RECORD_PARSERS[sidecar]);
    if (parsed.corruptRows > 0)
        throw new AssetSidecarRecoveryError('replacement_invalid');
    if (parsed.unterminated)
        throw new AssetSidecarRecoveryError('replacement_unterminated');
    return { bytes, text, parsed, digest: `sha256:${digest(bytes)}` };
}
function parseRecoveryJsonl(raw, parseRecord) {
    const records = [];
    let rows = 0;
    let corruptRows = 0;
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        rows += 1;
        try {
            const original = JSON.parse(line);
            const normalized = parseRecord(original);
            if (normalized)
                records.push({ original, normalized });
            else
                corruptRows += 1;
        }
        catch {
            corruptRows += 1;
        }
    }
    return {
        records,
        rows,
        validRows: records.length,
        corruptRows,
        unterminated: raw.length > 0 && !raw.endsWith('\n'),
    };
}
function canonicalRecords(records) {
    return records.map((record) => canonicalize(record.original));
}
function compareHistory(currentRecords, replacementRecords) {
    const current = canonicalRecords(currentRecords);
    const replacement = canonicalRecords(replacementRecords);
    if (current.some((record, index) => replacement[index] !== record)) {
        throw new AssetSidecarRecoveryError('valid_history_missing');
    }
    const extra = replacement.slice(current.length);
    const existing = new Set(current);
    return {
        preservedValidRows: current.length,
        addedRecords: extra.length,
        correctiveRecords: extra.filter((record) => !existing.has(record)).length,
        added: replacementRecords.slice(current.length),
    };
}
function isSafeCorrectiveRecord(sidecar, value) {
    if (sidecar === 'asset-sync')
        return true;
    if (!value.normalized || typeof value.normalized !== 'object' || Array.isArray(value.normalized))
        return false;
    const record = value.normalized;
    return sidecar === 'provenance'
        ? record['trusted'] === false
        : record['state'] === 'quarantined' || record['state'] === 'rejected';
}
function fileReport(file) {
    return {
        rows: file.parsed.rows,
        validRows: file.parsed.validRows,
        corruptRows: file.parsed.corruptRows,
        unterminated: file.parsed.unterminated,
        digest: file.digest,
    };
}
function ensureExactBackup(baseDir, sidecar, current) {
    const backupDir = join(baseDir, 'sidecar-backups');
    assertAssetStoreDirectory(baseDir);
    let backupDirCreated = false;
    if (!existsSync(backupDir)) {
        try {
            mkdirSync(backupDir, { recursive: false, mode: 0o700 });
            backupDirCreated = true;
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
        }
    }
    assertAssetStoreDirectory(backupDir);
    if (backupDirCreated)
        fsyncDirectoryBestEffort(baseDir);
    const hex = current.digest.slice('sha256:'.length);
    const backupId = `${sidecar}-${hex}.jsonl`;
    const backupPath = join(backupDir, backupId);
    try {
        createBufferDurableExclusive(backupPath, current.bytes);
    }
    catch (error) {
        if (!isErrno(error, 'EEXIST'))
            throw error;
        let existing;
        try {
            existing = readRegularBuffer(backupPath, current.bytes.length);
        }
        catch (readError) {
            if (readError instanceof AssetStoreReadLimitError) {
                throw new AssetSidecarRecoveryError('backup_conflict');
            }
            throw readError;
        }
        if (!existing?.equals(current.bytes))
            throw new AssetSidecarRecoveryError('backup_conflict');
    }
    return backupId;
}
export function recoverAssetSidecar(opts) {
    assertAssetStoreDirectory(opts.baseDir);
    const maxFileBytes = recoveryFileLimit(opts.maxFileBytes);
    const targetPath = join(opts.baseDir, SIDECAR_FILES[opts.sidecar]);
    const lockPath = join(opts.baseDir, '.assetstore.lock');
    let committed;
    try {
        return withAssetStoreLock(lockPath, () => {
            const currentRead = readBounded(targetPath, maxFileBytes, 'sidecar');
            const replacementRead = readBounded(opts.replacementPath, maxFileBytes, 'replacement');
            const current = parseCurrent(currentRead.bytes, opts.sidecar);
            const replacement = parseReplacement(replacementRead.bytes, opts.sidecar);
            const history = compareHistory(current.parsed.records, replacement.parsed.records);
            const degraded = current.parsed.corruptRows > 0 || current.parsed.unterminated;
            const sameBytes = current.bytes.equals(replacement.bytes);
            if (!degraded && !sameBytes)
                throw new AssetSidecarRecoveryError('sidecar_not_degraded');
            if (current.parsed.corruptRows > 0
                && opts.sidecar !== 'asset-sync'
                && history.correctiveRecords === 0) {
                throw new AssetSidecarRecoveryError('corrective_record_required');
            }
            if (history.added.some((record) => !isSafeCorrectiveRecord(opts.sidecar, record))) {
                throw new AssetSidecarRecoveryError('unsafe_corrective_record');
            }
            const acknowledgementRequired = degraded && !sameBytes;
            const mode = opts.write ? 'write' : 'preview';
            const baseReport = {
                mode,
                sidecar: opts.sidecar,
                current: fileReport(current),
                replacement: {
                    ...fileReport(replacement),
                    preservedValidRows: history.preservedValidRows,
                    addedRecords: history.addedRecords,
                    correctiveRecords: history.correctiveRecords,
                },
            };
            if (sameBytes) {
                return {
                    ...baseReport,
                    changed: false,
                    wouldWrite: false,
                    acknowledgementRequired: false,
                };
            }
            if (!opts.write) {
                return {
                    ...baseReport,
                    changed: false,
                    wouldWrite: true,
                    acknowledgementRequired,
                };
            }
            if (!opts.acknowledgeCorruptHistory) {
                throw new AssetSidecarRecoveryError('acknowledgement_required');
            }
            opts.deps?.beforeBackup?.();
            const backupId = ensureExactBackup(opts.baseDir, opts.sidecar, current);
            opts.deps?.beforeReplace?.();
            if (regularFileFingerprint(targetPath) !== currentRead.fingerprint) {
                throw new AssetSidecarRecoveryError('sidecar_changed');
            }
            if (regularFileFingerprint(opts.replacementPath) !== replacementRead.fingerprint) {
                throw new AssetSidecarRecoveryError('replacement_changed');
            }
            replaceUtf8Durable(targetPath, replacement.text);
            committed = {
                ...baseReport,
                changed: true,
                wouldWrite: false,
                acknowledgementRequired: false,
                backupId,
            };
            return committed;
        }, opts.deps?.lock);
    }
    catch (error) {
        if (committed && error instanceof LockReleaseError) {
            return { ...committed, lockReleaseWarning: error.reason };
        }
        throw error;
    }
}