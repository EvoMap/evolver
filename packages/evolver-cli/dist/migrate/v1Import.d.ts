import { assetstore } from '@evomap/evolver-core';
import { type V1Kind } from './fieldMap.js';
export interface ImportReport {
    imported: Record<V1Kind, number>;
    frozen: number;
    recomputed: number;
    deduped: number;
    sidecarExtensions: number;
    memoryGraphArchived: boolean;
    memoryGraphImported: number;
    memoryGraphDeferred: boolean;
    candidatesSkipped: boolean;
}
/**
 * v1→v2 只读迁移(M8-2). 只读 v1(无双写); 冻结存量 asset_id; 非 schema 字段(avoid)落 sidecar;
 * memory_graph 不强转(语义不符)→ 归档只读; candidates 候选池不属 wire 资产 → 跳过.
 */
export interface ImportV1Options {
    workspace?: string;
    userId?: string;
}
export declare function importV1(v1Dir: string, store: assetstore.LocalJsonlProvider, outDir: string, options?: ImportV1Options): Promise<ImportReport>;