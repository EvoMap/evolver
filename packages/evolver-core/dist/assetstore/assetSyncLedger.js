import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { appendUtf8Durable, assertAssetStoreDirectory, ensureAssetStoreDirectory, readUtf8Regular, regularFileFingerprint, replaceUtf8Durable, withAssetStoreLock, } from './assetStoreStorage.js';
import { ASSET_SYNC_INVENTORY_MAX_SEGMENT_BYTES, parseAssetSyncInventorySegmentRecord, parseAssetSyncRecord, parseAssetSyncRunRecord, parseSidecarJsonl, } from './assetSidecarRecords.js';
export const ASSET_SYNC_INVENTORY_MAX_SEGMENTS = 24;
export const ASSET_SYNC_INVENTORY_MAX_ITEMS_PER_SEGMENT = 10_000;
export const ASSET_SYNC_INVENTORY_MAX_UNIQUE_ITEMS = 240_000;
export const ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const ASSET_SYNC_SIDECAR_MAX_BYTES = 64 * 1024 * 1024;
export class AssetSyncLedger {
    now;
    path;
    lockPath;
    index = new Map();
    runKeyIndex = new Map();
    inventoryKeyIndex = new Map();
    fileState = null;
    loaded = false;
    constructor(baseDir, now = Date.now) {
        this.now = now;
        ensureAssetStoreDirectory(baseDir);
        this.path = join(baseDir, 'asset-sync.jsonl');
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    append(rec) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const full = immutableRecord({
                ...rec,
                syncedAt: rec.syncedAt ?? new Date(this.now()).toISOString(),
            });
            appendUtf8Durable(this.path, `${JSON.stringify(full)}\n`);
            this.index.set(full.assetId, full);
            if (full.runKey) {
                const scoped = this.runKeyIndex.get(full.runKey) ?? new Map();
                scoped.set(full.assetId, full);
                this.runKeyIndex.set(full.runKey, scoped);
            }
            if (full.inventoryKey) {
                const scoped = this.inventoryKeyIndex.get(full.inventoryKey) ?? new Map();
                scoped.set(full.assetId, full);
                this.inventoryKeyIndex.set(full.inventoryKey, scoped);
            }
            this.fileState = regularFileFingerprint(this.path);
            return full;
        });
    }
    appendRun(rec) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const full = parseAssetSyncRunRecord({
                recordType: 'run',
                ...rec,
                syncedAt: rec.syncedAt ?? new Date(this.now()).toISOString(),
            });
            if (!full)
                throw new Error('invalid asset sync run record');
            appendUtf8Durable(this.path, `${JSON.stringify(full)}\n`);
            this.fileState = regularFileFingerprint(this.path);
            return full;
        });
    }
    appendInventorySegment(rec) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const full = parseAssetSyncInventorySegmentRecord({
                recordType: 'inventory_scan',
                ...rec,
                syncedAt: rec.syncedAt ?? new Date(this.now()).toISOString(),
            });
            if (!full)
                return null;
            const state = readUtf8Regular(this.path) ?? '';
            const line = `${JSON.stringify(full)}\n`;
            if (full.index === 0) {
                const compacted = removeInventoryScan(state, full.inventoryKey);
                const replacement = `${compacted}${line}`;
                if (!canAppendInventorySegment(undefined, full)
                    || inventoryScanBytes(replacement) > ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES
                    || Buffer.byteLength(replacement, 'utf8') > ASSET_SYNC_SIDECAR_MAX_BYTES) {
                    return null;
                }
                replaceUtf8Durable(this.path, replacement);
                this.rebuildIndex(regularFileFingerprint(this.path));
                return full;
            }
            const current = this.latestInventorySnapshotUnderLock(full.inventoryKey);
            if (!canAppendInventorySegment(current, full))
                return null;
            if (inventoryScanBytes(state) + Buffer.byteLength(line, 'utf8') > ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES
                || Buffer.byteLength(state, 'utf8') + Buffer.byteLength(line, 'utf8') > ASSET_SYNC_SIDECAR_MAX_BYTES) {
                return null;
            }
            appendUtf8Durable(this.path, line);
            this.fileState = regularFileFingerprint(this.path);
            return full;
        });
    }
    appendInventoryBatch(rec) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const records = createInventoryBatchRecords({
                ...rec,
                syncedAt: rec.syncedAt ?? new Date(this.now()).toISOString(),
            });
            if (!records)
                return null;
            const state = readUtf8Regular(this.path) ?? '';
            const lines = records.map((record) => `${JSON.stringify(record)}\n`).join('');
            const current = rec.index === 0 ? undefined : this.latestInventorySnapshotUnderLock(rec.inventoryKey);
            if (!canAppendInventoryBatch(current, records))
                return null;
            if (rec.index === 0) {
                const compacted = removeInventoryScan(state, rec.inventoryKey);
                const replacement = `${compacted}${lines}`;
                if (inventoryScanBytes(replacement) > ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES
                    || Buffer.byteLength(replacement, 'utf8') > ASSET_SYNC_SIDECAR_MAX_BYTES) {
                    return null;
                }
                replaceUtf8Durable(this.path, replacement);
                this.rebuildIndex(regularFileFingerprint(this.path));
                return records;
            }
            if (inventoryScanBytes(state) + Buffer.byteLength(lines, 'utf8') > ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES
                || Buffer.byteLength(state, 'utf8') + Buffer.byteLength(lines, 'utf8') > ASSET_SYNC_SIDECAR_MAX_BYTES) {
                return null;
            }
            appendUtf8Durable(this.path, lines);
            this.fileState = regularFileFingerprint(this.path);
            return records;
        });
    }
    replaceInventoryRetryBatch(rec) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const state = readUtf8Regular(this.path) ?? '';
            const current = this.latestInventorySnapshotUnderLock(rec.inventoryKey);
            if (!current
                || current.retryIndex === undefined
                || rec.index !== current.retryIndex
                || rec.scanId !== current.scanId
                || rec.scope !== current.scope
                || !cursorFingerprintsEqual(rec.inputCursorFingerprints, current.nextCursorFingerprints))
                return null;
            const retryTail = findInventoryRetryTail(state, current);
            if (!retryTail)
                return null;
            const mergedItems = mergeInventoryRetryItems(retryTail.records, rec.items);
            if (!mergedItems)
                return null;
            const previousAnonymousBlocked = retryTail.records.reduce((total, record) => total + record.anonymousBlocked, 0);
            const records = createInventoryBatchRecords({
                ...rec,
                items: mergedItems,
                anonymousBlocked: Math.max(previousAnonymousBlocked, rec.anonymousBlocked),
                syncedAt: rec.syncedAt ?? new Date(this.now()).toISOString(),
            });
            if (!records)
                return null;
            const preserved = removeInventoryRetryTail(state, retryTail.lineIndexes);
            const prefix = inventorySnapshotFromRaw(preserved, rec.inventoryKey);
            if (!canAppendInventoryBatch(prefix, records))
                return null;
            const replacement = `${preserved}${records.map((record) => `${JSON.stringify(record)}\n`).join('')}`;
            if (inventoryScanBytes(replacement) > ASSET_SYNC_INVENTORY_MAX_TOTAL_BYTES
                || Buffer.byteLength(replacement, 'utf8') > ASSET_SYNC_SIDECAR_MAX_BYTES)
                return null;
            replaceUtf8Durable(this.path, replacement);
            this.rebuildIndex(regularFileFingerprint(this.path));
            return records;
        });
    }
    clearInventoryScan(inventoryKey) {
        assertAssetStoreDirectory(dirname(this.path));
        withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const state = readUtf8Regular(this.path) ?? '';
            const compacted = removeInventoryScan(state, inventoryKey);
            if (compacted === state)
                return;
            replaceUtf8Durable(this.path, compacted);
            this.rebuildIndex(regularFileFingerprint(this.path));
        });
    }
    runRecords(runId) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return this.readRunRecordsUnderLock().filter((record) => record.runId === runId);
        });
    }
    latestIncompleteRun(runKey) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            let current;
            for (const record of this.readRunRecordsUnderLock()) {
                if (record.runKey !== runKey)
                    continue;
                if (record.state === 'started') {
                    current = Object.freeze({
                        ...record,
                        processed: current?.runId === record.runId ? current.processed : new Map(),
                    });
                }
                if (record.state === 'progress' && record.remoteAssetId && record.outcome) {
                    if (current?.runId === record.runId) {
                        const processed = new Map(current.processed);
                        processed.set(record.remoteAssetId, record);
                        current = Object.freeze({ ...current, processed });
                    }
                }
                if (record.state === 'completed' && current?.runId === record.runId)
                    current = undefined;
            }
            return current;
        });
    }
    latestInventoryScan(inventoryKey) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return this.latestInventorySnapshotUnderLock(inventoryKey);
        });
    }
    get(assetId) {
        return this.withFreshRead((index) => index.get(assetId) ?? null);
    }
    getForRunKey(runKey, assetId) {
        return this.withFreshRead(() => this.runKeyIndex.get(runKey)?.get(assetId) ?? null);
    }
    list() {
        return this.withFreshRead((index) => [...index.values()]);
    }
    listForRunKey(runKey) {
        return this.withFreshRead(() => [...(this.runKeyIndex.get(runKey)?.values() ?? [])]);
    }
    listForInventoryKey(inventoryKey) {
        return this.withFreshRead(() => [...(this.inventoryKeyIndex.get(inventoryKey)?.values() ?? [])]);
    }
    rebuildIndex(state) {
        const next = new Map();
        const nextRunKeyIndex = new Map();
        const nextInventoryKeyIndex = new Map();
        const raw = state === 'missing' ? null : readUtf8Regular(this.path);
        if (raw !== null) {
            const parsed = parseSidecarJsonl(raw, parseAssetSyncRecord);
            for (const parsedRecord of parsed.records) {
                const record = immutableRecord(parsedRecord);
                next.set(record.assetId, record);
                if (record.runKey) {
                    const scoped = nextRunKeyIndex.get(record.runKey) ?? new Map();
                    scoped.set(record.assetId, record);
                    nextRunKeyIndex.set(record.runKey, scoped);
                }
                if (record.inventoryKey) {
                    const scoped = nextInventoryKeyIndex.get(record.inventoryKey) ?? new Map();
                    scoped.set(record.assetId, record);
                    nextInventoryKeyIndex.set(record.inventoryKey, scoped);
                }
            }
        }
        this.index.clear();
        for (const [assetId, record] of next)
            this.index.set(assetId, record);
        this.runKeyIndex.clear();
        for (const [runKey, records] of nextRunKeyIndex)
            this.runKeyIndex.set(runKey, records);
        this.inventoryKeyIndex.clear();
        for (const [inventoryKey, records] of nextInventoryKeyIndex)
            this.inventoryKeyIndex.set(inventoryKey, records);
        this.fileState = state;
        this.loaded = true;
    }
    refreshUnderLock() {
        const state = regularFileFingerprint(this.path);
        if (!this.loaded || state !== this.fileState)
            this.rebuildIndex(state);
    }
    withFreshRead(read) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return read(this.index);
        });
    }
    readRunRecordsUnderLock() {
        const raw = readUtf8Regular(this.path);
        if (raw === null)
            return [];
        const records = [];
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                const record = parseAssetSyncRunRecord(JSON.parse(line));
                if (record)
                    records.push(record);
            }
            catch {
                // Corrupt sidecar lines cannot make all resumable work unreadable.
            }
        }
        return records;
    }
    latestInventorySnapshotUnderLock(inventoryKey) {
        const raw = readUtf8Regular(this.path);
        return raw === null ? undefined : inventorySnapshotFromRaw(raw, inventoryKey);
    }
}
function inventorySnapshotFromRaw(raw, inventoryKey) {
    let current;
    let pendingBatch = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const record = parseInventoryLine(line);
        if (!record || record.inventoryKey !== inventoryKey)
            continue;
        if (record.batchId) {
            if (record.batchIndex === 0) {
                pendingBatch = [record];
            }
            else if (continuesPendingBatch(pendingBatch, record)) {
                pendingBatch.push(record);
            }
            else {
                pendingBatch = [];
            }
            if (pendingBatch.length === record.batchSize) {
                const batch = pendingBatch;
                pendingBatch = [];
                if (!canAppendInventoryBatch(current, batch)) {
                    if (current?.scanId === record.scanId)
                        current = undefined;
                    continue;
                }
                current = snapshotFromInventoryBatch(current, batch);
            }
            continue;
        }
        pendingBatch = [];
        if (record.index === 0) {
            current = snapshotFromFirstSegment(record);
            continue;
        }
        if (!current || !canAppendInventorySegment(current, record)) {
            if (current?.scanId === record.scanId)
                current = undefined;
            continue;
        }
        current = appendSegmentToSnapshot(current, record);
    }
    return current;
}
function immutableRecord(record) {
    return Object.freeze({ ...record });
}
function createInventoryBatchRecords(rec) {
    if (!Array.isArray(rec.items) || !Number.isInteger(rec.anonymousBlocked) || rec.anonymousBlocked < 0)
        return null;
    const syncedAt = rec.syncedAt ?? new Date().toISOString();
    const common = parseAssetSyncInventorySegmentRecord({
        recordType: 'inventory_scan',
        ...rec,
        items: [],
        anonymousBlocked: 0,
        syncedAt,
    });
    const totalItems = rec.items.length + rec.anonymousBlocked;
    const remoteAssetIds = new Set();
    for (const item of rec.items) {
        if (!item || typeof item.remoteAssetId !== 'string' || remoteAssetIds.has(item.remoteAssetId))
            return null;
        remoteAssetIds.add(item.remoteAssetId);
    }
    if (!common
        || totalItems > ASSET_SYNC_INVENTORY_MAX_UNIQUE_ITEMS)
        return null;
    if (splitInventoryUnits(rec.items, rec.anonymousBlocked).length === 1) {
        const singleton = parseAssetSyncInventorySegmentRecord({
            ...common,
            items: rec.items,
            anonymousBlocked: rec.anonymousBlocked,
        });
        if (singleton)
            return Object.freeze([singleton]);
    }
    const batchId = randomUUID();
    const initialChunks = splitInventoryUnits(rec.items, rec.anonymousBlocked);
    const chunks = [];
    for (const chunk of initialChunks) {
        const remainingSegments = ASSET_SYNC_INVENTORY_MAX_SEGMENTS - rec.index - chunks.length;
        const fitted = splitInventoryChunkToFit(common, chunk, batchId, chunks.length, remainingSegments);
        if (!fitted)
            return null;
        chunks.push(...fitted);
    }
    if (chunks.length === 0
        || chunks.length > ASSET_SYNC_INVENTORY_MAX_SEGMENTS
        || rec.index + chunks.length > ASSET_SYNC_INVENTORY_MAX_SEGMENTS)
        return null;
    const records = [];
    for (const [batchIndex, chunk] of chunks.entries()) {
        const parsed = parseAssetSyncInventorySegmentRecord({
            ...common,
            index: rec.index + batchIndex,
            items: chunk.items,
            anonymousBlocked: chunk.anonymousBlocked,
            ...(chunks.length > 1 ? { batchId, batchIndex, batchSize: chunks.length } : {}),
        });
        if (!parsed)
            return null;
        records.push(parsed);
    }
    return Object.freeze(records);
}
function splitInventoryUnits(items, anonymousBlocked) {
    if (items.length === 0 && anonymousBlocked === 0)
        return [{ items: [], anonymousBlocked: 0 }];
    const chunks = [];
    let itemOffset = 0;
    let anonymousRemaining = anonymousBlocked;
    while (itemOffset < items.length || anonymousRemaining > 0) {
        const itemCount = Math.min(ASSET_SYNC_INVENTORY_MAX_ITEMS_PER_SEGMENT, items.length - itemOffset);
        const anonymousCount = Math.min(ASSET_SYNC_INVENTORY_MAX_ITEMS_PER_SEGMENT - itemCount, anonymousRemaining);
        chunks.push({
            items: items.slice(itemOffset, itemOffset + itemCount),
            anonymousBlocked: anonymousCount,
        });
        itemOffset += itemCount;
        anonymousRemaining -= anonymousCount;
    }
    return chunks;
}
function splitInventoryChunkToFit(common, chunk, batchId, batchIndex, remainingSegments) {
    if (remainingSegments < 1)
        return null;
    const parsed = parseAssetSyncInventorySegmentRecord({
        ...common,
        index: common.index + batchIndex,
        items: chunk.items,
        anonymousBlocked: chunk.anonymousBlocked,
    });
    const batchProbe = parsed ? {
        ...parsed,
        batchId,
        batchIndex,
        batchSize: ASSET_SYNC_INVENTORY_MAX_SEGMENTS,
    } : null;
    if (batchProbe
        && Buffer.byteLength(JSON.stringify(batchProbe), 'utf8') <= ASSET_SYNC_INVENTORY_MAX_SEGMENT_BYTES)
        return [chunk];
    const units = chunk.items.length + chunk.anonymousBlocked;
    if (units <= 1)
        return null;
    const leftUnits = Math.floor(units / 2);
    const leftItemCount = Math.min(leftUnits, chunk.items.length);
    const left = {
        items: chunk.items.slice(0, leftItemCount),
        anonymousBlocked: leftUnits - leftItemCount,
    };
    const right = {
        items: chunk.items.slice(leftItemCount),
        anonymousBlocked: chunk.anonymousBlocked - left.anonymousBlocked,
    };
    const fittedLeft = splitInventoryChunkToFit(common, left, batchId, batchIndex, remainingSegments);
    if (!fittedLeft)
        return null;
    const fittedRight = splitInventoryChunkToFit(common, right, batchId, batchIndex + fittedLeft.length, remainingSegments - fittedLeft.length);
    return fittedLeft && fittedRight ? [...fittedLeft, ...fittedRight] : null;
}
function continuesPendingBatch(pending, record) {
    const first = pending[0];
    return Boolean(first?.batchId
        && record.batchId === first.batchId
        && record.batchSize === first.batchSize
        && record.batchIndex === pending.length
        && record.index === first.index + pending.length
        && record.scanId === first.scanId
        && record.inventoryKey === first.inventoryKey
        && record.scope === first.scope
        && record.syncedAt === first.syncedAt
        && record.cursorHeld === first.cursorHeld
        && cursorFingerprintsEqual(record.inputCursorFingerprints, first.inputCursorFingerprints)
        && cursorFingerprintsEqual(record.nextCursorFingerprints, first.nextCursorFingerprints));
}
function canAppendInventoryBatch(current, records) {
    const first = records[0];
    if (!first)
        return false;
    if (records.length === 1)
        return !first.batchId && canAppendInventorySegment(current, first);
    if (first.batchIndex !== 0
        || first.batchSize !== records.length
        || !records.every((record, index) => index === 0 || continuesPendingBatch(records.slice(0, index), record))
        || (first.cursorHeld === true && !inventoryBatchHasRetryableOutcome(records)))
        return false;
    if (first.index === 0) {
        if (!cursorFingerprintsEqual(first.inputCursorFingerprints, { purchased: null, published: null }))
            return false;
    }
    else if (!current
        || current.complete
        || current.retryIndex !== undefined
        || current.scanId !== first.scanId
        || current.inventoryKey !== first.inventoryKey
        || current.scope !== first.scope
        || current.segmentCount !== first.index
        || !cursorFingerprintsEqual(current.nextCursorFingerprints, first.inputCursorFingerprints)) {
        return false;
    }
    if ((current?.segmentCount ?? 0) + records.length > ASSET_SYNC_INVENTORY_MAX_SEGMENTS)
        return false;
    const outcomes = new Set(current?.outcomes.keys() ?? []);
    let anonymousBlocked = current?.anonymousBlocked ?? 0;
    for (const record of records) {
        for (const item of record.items)
            outcomes.add(item.remoteAssetId);
        anonymousBlocked += record.anonymousBlocked;
    }
    return outcomes.size + anonymousBlocked <= ASSET_SYNC_INVENTORY_MAX_UNIQUE_ITEMS;
}
function snapshotFromInventoryBatch(current, records) {
    const first = records[0];
    if (!first)
        throw new Error('inventory batch is empty');
    const outcomes = new Map(current?.outcomes ?? []);
    let anonymousBlocked = current?.anonymousBlocked ?? 0;
    for (const record of records) {
        for (const item of record.items) {
            if (!outcomes.has(item.remoteAssetId))
                outcomes.set(item.remoteAssetId, item.outcome);
        }
        anonymousBlocked += record.anonymousBlocked;
    }
    const retryIndex = inventoryBatchRetryIndex(first);
    return immutableInventorySnapshot({
        scanId: first.scanId,
        inventoryKey: first.inventoryKey,
        scope: first.scope,
        segmentCount: (current?.segmentCount ?? 0) + records.length,
        nextCursorFingerprints: first.nextCursorFingerprints,
        outcomes,
        anonymousBlocked,
        complete: retryIndex === undefined && inventoryScanComplete(first.scope, first.nextCursorFingerprints),
        ...(retryIndex === undefined ? {} : { retryIndex }),
    });
}
function canAppendInventorySegment(current, record) {
    if (record.cursorHeld === true && !inventoryBatchHasRetryableOutcome([record]))
        return false;
    if (record.index === 0) {
        return cursorFingerprintsEqual(record.inputCursorFingerprints, { purchased: null, published: null });
    }
    if (!current
        || current.complete
        || current.retryIndex !== undefined
        || current.scanId !== record.scanId
        || current.inventoryKey !== record.inventoryKey
        || current.scope !== record.scope
        || current.segmentCount !== record.index
        || !cursorFingerprintsEqual(current.nextCursorFingerprints, record.inputCursorFingerprints)
        || current.segmentCount >= ASSET_SYNC_INVENTORY_MAX_SEGMENTS) {
        return false;
    }
    const newUniqueItems = record.items.reduce((count, item) => count + (current.outcomes.has(item.remoteAssetId) ? 0 : 1), 0);
    return current.outcomes.size + current.anonymousBlocked + newUniqueItems + record.anonymousBlocked
        <= ASSET_SYNC_INVENTORY_MAX_UNIQUE_ITEMS;
}
function snapshotFromFirstSegment(record) {
    if (record.items.length + record.anonymousBlocked > ASSET_SYNC_INVENTORY_MAX_UNIQUE_ITEMS)
        return undefined;
    if (record.cursorHeld === true && !inventoryBatchHasRetryableOutcome([record]))
        return undefined;
    const retryIndex = inventoryBatchRetryIndex(record);
    return immutableInventorySnapshot({
        scanId: record.scanId,
        inventoryKey: record.inventoryKey,
        scope: record.scope,
        segmentCount: 1,
        nextCursorFingerprints: record.nextCursorFingerprints,
        outcomes: new Map(record.items.map((item) => [item.remoteAssetId, item.outcome])),
        anonymousBlocked: record.anonymousBlocked,
        complete: retryIndex === undefined && inventoryScanComplete(record.scope, record.nextCursorFingerprints),
        ...(retryIndex === undefined ? {} : { retryIndex }),
    });
}
function appendSegmentToSnapshot(current, record) {
    const outcomes = new Map(current.outcomes);
    for (const item of record.items) {
        if (!outcomes.has(item.remoteAssetId))
            outcomes.set(item.remoteAssetId, item.outcome);
    }
    const retryIndex = inventoryBatchRetryIndex(record);
    return immutableInventorySnapshot({
        ...current,
        segmentCount: current.segmentCount + 1,
        nextCursorFingerprints: record.nextCursorFingerprints,
        outcomes,
        anonymousBlocked: current.anonymousBlocked + record.anonymousBlocked,
        complete: retryIndex === undefined && inventoryScanComplete(record.scope, record.nextCursorFingerprints),
        retryIndex,
    });
}
function inventoryBatchRetryIndex(first) {
    return first.cursorHeld === true ? first.index : undefined;
}
function inventoryBatchHasRetryableOutcome(records) {
    return records.some((record) => record.items.some((item) => (item.outcome === 'failed' || item.outcome === 'pending')));
}
function findInventoryRetryTail(raw, snapshot) {
    if (snapshot.retryIndex === undefined)
        return undefined;
    const lines = raw.split('\n');
    let found;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const first = parseInventoryLine(lines[lineIndex]);
        if (!first
            || first.inventoryKey !== snapshot.inventoryKey
            || first.scanId !== snapshot.scanId
            || first.index !== snapshot.retryIndex
            || first.batchIndex !== undefined && first.batchIndex !== 0)
            continue;
        const records = [first];
        const lineIndexes = new Set([lineIndex]);
        if (first.batchSize !== undefined) {
            for (let offset = 1; offset < first.batchSize; offset += 1) {
                const next = parseInventoryLine(lines[lineIndex + offset]);
                if (!next || !continuesPendingBatch(records, next))
                    break;
                records.push(next);
                lineIndexes.add(lineIndex + offset);
            }
            if (records.length !== first.batchSize)
                continue;
        }
        if (records.length !== snapshot.segmentCount - snapshot.retryIndex
            || inventoryBatchRetryIndex(first) !== snapshot.retryIndex)
            continue;
        found = { records: Object.freeze(records), lineIndexes };
    }
    return found;
}
function parseInventoryLine(line) {
    if (!line?.trim())
        return null;
    try {
        return parseAssetSyncInventorySegmentRecord(JSON.parse(line));
    }
    catch {
        return null;
    }
}
function mergeInventoryRetryItems(previousRecords, retriedItems) {
    const retriedById = new Map();
    for (const item of retriedItems) {
        if (retriedById.has(item.remoteAssetId))
            return null;
        retriedById.set(item.remoteAssetId, item);
    }
    const previousIds = new Set();
    const merged = [];
    for (const record of previousRecords) {
        for (const item of record.items) {
            previousIds.add(item.remoteAssetId);
            const retried = retriedById.get(item.remoteAssetId);
            merged.push(retried ? {
                remoteAssetId: item.remoteAssetId,
                outcome: mergeInventoryRetryOutcome(item.outcome, retried.outcome),
            } : item);
        }
    }
    for (const item of retriedItems) {
        if (!previousIds.has(item.remoteAssetId))
            merged.push(item);
    }
    return merged;
}
function mergeInventoryRetryOutcome(previous, retried) {
    if (previous !== 'failed' && previous !== 'pending')
        return previous;
    if (retried === 'imported' || retried === 'already_local' || retried === 'blocked')
        return retried;
    if (previous === 'failed' && retried === 'pending')
        return previous;
    return retried;
}
function removeInventoryRetryTail(raw, removedLineIndexes) {
    return raw.split('\n')
        .filter((line, index) => line.trim() && !removedLineIndexes.has(index))
        .map((line) => `${line}\n`)
        .join('');
}
function immutableInventorySnapshot(snapshot) {
    return Object.freeze({
        ...snapshot,
        nextCursorFingerprints: Object.freeze({ ...snapshot.nextCursorFingerprints }),
        outcomes: new Map(snapshot.outcomes),
    });
}
function inventoryScanComplete(scope, cursors) {
    if (scope === 'purchased')
        return cursors.purchased === null;
    if (scope === 'published')
        return cursors.published === null;
    return cursors.purchased === null && cursors.published === null;
}
function cursorFingerprintsEqual(left, right) {
    return left.purchased === right.purchased && left.published === right.published;
}
function removeInventoryScan(raw, inventoryKey) {
    return raw.split('\n').filter((line) => {
        if (!line.trim())
            return false;
        try {
            const record = JSON.parse(line);
            return record['recordType'] !== 'inventory_scan' || record['inventoryKey'] !== inventoryKey;
        }
        catch {
            return true;
        }
    }).map((line) => `${line}\n`).join('');
}
function inventoryScanBytes(raw) {
    let bytes = 0;
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const record = JSON.parse(line);
            if (record['recordType'] === 'inventory_scan')
                bytes += Buffer.byteLength(`${line}\n`, 'utf8');
        }
        catch {
            // Unknown corrupt rows are preserved but cannot grow through this API.
        }
    }
    return bytes;
}