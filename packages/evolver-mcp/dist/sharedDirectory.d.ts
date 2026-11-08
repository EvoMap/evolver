export type DirectoryOperation = 'open' | 'link' | 'rename' | 'unlink' | 'sync';
/** The operation completed on the pinned inode, but its pathname is no longer trusted.
 * This is not a durable-success receipt; callers must retain evidence rather than blindly retry. */
export declare class SharedDirectoryPostconditionError extends Error {
    readonly operation: DirectoryOperation;
    readonly code = "SHARED_DIRECTORY_POSTCONDITION";
    readonly operationCompleted = true;
    readonly retryable = false;
    constructor(operation: DirectoryOperation, cause: unknown);
}
declare let operationHookForTest: ((operation: DirectoryOperation, directory: string) => void) | undefined;
export declare function _setSharedDirectoryOperationHookForTest(hook?: typeof operationHookForTest): void;
export interface SharedDirectory {
    path: string;
    missing: boolean;
    assertCurrent(): void;
    open(path: string, flags: number, mode?: number): number;
    link(from: string, to: string): void;
    rename(from: string, to: string): void;
    unlink(path: string): void;
    sync(): void;
    close(): void;
}
/** Pin directory components before using a leaf. POSIX writes use *at calls; Windows handles deny parent
 * deletion/rename for the whole operation. O_NOFOLLOW on the leaf alone is not a parent fence. */
export declare function pinSharedDirectory(path: string): SharedDirectory;
export {};