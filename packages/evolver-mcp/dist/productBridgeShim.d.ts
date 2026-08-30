#!/usr/bin/env node
export declare const GRANT_SCHEMA = "evox.product_bridge.grant.v1";
export declare const MAX_STDIO_FRAME_BYTES: number;
export declare const MAX_IN_FLIGHT_REQUESTS = 32;
export declare const MAX_PENDING_STDIO_FRAMES = 64;
export declare const MAX_PENDING_STDIO_BYTES: number;
interface JsonRpcMessage {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}
export declare function grantFilePath(env?: NodeJS.ProcessEnv): string;
export declare function isLoopbackHttp(raw: string): boolean;
export declare function readGrant(filePath?: string): {
    url: string;
    grant: string;
};
/** 将请求、通知和客户端响应转发到回环 product bridge。 */
export declare function dispatch(req: JsonRpcMessage): Promise<Record<string, unknown> | null>;
export interface DecodedStdioChunk {
    readonly frames: string[];
    readonly oversizedFrames: number;
}
/** MCP stdio 使用换行分隔 JSON；解码器限制单帧大小，并排出当前缓冲区中的全部完整帧。 */
export declare class StdioLineDecoder {
    private pending;
    private discardingOversized;
    push(chunk: Buffer | string): DecodedStdioChunk;
    finish(): {
        incomplete: boolean;
    };
}
/** 对等待转发的完整帧同时施加数量和字节上限。 */
export declare class BoundedStdioFrameQueue {
    private readonly frames;
    private queuedBytes;
    get length(): number;
    get bytes(): number;
    enqueue(frame: string): boolean;
    shift(): string | undefined;
    isBelowResumeWatermark(): boolean;
}
export interface StdioBridgeOutput {
    write(message: string): boolean;
    on(event: 'drain', listener: () => void): unknown;
}
/** 启动可注入流和转发函数的 stdio bridge，便于验证背压与协议行为。 */
export declare function runStdioBridge(input?: NodeJS.ReadableStream, output?: StdioBridgeOutput, dispatchMessage?: typeof dispatch): void;
export {};