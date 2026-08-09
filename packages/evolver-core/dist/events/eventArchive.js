import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { rootEvent } from './eventSchema.js';
export const ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS = 10_000;
const SEGMENT_PATTERN = /^root-events-(\d{16})-(\d{16})\.jsonl$/;
export class InvalidRootEventLogError extends Error {
    line;
    code = 'ROOT_EVENT_ARCHIVE_INVALID_LOG';
    constructor(line, reason) {
        super(`root event archive refused invalid active log at line ${line}: ${reason}`);
        this.line = line;
        this.name = 'InvalidRootEventLogError';
    }
}
export class ArchiveSegmentConflictError extends Error {
    archiveId;
    code = 'ROOT_EVENT_ARCHIVE_SEGMENT_CONFLICT';
    constructor(archiveId) {
        super(`root event archive segment ${archiveId} already exists with different content`);
        this.archiveId = archiveId;
        this.name = 'ArchiveSegmentConflictError';
    }
}
export class InvalidRootEventArchiveError extends Error {
    segment;
    line;
    code = 'ROOT_EVENT_ARCHIVE_INVALID_ARCHIVE';
    constructor(segment, line) {
        super(`root event archive segment ${segment} is invalid at line ${line}`);
        this.segment = segment;
        this.line = line;
        this.name = 'InvalidRootEventArchiveError';
    }
}
export class RootEventHistoryGapError extends Error {
    expectedSeq;
    actualSeq;
    code = 'ROOT_EVENT_HISTORY_GAP';
    constructor(expectedSeq, actualSeq) {
        super(`root event history expected seq ${expectedSeq} but found ${actualSeq}`);
        this.expectedSeq = expectedSeq;
        this.actualSeq = actualSeq;
        this.name = 'RootEventHistoryGapError';
    }
}
export function rootEventArchiveDir(path) {
    const ext = extname(path);
    const stem = ext.length > 0 ? basename(path, ext) : basename(path);
    return join(dirname(path), `${stem}.archive`);
}
export function rootEventArchiveSegmentName(firstSeq, lastSeq) {
    return `root-events-${String(firstSeq).padStart(16, '0')}-${String(lastSeq).padStart(16, '0')}.jsonl`;
}
export function planRootEventArchive(opts) {
    const keepEvents = normalizeKeepEvents(opts.keepEvents);
    const active = readActiveStrict(opts.path);
    const wouldArchive = Math.max(0, active.length - keepEvents);
    const prefix = active.slice(0, wouldArchive);
    readValidatedArchive(opts.path, active);
    const firstSeq = prefix[0]?.event.seq ?? null;
    const lastSeq = prefix[prefix.length - 1]?.event.seq ?? null;
    return {
        mode: 'preview',
        activeRecords: active.length,
        keepEvents,
        wouldArchive,
        retainedRecords: active.length - wouldArchive,
        firstSeq,
        lastSeq,
        archiveId: firstSeq === null || lastSeq === null ? null : `${firstSeq}-${lastSeq}`,
    };
}
export function archiveRootEvents(opts) {
    const keepEvents = normalizeKeepEvents(opts.keepEvents);
    const lockPath = `${opts.path}.lock`;
    mkdirSync(dirname(opts.path), { recursive: true });
    acquireLock(lockPath);
    try {
        const active = readActiveStrict(opts.path);
        const archivedRecords = Math.max(0, active.length - keepEvents);
        const prefix = active.slice(0, archivedRecords);
        const tail = active.slice(archivedRecords);
        const firstSeq = prefix[0]?.event.seq ?? null;
        const lastSeq = prefix[prefix.length - 1]?.event.seq ?? null;
        const archiveId = firstSeq === null || lastSeq === null ? null : `${firstSeq}-${lastSeq}`;
        let reusedSegment = false;
        const archivedBySeq = readValidatedArchive(opts.path, active);
        if (archiveId !== null && firstSeq !== null && lastSeq !== null) {
            const archiveDir = rootEventArchiveDir(opts.path);
            const missing = [];
            for (const line of prefix) {
                const archived = archivedBySeq.get(line.event.seq);
                if (archived === undefined) {
                    missing.push(line);
                    continue;
                }
                if (JSON.stringify(archived) !== JSON.stringify(line.event)) {
                    throw new ArchiveSegmentConflictError(String(line.event.seq));
                }
                reusedSegment = true;
            }
            for (const segment of contiguousGroups(missing)) {
                const missingFirstSeq = segment[0].event.seq;
                const missingLastSeq = segment[segment.length - 1].event.seq;
                const archiveBytes = serializeLines(segment);
                mkdirSync(archiveDir, { recursive: true });
                const segmentPath = join(archiveDir, rootEventArchiveSegmentName(missingFirstSeq, missingLastSeq));
                if (existsSync(segmentPath))
                    throw new ArchiveSegmentConflictError(`${missingFirstSeq}-${missingLastSeq}`);
                durableReplace(`${segmentPath}.tmp`, segmentPath, archiveBytes);
                fsyncDirectoryBestEffort(archiveDir);
            }
            durableReplace(`${opts.path}.archive.tmp`, opts.path, serializeLines(tail));
            fsyncDirectoryBestEffort(dirname(opts.path));
        }
        return {
            mode: 'write',
            activeRecordsBefore: active.length,
            keepEvents,
            archivedRecords,
            retainedRecords: tail.length,
            firstSeq,
            lastSeq,
            archiveId,
            reusedSegment,
        };
    }
    finally {
        releaseLock(lockPath);
    }
}
export function readRootEventHistory(path, archiveDir = rootEventArchiveDir(path)) {
    // Snapshot active first. Writers publish archive segments before replacing active, so this prevents a reader
    // from combining an old archive inventory with the new active tail and temporarily dropping the rotated prefix.
    const active = readEventsLenient(path);
    const bySeq = new Map();
    for (const file of archiveSegmentFiles(archiveDir)) {
        for (const event of readEventsLenient(join(archiveDir, file))) {
            // Archive segments are immutable: the first segment in canonical order owns a seq. A later conflicting
            // segment cannot silently replace it during operational reads. Strict validation still reports the
            // conflict and blocks archive writes.
            if (!bySeq.has(event.seq))
                bySeq.set(event.seq, event);
        }
    }
    // Preserve the pre-archive fail-soft behavior for routine commands. The active log is the current writer
    // source, so it deterministically wins an active/archive conflict without crashing status/report readers.
    for (const event of active)
        bySeq.set(event.seq, event);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
/** Strict replay for control-plane decisions that must fail closed on partial or conflicting history. */
export function readRootEventHistoryStrict(path) {
    const active = readActiveStrict(path);
    const bySeq = readValidatedArchive(path, active);
    for (const line of active)
        bySeq.set(line.event.seq, line.event);
    return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}
export function validateRootEventHistory(path) {
    void readRootEventHistoryStrict(path);
}
export function inspectRootEventArchive(path) {
    const archiveDir = rootEventArchiveDir(path);
    const files = archiveSegmentFiles(archiveDir);
    let bytes = 0;
    let records = 0;
    let invalidLines = 0;
    let firstSeq = null;
    let lastSeq = null;
    for (const file of files) {
        const raw = readFileSync(join(archiveDir, file), 'utf8');
        bytes += Buffer.byteLength(raw, 'utf8');
        for (const line of raw.split('\n')) {
            if (line.length === 0)
                continue;
            try {
                const event = rootEvent.parse(JSON.parse(line));
                firstSeq ??= event.seq;
                lastSeq = event.seq;
                records += 1;
            }
            catch {
                invalidLines += 1;
            }
        }
    }
    return {
        exists: files.length > 0,
        segments: files.length,
        bytes,
        records,
        invalidLines,
        firstSeq,
        lastSeq,
    };
}
function readActiveStrict(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    let previousSeq = null;
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        if (raw.length === 0)
            continue;
        let event;
        try {
            event = rootEvent.parse(JSON.parse(raw));
        }
        catch {
            throw new InvalidRootEventLogError(index + 1, 'invalid json or event schema');
        }
        if (previousSeq !== null && event.seq !== previousSeq + 1) {
            throw new InvalidRootEventLogError(index + 1, 'seq must be contiguous and strictly increasing');
        }
        previousSeq = event.seq;
        out.push({ event, raw });
    }
    return out;
}
function readEventsLenient(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.length === 0)
            continue;
        try {
            out.push(rootEvent.parse(JSON.parse(line)));
        }
        catch {
            // Active reads retain the existing crash-tail behavior. Strict archive writes refuse these lines.
        }
    }
    return out;
}
function archiveSegmentFiles(archiveDir) {
    if (!existsSync(archiveDir))
        return [];
    return readdirSync(archiveDir).filter((entry) => SEGMENT_PATTERN.test(entry)).sort();
}
function readArchivedEventsStrict(archiveDir) {
    const out = new Map();
    for (const file of archiveSegmentFiles(archiveDir)) {
        const lines = readFileSync(join(archiveDir, file), 'utf8').split('\n');
        let previousSeq = null;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line.length === 0)
                continue;
            let event;
            try {
                event = rootEvent.parse(JSON.parse(line));
            }
            catch {
                throw new InvalidRootEventArchiveError(file, index + 1);
            }
            if (previousSeq !== null && event.seq !== previousSeq + 1) {
                throw new InvalidRootEventArchiveError(file, index + 1);
            }
            previousSeq = event.seq;
            const current = out.get(event.seq);
            if (current !== undefined && JSON.stringify(current) !== JSON.stringify(event)) {
                throw new ArchiveSegmentConflictError(String(event.seq));
            }
            out.set(event.seq, event);
        }
    }
    return out;
}
function readValidatedArchive(path, active) {
    const archived = readArchivedEventsStrict(rootEventArchiveDir(path));
    for (const line of active) {
        const existing = archived.get(line.event.seq);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(line.event)) {
            throw new ArchiveSegmentConflictError(String(line.event.seq));
        }
    }
    assertContinuousHistory(archived, active);
    return archived;
}
function assertContinuousHistory(archived, active) {
    const seqs = new Set(archived.keys());
    for (const line of active)
        seqs.add(line.event.seq);
    const ordered = [...seqs].sort((left, right) => left - right);
    if (ordered.length === 0)
        return;
    let expected = 1;
    for (const actual of ordered) {
        if (actual !== expected)
            throw new RootEventHistoryGapError(expected, actual);
        expected += 1;
    }
}
function contiguousGroups(lines) {
    const groups = [];
    for (const line of lines) {
        const current = groups[groups.length - 1];
        const previous = current?.[current.length - 1];
        if (current === undefined || previous === undefined || line.event.seq !== previous.event.seq + 1) {
            groups.push([line]);
        }
        else {
            current.push(line);
        }
    }
    return groups;
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
function normalizeKeepEvents(value) {
    if (value === undefined)
        return ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS;
    if (!Number.isFinite(value) || value < 1)
        throw new RangeError('keepEvents must be a positive integer');
    return Math.floor(value);
}