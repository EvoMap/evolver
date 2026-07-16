export interface NormalizedTurn {
    role: 'user' | 'assistant' | 'tool' | 'system';
    text: string;
    timestamp?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    toolName?: string;
    toolInput?: unknown;
    /** Anthropic content blocks carry the tool name on tool_use and reference it by id on tool_result;
     *  this id lets us correlate the two so a failing tool_result can be attributed to its tool. */
    toolUseId?: string;
    toolResult?: string;
    errorMessage?: string;
    reasoning?: boolean;
    /** A thinking block that was present in the source but carried no text AND no signature/encrypted payload.
     *  We KEEP the turn (instead of silently dropping it) and flag it so buyers can tell "the model emitted an
     *  empty thinking block" apart from "we dropped the reasoning during collection". */
    thinkingEmpty?: boolean;
    reasoningSignature?: string;
    encryptedSignature?: string;
    encryptedContent?: unknown;
    sourceRecord?: unknown;
    rawRow?: unknown;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    isMeta: boolean;
}
export interface NormalizedNativeCall {
    provider?: string;
    timestamp?: string;
    request_time?: string;
    response_time?: string;
    ttfb_ms?: number;
    request_headers?: unknown;
    response_headers?: unknown;
    transport?: unknown;
    transport_metadata?: unknown;
    request_body?: unknown;
    response_body?: unknown;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    sourceRecord?: unknown;
    rawRow?: unknown;
}
export interface NormalizedSession {
    turns: NormalizedTurn[];
    sessionId?: string;
    provider?: string;
    model?: string;
    tools?: unknown;
    startedAt?: string;
    nativeCalls?: NormalizedNativeCall[];
    clientSource?: string;
    systemPrompt?: string;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    sourceRecord?: unknown;
    rawRows?: unknown[];
}
export interface SessionLogAdapter {
    readonly agent: string;
    detect(path: string): boolean;
    /** Derive a stable runtime session id when the transcript itself does not carry one. */
    sessionIdFromPath?(path: string): string | undefined;
    parse(rawChunk: string): NormalizedTurn[];
    parseSession?(rawChunk: string): NormalizedSession;
    parseSessions?(rawChunk: string): NormalizedSession[];
}
export interface JsonlParseStats {
    rowsScanned: number;
    rowsRead: number;
    invalidJson: number;
}
export declare function stripUtf8Bom(value: string): string;
export declare const META_MARKERS: string[];
export declare function isMetaText(text: string): boolean;
export declare function parseJsonlLinesWithStats(chunk: string): {
    rows: Record<string, unknown>[];
    stats: JsonlParseStats;
};
export declare function parseJsonlLines(chunk: string): Record<string, unknown>[];
/** content: string | array of {type:text|tool_use|tool_result} → NormalizedTurn[]. */
export declare function extractContent(role: NormalizedTurn['role'], content: unknown): NormalizedTurn[];
/**
 * Backfill toolName onto tool_result turns by correlating tool_use_id → the originating tool_use's name.
 * Anthropic content blocks only name the tool on tool_use; the tool_result references it by id, so without
 * this a failing tool_result has no tool attribution. No-op for turns that carry no toolUseId.
 */
export declare function correlateToolNames(turns: NormalizedTurn[]): NormalizedTurn[];