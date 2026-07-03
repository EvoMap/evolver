import { createRequire } from 'node:module';
import { correlateToolNames, isMetaText } from './types.js';
const nodeRequire = createRequire(import.meta.url);
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
// NOT yet covered / known gaps (the local machine's DB had only EMPTY composers, so these are schema-documented
// but not golden-verified against real populated bubbles): Cursor's code-edit "diff" capability blocks
// (codeBlockData / originalFileStates) are NOT reconstructed into before/after diffs; sub-composer / best-of-N
// branch bubbles are read flat (no tree structure); attachment/context payloads are ignored. Extend with a real
// populated-DB fixture before trusting those.
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
function bubbleToTurns(bubble, bubbleId) {
    if (!isRecord(bubble))
        return [];
    const type = finiteNumber(bubble['type']);
    const inputTokens = isRecord(bubble['tokenCount']) ? finiteNumber(bubble['tokenCount']['inputTokens']) : undefined;
    const outputTokens = isRecord(bubble['tokenCount']) ? finiteNumber(bubble['tokenCount']['outputTokens']) : undefined;
    const text = asString(bubble['text']);
    const turns = [];
    if (type === 1) {
        // user bubble
        turns.push({ role: 'user', text, isMeta: isMetaText(text) });
        return turns;
    }
    // assistant (type === 2) or unknown -> treat as assistant content
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
    return turns;
}
function conversationHeaders(composer) {
    const headers = composer['fullConversationHeadersOnly'];
    if (!Array.isArray(headers))
        return [];
    return headers
        .map((header) => (isRecord(header) ? { bubbleId: asString(header['bubbleId']), type: finiteNumber(header['type']) } : { bubbleId: '' }))
        .filter((header) => header.bubbleId);
}
function composerToSession(composer, composerId, readBubble) {
    const headers = conversationHeaders(composer);
    const conversationMap = isRecord(composer['conversationMap']) ? composer['conversationMap'] : undefined;
    const orderedBubbleIds = headers.length > 0
        ? headers.map((header) => header.bubbleId)
        : (conversationMap ? Object.keys(conversationMap) : []);
    const turns = [];
    for (const bubbleId of orderedBubbleIds) {
        const bubble = (conversationMap && conversationMap[bubbleId] !== undefined)
            ? conversationMap[bubbleId]
            : readBubble(composerId, bubbleId);
        turns.push(...bubbleToTurns(bubble, bubbleId));
    }
    const model = isRecord(composer['modelConfig']) ? asString(composer['modelConfig']['modelName']) : '';
    const createdAt = finiteNumber(composer['createdAt']);
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
 * composer that has at least one real (non-meta) turn. Never throws on a malformed/locked db — returns []. The db
 * is opened read-only, so it is safe to run against a live Cursor profile.
 */
export function parseCursorStateVscdb(dbPath) {
    let db;
    try {
        db = openReadOnlySqliteDatabase(dbPath);
        const composerRows = db
            .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
            .all();
        const bubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
        const readBubble = (composerId, bubbleId) => {
            try {
                const row = bubbleStmt.get(`bubbleId:${composerId}:${bubbleId}`);
                if (!row || typeof row.value !== 'string')
                    return undefined;
                return JSON.parse(row.value);
            }
            catch {
                return undefined;
            }
        };
        const sessions = [];
        for (const row of composerRows) {
            if (typeof row.value !== 'string')
                continue;
            let composer;
            try {
                composer = JSON.parse(row.value);
            }
            catch {
                continue;
            }
            if (!isRecord(composer))
                continue;
            const composerId = asString(row.key).replace(/^composerData:/, '') || asString(composer['composerId']);
            const session = composerToSession(composer, composerId, readBubble);
            if (session.turns.some((turn) => turn.isMeta !== true))
                sessions.push(session);
        }
        return sessions;
    }
    catch {
        return [];
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