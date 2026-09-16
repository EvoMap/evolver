import type { ReferenceNativeSnapshot } from './referenceNativeSnapshot.js';
interface PosixFileState {
    kind: 'file' | 'directory' | 'other';
    dev: bigint;
    ino: bigint;
    size: bigint;
    nlink: bigint;
    mtime: bigint;
    ctime: bigint;
}
export interface PosixReferenceApi {
    openRoot(flags: number): number;
    openAt(parent: number, name: string, flags: number): number;
    state(fd: number): PosixFileState;
    read(fd: number, buffer: Buffer, offset: number, length: number): number;
    close(fd: number): void;
}
export interface PosixReferenceRoot {
    read(segments: readonly string[], maxBytes: number, expected?: ReferenceNativeSnapshot): Uint8Array;
    close(): void;
}
export declare class PosixReferenceError extends Error {
    readonly code: string;
    readonly operationCode?: string | undefined;
    constructor(code: string, operationCode?: string | undefined);
}
export declare function createPosixReferenceApi(platform: 'linux' | 'darwin'): PosixReferenceApi;
/** 从稳定directory descriptor逐组件openat；从不把校验后的字符串重新作为绝对路径打开。 */
export declare function openPosixReferenceRoot(rootPath: string, platform: 'linux' | 'darwin', injected?: PosixReferenceApi): PosixReferenceRoot;
export {};