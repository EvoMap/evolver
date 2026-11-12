export type ContainedWriteResult = {
    ok: true;
} | {
    ok: false;
    reason: 'exists' | 'unsafe_path';
};
export declare function relativePathInsideRoot(root: string, requested: string): string | null;
export declare function writeFileInsideRoot(root: string, relPath: string, content: string, overwrite: boolean): ContainedWriteResult;