export interface SseUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
export interface SseScanResult {
    usage?: SseUsage;
    stop_reason?: string | null;
    response_id?: string;
    error?: string;
    content_text?: string;
    content_events?: unknown[];
    semantic_tail_events?: unknown[];
    raw_stream_body?: string;
    raw_stream_truncated?: boolean;
    content_truncated?: boolean;
    dropped_event_count?: number;
}
export interface StreamEndInfo {
    error?: string;
    cancelled?: boolean;
}
/** Partial-line buffer cap: a pathological stream with no newlines must not grow memory unbounded. OpenAI
 * Responses `response.completed` can put the full response onto one data line, so keep this generous. */
export declare const MAX_PARTIAL_LINE_BYTES: number;
export declare class SseUsageScanner {
    readonly result: SseScanResult;
    private buf;
    private overCapLine;
    private largeLineTail;
    private rawStreamChars;
    private readonly decoder;
    /** OPT-IN: when true, accumulate streamed completion text into result.content_text (bounded). Default false
     * keeps the scanner metadata-only. Driven by the body-capture flag (see bodyCapture.ts). */
    private readonly captureContent;
    private readonly limits;
    private readonly maxPartialLineBytes;
    constructor(opts?: {
        captureContent?: boolean;
        env?: NodeJS.ProcessEnv;
    });
    push(chunk: unknown): void;
    finish(): void;
    private captureRawStream;
    private pushText;
    private scanLargeLineText;
    private markDroppedDataLine;
    private scanLine;
}
/**
 * Wrap a stream so every chunk passes to `push` before reaching the consumer, with `onEnd` fired exactly once
 * on completion, error, or client cancel. Handles the two shapes _streamResponse relays (Web ReadableStream
 * and async iterables); anything opaque is returned untouched with an immediate onEnd (trace without usage).
 */
export declare function teeStreamForScan(stream: unknown, push: (chunk: unknown) => void, onEnd: (info?: StreamEndInfo) => void): unknown;