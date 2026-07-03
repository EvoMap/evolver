import { type AssetKind, type AssetRecord, type AssetStoreProvider, type PutResult, type SearchQuery } from './provider.js';
/** 远程后端传输(M6 换真 hub Capability; M3-1 用内存桩). */
export interface RemoteTransport {
    putRemote(record: AssetRecord): Promise<{
        stored: boolean;
    }>;
    getRemote(assetId: string): Promise<AssetRecord | null>;
    searchRemote(query: SearchQuery): Promise<AssetRecord[]>;
    listRemote(kind: AssetKind | undefined, limit: number): Promise<AssetRecord[]>;
}
/**
 * 远程资产库参考实现(M3-1). 与 LocalJsonlProvider 同接口, 证明 wire protocol provider-无关.
 * 落库前同样走 normalizeForPut(asset_id 命门 + 强绑定校验在 core 侧, 不信任远端).
 */
export declare class RemoteStubProvider implements AssetStoreProvider {
    private readonly transport;
    constructor(transport: RemoteTransport);
    put(asset: AssetRecord): Promise<PutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    search(query: SearchQuery): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
}
/** 内存传输桩(测试/本地演示用). */
export declare class InMemoryTransport implements RemoteTransport {
    private readonly db;
    putRemote(record: AssetRecord): Promise<{
        stored: boolean;
    }>;
    getRemote(assetId: string): Promise<AssetRecord | null>;
    searchRemote(q: SearchQuery): Promise<AssetRecord[]>;
    listRemote(kind: AssetKind | undefined, limit: number): Promise<AssetRecord[]>;
}