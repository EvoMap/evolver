import { createWindowsReferenceApi } from '../benchmark/referenceNativeWindows.js';
import { type AuditBudget, type AuditFileHandle } from './boundedAudit.js';
export { WindowsAuditNameBusyError } from './boundedAudit.js';
type Handle = bigint;
type FileInfo = ReturnType<ReturnType<typeof createWindowsReferenceApi>['info']>;
type OpenMode = 'directory' | 'directory-read' | 'read' | 'append' | 'existing' | 'create' | 'delete';
/** Private test seam, not a barrel export. Fixed file operations only; never a DLL/symbol/FFI capability. */
export interface WindowsAuditApi {
    root(drive: string): Promise<Handle>;
    child(parent: Handle, name: string, mode: OpenMode): Promise<Handle>;
    info(handle: Handle): FileInfo;
    finalPath(handle: Handle): string;
    fileType(handle: Handle): number;
    read(handle: Handle, buffer: Buffer, position: number): Promise<number>;
    append(handle: Handle, buffer: Buffer): Promise<number>;
    truncate(handle: Handle, size: number): Promise<void>;
    sync(handle: Handle): Promise<void>;
    publish(handle: Handle, parent: Handle, name: string): Promise<void>;
    remove(handle: Handle): Promise<void>;
    close(handle: Handle): Promise<void>;
}
/** Uses the already packaged Koffi 3.2.1. Read-only reference capabilities stay read-only. */
export declare function createWindowsAuditApi(): WindowsAuditApi;
/** Separate, strictly read-only capability for source snapshots. Not a barrel export.
 * No mkdir, write, lock or mutation method is reachable through this interface.
 * Metadata is the existing fixed, bounded HANDLE metadata implementation; bulk reads
 * and opens/closes use the audit backend's asynchronous Koffi worker-pool calls.
 */
export interface WindowsSnapshotApi extends Pick<WindowsAuditApi, 'root' | 'info' | 'finalPath' | 'fileType' | 'read' | 'close'> {
    child(parent: Handle, name: string, directory: boolean): Promise<Handle>;
}
export declare function createWindowsSnapshotApi(): WindowsSnapshotApi;
export interface WindowsAuditSnapshot {
    info: FileInfo;
    text: string;
}
/** Private directory capability. All operations resolve one validated name relative to its pinned parent. */
export interface WindowsAuditDirectory {
    open(name: string, maxBytes: number, budget: AuditBudget, existingOnly?: boolean): Promise<AuditFileHandle>;
    snapshot(name: string, budget?: AuditBudget): Promise<WindowsAuditSnapshot | undefined>;
    exists(name: string): Promise<boolean>;
    publish(name: string, owner: string, budget: AuditBudget, published: () => void): Promise<boolean>;
    remove(name: string, expected: WindowsAuditSnapshot): Promise<void>;
    /** Retry only acquisitions whose native close failed, keeping live parents usable. */
    retryReleasedHandles(): Promise<void>;
    close(): Promise<void>;
}
export declare function openWindowsAuditDirectory(path: string, budget: AuditBudget, injected?: WindowsAuditApi, existingOnly?: boolean): Promise<WindowsAuditDirectory>;
export declare function openWindowsAuditFile(path: string, maxBytes: number, budget: AuditBudget, injected?: WindowsAuditApi, existingOnly?: boolean): Promise<AuditFileHandle>;
/** The v2 process-start/PID/token and .lock/.mutation/.guardian protocol; legacy live PIDs stay conservative. */
export declare function withWindowsAuditLock<T>(path: string, budget: AuditBudget, run: () => Promise<T>, injected?: WindowsAuditApi): Promise<T>;