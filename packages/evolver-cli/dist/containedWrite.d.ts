export type ContainedWriteResult = {
    ok: true;
} | {
    ok: false;
    reason: 'exists' | 'unsafe_path';
};
export declare function relativePathInsideRoot(root: string, requested: string): string | null;
export declare function writeFileInsideRoot(root: string, relPath: string, content: string | Uint8Array, overwrite: boolean): ContainedWriteResult;
/** What `writeFileInsideRoot` would answer for this target, decided without creating or changing anything. */
export declare function checkWriteInsideRoot(root: string, relPath: string, overwrite: boolean): ContainedWriteResult;