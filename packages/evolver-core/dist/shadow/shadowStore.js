import { normalizeForPut } from '../assetstore/provider.js';
/**
 * shadow 包 AssetStoreProvider(M8-1-shadow-d). shadow 下 put 只记录不真写,
 * 但维护本地镜像(+sink.markSeen)使 cycle 内 capsule_id→event 引用链(A4)可见、重复 put 返 stored:false(gotcha #2)。
 * get/search/list 合并真 store(只读) + shadow 镜像。enforce 直通真 store。
 */
export class ShadowAssetStore {
    inner;
    sink;
    mode;
    mirror = new Map();
    constructor(inner, sink, mode) {
        this.inner = inner;
        this.sink = sink;
        this.mode = mode;
    }
    async put(asset) {
        if (this.mode === 'enforce')
            return this.inner.put(asset);
        const { record, verified } = normalizeForPut(asset);
        const already = this.sink.seen(record.asset_id) || this.mirror.has(record.asset_id);
        this.sink.record({ action: 'WOULD_STORE_PUT', assetId: record.asset_id, assetKind: record.type, payloadSize: JSON.stringify(record).length });
        if (!already) {
            this.sink.markSeen(record.asset_id);
            this.mirror.set(record.asset_id, record);
        }
        return { asset_id: record.asset_id, stored: !already, verified };
    }
    async get(assetId) {
        return this.mirror.get(assetId) ?? this.inner.get(assetId);
    }
    async search(q) {
        const real = await this.inner.search(q);
        if (this.mode === 'enforce' || this.mirror.size === 0)
            return real;
        const seen = new Set(real.map((r) => r.asset_id));
        const shadow = [...this.mirror.values()].filter((r) => !seen.has(r.asset_id) && matches(r, q));
        return [...real, ...shadow];
    }
    async list(kind, limit = 1000) {
        const real = await this.inner.list(kind, limit);
        if (this.mode === 'enforce' || this.mirror.size === 0)
            return real;
        const seen = new Set(real.map((r) => r.asset_id));
        const shadow = [...this.mirror.values()].filter((r) => !seen.has(r.asset_id) && (!kind || r.type === kind));
        return [...real, ...shadow].slice(0, limit);
    }
}
function matches(r, q) {
    if (q.kind && r.type !== q.kind)
        return false;
    if (q.gene && r.gene !== q.gene)
        return false;
    return true;
}