import { type AssetStoreProvider, type AssetRecord, type AssetKind, type PutResult, type SearchQuery } from '../assetstore/provider.js';
import type { ShadowSink, ShadowMode } from './sink.js';
/**
 * shadow 包 AssetStoreProvider(M8-1-shadow-d). shadow 下 put 只记录不真写,
 * 但维护本地镜像(+sink.markSeen)使 cycle 内 capsule_id→event 引用链(A4)可见、重复 put 返 stored:false(gotcha #2)。
 * get/search/list 合并真 store(只读) + shadow 镜像。enforce 直通真 store。
 */
export declare class ShadowAssetStore implements AssetStoreProvider {
    private readonly inner;
    private readonly sink;
    private readonly mode;
    private readonly mirror;
    constructor(inner: AssetStoreProvider, sink: ShadowSink, mode: ShadowMode);
    put(asset: AssetRecord): Promise<PutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    search(q: SearchQuery): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
}