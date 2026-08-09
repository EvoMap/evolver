import { parseJsonlLines, extractContent, isMetaText, correlateToolNames, stripUtf8Bom } from './types.js';
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function firstNumber(record, keys) {
    for (const key of keys) {
        const value = finiteNumber(record[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function firstString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
function parseJsonish(value) {
    if (typeof value !== 'string')
        return value;
    const trimmed = stripUtf8Bom(value).trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[')))
        return value;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return value;
    }
}
function parsedRecord(value) {
    const parsed = parseJsonish(value);
    return isRecord(parsed) ? parsed : undefined;
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function firstPresent(record, keys) {
    for (const key of keys)
        if (hasOwn(record, key))
            return record[key];
    return undefined;
}
function firstPresentFrom(records, keys) {
    for (const record of records) {
        const value = firstPresent(record, keys);
        if (value !== undefined)
            return parseJsonish(value);
    }
    return undefined;
}
function firstStringFrom(records, keys) {
    for (const record of records) {
        const value = firstString(record, keys);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function mergeSessionMetadata(current, next) {
    const nativeCalls = [...(current.nativeCalls ?? []), ...(next.nativeCalls ?? [])];
    const rawRows = [...(current.rawRows ?? []), ...(next.rawRows ?? [])];
    return {
        ...current,
        ...(!current.sessionId && next.sessionId ? { sessionId: next.sessionId } : {}),
        ...(!current.provider && next.provider ? { provider: next.provider } : {}),
        ...(!current.model && next.model ? { model: next.model } : {}),
        ...(current.tools === undefined && next.tools !== undefined ? { tools: next.tools } : {}),
        ...(!current.startedAt && next.startedAt ? { startedAt: next.startedAt } : {}),
        ...(!current.clientSource && next.clientSource ? { clientSource: next.clientSource } : {}),
        ...(!current.systemPrompt && next.systemPrompt ? { systemPrompt: next.systemPrompt } : {}),
        ...(current.metadata === undefined && next.metadata !== undefined ? { metadata: next.metadata } : {}),
        ...(current.usage === undefined && next.usage !== undefined ? { usage: next.usage } : {}),
        ...(current.risk === undefined && next.risk !== undefined ? { risk: next.risk } : {}),
        ...(current.fidelity === undefined && next.fidelity !== undefined ? { fidelity: next.fidelity } : {}),
        ...(current.confidentiality === undefined && next.confidentiality !== undefined ? { confidentiality: next.confidentiality } : {}),
        ...(current.sourceRecord === undefined && next.sourceRecord !== undefined ? { sourceRecord: next.sourceRecord } : {}),
        ...(rawRows.length > 0 ? { rawRows } : {}),
        ...(nativeCalls.length > 0 ? { nativeCalls } : {}),
    };
}
function sourceTurnMetadata(source) {
    if (!source)
        return {};
    const parsedMeta = parsedRecord(source['meta']);
    const parsedMetadata = parsedRecord(source['metadata']);
    const sourceRecords = [source, parsedMetadata, parsedMeta].filter((record) => isRecord(record));
    const usageValue = firstPresentFrom(sourceRecords, ['usage']);
    const usage = isRecord(usageValue) ? usageValue : source;
    const model = firstStringFrom(sourceRecords, ['model', 'model_name', 'modelName']);
    const inputTokens = firstNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
    const outputTokens = firstNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
    const metadata = parsedMetadata ?? parsedMeta;
    return {
        ...(model ? { model } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        sourceRecord: source,
        rawRow: source,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(usageValue !== undefined ? { usage: usageValue } : {}),
        ...(firstPresentFrom(sourceRecords, ['risk']) !== undefined ? { risk: firstPresentFrom(sourceRecords, ['risk']) } : {}),
        ...(firstPresentFrom(sourceRecords, ['fidelity']) !== undefined ? { fidelity: firstPresentFrom(sourceRecords, ['fidelity']) } : {}),
        ...(firstPresentFrom(sourceRecords, ['confidentiality']) !== undefined ? { confidentiality: firstPresentFrom(sourceRecords, ['confidentiality']) } : {}),
    };
}
function hasUsage(metadata) {
    return metadata.inputTokens !== undefined || metadata.outputTokens !== undefined;
}
function withSourceMetadata(turns, source) {
    if (turns.length === 0)
        return turns;
    const metadata = sourceTurnMetadata(source);
    let usageAttached = false;
    return turns.map((turn) => {
        const out = {
            ...turn,
            ...(metadata.model ? { model: metadata.model } : {}),
            ...(metadata.sourceRecord !== undefined ? { sourceRecord: metadata.sourceRecord } : {}),
            ...(metadata.rawRow !== undefined ? { rawRow: metadata.rawRow } : {}),
            ...(metadata.metadata !== undefined ? { metadata: metadata.metadata } : {}),
            ...(metadata.usage !== undefined ? { usage: metadata.usage } : {}),
            ...(metadata.risk !== undefined ? { risk: metadata.risk } : {}),
            ...(metadata.fidelity !== undefined ? { fidelity: metadata.fidelity } : {}),
            ...(metadata.confidentiality !== undefined ? { confidentiality: metadata.confidentiality } : {}),
        };
        if (!usageAttached && turn.isMeta !== true && hasUsage(metadata)) {
            if (metadata.inputTokens !== undefined)
                out.inputTokens = metadata.inputTokens;
            if (metadata.outputTokens !== undefined)
                out.outputTokens = metadata.outputTokens;
            usageAttached = true;
        }
        return out;
    });
}
// VERIFICATION BAR: an adapter only ships once its parse() is checked against a REAL session log from that tool
// — a trimmed, sanitized sample + a golden test (see the golden tests in adapters.test.ts). A guessed schema is
// worse than no adapter: it silently yields 0 turns on real logs while looking supported. Today: claude-code,
// codex, cursor, Gemini, and Antigravity are verified against trimmed sanitized real-log samples. opencode/kiro
// stay removed until each has a real-log golden test.
// claude-code AND cursor share the Anthropic content-block transcript shape: one JSONL record per turn,
// { role|type: 'user'|'assistant', message: { content: [ {type:'text',text} | {type:'tool_use',name,id?} |
// {type:'tool_result',...} ] } }. correlateToolNames backfills a tool_result's tool name from its tool_use id.
function anthropicStyleTranscript(chunk) {
    return correlateToolNames(parseJsonlLines(chunk).flatMap((obj) => {
        const type = (obj['type'] ?? obj['role']);
        if (type !== 'user' && type !== 'assistant')
            return []; // non-turn records (no role/type) → skipped
        const msg = isRecord(obj['message']) ? obj['message'] : undefined;
        const timestamp = typeof obj['timestamp'] === 'string'
            ? obj['timestamp']
            : (typeof msg?.['timestamp'] === 'string' ? msg['timestamp'] : undefined);
        const metadataSource = msg ? { ...obj, ...msg } : obj;
        return withSourceMetadata(extractContent(type, msg?.['content'] ?? obj['content']), metadataSource)
            .map((turn) => (timestamp ? { ...turn, timestamp } : turn));
    }));
}
// codex content items are {type:'input_text'|'output_text'|'text', text}; flatten to a single string.
const CODEX_TEXT_TYPES = new Set(['input_text', 'output_text', 'text']);
function codexMessageText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((p) => !!p && typeof p === 'object')
        .filter((p) => CODEX_TEXT_TYPES.has(String(p['type'])))
        .map((p) => (typeof p['text'] === 'string' ? p['text'] : ''))
        .join('');
}
// codex injects scaffolding envelopes (not human/model-authored) — treat them as meta so distillation skips them.
const CODEX_META_TAGS = ['<environment_context>', '<permissions instructions>', '<user_instructions>'];
// Shell-style tool outputs lead with `Exit code: N` — a non-zero code is a tool FAILURE. Downstream signal
// extraction keys error signals off `errorMessage`, so surface it there (not just toolResult), mirroring claude's
// is_error. Shared by the codex adapter and the generic chat adapter (both wrap shell-style tool output).
function exitCodeFailed(output) {
    const m = /^Exit code:\s*(-?\d+)/.exec(output);
    return m ? Number(m[1]) !== 0 : false;
}
function stringifyReasoningSummary(summary) {
    if (typeof summary === 'string')
        return summary;
    if (!Array.isArray(summary))
        return '';
    return summary.map((item) => {
        if (typeof item === 'string')
            return item;
        if (!item || typeof item !== 'object')
            return '';
        const row = item;
        for (const key of ['text', 'summary', 'content']) {
            const value = row[key];
            if (typeof value === 'string')
                return value;
        }
        return '';
    }).filter(Boolean).join('\n');
}
function withoutKeys(obj, keys) {
    const out = {};
    for (const [key, value] of Object.entries(obj))
        if (!keys.includes(key))
            out[key] = value;
    return out;
}
function codexToolUseId(p) {
    for (const key of ['call_id', 'id', 'tool_call_id', 'tool_use_id']) {
        const value = p[key];
        if (typeof value === 'string' && value)
            return value;
    }
    return undefined;
}
function codexNativeToolTurn(p) {
    const type = String(p['type'] ?? '');
    if (!type)
        return null;
    const isOutput = /(?:_output|output)$/.test(type);
    const isCall = /(?:_call|call)$/.test(type);
    if (!isCall && !isOutput)
        return null;
    const payload = withoutKeys(p, ['type', 'id', 'call_id', 'tool_call_id', 'tool_use_id']);
    const toolUseId = codexToolUseId(p);
    if (isOutput) {
        return {
            role: 'tool',
            text: '',
            toolName: type,
            ...(toolUseId ? { toolUseId } : {}),
            toolResult: JSON.stringify(payload),
            isMeta: false,
        };
    }
    return {
        role: 'assistant',
        text: '',
        toolName: type,
        ...(toolUseId ? { toolUseId } : {}),
        toolInput: payload,
        isMeta: false,
    };
}
function normalizeChatRole(rawRole) {
    if (rawRole === 'developer')
        return 'system';
    if (rawRole === 'human')
        return 'user';
    if (rawRole === 'model')
        return 'assistant';
    if (rawRole === 'function')
        return 'tool';
    if (['user', 'assistant', 'tool', 'system'].includes(rawRole))
        return rawRole;
    return null;
}
// FIX-8: extract a SESSION-level system prompt for Anthropic-shaped transcripts. Claude stores the system prompt
// out-of-band in some versions: a dedicated `{type:'system'}` record, a record carrying a top-level
// `systemPrompt`/`system` string, or a leading message with role 'system'. When present we surface it at session
// level so buyers can see the operating instructions; when absent (current Claude transcripts persist no system
// record) parseSession simply omits it. We scan a bounded prefix — the system record is always near the top.
function anthropicSessionSystemPrompt(chunk) {
    const rows = parseJsonlLines(chunk).slice(0, 50);
    for (const row of rows) {
        if (typeof row['systemPrompt'] === 'string' && row['systemPrompt'].trim())
            return row['systemPrompt'];
        if (typeof row['system'] === 'string' && row['system'].trim())
            return row['system'];
        const type = (row['type'] ?? row['role']);
        const msg = isRecord(row['message']) ? row['message'] : undefined;
        const role = (msg?.['role'] ?? row['role']);
        if (type === 'system' || role === 'system') {
            const content = msg?.['content'] ?? row['content'];
            if (typeof content === 'string' && content.trim())
                return content;
            if (Array.isArray(content)) {
                const text = content
                    .filter((p) => isRecord(p))
                    .map((p) => (typeof p['text'] === 'string' ? p['text'] : ''))
                    .join('');
                if (text.trim())
                    return text;
            }
        }
    }
    return undefined;
}
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUDE_TRANSCRIPT_PATH = /(?:^|[/\\])\.claude[/\\]projects[/\\](?:[^/\\]+[/\\])*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.jsonl$/;
const CURSOR_TRANSCRIPT_PATHS = [
    /(?:^|[/\\])\.cursor[/\\]projects[/\\](?:[^/\\]+[/\\])*agent-transcripts[/\\]([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.jsonl$/,
    /(?:^|[/\\])\.cursor[/\\]projects[/\\](?:[^/\\]+[/\\])*agent-transcripts[/\\]([A-Za-z0-9][A-Za-z0-9._-]{0,127})[/\\]\1\.jsonl$/,
];
function transcriptSessionId(chunk, keys) {
    const values = new Set();
    for (const row of parseJsonlLines(chunk)) {
        for (const key of keys) {
            if (!hasOwn(row, key))
                continue;
            const value = row[key];
            if (typeof value !== 'string' || !NATIVE_SESSION_ID.test(value))
                return { invalid: true };
            values.add(value);
            if (values.size > 1)
                return { invalid: true };
        }
    }
    return { value: values.values().next().value, invalid: false };
}
function nativeResumeIdentity(harness, path, chunk, pathPattern, recordKeys) {
    const pathId = pathPattern.exec(path)?.[1];
    if (!pathId || !NATIVE_SESSION_ID.test(pathId))
        return undefined;
    const recordId = transcriptSessionId(chunk, recordKeys);
    if (recordId.invalid || (recordId.value !== undefined && recordId.value !== pathId))
        return undefined;
    return { harness, sessionId: pathId };
}
function cursorResumeIdentity(path, chunk) {
    for (const pattern of CURSOR_TRANSCRIPT_PATHS) {
        const identity = nativeResumeIdentity('cursor', path, chunk, pattern, ['sessionId', 'session_id', 'conversationId', 'conversation_id']);
        if (identity)
            return identity;
    }
    return undefined;
}
function anthropicStyleSession(chunk, sessionIdKeys = []) {
    const systemPrompt = anthropicSessionSystemPrompt(chunk);
    const sessionId = transcriptSessionId(chunk, sessionIdKeys);
    return {
        turns: anthropicStyleTranscript(chunk),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(!sessionId.invalid && sessionId.value ? { sessionId: sessionId.value } : {}),
    };
}
export const claudeCodeAdapter = {
    agent: 'claude-code',
    detect: (p) => /\.claude[/\\]projects[/\\].*\.jsonl$/.test(p) || /claude.*\.jsonl$/i.test(p),
    resumeIdentityFromSource: (path, chunk) => nativeResumeIdentity('claude-code', path, chunk, CLAUDE_TRANSCRIPT_PATH, ['sessionId', 'session_id']),
    parse: anthropicStyleTranscript,
    parseSession: (chunk) => anthropicStyleSession(chunk, ['sessionId', 'session_id']),
};
// Verified against real cursor agent-transcripts
// (~/.cursor/projects/<proj>/agent-transcripts/<session-id>.jsonl, with newer nested layouts also accepted):
// same Anthropic content-block shape as claude-code — observed blocks are text + tool_use (no tool_result). Other
// .jsonl that live under .cursor (eval datasets: task_id/canonical_solution, no role) carry no turn and parse to [].
export const cursorAdapter = {
    agent: 'cursor',
    detect: (p) => /\.cursor[/\\].*\.jsonl$/.test(p) || /cursor.*\.jsonl$/i.test(p),
    resumeIdentityFromSource: cursorResumeIdentity,
    parse: anthropicStyleTranscript,
    parseSession: (chunk) => anthropicStyleSession(chunk, ['sessionId', 'session_id', 'conversationId', 'conversation_id']),
};
// Verified against codex-cli 0.137.0 rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Each line is
// {timestamp, type, payload}. Codex writes the SAME conversation twice: a high-level `event_msg` stream
// (user_message/agent_message) and the authoritative `response_item` stream (full roles + tool calls + outputs).
// We parse ONLY `response_item` — parsing both would double-count every user/assistant turn. A tool call and its
// output share a `call_id` (codex's analogue of claude's tool_use_id), so correlateToolNames backfills the
// tool's name onto its (possibly failing) output turn — preserving tool attribution for signal extraction.
function codexTranscript(chunk) {
    return correlateToolNames(parseJsonlLines(chunk).flatMap((obj) => {
        if (obj['type'] !== 'response_item')
            return [];
        const p = obj['payload'];
        if (!p)
            return [];
        const callId = codexToolUseId(p);
        const timestamp = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : undefined;
        const stamp = (turns) => timestamp ? turns.map((turn) => ({ ...turn, timestamp })) : turns;
        const annotate = (turns) => stamp(withSourceMetadata(turns, p));
        switch (p['type']) {
            case 'message': {
                const raw = String(p['role'] ?? 'user');
                // codex 'developer' role = injected system instruction envelope.
                const role = normalizeChatRole(raw) ?? 'user';
                const text = codexMessageText(p['content']);
                if (!text)
                    return [];
                const meta = role === 'system' || isMetaText(text) || CODEX_META_TAGS.some((t) => text.startsWith(t));
                return annotate([{ role, text, isMeta: meta }]);
            }
            case 'function_call': // shell_command etc. — model-issued tool call
            case 'custom_tool_call': // apply_patch etc.
                return annotate([{
                        role: 'assistant',
                        text: '',
                        toolName: String(p['name'] ?? ''),
                        ...(callId ? { toolUseId: String(callId) } : {}),
                        ...(p['arguments'] !== undefined ? { toolInput: p['arguments'] } : {}),
                        ...(p['input'] !== undefined ? { toolInput: p['input'] } : {}),
                        isMeta: false,
                    }]);
            case 'function_call_output':
            case 'custom_tool_call_output': {
                const out = typeof p['output'] === 'string' ? p['output'] : JSON.stringify(p['output'] ?? '');
                return annotate([{ role: 'tool', text: '', toolResult: out, ...(callId ? { toolUseId: String(callId) } : {}), ...(exitCodeFailed(out) ? { errorMessage: out } : {}), isMeta: false }]);
            }
            case 'reasoning': {
                const text = stringifyReasoningSummary(p['summary']);
                const reasoningSignature = typeof p['signature'] === 'string' ? p['signature'] : undefined;
                const encryptedSignature = typeof p['encrypted_signature'] === 'string'
                    ? p['encrypted_signature']
                    : (typeof p['encryptedSignature'] === 'string' ? p['encryptedSignature'] : undefined);
                const encryptedContent = p['encrypted_content'] ?? p['encryptedContent'];
                const metadata = sourceTurnMetadata(p);
                if (!text && !reasoningSignature && !encryptedSignature && encryptedContent === undefined && !metadata.model && !hasUsage(metadata))
                    return [];
                return annotate([{
                        role: 'assistant',
                        text,
                        reasoning: true,
                        ...(reasoningSignature ? { reasoningSignature } : {}),
                        ...(encryptedSignature ? { encryptedSignature } : {}),
                        ...(encryptedContent !== undefined ? { encryptedContent } : {}),
                        isMeta: false,
                    }]);
            }
            default: // token_count, etc. → drop
                {
                    const nativeTurn = codexNativeToolTurn(p);
                    return nativeTurn ? annotate([nativeTurn]) : [];
                }
        }
    }));
}
// FIX-8: codex injects its system instruction as the first `developer`/`system` message (mapped to a meta
// system turn by codexTranscript). Surface that as the session-level systemPrompt as well.
function codexSession(chunk) {
    const turns = codexTranscript(chunk);
    const systemTurn = turns.find((turn) => turn.role === 'system' && turn.text.trim());
    return {
        turns,
        ...(systemTurn ? { systemPrompt: systemTurn.text } : {}),
    };
}
export const codexAdapter = {
    agent: 'codex',
    // real files are rollout-<ts>-<uuid>.jsonl under .codex/sessions|archived_sessions; keep the generic codex*.jsonl too.
    detect: (p) => /\.codex[/\\].*\.jsonl$/.test(p) || /(^|[/\\])rollout-.*\.jsonl$/i.test(p) || /codex.*\.jsonl$/i.test(p),
    parse: codexTranscript,
    parseSession: codexSession,
};
// ── Gemini CLI adapter ───────────────────────────────────────────────────────
// Verified against real Gemini CLI session files at
// ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<id>.{json,jsonl}. The session
// file is ONE JSON document:
//   { sessionId, projectHash, startTime, lastUpdated, messages: [...], summary }
// (We deliberately NEVER read ~/.gemini/tmp/<hash>/logs.json — it is a terse
//  event log, not the conversation.)
// Each message: { id, timestamp, type: 'user'|'gemini'|'info', content: string,
//   thoughts?: [{subject, description, timestamp}], tokens?: {input,output,...,total},
//   model?: string, toolCalls?: [{ id, name, args, result: [{functionResponse:{...,response}}] }] }.
// - type 'user'    -> user turn (content is a string or [{text}] parts array)
// - type 'gemini'  -> assistant turn; `thoughts` -> a reasoning turn (subject + description),
//                     `toolCalls` -> tool_use turn(s) + paired tool_result turn(s).
// - type 'info'    -> CLI scaffolding (e.g. update banner) -> meta, dropped from distillation.
function geminiContentToString(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')))
            .join('');
    }
    return '';
}
function geminiThoughtsText(thoughts) {
    if (!Array.isArray(thoughts))
        return '';
    return thoughts
        .map((thought) => {
        if (typeof thought === 'string')
            return thought;
        if (!isRecord(thought))
            return '';
        const subject = typeof thought['subject'] === 'string' ? thought['subject'] : '';
        const description = typeof thought['description'] === 'string' ? thought['description'] : '';
        return [subject, description].filter(Boolean).join(': ');
    })
        .filter(Boolean)
        .join('\n');
}
function geminiUsageFromTokens(tokens) {
    if (!isRecord(tokens))
        return {};
    const input = finiteNumber(tokens['input'] ?? tokens['inputTokens'] ?? tokens['promptTokenCount']);
    const output = finiteNumber(tokens['output'] ?? tokens['outputTokens'] ?? tokens['candidatesTokenCount']);
    return {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
    };
}
function geminiToolCallTurns(toolCalls, model) {
    if (!Array.isArray(toolCalls))
        return [];
    const turns = [];
    for (const call of toolCalls) {
        if (!isRecord(call))
            continue;
        const name = typeof call['name'] === 'string' ? call['name'] : '';
        const id = typeof call['id'] === 'string' ? call['id'] : undefined;
        turns.push({
            role: 'assistant',
            text: '',
            ...(name ? { toolName: name } : {}),
            ...(id ? { toolUseId: id } : {}),
            ...(call['args'] !== undefined ? { toolInput: call['args'] } : {}),
            ...(model ? { model } : {}),
            isMeta: false,
        });
        // Gemini stores the tool result inside `result: [{ functionResponse: { name, response } }]`.
        const results = Array.isArray(call['result']) ? call['result'] : [];
        for (const result of results) {
            if (!isRecord(result))
                continue;
            const fr = isRecord(result['functionResponse']) ? result['functionResponse'] : undefined;
            const responseValue = fr ? fr['response'] : result['response'];
            if (responseValue === undefined && fr === undefined)
                continue;
            const text = typeof responseValue === 'string' ? responseValue : JSON.stringify(responseValue ?? result);
            turns.push({
                role: 'tool',
                text: '',
                ...(name ? { toolName: name } : {}),
                ...(id ? { toolUseId: id } : {}),
                toolResult: text,
                ...(exitCodeFailed(text) ? { errorMessage: text } : {}),
                isMeta: false,
            });
        }
    }
    return turns;
}
function geminiMessageToTurns(message) {
    const type = String(message['type'] ?? '');
    const timestamp = typeof message['timestamp'] === 'string' ? message['timestamp'] : undefined;
    const model = typeof message['model'] === 'string' ? message['model'] : undefined;
    const stamp = (turn) => (timestamp ? { ...turn, timestamp } : turn);
    if (type === 'user') {
        const text = geminiContentToString(message['content']);
        return [stamp({ role: 'user', text, isMeta: isMetaText(text) })];
    }
    if (type === 'gemini') {
        const usage = geminiUsageFromTokens(message['tokens']);
        const turns = [];
        const thoughts = geminiThoughtsText(message['thoughts']);
        if (thoughts) {
            turns.push({ role: 'assistant', text: thoughts, reasoning: true, ...(model ? { model } : {}), isMeta: false });
        }
        const text = geminiContentToString(message['content']);
        if (text) {
            turns.push({
                role: 'assistant',
                text,
                ...(model ? { model } : {}),
                ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                isMeta: isMetaText(text),
            });
        }
        turns.push(...geminiToolCallTurns(message['toolCalls'], model));
        // Attach usage to the first non-meta turn even when the assistant only produced
        // thoughts/tool calls (empty content), so token accounting is not lost.
        if (text === '' && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
            const first = turns.find((turn) => turn.isMeta !== true);
            if (first) {
                if (usage.inputTokens !== undefined && first.inputTokens === undefined)
                    first.inputTokens = usage.inputTokens;
                if (usage.outputTokens !== undefined && first.outputTokens === undefined)
                    first.outputTokens = usage.outputTokens;
            }
        }
        return turns.map(stamp);
    }
    // 'info' and any other CLI scaffolding records -> meta so distillation skips them.
    const infoText = geminiContentToString(message['content']);
    return infoText ? [stamp({ role: 'system', text: infoText, isMeta: true })] : [];
}
function geminiSessionFromValue(value) {
    if (!isRecord(value))
        return null;
    const messages = Array.isArray(value['messages']) ? value['messages'] : undefined;
    if (!messages)
        return null;
    const turns = correlateToolNames(messages.filter((m) => isRecord(m)).flatMap(geminiMessageToTurns));
    const sessionId = firstString(value, ['sessionId', 'session_id', 'id']);
    const startedAt = firstString(value, ['startTime', 'start_time', 'lastUpdated']);
    const model = turns.find((turn) => turn.model)?.model;
    return {
        turns,
        ...(sessionId ? { sessionId } : {}),
        provider: 'gemini',
        ...(model ? { model } : {}),
        ...(startedAt ? { startedAt } : {}),
        clientSource: 'gemini-cli',
        sourceRecord: value,
        rawRows: [value],
    };
}
function geminiSessions(chunk) {
    const trimmed = stripUtf8Bom(chunk).trim();
    if (!trimmed)
        return [];
    // Gemini session files are a single JSON document. Tolerate JSONL-of-sessions too.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            const values = Array.isArray(parsed) ? parsed : [parsed];
            return values
                .map(geminiSessionFromValue)
                .filter((session) => session !== null && session.turns.length > 0);
        }
        catch { /* fall through to JSONL */ }
    }
    return parseJsonlLines(chunk)
        .map(geminiSessionFromValue)
        .filter((session) => session !== null && session.turns.length > 0);
}
export const geminiAdapter = {
    agent: 'gemini',
    // Real path: ~/.gemini/tmp/<hash>/chats/session-<ts>-<id>.{json,jsonl}. NEVER logs.json.
    detect: (p) => {
        if (/(^|[/\\])logs\.json$/i.test(p))
            return false;
        return /\.gemini[/\\].*[/\\]chats[/\\]session-[^/\\]*\.jsonl?$/i.test(p)
            || /(^|[/\\])gemini[^/\\]*session[^/\\]*\.jsonl?$/i.test(p)
            || /(^|[/\\])session-[^/\\]*\.gemini\.jsonl?$/i.test(p);
    },
    parse: (chunk) => geminiSessions(chunk).flatMap((session) => session.turns),
    parseSession: (chunk) => geminiSessions(chunk)[0] ?? { turns: [] },
    parseSessions: geminiSessions,
};
// Antigravity persists one JSON record per event at
// ~/.gemini/{antigravity,antigravity-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl.
// Verified real records carry {type,status,source,step_index,created_at,content}; PLANNER_RESPONSE additionally
// carries plaintext `thinking` and tool_calls: [{name,args}]. The file can append a newer snapshot of an earlier
// step, so the last terminal record for each type + step_index is authoritative.
const ANTIGRAVITY_TRANSCRIPT_PATH = /(?:^|[/\\])\.gemini[/\\](?:antigravity|antigravity-ide)[/\\]brain[/\\]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})[/\\]\.system_generated[/\\]logs[/\\]transcript\.jsonl$/i;
const ANTIGRAVITY_TERMINAL_STATUSES = new Set(['DONE', 'ERROR', 'CANCELED']);
const ANTIGRAVITY_TOOL_RESULT_TYPES = new Set([
    'ASK_QUESTION',
    'CODE_ACTION',
    'GENERIC',
    'GREP_SEARCH',
    'LIST_DIRECTORY',
    'RUN_COMMAND',
    'SEARCH_WEB',
    'VIEW_FILE',
]);
function antigravityStatus(record) {
    return typeof record['status'] === 'string' ? record['status'].toUpperCase() : '';
}
function antigravityRecords(chunk) {
    const selected = new Map();
    parseJsonlLines(chunk).forEach((record, rowIndex) => {
        const type = typeof record['type'] === 'string' ? record['type'] : '';
        const stepIndex = finiteNumber(record['step_index']);
        const key = type && stepIndex !== undefined ? `${type}\u0000${stepIndex}` : `row\u0000${rowIndex}`;
        const current = selected.get(key);
        if (!current) {
            selected.set(key, { record, rowIndex });
            return;
        }
        const currentTerminal = ANTIGRAVITY_TERMINAL_STATUSES.has(antigravityStatus(current.record));
        const nextTerminal = ANTIGRAVITY_TERMINAL_STATUSES.has(antigravityStatus(record));
        if (!currentTerminal || nextTerminal) {
            // Snapshot rows are partial: omitted tool_calls carry forward, while an explicit value (including []) wins.
            // Keep the first logical position so a late terminal snapshot cannot move a tool call after its result.
            const selectedRecord = type === 'PLANNER_RESPONSE'
                && !hasOwn(record, 'tool_calls')
                && hasOwn(current.record, 'tool_calls')
                ? { ...record, tool_calls: current.record['tool_calls'] }
                : record;
            selected.set(key, { record: selectedRecord, rowIndex: current.rowIndex });
        }
    });
    return [...selected.values()]
        .sort((a, b) => a.rowIndex - b.rowIndex)
        .map(({ record }) => record);
}
function antigravityRecordMetadata(record) {
    const metadata = {};
    for (const key of ['type', 'status', 'source', 'step_index', 'created_at']) {
        if (record[key] !== undefined)
            metadata[key] = record[key];
    }
    return metadata;
}
function antigravityRecordText(record, key = 'content') {
    return typeof record[key] === 'string' ? record[key] : '';
}
function antigravityFailure(record) {
    const type = typeof record['type'] === 'string' ? record['type'] : '';
    const status = antigravityStatus(record);
    if (type !== 'ERROR_MESSAGE' && status !== 'ERROR' && status !== 'CANCELED')
        return undefined;
    return antigravityRecordText(record, 'error')
        || antigravityRecordText(record)
        || `Antigravity ${type || 'record'} ${status || 'ERROR'}`;
}
function annotateAntigravityTurns(record, turns) {
    const timestamp = typeof record['created_at'] === 'string' ? record['created_at'] : undefined;
    const metadata = antigravityRecordMetadata(record);
    const errorMessage = antigravityFailure(record);
    return turns.map((turn) => ({
        ...turn,
        ...(timestamp ? { timestamp } : {}),
        ...(errorMessage && !turn.errorMessage ? { errorMessage } : {}),
        metadata,
        sourceRecord: record,
        rawRow: record,
    }));
}
function antigravityResultTypeForTool(toolName) {
    switch (toolName.toLowerCase()) {
        case 'ask_question': return 'ASK_QUESTION';
        case 'grep_search': return 'GREP_SEARCH';
        case 'list_dir': return 'LIST_DIRECTORY';
        case 'run_command': return 'RUN_COMMAND';
        case 'search_web': return 'SEARCH_WEB';
        case 'view_file': return 'VIEW_FILE';
        case 'multi_replace_file_content':
        case 'replace_file_content':
        case 'write_to_file': return 'CODE_ACTION';
        default: return 'GENERIC';
    }
}
function antigravityFallbackToolName(resultType) {
    switch (resultType) {
        case 'ASK_QUESTION': return 'ask_question';
        case 'CODE_ACTION': return 'code_action';
        case 'GREP_SEARCH': return 'grep_search';
        case 'LIST_DIRECTORY': return 'list_dir';
        case 'RUN_COMMAND': return 'run_command';
        case 'SEARCH_WEB': return 'search_web';
        case 'VIEW_FILE': return 'view_file';
        default: return 'generic';
    }
}
function antigravityTranscriptFromRecords(records) {
    const turns = [];
    const pendingTools = [];
    records.forEach((record, rowIndex) => {
        const type = typeof record['type'] === 'string' ? record['type'] : '';
        const content = antigravityRecordText(record);
        const recordTurns = [];
        if (type === 'USER_INPUT') {
            recordTurns.push({ role: 'user', text: content, isMeta: isMetaText(content) });
        }
        else if (type === 'PLANNER_RESPONSE') {
            const thinking = antigravityRecordText(record, 'thinking');
            if (thinking)
                recordTurns.push({ role: 'assistant', text: thinking, reasoning: true, isMeta: false });
            if (content)
                recordTurns.push({ role: 'assistant', text: content, isMeta: isMetaText(content) });
            const toolCalls = Array.isArray(record['tool_calls']) ? record['tool_calls'] : [];
            toolCalls.forEach((value, ordinal) => {
                if (!isRecord(value))
                    return;
                const toolName = typeof value['name'] === 'string' && value['name'] ? value['name'] : 'antigravity_tool';
                const stepIndex = finiteNumber(record['step_index']);
                const toolUseId = `antigravity:${stepIndex ?? `row-${rowIndex}`}:${ordinal}`;
                pendingTools.push({ toolName, toolUseId, resultType: antigravityResultTypeForTool(toolName) });
                recordTurns.push({
                    role: 'assistant',
                    text: '',
                    toolName,
                    toolUseId,
                    ...(hasOwn(value, 'args') ? { toolInput: value['args'] } : {}),
                    isMeta: false,
                });
            });
        }
        else if (ANTIGRAVITY_TOOL_RESULT_TYPES.has(type)) {
            const pendingIndex = pendingTools.findIndex((pending) => pending.resultType === type);
            const pending = pendingIndex >= 0 ? pendingTools.splice(pendingIndex, 1)[0] : undefined;
            recordTurns.push({
                role: 'tool',
                text: '',
                toolName: pending?.toolName ?? antigravityFallbackToolName(type),
                ...(pending ? { toolUseId: pending.toolUseId } : {}),
                toolResult: content,
                isMeta: false,
            });
        }
        else if (type === 'ERROR_MESSAGE') {
            const errorMessage = antigravityFailure(record);
            recordTurns.push({ role: 'system', text: content || errorMessage, errorMessage, isMeta: true });
        }
        else if (type === 'SYSTEM_MESSAGE' || type === 'CONVERSATION_HISTORY' || type === 'CHECKPOINT') {
            recordTurns.push({ role: 'system', text: content, isMeta: true });
        }
        turns.push(...annotateAntigravityTurns(record, recordTurns));
    });
    return turns;
}
function antigravitySession(chunk) {
    const records = antigravityRecords(chunk);
    const startedAt = records.find((record) => typeof record['created_at'] === 'string')?.['created_at'];
    return {
        turns: antigravityTranscriptFromRecords(records),
        provider: 'antigravity',
        clientSource: 'antigravity',
        ...(typeof startedAt === 'string' ? { startedAt } : {}),
        rawRows: records,
    };
}
export const antigravityAdapter = {
    agent: 'antigravity',
    detect: (path) => ANTIGRAVITY_TRANSCRIPT_PATH.test(path),
    sessionIdFromPath: (path) => ANTIGRAVITY_TRANSCRIPT_PATH.exec(path)?.[1],
    parse: (chunk) => antigravitySession(chunk).turns,
    parseSession: antigravitySession,
    parseSessions: (chunk) => {
        const session = antigravitySession(chunk);
        return session.turns.length > 0 ? [session] : [];
    },
};
// ── generic chat-transcript adapter ──────────────────────────────────────────
// The per-tool adapters above are gated on a REAL private-log golden (a guessed private schema silently yields 0
// turns). This one is different ON PURPOSE: it targets the DOCUMENTED, stable interchange format — OpenAI
// chat-completions / Anthropic messages — not a tool's private log. The "real sample" it is verified against is
// the published schema itself (golden tests), so it is not a guess. The payoff: any agent that can dump its
// conversation as standard messages joins the self-learning loop WITHOUT a bespoke adapter (this is the intake
// for the mcp-generic / http-agent runtimes). Registered LAST so any tool-specific path still wins; matched by an
// explicit on-disk intake convention: name the transcript `<name>.chat|messages|transcript.json[l]`.
/** Flatten a message `content` (string | OpenAI text-parts | mixed) to a plain string — for tool messages. */
function chatContentToString(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((p) => (typeof p === 'string' ? p : (p && typeof p === 'object' && typeof p['text'] === 'string' ? p['text'] : '')))
        .join('');
}
function hasGenericTurnPayload(turn) {
    return Boolean(turn.text
        || turn.toolName
        || turn.toolInput !== undefined
        || turn.toolResult !== undefined
        || turn.errorMessage
        || turn.reasoning === true
        || turn.reasoningSignature
        || turn.encryptedSignature
        || turn.encryptedContent !== undefined);
}
/** One standard chat message → turns. Handles string/parts/Anthropic-block content (via extractContent), the
 *  OpenAI `role:'tool'` result message, and an assistant `tool_calls` array (each → a tool_use-style turn so
 *  correlateToolNames can attribute the matching tool result). A record without a known role is not a message. */
function chatMessageToTurns(obj) {
    const rawRole = obj['role'];
    if (typeof rawRole !== 'string')
        return [];
    const role = normalizeChatRole(rawRole);
    if (!role)
        return [];
    if (role === 'tool') {
        const text = chatContentToString(obj['content']);
        // A failed tool result must surface on errorMessage (not just toolResult) — extractSignals mines strong tool
        // errors from errorMessage and skips empty-text turns, so without this a failure produces no signal. Standard
        // messages have no universal error flag, so we honor an explicit is_error/isError when the producer sets one,
        // plus the shared shell `Exit code: N` convention (same as the codex adapter), and never guess from free text.
        const flaggedError = obj['is_error'] === true || obj['isError'] === true;
        const failed = flaggedError || exitCodeFailed(text);
        return withSourceMetadata([{
                role: 'tool', text: '', toolResult: text,
                ...(typeof obj['name'] === 'string' ? { toolName: obj['name'] } : {}),
                ...(typeof obj['tool_call_id'] === 'string' ? { toolUseId: obj['tool_call_id'] } : {}),
                ...(failed ? { errorMessage: text } : {}),
                isMeta: false,
            }], obj);
    }
    // A system message is an instruction envelope, not agent narration — mark it meta so distillation skips it
    // (mirrors the codex adapter's developer/system handling).
    const content = extractContent(role, obj['content']).filter(hasGenericTurnPayload);
    const turns = role === 'system' ? content.map((t) => ({ ...t, isMeta: true })) : [...content];
    const reasoningContent = firstString(obj, ['reasoning_content', 'reasoningContent', 'thinking']);
    if (role === 'assistant' && reasoningContent) {
        turns.unshift({
            role: 'assistant',
            text: reasoningContent,
            reasoning: true,
            ...(firstString(obj, ['reasoning_signature', 'reasoningSignature', 'signature']) ? { reasoningSignature: firstString(obj, ['reasoning_signature', 'reasoningSignature', 'signature']) } : {}),
            ...(firstString(obj, ['encrypted_signature', 'encryptedSignature']) ? { encryptedSignature: firstString(obj, ['encrypted_signature', 'encryptedSignature']) } : {}),
            ...(obj['encrypted_content'] !== undefined ? { encryptedContent: obj['encrypted_content'] } : {}),
            ...(obj['encryptedContent'] !== undefined ? { encryptedContent: obj['encryptedContent'] } : {}),
            isMeta: false,
        });
    }
    const toolCalls = obj['tool_calls'];
    if (role === 'assistant' && Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (!tc || typeof tc !== 'object')
                continue;
            const c = tc;
            const fn = (c['function'] && typeof c['function'] === 'object' ? c['function'] : {});
            const name = typeof fn['name'] === 'string' ? fn['name'] : (typeof c['name'] === 'string' ? c['name'] : '');
            turns.push({
                role: 'assistant',
                text: '',
                toolName: name,
                ...(typeof c['id'] === 'string' ? { toolUseId: c['id'] } : {}),
                ...(fn['arguments'] !== undefined ? { toolInput: fn['arguments'] } : {}),
                isMeta: false,
            });
        }
    }
    return withSourceMetadata(turns, obj);
}
function genericChatMetadataFromRecord(record) {
    const meta = parsedRecord(record['meta']) ?? {};
    const metadata = parsedRecord(record['metadata']) ?? {};
    const metadataSources = [record, metadata, meta];
    const request = isRecord(parseJsonish(record['request'])) ? parseJsonish(record['request']) : {};
    const requestBody = isRecord(parseJsonish(record['request_body'] ?? record['requestBody']))
        ? parseJsonish(record['request_body'] ?? record['requestBody'])
        : {};
    const response = isRecord(parseJsonish(record['response'])) ? parseJsonish(record['response']) : {};
    const responseBody = isRecord(parseJsonish(record['response_body'] ?? record['responseBody']))
        ? parseJsonish(record['response_body'] ?? record['responseBody'])
        : {};
    const responseData = isRecord(parseJsonish(response['response_data'] ?? response['responseData']))
        ? parseJsonish(response['response_data'] ?? response['responseData'])
        : {};
    const responseBodyData = isRecord(parseJsonish(responseBody['response_data'] ?? responseBody['responseData']))
        ? parseJsonish(responseBody['response_data'] ?? responseBody['responseData'])
        : {};
    const sessionId = firstString(record, ['trajectory_id', 'trajectoryId', 'session_id', 'sessionId', 'task_id', 'taskId', 'id']);
    const provider = firstStringFrom(metadataSources, ['provider', 'wire_api', 'wireApi', 'upstream', 'source', 'client_source', 'clientSource']);
    const model = firstStringFrom(metadataSources, ['model', 'model_name', 'modelName', 'chosen_model', 'chosenModel'])
        ?? firstString(request, ['model', 'chosen_model', 'chosenModel'])
        ?? firstString(requestBody, ['model', 'chosen_model', 'chosenModel'])
        ?? firstString(responseData, ['model', 'chosen_model', 'chosenModel'])
        ?? firstString(responseBodyData, ['model', 'chosen_model', 'chosenModel'])
        ?? firstString(responseBody, ['model', 'chosen_model', 'chosenModel'])
        ?? firstString(response, ['model', 'chosen_model', 'chosenModel']);
    const startedAt = firstString(record, ['created_at', 'createdAt', 'timestamp', 'request_time', 'requestTime'])
        ?? firstString(meta, ['created_at', 'createdAt', 'create_time', 'createTime', 'timestamp', 'request_time', 'requestTime']);
    const requestTime = firstString(record, ['request_time', 'requestTime'])
        ?? firstString(meta, ['request_time', 'requestTime']);
    const responseTime = firstString(record, ['response_time', 'responseTime'])
        ?? firstString(meta, ['response_time', 'responseTime']);
    const clientSource = firstStringFrom(metadataSources, ['client_source', 'clientSource']);
    const systemPrompt = firstStringFrom(metadataSources, ['system_prompt', 'systemPrompt']);
    const tools = record['tools'] ?? request['tools'] ?? requestBody['tools'];
    const nativeCall = nativeCallFromRecord(record, { provider, startedAt, requestTime, responseTime });
    const metadataValue = record['metadata'] !== undefined ? parseJsonish(record['metadata']) : (record['meta'] !== undefined ? parseJsonish(record['meta']) : undefined);
    const usage = firstPresentFrom(metadataSources, ['usage']);
    const risk = firstPresentFrom(metadataSources, ['risk']);
    const fidelity = firstPresentFrom(metadataSources, ['fidelity']);
    const confidentiality = firstPresentFrom(metadataSources, ['confidentiality']);
    return {
        ...(sessionId ? { sessionId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(clientSource ? { clientSource } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(risk !== undefined ? { risk } : {}),
        ...(fidelity !== undefined ? { fidelity } : {}),
        ...(confidentiality !== undefined ? { confidentiality } : {}),
        sourceRecord: record,
        rawRows: [record],
        ...(nativeCall ? { nativeCalls: [nativeCall] } : {}),
    };
}
function nativeCallFromRecord(record, metadata) {
    const hasRequest = hasOwn(record, 'request') || hasOwn(record, 'request_body') || hasOwn(record, 'requestBody');
    const hasResponse = hasOwn(record, 'response') || hasOwn(record, 'response_body') || hasOwn(record, 'responseBody');
    const requestHeaders = firstPresent(record, ['request_headers', 'requestHeaders']);
    const responseHeaders = firstPresent(record, ['response_headers', 'responseHeaders']);
    const transport = firstPresent(record, ['transport']);
    const transportMetadata = firstPresent(record, ['transport_metadata', 'transportMetadata']);
    const ttfbMs = finiteNumber(record['ttfb_ms'] ?? record['ttfbMs']);
    if (!hasRequest && !hasResponse && requestHeaders === undefined && responseHeaders === undefined && transport === undefined && transportMetadata === undefined && ttfbMs === undefined)
        return undefined;
    const requestBody = parseJsonish(firstPresent(record, ['request', 'request_body', 'requestBody']));
    const responseBody = parseJsonish(firstPresent(record, ['response', 'response_body', 'responseBody']));
    const metadataValue = record['metadata'] !== undefined ? parseJsonish(record['metadata']) : (record['meta'] !== undefined ? parseJsonish(record['meta']) : undefined);
    const meta = parsedRecord(record['meta']) ?? {};
    const normalizedMetadata = parsedRecord(record['metadata']) ?? {};
    const metadataSources = [record, normalizedMetadata, meta];
    const usage = firstPresentFrom(metadataSources, ['usage']);
    const risk = firstPresentFrom(metadataSources, ['risk']);
    const fidelity = firstPresentFrom(metadataSources, ['fidelity']);
    const confidentiality = firstPresentFrom(metadataSources, ['confidentiality']);
    return {
        ...(metadata.provider ? { provider: metadata.provider } : {}),
        ...(metadata.startedAt ? { timestamp: metadata.startedAt } : {}),
        ...(metadata.requestTime ? { request_time: metadata.requestTime } : {}),
        ...(metadata.responseTime ? { response_time: metadata.responseTime } : {}),
        ...(ttfbMs !== undefined ? { ttfb_ms: ttfbMs } : {}),
        ...(requestHeaders !== undefined ? { request_headers: parseJsonish(requestHeaders) } : {}),
        ...(responseHeaders !== undefined ? { response_headers: parseJsonish(responseHeaders) } : {}),
        ...(transport !== undefined ? { transport: parseJsonish(transport) } : {}),
        ...(transportMetadata !== undefined ? { transport_metadata: parseJsonish(transportMetadata) } : {}),
        ...(hasRequest ? { request_body: requestBody } : {}),
        ...(hasResponse ? { response_body: responseBody } : {}),
        ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(risk !== undefined ? { risk } : {}),
        ...(fidelity !== undefined ? { fidelity } : {}),
        ...(confidentiality !== undefined ? { confidentiality } : {}),
        sourceRecord: record,
        rawRow: record,
    };
}
function responseMessageFromBody(value) {
    const body = parseJsonish(value);
    if (!isRecord(body))
        return [];
    if (isRecord(body['message']))
        return genericChatRecordsFromValue(body['message']).records;
    if (Array.isArray(body['choices'])) {
        return body['choices'].flatMap((choice) => {
            if (!isRecord(choice))
                return [];
            if (isRecord(choice['message'])) {
                const message = { ...choice['message'] };
                if (body['model'] !== undefined && message['model'] === undefined)
                    message['model'] = body['model'];
                if (body['usage'] !== undefined && message['usage'] === undefined)
                    message['usage'] = body['usage'];
                return genericChatRecordsFromValue(message).records;
            }
            return [];
        });
    }
    if (typeof body['role'] === 'string')
        return genericChatRecordsFromValue(body).records;
    if (body['content'] !== undefined || body['tool_calls'] !== undefined || body['usage'] !== undefined) {
        return [{
                role: 'assistant',
                ...(body['content'] !== undefined ? { content: body['content'] } : {}),
                ...(body['output'] !== undefined ? { content: body['output'] } : {}),
                ...(body['tool_calls'] !== undefined ? { tool_calls: body['tool_calls'] } : {}),
                ...(body['model'] !== undefined ? { model: body['model'] } : {}),
                ...(body['usage'] !== undefined ? { usage: body['usage'] } : {}),
            }];
    }
    return [];
}
function candidateMessages(value) {
    if (Array.isArray(value))
        return value.flatMap(candidateMessages);
    if (isRecord(value))
        return genericChatRecordsFromValue(value).records;
    return [];
}
function requestResponseRecordsFromValue(value) {
    const request = parseJsonish(value['request'] ?? value['request_body'] ?? value['requestBody']);
    const responseEnvelope = parseJsonish(value['response'] ?? value['response_body'] ?? value['responseBody']);
    const response = isRecord(responseEnvelope) && (responseEnvelope['response_data'] !== undefined || responseEnvelope['responseData'] !== undefined)
        ? parseJsonish(responseEnvelope['response_data'] ?? responseEnvelope['responseData'])
        : responseEnvelope;
    const records = [];
    if (isRecord(request)) {
        if (typeof request['instructions'] === 'string')
            records.push({ role: 'system', content: request['instructions'] });
        if (typeof request['system_prompt'] === 'string')
            records.push({ role: 'system', content: request['system_prompt'] });
        if (typeof request['systemPrompt'] === 'string')
            records.push({ role: 'system', content: request['systemPrompt'] });
        records.push(...genericChatRecordsFromValue(request).records);
    }
    records.push(...responseMessageFromBody(response));
    return records;
}
function systemPromptRecord(metadata) {
    return metadata.systemPrompt ? [{ role: 'system', content: metadata.systemPrompt }] : [];
}
function isSessionWrapperRecord(value) {
    return Array.isArray(value['messages'])
        || Array.isArray(value['turns'])
        || Array.isArray(value['prompt'])
        || value['request'] !== undefined
        || value['request_body'] !== undefined
        || value['requestBody'] !== undefined
        || value['response'] !== undefined
        || value['response_body'] !== undefined
        || value['responseBody'] !== undefined;
}
function genericChatRecordsFromValue(value) {
    if (Array.isArray(value)) {
        return value.reduce((acc, item) => {
            const parsed = genericChatRecordsFromValue(item);
            acc.records.push(...parsed.records);
            acc.metadata = mergeSessionMetadata(acc.metadata, parsed.metadata);
            return acc;
        }, { records: [], metadata: {} });
    }
    if (!isRecord(value))
        return { records: [], metadata: {} };
    const metadata = genericChatMetadataFromRecord(value);
    if (Array.isArray(value['prompt'])) {
        return {
            records: systemPromptRecord(metadata).concat(value['prompt']
                .filter((x) => isRecord(x))
                .concat(candidateMessages(value['candidates']))),
            metadata,
        };
    }
    const wrapped = value['messages'] ?? value['turns'];
    if (Array.isArray(wrapped)) {
        return {
            records: systemPromptRecord(metadata).concat(wrapped.filter((x) => isRecord(x))),
            metadata,
        };
    }
    const requestResponseRecords = requestResponseRecordsFromValue(value);
    if (requestResponseRecords.length > 0)
        return { records: requestResponseRecords, metadata };
    if (isRecord(value['message'])) {
        const parsed = genericChatRecordsFromValue(value['message']);
        return { records: parsed.records, metadata: mergeSessionMetadata(metadata, parsed.metadata) };
    }
    return typeof value['role'] === 'string' ? { records: [value], metadata: {} } : { records: [], metadata };
}
function applyGenericSessionMetadata(turns, metadata) {
    if (!metadata.model
        && metadata.metadata === undefined
        && metadata.usage === undefined
        && metadata.risk === undefined
        && metadata.fidelity === undefined
        && metadata.confidentiality === undefined
        && metadata.sourceRecord === undefined)
        return turns;
    let sessionScopedApplied = false;
    const hasNonMetaTurn = turns.some((turn) => turn.isMeta !== true);
    return turns.map((turn) => {
        const out = {
            ...turn,
            ...(!turn.model && metadata.model ? { model: metadata.model } : {}),
        };
        if (!sessionScopedApplied && (!hasNonMetaTurn || turn.isMeta !== true)) {
            if (out.metadata === undefined && metadata.metadata !== undefined)
                out.metadata = metadata.metadata;
            if (out.usage === undefined && metadata.usage !== undefined)
                out.usage = metadata.usage;
            if (out.risk === undefined && metadata.risk !== undefined)
                out.risk = metadata.risk;
            if (out.fidelity === undefined && metadata.fidelity !== undefined)
                out.fidelity = metadata.fidelity;
            if (out.confidentiality === undefined && metadata.confidentiality !== undefined)
                out.confidentiality = metadata.confidentiality;
            if (out.sourceRecord === undefined && metadata.sourceRecord !== undefined)
                out.sourceRecord = metadata.sourceRecord;
            if (out.rawRow === undefined && metadata.sourceRecord !== undefined)
                out.rawRow = metadata.sourceRecord;
            sessionScopedApplied = true;
        }
        return out;
    });
}
/** Accept JSONL (one message per line), a bare JSON array of messages, a { messages|turns: [...] } wrapper (the
 *  chat-completions request-body shape), or a SINGLE message object (incl. pretty-printed multi-line — which is
 *  not valid JSONL, so it must be handled here, not fall through). */
function genericChatRecords(chunk) {
    const trimmed = stripUtf8Bom(chunk).trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            return genericChatRecordsFromValue(parsed);
        }
        catch { /* not a single JSON doc → treat as JSONL below */ }
    }
    return parseJsonlLines(chunk).reduce((acc, row) => {
        const parsed = genericChatRecordsFromValue(row);
        acc.records.push(...parsed.records);
        acc.metadata = mergeSessionMetadata(acc.metadata, parsed.metadata);
        return acc;
    }, { records: [], metadata: {} });
}
function genericChatSessionFromParseResult(parsed) {
    const turns = correlateToolNames(parsed.records.flatMap(chatMessageToTurns));
    return {
        turns: applyGenericSessionMetadata(turns, parsed.metadata),
        ...parsed.metadata,
    };
}
function genericChatSession(chunk) {
    return genericChatSessionFromParseResult(genericChatRecords(chunk));
}
function genericChatSessionsFromValue(value) {
    if (Array.isArray(value) && value.every((item) => isRecord(item) && isSessionWrapperRecord(item))) {
        return value
            .map((item) => genericChatSessionFromParseResult(genericChatRecordsFromValue(item)))
            .filter((session) => session.turns.length > 0);
    }
    const session = genericChatSessionFromParseResult(genericChatRecordsFromValue(value));
    return session.turns.length > 0 ? [session] : [];
}
function genericChatSessions(chunk) {
    const trimmed = stripUtf8Bom(chunk).trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            return genericChatSessionsFromValue(parsed);
        }
        catch { /* not a single JSON doc → treat as JSONL below */ }
    }
    const rows = parseJsonlLines(chunk);
    if (rows.length > 0 && rows.every(isSessionWrapperRecord)) {
        return rows
            .map((row) => genericChatSessionFromParseResult(genericChatRecordsFromValue(row)))
            .filter((session) => session.turns.length > 0);
    }
    const session = genericChatSessionFromParseResult(rows.reduce((acc, row) => {
        const parsed = genericChatRecordsFromValue(row);
        acc.records.push(...parsed.records);
        acc.metadata = mergeSessionMetadata(acc.metadata, parsed.metadata);
        return acc;
    }, { records: [], metadata: {} }));
    return session.turns.length > 0 ? [session] : [];
}
export const genericChatAdapter = {
    agent: 'generic-chat',
    detect: (p) => /(^|[/\\])[^/\\]*\.(chat|messages|transcript)\.jsonl?$/i.test(p),
    parse: (chunk) => genericChatSessions(chunk).flatMap((session) => session.turns),
    parseSession: genericChatSession,
    parseSessions: genericChatSessions,
};
// ── Kimi (wire.jsonl) adapter ────────────────────────────────────────────────
// Kimi CLI persists the raw wire conversation to `wire.jsonl`: one JSON object per line, each carrying the FULL
// `messages` array (OpenAI chat-completions shape) with PLAINTEXT thinking directly captured (no encrypted/signed
// reasoning — Kimi exposes it). No real local sample was available, so this is built against that documented
// "one record per line, full messages + plaintext thinking" shape and reuses the generic chat message decoder
// (which already understands messages[], reasoning_content/thinking, tool_calls, and the role:'tool' result).
// When the same file carries multiple lines, the LAST full messages snapshot wins (it is the most complete turn
// log), avoiding double-counting earlier partial snapshots.
function kimiSessions(chunk) {
    const rows = parseJsonlLines(chunk);
    // Pick the row with the most messages as the authoritative conversation snapshot; fall back to all rows merged.
    let best;
    let bestLen = -1;
    for (const row of rows) {
        const messages = row['messages'];
        const len = Array.isArray(messages) ? messages.length : -1;
        if (len > bestLen) {
            bestLen = len;
            best = row;
        }
    }
    const source = best ?? rows;
    const sessions = genericChatSessionsFromValue(source);
    return sessions.map((session) => ({ ...session, provider: session.provider ?? 'kimi', clientSource: session.clientSource ?? 'kimi' }));
}
export const kimiAdapter = {
    agent: 'kimi',
    detect: (p) => /(^|[/\\])wire\.jsonl$/i.test(p) || /(^|[/\\])kimi[^/\\]*\.jsonl$/i.test(p),
    parse: (chunk) => kimiSessions(chunk).flatMap((session) => session.turns),
    parseSession: (chunk) => kimiSessions(chunk)[0] ?? { turns: [] },
    parseSessions: kimiSessions,
};
// ── Removed runtime adapters ─────────────────────────────────────────────────
// Kiro and OpenCode transcript adapters were removed in V2: no sanitized real-log golden fixture exists for
// either runtime, so shipping a guessed schema would silently yield 0 turns on real logs while appearing
// supported. The MCP config installer (setup-hooks --runtime=kiro|opencode) remains functional for injection.
//
// Sentinels live in REMOVED_ADAPTERS (NOT in ADAPTERS) so content probes that walk ADAPTERS and call
// parse() cannot throw "kiro removed" on unrelated JSON (trajectoryExport.adapterForContent).
// Path-based selection uses adapterForPath, which checks REMOVED_ADAPTERS first; matching paths then fail
// closed on parse with an actionable error.
const REMOVED_ADAPTER_MESSAGE = (agent) => `${agent} transcript adapter was removed from evolver v2 — no sanitized real-log golden fixture exists. `
    + `Re-add with a verified golden test (see adapters.test.ts). `
    + `MCP injection (setup-hooks --runtime=${agent}) is still supported; only transcript ingest is blocked.`;
function removedAdapter(agent, detect) {
    return {
        agent,
        detect,
        parse: () => { throw new Error(REMOVED_ADAPTER_MESSAGE(agent)); },
        parseSession: () => { throw new Error(REMOVED_ADAPTER_MESSAGE(agent)); },
        parseSessions: () => { throw new Error(REMOVED_ADAPTER_MESSAGE(agent)); },
    };
}
export const kiroRemovedAdapter = removedAdapter('kiro', (p) => /(^|[/\\])\.kiro([/\\]|$)/i.test(p) || /(^|[/\\])kiro[^/\\]*\.jsonl?$/i.test(p));
export const opencodeRemovedAdapter = removedAdapter('opencode', (p) => /(^|[/\\])\.opencode([/\\]|$)/i.test(p) || /(^|[/\\])opencode[^/\\]*\.jsonl?$/i.test(p));
/** Explicitly removed transcript adapters — path fail-closed only. Never walk this list for content probes. */
export const REMOVED_ADAPTERS = [kiroRemovedAdapter, opencodeRemovedAdapter];
// Only verified adapters are registered for content/path discovery. Removed runtimes are listed in
// REMOVED_ADAPTERS and selected only via adapterForPath path match (then parse throws).
// genericChatAdapter is LAST so any tool-specific path (claude/cursor/codex/gemini/antigravity/kimi) resolves first.
export const ADAPTERS = [claudeCodeAdapter, codexAdapter, cursorAdapter, geminiAdapter, antigravityAdapter, kimiAdapter, genericChatAdapter];
export function adapterForPath(path) {
    const removed = REMOVED_ADAPTERS.find((a) => a.detect(path));
    if (removed)
        return removed;
    return ADAPTERS.find((a) => a.detect(path));
}
/** True when the agent id has an explicit removed transcript sentinel (see REMOVED_ADAPTERS). */
export function isRemovedAdapter(agent) {
    return REMOVED_ADAPTERS.some((a) => a.agent === agent);
}