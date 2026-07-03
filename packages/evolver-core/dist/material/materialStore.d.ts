import { type Material } from '../schema/material.js';
export interface MaterialStoreOptions {
    path: string;
}
/** 原材料库 (append-only jsonl + single-writer + materialId 去重). */
export declare class MaterialStore {
    readonly path: string;
    private readonly lockPath;
    private readonly seen;
    private chain;
    constructor(opts: MaterialStoreOptions);
    /** 幂等 put: 已存在 materialId 跳过. */
    put(input: Material): Promise<{
        material: Material;
        stored: boolean;
    }>;
    private putLocked;
    get(materialId: string): Material | undefined;
    readAll(): Material[];
    iterate(opts?: {
        consumerGroup?: string;
        since?: string;
    }): Generator<Material>;
}