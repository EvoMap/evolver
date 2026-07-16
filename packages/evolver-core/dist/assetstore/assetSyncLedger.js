import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export class AssetSyncLedger {
    now;
    path;
    index = new Map();
    loaded = false;
    constructor(baseDir, now = Date.now) {
        this.now = now;
        this.path = join(baseDir, 'asset-sync.jsonl');
    }
    append(rec) {
        this.load();
        const full = {
            ...rec,
            syncedAt: rec.syncedAt ?? new Date(this.now()).toISOString(),
        };
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${JSON.stringify(full)}\n`);
        this.index.set(full.assetId, full);
        return full;
    }
    get(assetId) {
        this.load();
        return this.index.get(assetId) ?? null;
    }
    list() {
        this.load();
        return [...this.index.values()];
    }
    load() {
        if (this.loaded)
            return;
        if (existsSync(this.path)) {
            for (const line of readFileSync(this.path, 'utf8').split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const rec = parseRecord(JSON.parse(line));
                    if (rec)
                        this.index.set(rec.assetId, rec);
                }
                catch {
                    // Skip corrupt audit lines; the asset store remains the source of content truth.
                }
            }
        }
        this.loaded = true;
    }
}
function parseRecord(value) {
    const assetId = stringField(value, 'assetId');
    const type = stringField(value, 'type');
    const source = stringField(value, 'source');
    const scope = stringField(value, 'scope');
    const syncedAt = stringField(value, 'syncedAt');
    const remoteAssetId = stringField(value, 'remoteAssetId');
    if (!assetId ||
        (type !== 'Gene' && type !== 'Capsule') ||
        source !== 'hub' ||
        (scope !== 'purchased' && scope !== 'published') ||
        !syncedAt ||
        !remoteAssetId) {
        return null;
    }
    const logicalId = stringField(value, 'logicalId');
    const status = stringField(value, 'status');
    const forced = value['forced'] === true;
    const collisionWithAssetId = stringField(value, 'collisionWithAssetId');
    return {
        assetId,
        type,
        source,
        scope,
        syncedAt,
        remoteAssetId,
        ...(logicalId ? { logicalId } : {}),
        ...(status ? { status } : {}),
        ...(forced ? { forced: true } : {}),
        ...(collisionWithAssetId ? { collisionWithAssetId } : {}),
    };
}
function stringField(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}