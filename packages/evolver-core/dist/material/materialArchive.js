import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync, } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { material } from '../schema/material.js';
import { acquireLock, releaseLock } from '../util/fileLock.js';
export const MATERIAL_ARCHIVE_DEFAULT_KEEP_RECORDS = 1_000;
const SEGMENT_PATTERN = /^material-(\d{16})-(\d{16})\.jsonl$/;
export class InvalidMaterialLogError extends Error {
    line;
    code = 'MATERIAL_ARCHIVE_INVALID_LOG';
    constructor(line, reason) {
        super(`material archive refused invalid active log at line ${line}: ${reason}`);
        this.line = line;
        this.name = 'InvalidMaterialLogError';
    }
}
export class InvalidMaterialArchiveError extends Error {
    segment;
    line;
    code = 'MATERIAL_ARCHIVE_INVALID_ARCHIVE';
    constructor(segment, line, reason) {
        super(`material archive segment ${segment} is invalid at line ${line}: ${reason}`);
        this.segment = segment;
        this.line = line;
        this.name = 'InvalidMaterialArchiveError';
    }
}
export class MaterialArchiveRangeError extends Error {
    code = 'MATERIAL_ARCHIVE_RANGE_INVALID';
    constructor(reason) {
        super(`material archive range is invalid: ${reason}`);
        this.name = 'MaterialArchiveRangeError';
    }
}
export class MaterialArchiveSegmentConflictError extends Error {
    archiveId;
    code = 'MATERIAL_ARCHIVE_SEGMENT_CONFLICT';
    constructor(archiveId) {
        super(`material archive segment ${archiveId} already exists with different content`);
        this.archiveId = archiveId;
        this.name = 'MaterialArchiveSegmentConflictError';
    }
}
export class InvalidMaterialArchiveCursorError extends Error {
    code = 'MATERIAL_ARCHIVE_CURSOR_INVALID';
    constructor(reason) {
        super(`material archive cursor is invalid: ${reason}`);
        this.name = 'InvalidMaterialArchiveCursorError';
    }
}
export function materialArchiveDir(path) {
    const ext = extname(path);
    const stem = ext.length > 0 ? basename(path, ext) : basename(path);
    return join(dirname(path), `${stem}.archive`);
}
export function materialArchiveSegmentName(start, end) {
    return `material-${String(start).padStart(16, '0')}-${String(end).padStart(16, '0')}.jsonl`;
}
export function planMaterialArchive(opts) {
    const keepRecords = normalizeKeepRecords(opts.keepRecords);
    const state = readStrictHistory(opts.path);
    const historyRecords = state.archive.length + state.logicalActive.length;
    const cursors = readCursorsStrict(opts.cursorPaths ?? [], historyRecords);
    const minCursor = minimumCursor(cursors, state.archive.length);
    const wouldArchive = archiveableCount(state, minCursor, keepRecords);
    const start = state.archive.length;
    const end = start + wouldArchive - 1;
    return {
        mode: 'preview',
        activeRecords: state.logicalActive.length,
        physicalActiveRecords: state.active.length,
        archiveRecords: state.archive.length,
        historyRecords,
        keepRecords,
        minCursor,
        cursors,
        overlapRecords: state.overlap,
        wouldArchive,
        retainedRecords: state.logicalActive.length - wouldArchive,
        archiveId: wouldArchive === 0 ? null : `${start}-${end}`,
    };
}
export function archiveMaterialStore(opts) {
    const keepRecords = normalizeKeepRecords(opts.keepRecords);
    const lockPath = `${opts.path}.lock`;
    mkdirSync(dirname(opts.path), { recursive: true });
    acquireLock(lockPath);
    try {
        const state = readStrictHistory(opts.path);
        const historyRecords = state.archive.length + state.logicalActive.length;
        const cursors = readCursorsStrict(opts.cursorPaths ?? [], historyRecords);
        const minCursor = minimumCursor(cursors, state.archive.length);
        const archivedRecords = archiveableCount(state, minCursor, keepRecords);
        const start = state.archive.length;
        const end = start + archivedRecords - 1;
        const archiveId = archivedRecords === 0 ? null : `${start}-${end}`;
        if (archivedRecords > 0) {
            const prefix = state.logicalActive.slice(0, archivedRecords);
            const archiveDir = materialArchiveDir(opts.path);
            mkdirSync(archiveDir, { recursive: true });
            const segmentPath = join(archiveDir, materialArchiveSegmentName(start, end));
            const contents = serializeLines(prefix);
            if (existsSync(segmentPath)) {
                if (readFileSync(segmentPath, 'utf8') !== contents) {
                    throw new MaterialArchiveSegmentConflictError(archiveId ?? `${start}-${end}`);
                }
            }
            else {
                durableReplace(`${segmentPath}.tmp`, segmentPath, contents);
                fsyncDirectoryBestEffort(archiveDir);
            }
        }
        const tail = state.logicalActive.slice(archivedRecords);
        if (archivedRecords > 0 || state.overlap > 0) {
            durableReplace(`${opts.path}.archive.tmp`, opts.path, serializeLines(tail));
            fsyncDirectoryBestEffort(dirname(opts.path));
        }
        return {
            mode: 'write',
            activeRecordsBefore: state.logicalActive.length,
            physicalActiveRecordsBefore: state.active.length,
            keepRecords,
            minCursor,
            cursors,
            archivedRecords,
            retainedRecords: tail.length,
            archiveRecords: state.archive.length + archivedRecords,
            historyRecords,
            recoveredOverlap: state.overlap,
            archiveId,
        };
    }
    finally {
        releaseLock(lockPath);
    }
}
/** Operational, fail-soft full history reader. Strict archive writes validate every line and range. */
export function readMaterialHistory(path) {
    // Snapshot active first. Writers persist an archive segment before replacing active, so every interleaving
    // now observes either the old active state or a recoverable archive/active overlap, never a new tail with an
    // old archive base.
    const active = readMaterialsLenient(path);
    const ordered = [];
    const positions = new Map();
    const archiveDir = materialArchiveDir(path);
    for (const descriptor of segmentDescriptors(archiveDir)) {
        for (const record of readMaterialsLenient(join(archiveDir, descriptor.file))) {
            if (positions.has(record.materialId))
                continue;
            positions.set(record.materialId, ordered.length);
            ordered.push(record);
        }
    }
    // The active log is the current writer source. In a crash overlap it owns the duplicate record while its
    // original absolute position remains stable.
    for (const record of active) {
        const position = positions.get(record.materialId);
        if (position === undefined) {
            positions.set(record.materialId, ordered.length);
            ordered.push(record);
        }
        else {
            ordered[position] = record;
        }
    }
    return ordered;
}
/** Absolute-offset range reader used by durable consumers after active records move into archive segments. */
export function readMaterialRange(path, start, count) {
    const normalizedStart = normalizeRangeStart(start);
    const normalizedCount = normalizeRangeCount(count);
    if (normalizedCount === 0)
        return [];
    // Keep the same active-first snapshot order as readMaterialHistory; see its concurrency note.
    const active = readMaterialsLenient(path);
    const archiveDir = materialArchiveDir(path);
    const descriptors = segmentDescriptors(archiveDir);
    if (descriptors.length === 0) {
        return active.slice(normalizedStart, normalizedStart + normalizedCount);
    }
    const archiveEnd = Math.max(...descriptors.map((descriptor) => descriptor.end));
    const requestedEnd = Math.min(Number.MAX_SAFE_INTEGER, normalizedStart + normalizedCount - 1);
    const byOffset = new Map();
    for (const descriptor of descriptors) {
        if (descriptor.end < normalizedStart || descriptor.start > requestedEnd)
            continue;
        const records = readMaterialsLenient(join(archiveDir, descriptor.file));
        for (let index = 0; index < records.length; index += 1) {
            const offset = descriptor.start + index;
            if (offset >= normalizedStart && offset <= requestedEnd && !byOffset.has(offset)) {
                byOffset.set(offset, records[index]);
            }
        }
    }
    if (requestedEnd > archiveEnd) {
        const overlap = detectOperationalOverlap(path, descriptors, active);
        const logicalActive = active.slice(overlap);
        const activeStart = archiveEnd + 1;
        for (let index = 0; index < logicalActive.length; index += 1) {
            const offset = activeStart + index;
            if (offset >= normalizedStart && offset <= requestedEnd)
                byOffset.set(offset, logicalActive[index]);
        }
    }
    return [...byOffset.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, record]) => record);
}
export function inspectMaterialArchive(path) {
    const archiveDir = materialArchiveDir(path);
    const descriptors = segmentDescriptors(archiveDir);
    let bytes = 0;
    let records = 0;
    let invalidLines = 0;
    for (const descriptor of descriptors) {
        const segmentPath = join(archiveDir, descriptor.file);
        bytes += statSync(segmentPath).size;
        for (const line of readFileSync(segmentPath, 'utf8').split('\n')) {
            if (line.length === 0)
                continue;
            try {
                material.parse(JSON.parse(line));
                records += 1;
            }
            catch {
                invalidLines += 1;
            }
        }
    }
    return {
        exists: descriptors.length > 0,
        segments: descriptors.length,
        bytes,
        records,
        invalidLines,
        firstOffset: descriptors[0]?.start ?? null,
        lastOffset: descriptors[descriptors.length - 1]?.end ?? null,
    };
}
function readStrictHistory(path) {
    const archive = readArchiveStrict(materialArchiveDir(path));
    const active = readActiveStrict(path);
    const overlap = detectOverlap(archive, active);
    const logicalActive = active.slice(overlap);
    const seen = new Map();
    for (const line of [...archive, ...logicalActive]) {
        const canonical = JSON.stringify(line.record);
        const existing = seen.get(line.record.materialId);
        if (existing !== undefined) {
            if (existing !== canonical)
                throw new MaterialArchiveSegmentConflictError(line.record.materialId);
            throw new MaterialArchiveRangeError(`duplicate material ${line.record.materialId}`);
        }
        seen.set(line.record.materialId, canonical);
    }
    return { archive, active, logicalActive, overlap };
}
function readArchiveStrict(archiveDir) {
    const descriptors = segmentDescriptors(archiveDir, true);
    const out = [];
    let expectedStart = 0;
    for (const descriptor of descriptors) {
        if (descriptor.start !== expectedStart) {
            throw new MaterialArchiveRangeError(`expected offset ${expectedStart} but found ${descriptor.start}`);
        }
        const lines = readStrictLines(join(archiveDir, descriptor.file), descriptor.file, true);
        const expectedLength = descriptor.end - descriptor.start + 1;
        if (lines.length !== expectedLength) {
            throw new MaterialArchiveRangeError(`${descriptor.file} declares ${expectedLength} record(s) but contains ${lines.length}`);
        }
        out.push(...lines);
        expectedStart = descriptor.end + 1;
    }
    return out;
}
function readActiveStrict(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        if (raw.length === 0)
            continue;
        try {
            out.push({ record: material.parse(JSON.parse(raw)), raw });
        }
        catch {
            throw new InvalidMaterialLogError(index + 1, 'invalid json or material schema');
        }
    }
    return out;
}
function readStrictLines(path, segment, archive) {
    const out = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        if (raw.length === 0)
            continue;
        try {
            out.push({ record: material.parse(JSON.parse(raw)), raw });
        }
        catch {
            if (archive)
                throw new InvalidMaterialArchiveError(segment, index + 1, 'invalid json or material schema');
            throw new InvalidMaterialLogError(index + 1, 'invalid json or material schema');
        }
    }
    return out;
}
function readMaterialsLenient(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.length === 0)
            continue;
        try {
            out.push(material.parse(JSON.parse(line)));
        }
        catch {
            // Preserve MaterialStore's existing fail-soft reads. Archive writes use strict parsing.
        }
    }
    return out;
}
function segmentDescriptors(archiveDir, strict = false) {
    if (!existsSync(archiveDir))
        return [];
    const out = [];
    for (const file of readdirSync(archiveDir).sort()) {
        const match = SEGMENT_PATTERN.exec(file);
        if (match === null)
            continue;
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
            if (strict)
                throw new MaterialArchiveRangeError(`invalid segment filename ${file}`);
            continue;
        }
        out.push({ file, start, end });
    }
    return out.sort((left, right) => left.start - right.start || left.end - right.end);
}
function detectOverlap(archive, active) {
    const max = Math.min(archive.length, active.length);
    for (let length = max; length > 0; length -= 1) {
        const archiveStart = archive.length - length;
        let matches = true;
        for (let index = 0; index < length; index += 1) {
            if (JSON.stringify(archive[archiveStart + index].record) !== JSON.stringify(active[index].record)) {
                matches = false;
                break;
            }
        }
        if (matches)
            return length;
    }
    return 0;
}
function detectOperationalOverlap(path, descriptors, active) {
    const latest = descriptors[descriptors.length - 1];
    if (latest === undefined || active.length === 0)
        return 0;
    const archived = readMaterialsLenient(join(materialArchiveDir(path), latest.file));
    const max = Math.min(archived.length, active.length);
    for (let length = max; length > 0; length -= 1) {
        const archiveStart = archived.length - length;
        let matches = true;
        for (let index = 0; index < length; index += 1) {
            if (JSON.stringify(archived[archiveStart + index]) !== JSON.stringify(active[index])) {
                matches = false;
                break;
            }
        }
        if (matches)
            return length;
    }
    return 0;
}
function readCursorsStrict(paths, historyRecords) {
    const out = [];
    for (const path of paths) {
        if (!existsSync(path))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            throw new InvalidMaterialArchiveCursorError('cursor file is not valid JSON');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new InvalidMaterialArchiveCursorError('cursor file must contain an object');
        }
        for (const [group, value] of Object.entries(parsed)) {
            if (!Number.isSafeInteger(value) || value < 0 || value > historyRecords) {
                throw new InvalidMaterialArchiveCursorError(`group ${group} is outside history bounds`);
            }
            out.push({ group, position: value });
        }
    }
    return out;
}
function minimumCursor(cursors, archiveRecords) {
    return cursors.length === 0 ? archiveRecords : Math.min(...cursors.map((cursor) => cursor.position));
}
function archiveableCount(state, minCursor, keepRecords) {
    const committedActive = Math.max(0, minCursor - state.archive.length);
    const tailBound = Math.max(0, state.logicalActive.length - keepRecords);
    return Math.min(committedActive, tailBound);
}
function serializeLines(lines) {
    return lines.length === 0 ? '' : `${lines.map((line) => line.raw).join('\n')}\n`;
}
function durableReplace(tmpPath, finalPath, contents) {
    let fd = null;
    try {
        fd = openSync(tmpPath, 'w', 0o600);
        writeSync(fd, contents, undefined, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(tmpPath, finalPath);
    }
    catch (error) {
        if (fd !== null)
            closeSync(fd);
        rmSync(tmpPath, { force: true });
        throw error;
    }
}
function fsyncDirectoryBestEffort(path) {
    let fd = null;
    try {
        fd = openSync(path, 'r');
        fsyncSync(fd);
    }
    catch {
        // Windows and some filesystems do not support fsync on directories.
    }
    finally {
        if (fd !== null)
            closeSync(fd);
    }
}
function normalizeKeepRecords(value) {
    if (value === undefined)
        return MATERIAL_ARCHIVE_DEFAULT_KEEP_RECORDS;
    if (!Number.isFinite(value) || value < 1)
        throw new RangeError('keepRecords must be a positive integer');
    return Math.floor(value);
}
function normalizeRangeStart(value) {
    if (!Number.isFinite(value) || value < 0)
        return 0;
    return Math.floor(value);
}
function normalizeRangeCount(value) {
    if (!Number.isFinite(value))
        return Number.MAX_SAFE_INTEGER;
    if (value <= 0)
        return 0;
    return Math.floor(value);
}