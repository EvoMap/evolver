const PLAN_RE = /\b(plan|design|architect|brainstorm|outline|think through|let'?s think)\b/i;
const SIMPLE_LOOKUP_MAX_CHARS = 80;
function lastMessageOfRole(messages, role) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === role)
            return m;
    }
    return null;
}
function blocksOf(msg) {
    if (!msg)
        return [];
    const c = msg.content;
    if (typeof c === 'string')
        return [{ type: 'text', text: c }];
    return Array.isArray(c) ? c : [];
}
function tailUserText(messages) {
    const tail = messages[messages.length - 1];
    if (!tail || tail.role !== 'user')
        return '';
    return blocksOf(tail)
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}
export function extractFeatures(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const lastAssistant = lastMessageOfRole(messages, 'assistant');
    const toolCallCount = blocksOf(lastAssistant).filter((b) => b && b.type === 'tool_use').length;
    const tail = messages[messages.length - 1];
    const tailIsUser = !!(tail && tail.role === 'user');
    const tailBlocks = blocksOf(tail ?? null);
    const lastUserIsToolResultOnly = tailIsUser && tailBlocks.length > 0 && tailBlocks.every((b) => b && b.type === 'tool_result');
    const userText = tailUserText(messages);
    const userRequestedPlanning = userText.length > 0 && PLAN_RE.test(userText);
    const userSimpleLookup = userText.length > 0 && !lastUserIsToolResultOnly && !userRequestedPlanning && userText.trim().length <= SIMPLE_LOOKUP_MAX_CHARS;
    // We don't have the real Anthropic response on the request side, but the last assistant message's shape
    // reconstructs stop_reason deterministically: any tool_use block ⇒ it ended with 'ToolUse'; text-only ⇒ 'Stop'.
    const stopReason = lastAssistant ? (toolCallCount > 0 ? 'ToolUse' : 'Stop') : null;
    return {
        last_assistant_tool_call_count: toolCallCount,
        last_assistant_had_tool_call: toolCallCount > 0,
        last_user_is_tool_result_only: lastUserIsToolResultOnly,
        user_requested_planning: userRequestedPlanning,
        user_simple_lookup: userSimpleLookup,
        last_assistant_output_tokens: 0,
        last_assistant_stop_reason: stopReason,
    };
}
export { PLAN_RE, SIMPLE_LOOKUP_MAX_CHARS };