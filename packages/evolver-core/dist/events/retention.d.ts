export type RetentionState = 'ok' | 'watch' | 'over_limit';
export declare const RETENTION_DEFAULT_MAX_ROOT_EVENTS = 100000;
export declare const RETENTION_DEFAULT_MAX_ROOT_BYTES: number;
export declare const RETENTION_DEFAULT_MAX_MATERIAL_RECORDS = 10000;
export declare const RETENTION_DEFAULT_MAX_MATERIAL_BYTES: number;
export declare const RETENTION_DEFAULT_WATCH_RATIO = 0.8;
export declare const RETENTION_DEFAULT_ROOT_TAIL_EVENTS: number;
export interface RetentionThresholds {
    maxRecords: number;
    maxBytes: number;
    watchRatio: number;
}
export interface RootRetentionSnapshot {
    name: 'root_events';
    exists: boolean;
    bytes: number;
    records: number;
    invalidLines: number;
    state: RetentionState;
    thresholds: RetentionThresholds;
    firstSeq: number | null;
    lastSeq: number | null;
    firstTs: string | null;
    lastTs: string | null;
    protectTailEvents: number;
    destructivePruneSafe: false;
    reason: string;
}
export interface MaterialRetentionSnapshot {
    name: 'material';
    exists: boolean;
    bytes: number;
    records: number;
    invalidLines: number;
    state: RetentionState;
    thresholds: RetentionThresholds;
    firstCapturedAt: string | null;
    lastCapturedAt: string | null;
    cursorValid: boolean;
    cursorInRange: boolean;
    cursor: number;
    effectiveCursor: number;
    consumedPrefix: number;
    pending: number;
    destructivePruneSafe: false;
    reason: string;
}
export interface RetentionReport {
    generatedAt: string;
    mode: 'read_only_policy';
    destructivePruneSupported: false;
    rootEvents: RootRetentionSnapshot;
    material: MaterialRetentionSnapshot;
    warnings: string[];
    nextActions: string[];
}
export interface RetentionReportOptions {
    rootEventsPath?: string;
    materialStorePath?: string;
    materialCursorPath?: string;
    now?: () => number;
    maxRootEvents?: number;
    maxRootBytes?: number;
    maxMaterialRecords?: number;
    maxMaterialBytes?: number;
    watchRatio?: number;
    protectRootTailEvents?: number;
}
export declare function defaultMaterialCursorPath(path?: string): string;
export declare function buildRetentionReport(opts?: RetentionReportOptions): RetentionReport;