const REQUIRED_COVERAGE = [
    { field: 'native_request_body', source: 'request_body' },
    { field: 'native_response_body', source: 'response_body' },
    { field: 'provider', source: 'provider' },
    { field: 'wire_api', source: 'wire_api' },
    { field: 'session_id', source: 'session_id' },
    { field: 'usage', source: 'usage' },
    { field: 'status', source: 'status' },
    { field: 'reasoning_summary', source: 'reasoning' },
    { field: 'tool_calls', source: 'tool_calls' },
    { field: 'diff_or_before_after', source: 'diff' },
    { field: 'validation_or_test_commands', source: 'validation' },
];
function stringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function booleanOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function parseSerializedBody(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function usageOrUndefined(value) {
    if (!isRecord(value))
        return undefined;
    const out = {};
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        const raw = value[key];
        if (typeof raw === 'number' && Number.isFinite(raw))
            out[key] = raw;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function present(value) {
    if (value === undefined || value === null)
        return false;
    if (typeof value === 'string')
        return value.length > 0;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === 'object')
        return Object.keys(value).length > 0;
    return true;
}
export function traceRecordToTurnDraft(record) {
    if (record.event !== 'llm_turn')
        return null;
    const usage = usageOrUndefined(record.usage);
    const requestBody = parseSerializedBody(record.requestBody !== undefined ? record.requestBody : record.request_body);
    const responseBody = parseSerializedBody(record.responseBody !== undefined ? record.responseBody : record.response_body);
    const reasoning = parseSerializedBody(record.reasoning);
    const toolCalls = parseSerializedBody(record.tool_calls);
    const diff = parseSerializedBody(record.diff);
    const validation = parseSerializedBody(record.validation);
    return {
        trace_id: stringOrNull(record.id),
        ts: stringOrNull(record.ts),
        provider: stringOrNull(record.provider),
        wire_api: stringOrNull(record.wire_api),
        route: stringOrNull(record.route),
        client: stringOrNull(record.client),
        session_id: stringOrNull(record.session_id),
        request_id: stringOrNull(record.request_id),
        response_id: stringOrNull(record.response_id),
        previous_response_id: stringOrNull(record.previous_response_id),
        original_model: stringOrNull(record.original_model),
        chosen_model: stringOrNull(record.chosen_model),
        status: numberOrNull(record.status),
        stream: booleanOrNull(record.stream),
        ttfb_ms: numberOrNull(record.ttfb_ms),
        latency_ms: numberOrNull(record.latency_ms),
        ...(usage ? { usage } : {}),
        ...(record.stop_reason !== undefined ? { stop_reason: stringOrNull(record.stop_reason) } : {}),
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
        ...(requestBody !== undefined ? { request_body: requestBody } : {}),
        ...(responseBody !== undefined ? { response_body: responseBody } : {}),
        ...(typeof record.redaction === 'string' ? { redaction: record.redaction } : {}),
        ...(typeof record.body_truncated === 'boolean' ? { body_truncated: record.body_truncated } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
        ...(diff !== undefined ? { diff } : {}),
        ...(validation !== undefined ? { validation } : {}),
    };
}
export function buildTraceTrajectoryDraft(records) {
    const turns = records.map(traceRecordToTurnDraft).filter((turn) => turn !== null);
    const sessionIds = [...new Set(turns.map((turn) => turn.session_id).filter((value) => typeof value === 'string' && value.length > 0))];
    return {
        schema: 'evolver_trace_trajectory_draft.v1',
        session_id: sessionIds.length === 1 ? sessionIds[0] : null,
        turns,
        coverage: coverageForTurns(turns),
    };
}
export function coverageForTurns(turns) {
    return REQUIRED_COVERAGE.map(({ field, source }) => {
        const hasField = turns.some((turn) => present(turn[source]));
        return {
            field,
            status: hasField ? 'covered' : 'missing',
            ...(hasField ? { source: 'llm_trace' } : {}),
        };
    });
}