import { type RelatedCapsuleQuery, type RelatedCapsuleResult } from './relatedCapsules.js';
import { type GeneSnapshotQuery, type GeneReadSnapshot } from './boundedSnapshot.js';
import { type ReferenceScope } from '../reference/guard.js';
import { type AssetKind, type AssetRecord, type AssetStoreProvider, type ConditionalPutOptions, type ConditionalPutResult, type PutResult, type SearchQuery, type LocalProjectContextV1 } from './provider.js';
/** Signal names a record advertises, across the four key spellings the pool uses. */
export declare function signalsOf(a: AssetRecord): string[];
export declare class LocalJsonlProvider implements AssetStoreProvider {
    readonly baseDir: string;
    static isBuiltInPromptReader(value: unknown): value is LocalJsonlProvider;
    private readonly index;
    private readonly lockPath;
    private readonly bundleJournalPath;
    private fileState;
    private loaded;
    private readonly recentIndex;
    readonly referenceScope: ReferenceScope;
    constructor(baseDir: string);
    private captureFileState;
    private stateChanged;
    private rebuildIndex;
    private refreshUnderLock;
    private ensureFresh;
    private updateFileStateAfterWrite;
    /** 仅在新 identity 已成功追加后更新其 kind；Capsule/Event 不影响 Gene 近期窗口。 */
    private indexAppendedRecord;
    /** 在任何持久化副作用前捕获实际 JSON 表示，热索引只持有该独立表示。 */
    private prepareAppend;
    private appendPreparedRecord;
    private readPendingBundle;
    private recoverPendingBundleUnderLock;
    private hasPendingBundle;
    queryGeneSnapshot(query?: GeneSnapshotQuery): Promise<GeneReadSnapshot>;
    beginPromptGeneSnapshotV1(query: GeneSnapshotQuery): import("./provider.js").ContextReadOperationV1<GeneReadSnapshot>;
    beginPromptRelatedCapsulesV1(query: RelatedCapsuleQuery): import("./provider.js").ContextReadOperationV1<RelatedCapsuleResult>;
    beginPromptAssetGetV1(assetId: string, query: {
        deadlineAt: number;
        signal: AbortSignal;
    }): import("./provider.js").ContextReadOperationV1<AssetRecord | null>;
    beginPromptLogicalGeneLookupV1(id: string, query: {
        deadlineAt: number;
        signal: AbortSignal;
    }): import("./provider.js").ContextReadOperationV1<AssetRecord[]>;
    beginGeneScanV1(query?: GeneSnapshotQuery): import("./geneScanV1.js").GeneScanSessionV1;
    queryRelatedCapsules(query: RelatedCapsuleQuery): Promise<RelatedCapsuleResult>;
    put(asset: AssetRecord): Promise<PutResult>;
    putConditional(asset: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
    putBundle(assets: readonly AssetRecord[]): Promise<PutResult[]>;
    putBundleWithLocalContextV1(assets: readonly AssetRecord[], value: LocalProjectContextV1): Promise<PutResult[]>;
    readLocalContextsV1(capsuleAssetIds: readonly string[]): Promise<LocalProjectContextV1[]>;
    private putBundleRecords;
    /**
     * 迁移专用(M8-2): 以**冻结 asset_id** 原样写入, 不经 normalizeForPut 重算/校验.
     * 仅 v1→v2 导入用(硬化 A6 存量冻结); 普通写一律走 put(). record 必须自带 asset_id.
     */
    putFrozen(record: AssetRecord): Promise<PutResult>;
    putFrozenConditional(record: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    getMany(assetIds: readonly string[]): Promise<ReadonlyMap<string, AssetRecord>>;
    findByLogicalId(id: string, limit?: number, kind?: AssetKind): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    listRecent(kind: AssetKind, limit?: number): Promise<AssetRecord[]>;
    listAll(kind?: AssetKind): AssetRecord[];
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