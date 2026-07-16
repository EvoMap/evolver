import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { material } from '../schema/material.js';
import { inspectMaterialArchive, planMaterialArchive, readMaterialHistory, } from '../material/materialArchive.js';
import { rootEvent } from './eventSchema.js';
import { ArchiveSegmentConflictError, inspectRootEventArchive, readRootEventHistory, RootEventHistoryGapError, ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS, validateRootEventHistory, } from './eventArchive.js';
import { materialStorePath as defaultMaterialStorePath, rootEventsPath as defaultRootEventsPath } from './paths.js';
export const RETENTION_DEFAULT_MAX_ROOT_EVENTS = 100_000;
export const RETENTION_DEFAULT_MAX_ROOT_BYTES = 64 * 1024 * 1024;
export const RETENTION_DEFAULT_MAX_MATERIAL_RECORDS = 10_000;
export const RETENTION_DEFAULT_MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
export const RETENTION_DEFAULT_WATCH_RATIO = 0.8;
export const RETENTION_DEFAULT_ROOT_TAIL_EVENTS = ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS;
export function defaultMaterialCursorPath(path = defaultMaterialStorePath()) {
    return join(dirname(path), 'cycle-consumer.json');
}
export function defaultMaterialCursorPaths(path = defaultMaterialStorePath()) {
    return [defaultMaterialCursorPath(path), join(dirname(path), 'distill-consumer.json')];
}
export function buildRetentionReport(opts = {}) {
    const now = new Date((opts.now ?? Date.now)()).toISOString();
    const watchRatio = ratioOf(opts.watchRatio, RETENTION_DEFAULT_WATCH_RATIO);
    const rootPath = opts.rootEventsPath ?? defaultRootEventsPath();
    const materialPath = opts.materialStorePath ?? defaultMaterialStorePath();
    const cursorPaths = opts.materialCursorPaths
        ?? (opts.materialCursorPath !== undefined ? [opts.materialCursorPath] : defaultMaterialCursorPaths(materialPath));
    const rootThresholds = {
        maxRecords: positiveInt(opts.maxRootEvents, RETENTION_DEFAULT_MAX_ROOT_EVENTS),
        maxBytes: positiveInt(opts.maxRootBytes, RETENTION_DEFAULT_MAX_ROOT_BYTES),
        watchRatio,
    };
    const materialThresholds = {
        maxRecords: positiveInt(opts.maxMaterialRecords, RETENTION_DEFAULT_MAX_MATERIAL_RECORDS),
        maxBytes: positiveInt(opts.maxMaterialBytes, RETENTION_DEFAULT_MAX_MATERIAL_BYTES),
        watchRatio,
    };
    const rootEvents = rootSnapshot(rootPath, rootThresholds, positiveInt(opts.protectRootTailEvents, RETENTION_DEFAULT_ROOT_TAIL_EVENTS));
    const material = materialSnapshot(materialPath, cursorPaths, materialThresholds);
    const warnings = buildWarnings(rootEvents, material);
    const nextActions = buildNextActions(rootEvents, material);
    return {
        generatedAt: now,
        mode: 'read_only_policy',
        destructivePruneSupported: false,
        rootEvents,
        material,
        warnings,
        nextActions,
    };
}
function rootSnapshot(path, thresholds, protectTailEvents) {
    const stats = readJsonl(path, (value) => rootEvent.parse(value));
    const archive = inspectRootEventArchive(path);
    const historyRecords = readRootEventHistory(path).length;
    let historyConflicts = 0;
    let historyGaps = 0;
    let historyIntegrityErrors = 0;
    try {
        validateRootEventHistory(path);
    }
    catch (error) {
        if (error instanceof ArchiveSegmentConflictError)
            historyConflicts = 1;
        else if (error instanceof RootEventHistoryGapError)
            historyGaps = 1;
        else
            historyIntegrityErrors = 1;
    }
    return {
        name: 'root_events',
        exists: stats.exists,
        bytes: stats.bytes,
        records: stats.records,
        invalidLines: stats.invalidLines,
        state: retentionState(stats.records, stats.bytes, thresholds),
        thresholds,
        firstSeq: stats.first?.seq ?? null,
        lastSeq: stats.last?.seq ?? null,
        firstTs: stats.first?.ts ?? null,
        lastTs: stats.last?.ts ?? null,
        archiveSegments: archive.segments,
        archiveRecords: archive.records,
        archiveBytes: archive.bytes,
        archiveInvalidLines: archive.invalidLines,
        historyRecords,
        historyBytes: archive.bytes + stats.bytes,
        historyConflicts,
        historyGaps,
        historyIntegrityErrors,
        archiveRotationSupported: true,
        archiveRotationSafe: stats.invalidLines === 0 && archive.invalidLines === 0 && historyConflicts === 0 && historyGaps === 0 && historyIntegrityErrors === 0,
        protectTailEvents: Math.min(stats.records, protectTailEvents),
        destructivePruneSafe: false,
        reason: 'archive rotation preserves replay history; destructive archive deletion remains disabled',
    };
}
function materialSnapshot(path, cursorPaths, thresholds) {
    const stats = readJsonl(path, (value) => material.parse(value));
    const archive = inspectMaterialArchive(path);
    const history = readMaterialHistory(path);
    const historyRecords = history.length;
    const cursors = readMaterialCursors(cursorPaths, historyRecords, archive.records);
    const effectiveCursor = cursors.inRange ? cursors.cycle : clampCursor(cursors.cycle, historyRecords);
    const effectiveMinimum = cursors.inRange ? cursors.min : clampCursor(cursors.min, historyRecords);
    let archiveRotationSafe = stats.invalidLines === 0 && archive.invalidLines === 0 && cursors.valid && cursors.inRange;
    if (archiveRotationSafe) {
        try {
            planMaterialArchive({ path, cursorPaths, keepRecords: 1 });
        }
        catch {
            archiveRotationSafe = false;
        }
    }
    return {
        name: 'material',
        exists: stats.exists || archive.exists,
        bytes: stats.bytes,
        records: stats.records,
        invalidLines: stats.invalidLines,
        state: retentionState(stats.records, stats.bytes, thresholds),
        thresholds,
        firstCapturedAt: history[0]?.capturedAt ?? null,
        lastCapturedAt: history[history.length - 1]?.capturedAt ?? null,
        archiveSegments: archive.segments,
        archiveRecords: archive.records,
        archiveBytes: archive.bytes,
        archiveInvalidLines: archive.invalidLines,
        historyRecords,
        historyBytes: archive.bytes + stats.bytes,
        cursorCount: cursors.count,
        minCursor: effectiveMinimum,
        cursorValid: cursors.valid,
        cursorInRange: cursors.inRange,
        cursor: cursors.cycle,
        effectiveCursor,
        consumedPrefix: effectiveMinimum,
        pending: Math.max(0, historyRecords - effectiveCursor),
        archiveRotationSupported: true,
        archiveRotationSafe,
        destructivePruneSafe: false,
        reason: 'archive rotation preserves absolute consumer cursors and full material history; destructive archive deletion remains disabled',
    };
}
function readJsonl(path, parse) {
    if (!existsSync(path)) {
        return { exists: false, bytes: 0, records: 0, invalidLines: 0, first: null, last: null };
    }
    const bytes = statSync(path).size;
    let records = 0;
    let invalidLines = 0;
    let first = null;
    let last = null;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line)
            continue;
        try {
            const parsed = parse(JSON.parse(line));
            first ??= parsed;
            last = parsed;
            records += 1;
        }
        catch {
            invalidLines += 1;
        }
    }
    return { exists: true, bytes, records, invalidLines, first, last };
}
function readMaterialCursors(paths, historyRecords, archiveRecords) {
    let valid = true;
    let inRange = true;
    let cycle = 0;
    let cycleFound = false;
    const values = [];
    for (const path of paths) {
        if (!existsSync(path))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            valid = false;
            continue;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            valid = false;
            continue;
        }
        for (const [group, value] of Object.entries(parsed)) {
            if (!Number.isSafeInteger(value) || value < 0) {
                valid = false;
                continue;
            }
            const position = value;
            values.push(position);
            if (position > historyRecords)
                inRange = false;
            if (group === 'cycle' && !cycleFound) {
                cycle = position;
                cycleFound = true;
            }
        }
    }
    return {
        valid,
        inRange,
        count: values.length,
        cycle,
        min: values.length === 0 ? archiveRecords : Math.min(...values),
    };
}
function retentionState(records, bytes, thresholds) {
    if (records > thresholds.maxRecords || bytes > thresholds.maxBytes)
        return 'over_limit';
    if (records >= thresholds.maxRecords * thresholds.watchRatio || bytes >= thresholds.maxBytes * thresholds.watchRatio)
        return 'watch';
    return 'ok';
}
function buildWarnings(root, mat) {
    const out = [];
    if (root.invalidLines > 0)
        out.push(`root_events has ${root.invalidLines} invalid jsonl line(s); recover before rotating`);
    if (root.archiveInvalidLines > 0)
        out.push(`root_events archive has ${root.archiveInvalidLines} invalid jsonl line(s); repair archive integrity before rotating again`);
    if (root.historyConflicts > 0)
        out.push('root_events active/archive history has conflicting seq records; repair audit integrity before rotating');
    if (root.historyGaps > 0)
        out.push('root_events active/archive history has a seq gap; restore the missing audit segment before rotating');
    if (root.historyIntegrityErrors > 0)
        out.push('root_events history fails structural integrity checks; repair event ordering before rotating');
    if (mat.invalidLines > 0)
        out.push(`material store has ${mat.invalidLines} invalid jsonl line(s); inspect before rotating`);
    if (!mat.cursorValid)
        out.push('material cursor is unreadable; retention uses effectiveCursor=0 until the cursor is repaired');
    if (mat.cursorValid && !mat.cursorInRange)
        out.push(`material cursor ${mat.cursor} is outside material record range 0..${mat.historyRecords}; retention uses effectiveCursor=${mat.effectiveCursor}`);
    if (root.state === 'over_limit')
        out.push('root_events exceeds retention thresholds for the active log; preview archive rotation before writing');
    if (mat.archiveInvalidLines > 0)
        out.push(`material archive has ${mat.archiveInvalidLines} invalid jsonl line(s); repair archive integrity before rotating again`);
    if (!mat.archiveRotationSafe)
        out.push('material active/archive/cursor state is not safe for rotation; run archive-material preview after repairing integrity');
    if (mat.state === 'over_limit')
        out.push('material active store exceeds retention thresholds; preview absolute-cursor archive rotation before writing');
    if (mat.pending > 0)
        out.push(`material store has ${mat.pending} pending record(s); do not prune pending material`);
    return out;
}
function buildNextActions(root, mat) {
    const out = [
        'archive rotation is available; keep destructive prune disabled for archive deletion',
    ];
    if (root.state !== 'ok')
        out.push(`root_events ${root.state}: run retention archive-root preview, then keep at least the last ${root.protectTailEvents} active event(s)`);
    if (!mat.cursorValid || !mat.cursorInRange)
        out.push('material: repair the cycle cursor and any other durable consumer cursor before archiving consumed material');
    if (mat.consumedPrefix > mat.archiveRecords)
        out.push(`material: ${mat.consumedPrefix - mat.archiveRecords} consumed prefix record(s) may be archived with archive-material without rewriting cursors`);
    if (mat.pending > 0)
        out.push('material: process or inspect pending records before any future prune');
    return out;
}
function positiveInt(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function ratioOf(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(0.99, Math.max(0.1, value));
}
function clampCursor(value, records) {
    return Math.min(records, Math.max(0, Math.floor(value)));
}