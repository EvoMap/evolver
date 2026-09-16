import type { ReferenceNativeSnapshot } from './referenceNativeSnapshot.js';
type Handle = bigint;
interface FileInfo {
    attributes: number;
    volume: number;
    index: bigint;
    size: bigint;
    links: number;
    creation: bigint;
    write: bigint;
    change: bigint;
}
/** 私有backend测试接缝：只有固定Windows文件操作，不暴露任意DLL或FFI调用。 */
export interface WindowsReferenceApi {
    open(path: string, directory: boolean): Handle | null;
    openChild(parent: Handle, name: string, directory: boolean): Handle | null;
    info(handle: Handle): FileInfo;
    finalPath(handle: Handle): string;
    fileType(handle: Handle): number;
    read(handle: Handle, output: Uint8Array): number;
    close(handle: Handle): void;
}
export interface WindowsReferenceRoot {
    read(relativeSegments: readonly string[], maxBytes: number, expected?: ReferenceNativeSnapshot): Uint8Array;
    close(): void;
}
export declare class WindowsReferenceError extends Error {
    readonly code: string;
    readonly operationCode?: string | undefined;
    readonly retryCleanup?: (() => void) | undefined;
    readonly cleanupFailed: boolean;
    constructor(code: string, operationCode?: string | undefined, retryCleanup?: (() => void) | undefined);
}
/** 私有模块的固定OS绑定factory，供native interleave测试包装真实调用；不从benchmark barrel导出。 */
export declare function createWindowsReferenceApi(): WindowsReferenceApi;
/** 先以真实handle固定授权root，再用NtCreateFile逐组件相对该handle打开；从不按子路径重开。 */
export declare function openWindowsReferenceRoot(rootPath: string, injectedApi?: WindowsReferenceApi): WindowsReferenceRoot;
export {};