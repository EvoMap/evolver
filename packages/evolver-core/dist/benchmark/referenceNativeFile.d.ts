import type { ReferenceNativeSnapshot } from './referenceNativeSnapshot.js';
export interface NativeReferenceReader {
    read(path: string, maxBytes: number, expected?: ReferenceNativeSnapshot): Uint8Array;
    close(): void;
}
export declare class NativeReferenceError extends Error {
    readonly code: string;
    readonly operationCode?: string | undefined;
    readonly retryCleanup?: (() => void) | undefined;
    constructor(code: string, operationCode?: string | undefined, retryCleanup?: (() => void) | undefined);
}
/** 受信任policy激活时固定root handles；读取请求只能在这些capability之下逐组件打开。 */
export declare function createNativeReferenceReader(roots: readonly string[]): NativeReferenceReader;