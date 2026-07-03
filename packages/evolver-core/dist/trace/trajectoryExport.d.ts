export declare const CODING_TRAJECTORY_SCHEMA = "evomap.coding_trajectory.v1";
export interface TraceReadStats {
    rowsScanned: number;
    rowsRead: number;
    invalidJson: number;
    encryptedRows: number;
    skippedMissingSecret: number;
    decryptFailures: number;
    nonTraceSkipped: number;
}
export interface NodeSecretKeyringEntry {
    version?: string | number;
    node_secret_version?: string | number;
    nodeSecretVersion?: string | number;
    node_secret?: string;
    nodeSecret?: string;
    secret?: string;
}
export type NodeSecretKeyringInput = Record<string, string> | readonly NodeSecretKeyringEntry[];
export interface TraceReadOptions {
    nodeSecret?: string;
    nodeSecretKeyring?: NodeSecretKeyringInput;
    hubPrivateKey?: string;
    allowPartial?: boolean;
}
export interface NormalizedToolCall {
    id: string;
    name: string;
    input?: unknown;
    arguments?: unknown;
    function?: unknown;
    bytes: number;
    declared?: boolean;
}
export interface CodingTrajectoryAttempt {
    attempt_index: number;
    model?: string | null;
    provider?: string;
    upstream_mode?: string;
    status?: number | null;
    error?: string;
    request_body?: unknown;
    response_body?: unknown;
    body_truncated?: boolean;
}
export interface CodingTrajectoryTurn {
    turn_index: number;
    request_id: string;
    timestamp: string;
    provider: string;
    endpoint: string;
    model: string;
    chosen_model?: string;
    original_model?: string;
    status: number | null;
    duration_ms: number | null;
    ttfb_ms?: number | null;
    is_stream: boolean;
    finish_reason: string;
    response_id: string;
    previous_response_id: string;
    input_tokens: number;
    output_tokens: number;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    request_headers?: unknown;
    response_headers?: unknown;
    transport?: unknown;
    transport_metadata?: unknown;
    source_record?: unknown;
    source_record_index?: number;
    raw_row?: unknown;
    raw_row_index?: number;
    request_body: unknown;
    response_body: unknown;
    reasoning?: unknown;
    thinking_empty?: boolean;
    reasoning_signature?: string;
    encrypted_signature?: string;
    encrypted_content?: unknown;
    diff?: unknown;
    validation?: unknown;
    tool_calls: NormalizedToolCall[];
    redaction?: string;
    body_truncated?: boolean;
    attempts?: CodingTrajectoryAttempt[];
    response_events_truncated?: boolean;
    error?: string;
    stream_error?: string;
    stream_cancelled?: boolean;
    complete: boolean;
    incomplete_reasons?: string[];
}
export interface CodingTrajectoryNativeCall {
    call_index: number;
    provider?: string;
    timestamp?: string;
    request_time?: string;
    response_time?: string;
    ttfb_ms?: number | null;
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
    source_record?: unknown;
    raw_row?: unknown;
    redaction?: string;
}
export interface CodingTrajectory {
    schema: typeof CODING_TRAJECTORY_SCHEMA;
    session_id: string;
    source_kind?: 'proxy_trace' | 'runtime_session';
    source_agent?: string;
    source_path?: string;
    session_model?: string;
    session_provider?: string;
    session_tools?: unknown;
    client_source?: string;
    system_prompt?: string;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    source_record?: unknown;
    source_records?: unknown[];
    raw_rows?: unknown[];
    task: string;
    providers: string[];
    endpoints: string[];
    languages: string[];
    stats: {
        turns: number;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        tool_call_count: number;
        tool_types: Record<string, number>;
        has_tool_calls: boolean;
        has_code_edit: boolean;
        has_test_execution: boolean;
        test_commands: string[];
        has_failure_correction: boolean;
        has_truncated_stream: boolean;
        has_incomplete_turns: boolean;
    };
    native_calls?: CodingTrajectoryNativeCall[];
    turns: CodingTrajectoryTurn[];
}
type JsonRecord = Record<string, unknown>;
export interface RuntimeSessionTurn {
    role: 'user' | 'assistant' | 'tool' | 'system';
    text: string;
    timestamp?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    toolName?: string;
    toolInput?: unknown;
    toolUseId?: string;
    toolResult?: unknown;
    errorMessage?: string;
    reasoning?: boolean;
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
    isMeta?: boolean;
}
export interface RuntimeSessionNativeCall {
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
    request?: unknown;
    response?: unknown;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    sourceRecord?: unknown;
    rawRow?: unknown;
}
export interface RuntimeSessionTrajectoryInput {
    sourceAgent: string;
    sourcePath: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    tools?: unknown;
    startedAt?: string;
    clientSource?: string;
    systemPrompt?: string;
    metadata?: unknown;
    usage?: unknown;
    risk?: unknown;
    fidelity?: unknown;
    confidentiality?: unknown;
    sourceRecord?: unknown;
    rawRows?: readonly unknown[];
    incompleteReasons?: readonly string[];
    nativeCalls?: readonly RuntimeSessionNativeCall[];
    turns: readonly RuntimeSessionTurn[];
}
export declare function stableUserIdHash(value: unknown): string;
export declare function readTraceRowsFromJsonl(text: string, opts?: TraceReadOptions): {
    rows: JsonRecord[];
    stats: TraceReadStats;
};
export declare function buildCodingTrajectoryFromSessionLog(input: RuntimeSessionTrajectoryInput): CodingTrajectory | null;
export declare function buildCodingTrajectories(rows: readonly JsonRecord[]): CodingTrajectory[];
export {};