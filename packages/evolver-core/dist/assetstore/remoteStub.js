import { normalizeForPut, } from './provider.js';
/**
 * 远程资产库参考实现(M3-1). 与 LocalJsonlProvider 同接口, 证明 wire protocol provider-无关.
 * 落库前同样走 normalizeForPut(asset_id 命门 + 强绑定校验在 core 侧, 不信任远端).
 */
export class RemoteStubProvider {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    async put(asset) {
        const { record, verified } = normalizeForPut(asset);
        const { stored } = await this.transport.putRemote(record);
        return { asset_id: record.asset_id, stored, verified };
    }
    get(assetId) { return this.transport.getRemote(assetId); }
    search(query) { return this.transport.searchRemote(query); }
    list(kind, limit = 1000) { return this.transport.listRemote(kind, limit); }
}
/** 内存传输桩(测试/本地演示用). */
export class InMemoryTransport {
    db = new Map();
    async putRemote(record) {
        if (this.db.has(record.asset_id))
            return { stored: false };
        this.db.set(record.asset_id, record);
        return { stored: true };
    }
    async getRemote(assetId) { return this.db.get(assetId) ?? null; }
    async searchRemote(q) {
        return [...this.db.values()].filter((r) => !q.kind || r.type === q.kind).slice(0, q.limit ?? 1000);
    }
    async listRemote(kind, limit) {
        return [...this.db.values()].filter((r) => !kind || r.type === kind).slice(0, limit);
    }
}