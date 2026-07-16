export function stripUtf8Bom(value) {
    return value.replace(/^\uFEFF/, '');
}
export const META_MARKERS = ['HEARTBEAT_OK', 'NO_REPLY', 'NO_RESPONSE_NEEDED', '[META]'];
export function isMetaText(text) {
    const t = text.trim();
    return t.length === 0 || META_MARKERS.some((m) => t === m || t.startsWith(m));
}
export function parseJsonlLinesWithStats(chunk) {
    const out = [];
    const stats = { rowsScanned: 0, rowsRead: 0, invalidJson: 0 };
    for (const l of chunk.split('\n')) {
        const line = stats.rowsScanned === 0 ? stripUtf8Bom(l) : l;
        if (!line.trim())
            continue;
        stats.rowsScanned += 1;
        try {
            const o = JSON.parse(line);
            if (o && typeof o === 'object') {
                out.push(o);
                stats.rowsRead += 1;
            }
        }
        catch {
            stats.invalidJson += 1;
        }
    }
    return { rows: out, stats };
}
export function parseJsonlLines(chunk) {
    return parseJsonlLinesWithStats(chunk).rows;
}
function stringifyResult(c) {
    if (typeof c === 'string')
        return c;
    if (Array.isArray(c))
        return c.map((x) => (typeof x === 'string' ? x : x['text'] ?? JSON.stringify(x))).join('\n');
    return JSON.stringify(c);
}
/** content: string | array of {type:text|tool_use|tool_result} → NormalizedTurn[]. */
export function extractContent(role, content) {
    if (typeof content === 'string')
        return [{ role, text: content, isMeta: isMetaText(content) }];
    if (!Array.isArray(content))
        return [];
    const turns = [];
    for (const part of content) {
        if (!part || typeof part !== 'object')
            continue;
        const p = part;
        const ptype = p['type'];
        if (ptype === 'text' && typeof p['text'] === 'string')
            turns.push({ role, text: p['text'], isMeta: isMetaText(p['text']) });
        else if (ptype === 'thinking') {
            const text = typeof p['thinking'] === 'string' ? p['thinking'] : (typeof p['text'] === 'string' ? p['text'] : '');
            const reasoningSignature = typeof p['signature'] === 'string' ? p['signature'] : undefined;
            const encryptedSignature = typeof p['encrypted_signature'] === 'string'
                ? p['encrypted_signature']
                : (typeof p['encryptedSignature'] === 'string' ? p['encryptedSignature'] : undefined);
            const encryptedContent = p['encrypted_content'] ?? p['encryptedContent'];
            // Previously an empty thinking block (no text, no signature, no encrypted payload) was dropped entirely,
            // which made "model thought nothing" indistinguishable from "we lost the reasoning". Keep it and flag it.
            const isEmptyThinking = !text && !reasoningSignature && !encryptedSignature && encryptedContent === undefined;
            turns.push({
                role: 'assistant',
                text,
                reasoning: true,
                ...(isEmptyThinking ? { thinkingEmpty: true } : {}),
                ...(reasoningSignature ? { reasoningSignature } : {}),
                ...(encryptedSignature ? { encryptedSignature } : {}),
                ...(encryptedContent !== undefined ? { encryptedContent } : {}),
                isMeta: false,
            });
        }
        else if (ptype === 'tool_use') {
            turns.push({
                role: 'assistant',
                text: '',
                toolName: String(p['name'] ?? ''),
                ...(p['id'] ? { toolUseId: String(p['id']) } : {}),
                ...(p['input'] !== undefined ? { toolInput: p['input'] } : {}),
                isMeta: false,
            });
        }
        else if (ptype === 'tool_result') {
            const r = stringifyResult(p['content']);
            turns.push({ role: 'tool', text: '', toolResult: r, ...(p['tool_use_id'] ? { toolUseId: String(p['tool_use_id']) } : {}), ...(p['is_error'] ? { errorMessage: r } : {}), isMeta: false });
        }
    }
    return turns;
}
/**
 * Backfill toolName onto tool_result turns by correlating tool_use_id → the originating tool_use's name.
 * Anthropic content blocks only name the tool on tool_use; the tool_result references it by id, so without
 * this a failing tool_result has no tool attribution. No-op for turns that carry no toolUseId.
 */
export function correlateToolNames(turns) {
    const nameById = new Map();
    for (const t of turns)
        if (t.toolUseId && t.toolName)
            nameById.set(t.toolUseId, t.toolName);
    if (nameById.size === 0)
        return turns;
    return turns.map((t) => (!t.toolName && t.toolUseId && nameById.has(t.toolUseId) ? { ...t, toolName: nameById.get(t.toolUseId) } : t));
}