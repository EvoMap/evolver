import { type Material } from '../schema/material.js';
export declare const MATERIAL_ARCHIVE_DEFAULT_KEEP_RECORDS = 1000;
export declare class InvalidMaterialLogError extends Error {
    readonly line: number;
    readonly code = "MATERIAL_ARCHIVE_INVALID_LOG";
    constructor(line: number, reason: string);
}
export declare class InvalidMaterialArchiveError extends Error {
    readonly segment: string;
    readonly line: number;
    readonly code = "MATERIAL_ARCHIVE_INVALID_ARCHIVE";
    constructor(segment: string, line: number, reason: string);
}
export declare class MaterialArchiveRangeError extends Error {
    readonly code = "MATERIAL_ARCHIVE_RANGE_INVALID";
    constructor(reason: string);
}
export declare class MaterialArchiveSegmentConflictError extends Error {
    readonly archiveId: string;
    readonly code = "MATERIAL_ARCHIVE_SEGMENT_CONFLICT";
    constructor(archiveId: string);
}
export declare class InvalidMaterialArchiveCursorError extends Error {
    readonly code = "MATERIAL_ARCHIVE_CURSOR_INVALID";
    constructor(reason: string);
}
export interface MaterialArchiveOptions {
    path: string;
    cursorPaths?: readonly string[];
    keepRecords?: number;
}
export interface MaterialArchiveCursor {
    group: string;
    position: number;
}
export interface MaterialArchivePlan {
    mode: 'preview';
    activeRecords: number;
    physicalActiveRecords: number;
    archiveRecords: number;
    historyRecords: number;
    keepRecords: number;
    minCursor: number;
    cursors: MaterialArchiveCursor[];
    overlapRecords: number;
    wouldArchive: number;
    retainedRecords: number;
    archiveId: string | null;
}
export interface MaterialArchiveResult {
    mode: 'write';
    activeRecordsBefore: number;
    physicalActiveRecordsBefore: number;
    keepRecords: number;
    minCursor: number;
    cursors: MaterialArchiveCursor[];
    archivedRecords: number;
    retainedRecords: number;
    archiveRecords: number;
    historyRecords: number;
    recoveredOverlap: number;
    archiveId: string | null;
}
export interface MaterialArchiveStats {
    exists: boolean;
    segments: number;
    bytes: number;
    records: number;
    invalidLines: number;
    firstOffset: number | null;
    lastOffset: number | null;
}
export declare function materialArchiveDir(path: string): string;
export declare function materialArchiveSegmentName(start: number, end: number): string;
export declare function planMaterialArchive(opts: MaterialArchiveOptions): MaterialArchivePlan;
export declare function archiveMaterialStore(opts: MaterialArchiveOptions): MaterialArchiveResult;
/** Operational, fail-soft full history reader. Strict archive writes validate every line and range. */
export declare function readMaterialHistory(path: string): Material[];
/** Absolute-offset range reader used by durable consumers after active records move into archive segments. */
export declare function readMaterialRange(path: string, start: number, count: number): Material[];
export declare function inspectMaterialArchive(path: string): MaterialArchiveStats;