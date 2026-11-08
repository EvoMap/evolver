import type { AssetKind, AssetRecord, AssetStoreProvider } from './provider.js';
export declare const MAX_RECENT_ASSETS = 1000;
export declare function assertRecentLimit(limit: number): void;
/** 输入必须已经按 asset_id 去重，且保留首次出现顺序；不根据可伪造的时间戳排序。 */
export declare function recentRecords(records: Iterable<AssetRecord>, kind: AssetKind, limit?: number): AssetRecord[];
/** 能力缺失时保留旧行为；能力错误时不能伪装成成功的旧语料。 */
export declare function listRecentAssets(store: AssetStoreProvider, kind: AssetKind, limit?: number, capturedReader?: AssetStoreProvider['listRecent']): Promise<AssetRecord[]>;
/** Recent capability and legacy fallback share detached, qualification-preserving data. */
export declare function captureRecentAssetResult(records: unknown, kind: AssetKind, limit: number): AssetRecord[];
/** provider 直接入口与组合消费者共享同一结果合同；不截断、排序或修改原记录。 */
export declare function assertRecentAssetResult(records: unknown, kind: AssetKind, limit: number): asserts records is AssetRecord[];