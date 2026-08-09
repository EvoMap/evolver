import { type RootEvent } from './eventSchema.js';
export declare const ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS = 10000;
export declare class InvalidRootEventLogError extends Error {
    readonly line: number;
    readonly code = "ROOT_EVENT_ARCHIVE_INVALID_LOG";
    constructor(line: number, reason: string);
}
export declare class ArchiveSegmentConflictError extends Error {
    readonly archiveId: string;
    readonly code = "ROOT_EVENT_ARCHIVE_SEGMENT_CONFLICT";
    constructor(archiveId: string);
}
export declare class InvalidRootEventArchiveError extends Error {
    readonly segment: string;
    readonly line: number;
    readonly code = "ROOT_EVENT_ARCHIVE_INVALID_ARCHIVE";
    constructor(segment: string, line: number);
}
export declare class RootEventHistoryGapError extends Error {
    readonly expectedSeq: number;
    readonly actualSeq: number;
    readonly code = "ROOT_EVENT_HISTORY_GAP";
    constructor(expectedSeq: number, actualSeq: number);
}
export interface RootEventArchiveOptions {
    path: string;
    keepEvents?: number;
}
export interface RootEventArchivePlan {
    mode: 'preview';
    activeRecords: number;
    keepEvents: number;
    wouldArchive: number;
    retainedRecords: number;
    firstSeq: number | null;
    lastSeq: number | null;
    archiveId: string | null;
}
export interface RootEventArchiveResult {
    mode: 'write';
    activeRecordsBefore: number;
    keepEvents: number;
    archivedRecords: number;
    retainedRecords: number;
    firstSeq: number | null;
    lastSeq: number | null;
    archiveId: string | null;
    reusedSegment: boolean;
}
export interface RootEventArchiveStats {
    exists: boolean;
    segments: number;
    bytes: number;
    records: number;
    invalidLines: number;
    firstSeq: number | null;
    lastSeq: number | null;
}
export declare function rootEventArchiveDir(path: string): string;
export declare function rootEventArchiveSegmentName(firstSeq: number, lastSeq: number): string;
export declare function planRootEventArchive(opts: RootEventArchiveOptions): RootEventArchivePlan;
export declare function archiveRootEvents(opts: RootEventArchiveOptions): RootEventArchiveResult;
export declare function readRootEventHistory(path: string, archiveDir?: string): RootEvent[];
/** Strict replay for control-plane decisions that must fail closed on partial or conflicting history. */
export declare function readRootEventHistoryStrict(path: string): RootEvent[];
export declare function validateRootEventHistory(path: string): void;
export declare function inspectRootEventArchive(path: string): RootEventArchiveStats;