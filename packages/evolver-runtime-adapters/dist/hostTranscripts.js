import * as zlib from 'node:zlib';
import { correlateToolNames, isMetaText, parseJsonlLines } from './types.js';
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringField(value) {
    return typeof value === 'string' && value ? value : undefined;
}
function isoTime(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return new Date(value).toISOString();
    return stringField(value);
}
function partsText(content) {
    if (typeof content === 'string')
        return content;
    if (isRecord(content))
        return stringField(content['text']) ?? '';
    if (!Array.isArray(content))
        return '';
    return content.map((part) => (isRecord(part) ? stringField(part['text']) ?? '' : '')).join('');
}
function stamped(turns, timestamp) {
    return timestamp ? turns.map((turn) => ({ ...turn, timestamp })) : turns;
}
function singleSessionId(rows, matches, key) {
    const ids = new Set(rows.filter(matches).map((row) => row[key]).filter((id) => typeof id === 'string' && !!id));
    return ids.size === 1 ? [...ids][0] : undefined;
}
// WorkBuddy and Grok wrap the typed prompt in injected <system-reminder>/<user_info> context; only the
// <user_query> body is the human's words. A user row that is only injected markup (compaction summaries,
// reminders) is host scaffolding.
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
function hostUserTurn(raw, injected) {
    if (!raw.trim())
        return [];
    const query = USER_QUERY.exec(raw)?.[1];
    const text = query ?? raw;
    const scaffolding = injected || (query === undefined && raw.trimStart().startsWith('<'));
    return [{ role: 'user', text, isMeta: scaffolding || isMetaText(text) }];
}
function toolCallTurn(name, id, input, model) {
    const toolUseId = stringField(id);
    return {
        role: 'assistant', text: '', toolName: String(name ?? ''),
        ...(toolUseId ? { toolUseId } : {}),
        ...(input !== undefined ? { toolInput: input } : {}),
        ...(model ? { model } : {}),
        isMeta: false,
    };
}
function toolResultTurn(result, id, failed) {
    const toolUseId = stringField(id);
    return { role: 'tool', text: '', toolResult: result, ...(toolUseId ? { toolUseId } : {}), ...(failed ? { errorMessage: result } : {}), isMeta: false };
}
function nonZeroExit(text, pattern) {
    const code = pattern.exec(text)?.[1];
    return code !== undefined && Number(code) !== 0;
}
// Verified against WorkBuddy 5.3 (CodeBuddy engine) logs at ~/.workbuddy/projects/<project>/<session-id>.jsonl.
// Rows are flat {type, role?, content?, callId?, name?, output?, providerData, sessionId, timestamp(ms)}. Tool
// results always carry status "completed": failures surface only in providerData.toolResult (`error`, or
// rawResponse.is_error/exitCode) and, for Bash, as a non-zero `Exit Code: N` line inside the output text.
const WORKBUDDY_EXIT_CODE = /^Exit Code:\s*(-?\d+)\s*$/m;
function workbuddyToolFailed(toolResult, result) {
    const raw = isRecord(toolResult['rawResponse']) ? toolResult['rawResponse'] : {};
    return toolResult['error'] !== undefined
        || raw['is_error'] === true
        || (typeof raw['exitCode'] === 'number' && raw['exitCode'] !== 0)
        || nonZeroExit(result, WORKBUDDY_EXIT_CODE);
}
function workbuddyRowTurns(row) {
    const providerData = isRecord(row['providerData']) ? row['providerData'] : {};
    const model = stringField(providerData['model']);
    switch (row['type']) {
        case 'message': {
            const text = partsText(row['content']);
            if (row['role'] === 'user')
                return hostUserTurn(text, false);
            if (row['role'] !== 'assistant' || !text)
                return [];
            return [{ role: 'assistant', text, ...(model ? { model } : {}), isMeta: isMetaText(text) }];
        }
        case 'reasoning': {
            const text = partsText(row['rawContent']) || partsText(row['content']);
            return text ? [{ role: 'assistant', text, reasoning: true, ...(model ? { model } : {}), isMeta: false }] : [];
        }
        case 'function_call':
            return [toolCallTurn(row['name'], row['callId'], row['arguments'], model)];
        case 'function_call_result': {
            const result = partsText(row['output']);
            const toolResult = isRecord(providerData['toolResult']) ? providerData['toolResult'] : {};
            return [{ ...toolResultTurn(result, row['callId'], workbuddyToolFailed(toolResult, result)), toolName: String(row['name'] ?? '') }];
        }
        default:
            return [];
    }
}
function workbuddySession(chunk) {
    const rows = parseJsonlLines(chunk);
    const sessionId = singleSessionId(rows, () => true, 'sessionId');
    const turns = correlateToolNames(rows.flatMap((row) => stamped(workbuddyRowTurns(row), isoTime(row['timestamp']))));
    return { turns, ...(sessionId ? { sessionId } : {}) };
}
export const workbuddyAdapter = {
    agent: 'workbuddy',
    detect: (p) => /(^|[/\\])\.workbuddy[/\\]projects[/\\].*\.jsonl$/i.test(p),
    parse: (chunk) => workbuddySession(chunk).turns,
    parseSession: workbuddySession,
};
// Verified against Grok CLI 1.0.70 sessions at ~/.grok/sessions/<url-encoded cwd>/<session-id>/chat_history.jsonl,
// the only full transcript in that directory (prompt_history.jsonl holds prompts only; updates.jsonl and
// events.jsonl are UI/hook streams). Rows: {type: system|user|reasoning|assistant|tool_result|backend_tool_call}.
// tool_result has no error flag, so failure is read from the result text: run_terminal_command prefixes
// `exit: N`, and MCP dispatch failures start with "Failed to call" or "Tool `x` failed via".
const GROK_TRANSCRIPT_PATH = /(?:^|[/\\])\.grok[/\\]sessions[/\\][^/\\]+[/\\]([^/\\]+)[/\\]chat_history\.jsonl$/i;
const GROK_EXIT = /^exit:\s*(-?\d+)/;
const GROK_DISPATCH_FAILURE = /^(?:Failed to call |Tool `[^`]+` failed via )/;
function grokRowTurns(row) {
    switch (row['type']) {
        case 'system': {
            const text = partsText(row['content']);
            return text ? [{ role: 'system', text, isMeta: true }] : [];
        }
        case 'user':
            return hostUserTurn(partsText(row['content']), row['synthetic_reason'] !== undefined);
        case 'reasoning': {
            const text = partsText(row['summary']);
            const encryptedContent = row['encrypted_content'];
            if (!text && encryptedContent === undefined)
                return [];
            return [{ role: 'assistant', text, reasoning: true, ...(encryptedContent !== undefined ? { encryptedContent } : {}), isMeta: false }];
        }
        case 'assistant': {
            const model = stringField(row['model_id']);
            const text = partsText(row['content']);
            const calls = Array.isArray(row['tool_calls']) ? row['tool_calls'].filter(isRecord) : [];
            return [
                ...(text ? [{ role: 'assistant', text, ...(model ? { model } : {}), isMeta: isMetaText(text) }] : []),
                ...calls.map((call) => toolCallTurn(call['name'], call['id'], call['arguments'], model)),
            ];
        }
        case 'tool_result': {
            const result = partsText(row['content']);
            const failed = nonZeroExit(result, GROK_EXIT) || GROK_DISPATCH_FAILURE.test(result);
            return [toolResultTurn(result, row['tool_call_id'], failed)];
        }
        default:
            return [];
    }
}
export const grokAdapter = {
    agent: 'grok',
    detect: (p) => GROK_TRANSCRIPT_PATH.test(p),
    sessionIdFromPath: (p) => GROK_TRANSCRIPT_PATH.exec(p)?.[1],
    parse: (chunk) => correlateToolNames(parseJsonlLines(chunk).flatMap(grokRowTurns)),
};
// Verified against DeepSeek Harness desktop sessions at
// ~/.dsh/sessions/<project>/<uuid | session-uuid>/session.v4.jsonl.zstd: a {type, seq, time, data} event stream whose
// first row is {type:'session', id}. Tool calls are taken from assistant/message `tool-call` blocks; the parallel
// tool/call events duplicate them. Bash appends `[exit code: N]` only on a non-zero exit and leaves isError false.
const DSH_EXIT = /\[exit code:\s*(-?\d+)\]\s*$/;
function dshAssistantTurns(data) {
    const message = isRecord(data['message']) ? data['message'] : {};
    const source = isRecord(message['source']) ? message['source'] : {};
    const model = stringField(source['model']);
    const usage = isRecord(data['usage']) ? data['usage'] : {};
    const blocks = Array.isArray(message['content']) ? message['content'].filter(isRecord) : [];
    const turns = blocks.flatMap((block) => {
        const text = stringField(block['text']) ?? '';
        if (block['type'] === 'reasoning')
            return text ? [{ role: 'assistant', text, reasoning: true, isMeta: false }] : [];
        if (block['type'] === 'text')
            return text ? [{ role: 'assistant', text, isMeta: isMetaText(text) }] : [];
        if (block['type'] === 'tool-call')
            return [toolCallTurn(block['name'], block['id'], block['arguments'])];
        return [];
    });
    return turns.map((turn, index) => ({
        ...turn,
        ...(model ? { model } : {}),
        ...(index === 0 && typeof usage['inputTokens'] === 'number' ? { inputTokens: usage['inputTokens'] } : {}),
        ...(index === 0 && typeof usage['outputTokens'] === 'number' ? { outputTokens: usage['outputTokens'] } : {}),
    }));
}
function dshRowTurns(row) {
    const data = isRecord(row['data']) ? row['data'] : {};
    const message = isRecord(data['message']) ? data['message'] : {};
    switch (row['type']) {
        case 'system/message': {
            const text = partsText(message['content']);
            return text ? [{ role: 'system', text, isMeta: true }] : [];
        }
        case 'user/message': {
            const text = partsText(data['content']);
            const source = isRecord(data['source']) ? data['source'] : {};
            return text ? [{ role: 'user', text, isMeta: source['kind'] !== 'user' || isMetaText(text) }] : [];
        }
        case 'assistant/message':
            return dshAssistantTurns(data);
        case 'tool/result': {
            const result = partsText(message['content']);
            return [toolResultTurn(result, message['toolCallId'], message['isError'] === true || nonZeroExit(result, DSH_EXIT))];
        }
        default:
            return [];
    }
}
function dshSession(chunk) {
    const rows = parseJsonlLines(chunk);
    const sessionId = singleSessionId(rows, (row) => row['type'] === 'session', 'id');
    const turns = correlateToolNames(rows.flatMap((row) => stamped(dshRowTurns(row), isoTime(row['time']))));
    return { turns, ...(sessionId ? { sessionId } : {}) };
}
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;
// DSH appends one zstd frame per flush. node:zlib decodes only the first frame of a buffer, so the frames are
// delimited by walking their block headers (RFC 8878 §3.1). A trailing frame still being written is ignored.
function zstdFrameEnd(bytes, start) {
    const descriptor = bytes[start + 4];
    if (descriptor === undefined)
        return undefined;
    const singleSegment = (descriptor >> 5) & 1;
    const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
    let offset = start + 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
        if (offset + 3 > bytes.length)
            return undefined;
        const header = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
        const blockType = (header >> 1) & 3;
        if (blockType === 3)
            throw new Error(`corrupt zstd block at byte ${offset}`);
        offset += 3 + (blockType === 1 ? 1 : header >>> 3);
        if (header & 1)
            break;
    }
    const end = offset + (((descriptor >> 2) & 1) ? 4 : 0);
    return end <= bytes.length ? end : undefined;
}
function decodeZstdFrames(bytes) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new Error(`dsh session logs are zstd-compressed and need node:zlib zstd support (Node >= 22.15 or >= 23.8); running ${process.version}`);
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const magic = buffer.readUInt32LE(offset);
        if (((magic & ZSTD_SKIPPABLE_MAGIC_MASK) >>> 0) === ZSTD_SKIPPABLE_MAGIC) {
            offset += 8 + buffer.readUInt32LE(offset + 4);
            continue;
        }
        if (magic !== ZSTD_FRAME_MAGIC)
            throw new Error(`not a zstd frame at byte ${offset}`);
        const end = zstdFrameEnd(buffer, offset);
        if (end === undefined)
            break;
        frames.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)));
        offset = end;
    }
    return Buffer.concat(frames).toString('utf8');
}
export const dshAdapter = {
    agent: 'dsh',
    detect: (p) => /(^|[/\\])\.dsh[/\\]sessions[/\\][^/\\]+[/\\][^/\\]+[/\\]session\.v4\.jsonl\.zstd$/i.test(p),
    decodeSource: decodeZstdFrames,
    parse: (chunk) => dshSession(chunk).turns,
    parseSession: dshSession,
};