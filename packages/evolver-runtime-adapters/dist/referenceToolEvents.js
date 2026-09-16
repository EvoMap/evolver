import { createHash } from 'node:crypto';
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
/** 解析冻结Pi事件对；忽略review文字，不执行args，不输出原始命令/结果。 */
export function referenceToolPairs(value) {
    const input = object(value);
    if (!input)
        throw new Error('invalid_reference_events');
    if (!Array.isArray(input['events']) && !Array.isArray(input['dispositions']))
        throw new Error('invalid_reference_events');
    if (Array.isArray(input['dispositions']) && input['dispositions'].length > 512)
        throw new Error('reference_event_limit');
    const rows = Array.isArray(input['events']) ? input['events']
        : Array.isArray(input['dispositions']) ? input['dispositions'].flatMap((entry) => {
            const row = object(entry);
            if (!Array.isArray(row?.['events']) || row['events'].length > 512)
                throw new Error('invalid_reference_events');
            return row['events'];
        }) : [];
    if (rows.length > 512)
        throw new Error('reference_event_limit');
    const calls = new Map();
    for (const raw of rows) {
        const row = object(raw);
        const event = object(row?.['event']);
        if (!event || (event['type'] !== 'tool_execution_start' && event['type'] !== 'tool_execution_end'))
            continue;
        const callId = event['toolCallId'];
        if (typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(callId))
            throw new Error('invalid_reference_call');
        if (typeof event['toolName'] !== 'string' || !event['toolName'] || event['toolName'].length > 128)
            throw new Error('invalid_reference_tool');
        const call = calls.get(callId) ?? {};
        const phase = event['type'] === 'tool_execution_start' ? 'start' : 'end';
        if (call[phase] && digest(call[phase]) !== digest(event))
            throw new Error('reference_call_collision');
        call[phase] = event;
        if (row?.['line'] !== undefined) {
            if (typeof row['line'] !== 'number' || !Number.isSafeInteger(row['line']) || row['line'] < 1)
                throw new Error('invalid_reference_line');
            const field = phase === 'start' ? 'startLine' : 'endLine';
            if (call[field] !== undefined && call[field] !== row['line'])
                throw new Error('reference_line_collision');
            call[field] = row['line'];
        }
        calls.set(callId, call);
    }
    return [...calls].map(([callId, call]) => {
        if (call.start && call.end && call.start['toolName'] !== call.end['toolName'])
            throw new Error('reference_tool_mismatch');
        if (call.startLine !== undefined && call.endLine !== undefined && call.endLine < call.startLine)
            throw new Error('reference_event_order');
        return { callId, eventDigest: digest([call.start ?? null, call.end ?? null]), complete: Boolean(call.start && call.end),
            ...(call.end && call.end['result'] !== undefined ? { resultDigest: digest(call.end['result']) } : {}),
            ...(call.startLine === undefined ? {} : { startLine: call.startLine }), ...(call.endLine === undefined ? {} : { endLine: call.endLine }) };
    });
}