import { dirname, join } from 'node:path';
import { appendUtf8Durable, assertAssetStoreDirectory, ensureAssetStoreDirectory, readUtf8Regular, regularFileFingerprint, withAssetStoreLock, } from './assetStoreStorage.js';
import { parseAssetSyncRecord, parseSidecarJsonl } from './assetSidecarRecords.js';
export class AssetSyncLedger {
    now;
    path;
    lockPath;
    index = new Map();
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
            this.fileState = regularFileFingerprint(this.path);
            return full;
        });
    }
    get(assetId) {
        return this.withFreshRead((index) => index.get(assetId) ?? null);
    }
    list() {
        return this.withFreshRead((index) => [...index.values()]);
    }
    rebuildIndex(state) {
        const next = new Map();
        const raw = state === 'missing' ? null : readUtf8Regular(this.path);
        if (raw !== null) {
            const parsed = parseSidecarJsonl(raw, parseAssetSyncRecord);
            for (const record of parsed.records)
                next.set(record.assetId, immutableRecord(record));
        }
        this.index.clear();
        for (const [assetId, record] of next)
            this.index.set(assetId, record);
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
}
function immutableRecord(record) {
    return Object.freeze({ ...record });
}