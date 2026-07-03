import type { Watermark } from '../schema/material.js';
export declare function fileWatermark(path: string, hashBytes?: number): Watermark;
export interface ScanResult {
    changed: boolean;
    newBytes: {
        start: number;
        end: number;
    } | null;
    watermark: Watermark;
}
/** 增量去重 (批注#15/#16): 快路径 (mtime,size,hash); 前缀完好+size 增→append 增量; 否则全量(rewrite/rename/truncate). */
export declare function scanFile(path: string, prev: Watermark | undefined, hashBytes?: number): ScanResult;
export declare function readRange(path: string, start: number, end: number): string;
/** watermark 游标持久化. */
export declare class WatermarkStore {
    private readonly path;
    private readonly map;
    constructor(path: string);
    get(filePath: string): Watermark | undefined;
    set(filePath: string, wm: Watermark): void;
}