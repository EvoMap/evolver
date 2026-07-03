import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { material } from '../schema/material.js';
import { rootEvent } from './eventSchema.js';
import { materialStorePath as defaultMaterialStorePath, rootEventsPath as defaultRootEventsPath } from './paths.js';
import { NARRATIVE_MAX_LIMIT } from './reports.js';
export const RETENTION_DEFAULT_MAX_ROOT_EVENTS = 100_000;
export const RETENTION_DEFAULT_MAX_ROOT_BYTES = 64 * 1024 * 1024;
export const RETENTION_DEFAULT_MAX_MATERIAL_RECORDS = 10_000;
export const RETENTION_DEFAULT_MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
export const RETENTION_DEFAULT_WATCH_RATIO = 0.8;
export const RETENTION_DEFAULT_ROOT_TAIL_EVENTS = Math.max(1_000, NARRATIVE_MAX_LIMIT);
export function defaultMaterialCursorPath(path = defaultMaterialStorePath()) {
    return join(dirname(path), 'cycle-consumer.json');
}
export function buildRetentionReport(opts = {}) {
    const now = new Date((opts.now ?? Date.now)()).toISOString();
    const watchRatio = ratioOf(opts.watchRatio, RETENTION_DEFAULT_WATCH_RATIO);
    const rootPath = opts.rootEventsPath ?? defaultRootEventsPath();
    const materialPath = opts.materialStorePath ?? defaultMaterialStorePath();
    const cursorPath = opts.materialCursorPath ?? defaultMaterialCursorPath(materialPath);
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
    const material = materialSnapshot(materialPath, cursorPath, materialThresholds);
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
        protectTailEvents: Math.min(stats.records, protectTailEvents),
        destructivePruneSafe: false,
        reason: 'root_events is the replay and audit source; archive readers must exist before destructive prune is safe',
    };
}
function materialSnapshot(path, cursorPath, thresholds) {
    const stats = readJsonl(path, (value) => material.parse(value));
    const cursor = readCycleCursor(cursorPath);
    const cursorInRange = cursor.value >= 0 && cursor.value <= stats.records;
    const effectiveCursor = cursorInRange ? cursor.value : clampCursor(cursor.value, stats.records);
    return {
        name: 'material',
        exists: stats.exists,
        bytes: stats.bytes,
        records: stats.records,
        invalidLines: stats.invalidLines,
        state: retentionState(stats.records, stats.bytes, thresholds),
        thresholds,
        firstCapturedAt: stats.first?.capturedAt ?? null,
        lastCapturedAt: stats.last?.capturedAt ?? null,
        cursorValid: cursor.valid,
        cursorInRange,
        cursor: cursor.value,
        effectiveCursor,
        consumedPrefix: effectiveCursor,
        pending: Math.max(0, stats.records - effectiveCursor),
        destructivePruneSafe: false,
        reason: 'material cursor is index-based; prune requires atomic archive plus cursor rewrite',
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
function readCycleCursor(path) {
    if (!existsSync(path))
        return { exists: false, valid: true, value: 0 };
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof parsed.cycle === 'number' && Number.isFinite(parsed.cycle)) {
            return { exists: true, valid: true, value: Math.floor(parsed.cycle) };
        }
        return { exists: true, valid: false, value: 0 };
    }
    catch {
        return { exists: true, valid: false, value: 0 };
    }
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
    if (mat.invalidLines > 0)
        out.push(`material store has ${mat.invalidLines} invalid jsonl line(s); inspect before rotating`);
    if (!mat.cursorValid)
        out.push('material cursor is unreadable; retention uses effectiveCursor=0 until the cursor is repaired');
    if (mat.cursorValid && !mat.cursorInRange)
        out.push(`material cursor ${mat.cursor} is outside material record range 0..${mat.records}; retention uses effectiveCursor=${mat.effectiveCursor}`);
    if (root.state === 'over_limit')
        out.push('root_events exceeds retention thresholds; plan archive support before deleting audit lines');
    if (mat.state === 'over_limit')
        out.push('material store exceeds retention thresholds; archive consumed prefix only with cursor rewrite');
    if (mat.pending > 0)
        out.push(`material store has ${mat.pending} pending record(s); do not prune pending material`);
    return out;
}
function buildNextActions(root, mat) {
    const out = [
        'keep destructive prune disabled until archive readers are wired into reports, replay and cycle recovery',
    ];
    if (root.state !== 'ok')
        out.push(`root_events ${root.state}: keep at least the last ${root.protectTailEvents} event(s) active after future archive`);
    if (!mat.cursorValid || !mat.cursorInRange)
        out.push('material: repair the cycle cursor before archiving consumed material');
    if (mat.consumedPrefix > 0)
        out.push(`material: ${mat.consumedPrefix} consumed prefix record(s) are archive candidates after atomic cursor rewrite exists`);
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