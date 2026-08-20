export interface NativeTraceUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
export interface NativeTraceRecord {
    event?: unknown;
    ts?: unknown;
    id?: unknown;
    request_id?: unknown;
    route?: unknown;
    provider?: unknown;
    wire_api?: unknown;
    client?: unknown;
    session_id?: unknown;
    response_id?: unknown;
    previous_response_id?: unknown;
    original_model?: unknown;
    chosen_model?: unknown;
    status?: unknown;
    stream?: unknown;
    ttfb_ms?: unknown;
    latency_ms?: unknown;
    usage?: unknown;
    stop_reason?: unknown;
    error?: unknown;
    requestBody?: unknown;
    responseBody?: unknown;
    request_body?: unknown;
    response_body?: unknown;
    redaction?: unknown;
    body_truncated?: unknown;
    reasoning?: unknown;
    tool_calls?: unknown;
    diff?: unknown;
    validation?: unknown;
}
export type TraceCoverageStatus = 'covered' | 'missing';
export interface TraceCoverageItem {
    field: string;
    status: TraceCoverageStatus;
    source?: string;
}
export interface TraceTurnDraft {
    trace_id: string | null;
    ts: string | null;
    provider: string | null;
    wire_api: string | null;
    route: string | null;
    client: string | null;
    session_id: string | null;
    request_id: string | null;
    response_id: string | null;
    previous_response_id: string | null;
    original_model: string | null;
    chosen_model: string | null;
    status: number | null;
    stream: boolean | null;
    ttfb_ms: number | null;
    latency_ms: number | null;
    usage?: NativeTraceUsage;
    stop_reason?: string | null;
    error?: string;
    request_body?: unknown;
    response_body?: unknown;
    redaction?: string;
    body_truncated?: boolean;
    reasoning?: unknown;
    tool_calls?: unknown;
    diff?: unknown;
    validation?: unknown;
}
export interface TraceTrajectoryDraft {
    schema: 'evolver_trace_trajectory_draft.v1';
    session_id: string | null;
    turns: TraceTurnDraft[];
    coverage: TraceCoverageItem[];
}
export declare function traceRecordToTurnDraft(record: NativeTraceRecord): TraceTurnDraft | null;
/**
 * Exact-join helper for Learning Ops: return the unique non-empty session id across turns.
 * Fail closed — 0 or >1 distinct ids yield null. Matches the correlation key contract used by
 * Darwin (`cc::<session_id>` ↔ packet `traceEvents[].sessionId`).
 */
export declare function uniqueSessionId(turns: readonly {
    session_id?: string | null;
}[]): string | null;
export declare function buildTraceTrajectoryDraft(records: readonly NativeTraceRecord[]): TraceTrajectoryDraft;
export declare function coverageForTurns(turns: readonly TraceTurnDraft[]): TraceCoverageItem[];