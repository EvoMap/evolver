import { asyncFileLockOwned } from '../util/asyncFileLockOwners.js';
/** The audit path needs only these operations, not Node's entire FileHandle surface. */
export interface AuditFileStat {
    dev: number | bigint;
    ino: number | bigint;
    nlink: number;
    size: number;
    mtimeMs: number;
    isFile(): boolean;
}
export interface AuditFileHandle {
    stat(): Promise<AuditFileStat>;
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{
        bytesRead: number;
    }>;
    write(buffer: Buffer, offset: number, length: number, position: null): Promise<{
        bytesWritten: number;
    }>;
    truncate(size: number): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
/** A deadline bounds preparation/lock waits. Once submitted, an append is awaited (never detached or retried). */
export interface AuditWriteOptions {
    deadlineAt?: number;
    signal?: AbortSignal;
}
export declare class AuditWriteSkipped extends Error {
    readonly reason: string;
    constructor(reason: string);
}
export declare class WindowsAuditNameBusyError extends AuditWriteSkipped {
    readonly status: 0xc0000043 | 0xc0000056;
    readonly code = "EBUSY";
    constructor(status: 0xc0000043 | 0xc0000056);
}
/** Shared only by durable context preparation and its stdout admission callers. */
export declare const DEFAULT_CONTEXT_PREPARATION_BUDGET_MS = 750;
export declare class AuditBudget {
    private readonly options;
    private readonly deadline;
    constructor(options?: AuditWriteOptions, phase?: 'audit' | 'context_preparation' | 'experience');
    check(): void;
    pause(): Promise<void>;
}
export declare function regularAuditFile(stat: Pick<AuditFileStat, 'isFile' | 'nlink' | 'size'>, maxBytes: number): void;
/** Open first, validate the actual descriptor, and continue using that descriptor. No unsafe reopen by name. */
export declare function openAuditFile(path: string, maxBytes: number, budget: AuditBudget, existingOnly?: boolean): Promise<AuditFileHandle>;
/** One bounded write, no appendFile retry loop and no Promise.race leaving a late writer behind. */
export declare function commitAuditLine(handle: AuditFileHandle, line: string, maxFileBytes: number, budget: AuditBudget, rollbackShortWrite?: boolean, boundary?: {
    dispatched(): void;
    rolledBack(): void;
}): Promise<void>;
/** Synchronous writers must not wait on a same-loop async owner's cleanup. */
export declare const auditLockOwned: typeof asyncFileLockOwned;
/** Retain cleanup even when a best-effort caller discards its error/receipt. */
export declare function withAuditLock<T>(path: string, budget: AuditBudget, run: () => Promise<T>): Promise<T>;