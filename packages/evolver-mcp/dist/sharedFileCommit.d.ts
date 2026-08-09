import { linkSync } from 'node:fs';
export interface SharedFileCommitOptions {
    path: string;
    expectedRaw: string | undefined;
    nextRaw: string | undefined;
    mode?: number;
    beforeCommitForTest?: () => void;
    afterValidateForTest?: () => void;
    afterDisplaceForTest?: (displacedPath: string) => void;
    beforePublishForTest?: () => void;
    linkForTest?: typeof linkSync;
}
export declare class SharedFileConflictError extends Error {
    readonly recoveryPath?: string | undefined;
    constructor(path: string, recoveryPath?: string | undefined, options?: {
        cause?: unknown;
    });
}
/** Commits only if the target bytes still match the caller's snapshot. */
export declare function commitSharedFile(options: SharedFileCommitOptions): void;