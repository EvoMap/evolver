import { type AssetKind, type AssetRecord, type AssetStoreProvider, type PutResult, type SearchQuery } from './provider.js';
/**
 * 本地 jsonl 资产库(M3-2, 移植 v1 src/gep/assetStore.js 单写锁).
 * 每 kind 一文件(genes/capsules/events.jsonl); append-only; O_EXCL 文件锁防并发写撕裂;
 * 内存索引(asset_id→record)供 get/search; 文件指纹变化时在共享锁内重建索引，保证多个
 * CLI/daemon 进程之间可见; 写入也在锁内刷新后再按 asset_id 去重(内容寻址天然幂等).
 */
export declare class LocalJsonlProvider implements AssetStoreProvider {
    readonly baseDir: string;
    private readonly index;
    private readonly lockPath;
    private fileState;
    private loaded;
    constructor(baseDir: string);
    private captureFileState;
    private stateChanged;
    private rebuildIndex;
    private refreshUnderLock;
    private ensureFresh;
    private updateFileStateAfterWrite;
    put(asset: AssetRecord): Promise<PutResult>;
    /**
     * 迁移专用(M8-2): 以**冻结 asset_id** 原样写入, 不经 normalizeForPut 重算/校验.
     * 仅 v1→v2 导入用(硬化 A6 存量冻结); 普通写一律走 put(). record 必须自带 asset_id.
     */
    putFrozen(record: AssetRecord): Promise<PutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    search(q: SearchQuery): Promise<AssetRecord[]>;
    /**
     * Opt-in log compaction: rewrite each kind's jsonl keeping ONE line per asset_id (last wins),
     * dropping duplicate/corrupt lines that accumulate across processes/restarts/migration. Lossless
     * because the store is content-addressed (one record per asset_id is all there ever was). This does
     * NOT evict assets — every unique asset is knowledge that stays. Atomic per file (temp + rename) under
     * the write lock. Returns kept/removed line counts.
     */
    compact(): Promise<{
        kept: number;
        removed: number;
    }>;
}