import { linkSync } from 'node:fs';
import { type DirectoryOperation } from './sharedDirectory.js';
import { type InstallerSyncResult } from './installerSync.js';
export interface SharedFileIdentity {
    dev: string;
    ino: string;
    mtimeNs: string;
    size: string;
    mode: number;
    uid: string;
    gid: string;
    sha256: string;
}
export interface SharedFileSnapshot {
    raw: string | null;
    identity: SharedFileIdentity | null;
}
/** Never traverse a redirected parent, including parents above an adapter's safe root. */
export declare function assertSharedPathSafe(path: string): void;
export declare function readSharedFileSnapshot(path: string): SharedFileSnapshot;
export declare function sameSharedFileIdentity(left: SharedFileIdentity | null, right: SharedFileIdentity | null): boolean;
export declare function syncSharedDirectory(path: string): void;
export interface SharedFileCommitPaths {
    prepared?: string;
    displaced?: string;
    movedLive?: string;
}
export interface SharedFileCommitReceipt {
    prepared(): void;
    publishing(): void;
    published(publication: SharedFileSnapshot): void;
    displaced(snapshot: SharedFileSnapshot): void;
    finished(): void;
}
export type SharedFileCommitObserver = ((options: SharedFileCommitOptions, paths: SharedFileCommitPaths) => SharedFileCommitReceipt) & {
    publicationAttempted?: (path: string) => boolean | undefined;
};
export declare function withSharedFileCompensation<T>(run: () => InstallerSyncResult<T>): T;
export declare function sharedFileCompensationActive(): boolean;
export declare function sharedFilePublicationAttempted(path: string): boolean | undefined;
declare let phaseHookForTest: ((phase: 'intent' | 'prepared' | 'publishing' | 'moved' | 'published' | 'receipt' | 'finished', path: string) => void) | undefined;
export declare function _setSharedFileCommitPhaseHookForTest(hook?: typeof phaseHookForTest): void;
/** Installers are synchronous. Nested observers are refused instead of silently losing a transaction. */
export declare function withSharedFileCommitObserver<T>(observer: SharedFileCommitObserver, run: () => InstallerSyncResult<T>): T;
export declare function sharedFileTransactionActive(): boolean;
export interface SharedFileCommitOptions {
    path: string;
    expectedRaw: string | undefined;
    nextRaw: string | undefined;
    mode?: number;
    expectedIdentity?: SharedFileIdentity | null;
    retainOriginal?: boolean;
    beforeCommitForTest?: () => void;
    afterValidateForTest?: () => void;
    afterDisplaceForTest?: (displacedPath: string) => void;
    beforePublishForTest?: () => void;
    linkForTest?: typeof linkSync;
}
export declare class SharedFileConflictError extends Error {
    readonly recoveryPath?: string | undefined;
    get completedOperation(): DirectoryOperation | undefined;
    get retryable(): boolean;
    constructor(path: string, recoveryPath?: string | undefined, options?: {
        cause?: unknown;
    });
}
export interface SharedFileCommitOutcome {
    retainedOriginal?: string;
}
/** Commits only if the target bytes still match the caller's snapshot. */
export declare function commitSharedFile(options: SharedFileCommitOptions): SharedFileCommitOutcome;
export {};