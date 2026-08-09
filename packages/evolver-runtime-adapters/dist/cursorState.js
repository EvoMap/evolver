import { createRequire } from 'node:module';
import { correlateToolNames, isMetaText } from './types.js';
const nodeRequire = createRequire(import.meta.url);
export class CursorStateVscdbError extends Error {
    stage;
    constructor(stage, message, cause) {
        super(`Cursor state database ${stage} error: ${message}`, { cause });
        this.name = 'CursorStateVscdbError';
        this.stage = stage;
    }
}
function isBunRuntime() {
    return typeof process.versions === 'object' && typeof process.versions.bun === 'string';
}
function openReadOnlySqliteDatabase(path) {
    if (isBunRuntime()) {
        const { Database } = nodeRequire('bun:sqlite');
        return new Database(path, { readonly: true });
    }
    // node:sqlite is exposed only as `node:sqlite` (no bare `sqlite` alias). Load it through createRequire so
    // bundlers do not statically strip the prefix and break Vitest/Vite or Bun standalone builds.
    const { DatabaseSync } = nodeRequire('node:sqlite');
    return new DatabaseSync(path, { readOnly: true });
}
// ── Cursor state.vscdb conversation extraction ───────────────────────────────
//
// VERIFICATION STATUS / COVERAGE (honest scope — read before extending):
// Cursor stores chat in ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb (sqlite, can be
// >1.85GB; node:sqlite opens it read-only with no CLI). Two tables: `ItemTable` (workbench KV) and
// `cursorDiskKV` (the conversation store). The conversation lives in `cursorDiskKV` under these keys:
//
//   composerData:<composerId>  -> session header. Fields we rely on:
//        { composerId, createdAt, unifiedMode, modelConfig:{modelName,...},
//          fullConversationHeadersOnly: [ { bubbleId, type } ],   // ORDERED message list
//          conversationMap?: { <bubbleId>: <bubble> } }           // sometimes inlined
//   bubbleId:<composerId>:<bubbleId>  -> a single message bubble (when not inlined in conversationMap).
//
// A bubble:
//   { type: 1|2, text, richText?, thinking?:{text}|string, toolFormerData?:{name,rawArgs|params,result},
//     tokenCount?:{inputTokens,outputTokens} }
//   type === 1 -> user, type === 2 -> assistant. (Cursor's MessageType enum.)
//
// COVERED here: opening the db read-only; enumerating composers; ordering messages by
// fullConversationHeadersOnly; reading bubbles from BOTH the inlined conversationMap and the separate
// bubbleId:<composer>:<bubble> rows; extracting user/assistant text, assistant `thinking` as a reasoning turn,
// and `toolFormerData` as a tool_use + tool_result pair; per-bubble token counts; session model/createdAt.
//
// Composer roots can also carry an inline `conversation` array (including sub-composer roots). Attachment bodies
// and explicit code-block content are preserved as turns. We intentionally do not synthesize before/after diffs
// from codeBlockData/originalFileStates because those fields vary by Cursor version.
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function bubbleThinkingText(bubble) {
    const thinking = bubble['thinking'];
    if (typeof thinking === 'string')
        return thinking;
    if (isRecord(thinking)) {
        const text = thinking['text'] ?? thinking['content'];
        if (typeof text === 'string')
            return text;
    }
    return '';
}
function bubbleToolTurns(bubble, toolUseId) {
    const tool = bubble['toolFormerData'];
    if (!isRecord(tool))
        return [];
    const name = asString(tool['name']) || asString(tool['tool']) || 'unknown';
    const rawArgs = tool['rawArgs'] ?? tool['params'] ?? tool['args'];
    const result = tool['result'];
    const turns = [{
            role: 'assistant',
            text: '',
            toolName: name,
            toolUseId,
            ...(rawArgs !== undefined ? { toolInput: rawArgs } : {}),
            isMeta: false,
        }];
    if (result !== undefined) {
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        turns.push({
            role: 'tool',
            text: '',
            toolName: name,
            toolUseId,
            toolResult: resultText,
            isMeta: false,
        });
    }
    return turns;
}
function explicitBodyText(value) {
    if (typeof value === 'string')
        return value;
    if (!isRecord(value))
        return '';
    return asString(value['text']) || asString(value['content']);
}
function bubbleAttachmentTexts(bubble) {
    const directValue = bubble['attachments'];
    if (directValue !== undefined && !Array.isArray(directValue)) {
        throw new CursorStateVscdbError('schema', 'conversation attachments must be an array');
    }
    const direct = Array.isArray(directValue) ? directValue : [];
    const toolValue = isRecord(bubble['toolFormerData']) ? bubble['toolFormerData']['attachments'] : undefined;
    if (toolValue !== undefined && !Array.isArray(toolValue)) {
        throw new CursorStateVscdbError('schema', 'tool attachments must be an array');
    }
    const tool = Array.isArray(toolValue) ? toolValue : [];
    return [...direct, ...tool].map((attachment) => {
        if (!isRecord(attachment)) {
            throw new CursorStateVscdbError('schema', 'attachment must be an object');
        }
        return explicitBodyText(attachment['body']);
    }).filter(Boolean);
}
function bubbleCodeBlockTexts(bubble) {
    const codeBlocks = bubble['codeBlocks'];
    if (codeBlocks === undefined)
        return [];
    if (!Array.isArray(codeBlocks)) {
        throw new CursorStateVscdbError('schema', 'conversation codeBlocks must be an array');
    }
    return codeBlocks.map(explicitContentText).filter(Boolean);
}
function explicitContentText(value) {
    if (typeof value === 'string')
        return value;
    if (!isRecord(value))
        return '';
    return asString(value['content']) || asString(value['text']) || asString(value['code']) || explicitBodyText(value['body']);
}
function contentTurns(role, texts, existingText = '') {
    const seen = new Set(existingText ? [existingText] : []);
    return texts.flatMap((text) => {
        const trimmed = text.trim();
        if (!trimmed || seen.has(trimmed))
            return [];
        seen.add(trimmed);
        return [{ role, text, isMeta: isMetaText(text) }];
    });
}
function bubbleToTurns(bubble, bubbleId) {
    if (!isRecord(bubble)) {
        throw new CursorStateVscdbError('schema', `conversation bubble ${bubbleId} is missing or invalid`);
    }
    const type = finiteNumber(bubble['type']);
    const inputTokens = isRecord(bubble['tokenCount']) ? finiteNumber(bubble['tokenCount']['inputTokens']) : undefined;
    const outputTokens = isRecord(bubble['tokenCount']) ? finiteNumber(bubble['tokenCount']['outputTokens']) : undefined;
    const text = asString(bubble['text']);
    const turns = [];
    if (type === 1) {
        // user bubble
        turns.push({ role: 'user', text, isMeta: isMetaText(text) });
        turns.push(...contentTurns('user', bubbleAttachmentTexts(bubble), text));
        turns.push(...contentTurns('user', bubbleCodeBlockTexts(bubble), text));
        return turns;
    }
    if (type !== 2) {
        throw new CursorStateVscdbError('schema', `conversation bubble ${bubbleId} has an unsupported type`);
    }
    // assistant bubble
    const thinking = bubbleThinkingText(bubble);
    if (thinking) {
        turns.push({ role: 'assistant', text: thinking, reasoning: true, isMeta: false });
    }
    if (text) {
        turns.push({
            role: 'assistant',
            text,
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            isMeta: isMetaText(text),
        });
    }
    turns.push(...bubbleToolTurns(bubble, bubbleId));
    turns.push(...contentTurns('assistant', bubbleAttachmentTexts(bubble), text));
    turns.push(...contentTurns('assistant', bubbleCodeBlockTexts(bubble), text));
    return turns;
}
function conversationHeaders(composer) {
    const headers = composer['fullConversationHeadersOnly'];
    if (headers === undefined)
        return [];
    if (!Array.isArray(headers)) {
        throw new CursorStateVscdbError('schema', 'fullConversationHeadersOnly must be an array');
    }
    return headers.map((header) => {
        if (!isRecord(header))
            throw new CursorStateVscdbError('schema', 'conversation header must be an object');
        const bubbleId = asString(header['bubbleId']);
        if (!bubbleId)
            throw new CursorStateVscdbError('schema', 'conversation header bubbleId is missing');
        return { bubbleId, type: finiteNumber(header['type']) };
    });
}
function inlineConversation(composer) {
    const conversation = composer['conversation'];
    if (conversation === undefined)
        return [];
    if (!Array.isArray(conversation)) {
        throw new CursorStateVscdbError('schema', 'conversation must be an array');
    }
    return conversation.map((bubble, index) => ({
        bubbleId: isRecord(bubble) ? asString(bubble['bubbleId']) || `inline-${index + 1}` : `inline-${index + 1}`,
        value: bubble,
    }));
}
function codeBlockContentByBubble(composer, readCodeBlockDiff) {
    const byBubble = new Map();
    const trailing = [];
    const codeBlockData = composer['codeBlockData'];
    if (codeBlockData === undefined)
        return { byBubble, trailing };
    if (!isRecord(codeBlockData)) {
        throw new CursorStateVscdbError('schema', 'codeBlockData must be an object');
    }
    const seen = new Set();
    const add = (text, bubbleId) => {
        const trimmed = text.trim();
        const key = `${bubbleId}\0${trimmed}`;
        if (!trimmed || seen.has(key))
            return;
        seen.add(key);
        if (bubbleId) {
            const texts = byBubble.get(bubbleId);
            if (texts)
                texts.push(text);
            else
                byBubble.set(bubbleId, [text]);
        }
        else
            trailing.push(text);
    };
    const stack = Object.values(codeBlockData).reverse()
        .map((value) => ({ value, bubbleId: '' }));
    let visited = 0;
    while (stack.length > 0) {
        if (++visited > 100_000)
            throw new CursorStateVscdbError('schema', 'codeBlockData is too deeply nested');
        const current = stack.pop();
        if (Array.isArray(current.value)) {
            for (let index = current.value.length - 1; index >= 0; index--) {
                stack.push({ value: current.value[index], bubbleId: current.bubbleId });
            }
            continue;
        }
        if (!isRecord(current.value))
            continue;
        const bubbleId = asString(current.value['bubbleId']) || current.bubbleId;
        const directText = asString(current.value['content']) || asString(current.value['text'])
            || asString(current.value['code']) || asString(current.value['body']);
        if (directText)
            add(directText, bubbleId);
        const diffId = asString(current.value['diffId']);
        if (diffId) {
            const diff = readCodeBlockDiff(diffId);
            if (!isRecord(diff) || !Array.isArray(diff['newModelDiffWrtV0'])) {
                throw new CursorStateVscdbError('schema', 'code block diff must contain newModelDiffWrtV0');
            }
            for (const line of diff['newModelDiffWrtV0']) {
                if (!isRecord(line)) {
                    throw new CursorStateVscdbError('schema', 'code block diff line must be an object');
                }
                const modified = line['modified'];
                if (typeof modified === 'string')
                    add(modified, bubbleId);
                else if (Array.isArray(modified) && modified.every((value) => typeof value === 'string')) {
                    add(modified.join('\n'), bubbleId);
                }
                else
                    throw new CursorStateVscdbError('schema', 'code block diff line must contain modified text');
            }
        }
        const children = Object.values(current.value).filter((child) => Array.isArray(child) || isRecord(child));
        for (let index = children.length - 1; index >= 0; index--) {
            stack.push({ value: children[index], bubbleId });
        }
    }
    return { byBubble, trailing };
}
function composerToSession(composer, composerId, readBubble, readCodeBlockDiff) {
    const headers = conversationHeaders(composer);
    const inline = inlineConversation(composer);
    const inlineById = new Map(inline.map((bubble) => [bubble.bubbleId, bubble.value]));
    const conversationMapValue = composer['conversationMap'];
    if (conversationMapValue !== undefined && !isRecord(conversationMapValue)) {
        throw new CursorStateVscdbError('schema', 'conversationMap must be an object');
    }
    const conversationMap = isRecord(conversationMapValue) ? conversationMapValue : undefined;
    const codeBlocks = codeBlockContentByBubble(composer, (diffId) => readCodeBlockDiff(composerId, diffId));
    const orderedBubbles = headers.length > 0
        ? headers.map((header) => ({ bubbleId: header.bubbleId, value: (conversationMap && conversationMap[header.bubbleId] !== undefined)
                ? conversationMap[header.bubbleId]
                : readBubble(composerId, header.bubbleId) ?? inlineById.get(header.bubbleId) }))
        : inline.length > 0
            ? inline
            : (conversationMap ? Object.entries(conversationMap).map(([bubbleId, value]) => ({ bubbleId, value })) : []);
    const turns = [];
    for (const bubble of orderedBubbles) {
        turns.push(...bubbleToTurns(bubble.value, bubble.bubbleId));
        turns.push(...contentTurns('assistant', codeBlocks.byBubble.get(bubble.bubbleId) ?? []));
    }
    turns.push(...contentTurns('assistant', codeBlocks.trailing));
    const model = isRecord(composer['modelConfig']) ? asString(composer['modelConfig']['modelName']) : '';
    const createdAt = finiteNumber(composer['createdAt']);
    if (createdAt !== undefined && Math.abs(createdAt) > 8_640_000_000_000_000) {
        throw new CursorStateVscdbError('schema', 'composer createdAt is outside the supported date range');
    }
    return {
        turns: correlateToolNames(turns),
        sessionId: composerId,
        provider: 'cursor',
        ...(model ? { model } : {}),
        ...(createdAt !== undefined ? { startedAt: new Date(createdAt).toISOString() } : {}),
        clientSource: 'cursor',
        sourceRecord: { composerId, ...(model ? { model } : {}) },
    };
}
/**
 * Read Cursor chat sessions out of a `state.vscdb` sqlite database (read-only). Returns one NormalizedSession per
 * composer that has at least one real (non-meta) turn. A valid database with no sessions returns []; database open,
 * query, and incompatible-schema failures throw CursorStateVscdbError. The database is always opened read-only.
 */
export function parseCursorStateVscdb(dbPath) {
    let db;
    try {
        try {
            db = openReadOnlySqliteDatabase(dbPath);
        }
        catch (error) {
            throw new CursorStateVscdbError('open', 'unable to open the file read-only', error);
        }
        let columns;
        try {
            columns = db.prepare('PRAGMA table_info(cursorDiskKV)').all();
        }
        catch (error) {
            throw new CursorStateVscdbError('query', 'unable to inspect cursorDiskKV', error);
        }
        const columnNames = new Set(columns.flatMap((column) => isRecord(column) ? [asString(column['name'])] : []));
        if (!columnNames.has('key') || !columnNames.has('value')) {
            throw new CursorStateVscdbError('schema', 'cursorDiskKV with key and value columns is required');
        }
        let composerRows;
        let valueStmt;
        try {
            composerRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
            valueStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
        }
        catch (error) {
            throw new CursorStateVscdbError('query', 'unable to query Cursor conversations', error);
        }
        const parseJsonValue = (value, label) => {
            const text = typeof value === 'string'
                ? value
                : value instanceof Uint8Array
                    ? new TextDecoder().decode(value)
                    : undefined;
            if (text === undefined) {
                throw new CursorStateVscdbError('schema', `${label} value must be JSON text or a UTF-8 blob`);
            }
            try {
                return JSON.parse(text);
            }
            catch (error) {
                throw new CursorStateVscdbError('schema', `${label} contains invalid JSON`, error);
            }
        };
        const readValue = (key, label) => {
            let row;
            try {
                row = valueStmt.get(key);
            }
            catch (error) {
                throw new CursorStateVscdbError('query', `unable to query a Cursor ${label}`, error);
            }
            if (!row)
                return undefined;
            return parseJsonValue(row.value, label);
        };
        const readBubble = (composerId, bubbleId) => readValue(`bubbleId:${composerId}:${bubbleId}`, 'conversation bubble');
        const readCodeBlockDiff = (composerId, diffId) => readValue(`codeBlockDiff:${composerId}:${diffId}`, 'code block diff');
        const sessions = [];
        let firstComposerError;
        for (const row of composerRows) {
            try {
                const composer = parseJsonValue(row.value, 'composer');
                if (!isRecord(composer))
                    throw new CursorStateVscdbError('schema', 'composer must be a JSON object');
                const composerId = asString(row.key).replace(/^composerData:/, '') || asString(composer['composerId']);
                if (!composerId)
                    throw new CursorStateVscdbError('schema', 'composer id is missing');
                const session = composerToSession(composer, composerId, readBubble, readCodeBlockDiff);
                if (session.turns.some((turn) => turn.isMeta !== true))
                    sessions.push(session);
            }
            catch (error) {
                if (!(error instanceof CursorStateVscdbError) || error.stage !== 'schema')
                    throw error;
                firstComposerError ??= error;
            }
        }
        // Returning only the healthy composers would silently produce an incomplete archive.
        if (firstComposerError)
            throw firstComposerError;
        return sessions;
    }
    finally {
        try {
            db?.close();
        }
        catch {
            /* ignore close errors */
        }
    }
}
/** True for a path that looks like a Cursor globalStorage state.vscdb. */
export function isCursorStateVscdbPath(path) {
    return /(^|[/\\])state\.vscdb$/i.test(path) && /[/\\]Cursor[/\\]/i.test(path);
}