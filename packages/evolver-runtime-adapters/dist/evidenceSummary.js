function toolUseId(turn) {
    const id = turn.toolUseId;
    return id?.trim() ? id : undefined;
}
function isToolCall(turn) {
    return turn.role === 'assistant'
        && turn.toolResult === undefined
        && (turn.toolUseId !== undefined
            || turn.toolInput !== undefined
            || turn.toolName !== undefined);
}
function isToolResult(turn) {
    return turn.role === 'tool';
}
/** Summarizes transcript structure only; complete coverage does not verify the task outcome. */
export function summarizeSessionEvidence(session) {
    const turns = session.turns.filter((turn) => turn.isMeta !== true);
    const pendingCallsById = new Map();
    let toolCalls = 0;
    let toolResults = 0;
    let matchedToolResults = 0;
    let unmatchedToolResults = 0;
    let failedToolResults = 0;
    for (const turn of turns) {
        if (isToolCall(turn)) {
            toolCalls += 1;
            const id = toolUseId(turn);
            if (id)
                pendingCallsById.set(id, (pendingCallsById.get(id) ?? 0) + 1);
            continue;
        }
        if (isToolResult(turn)) {
            toolResults += 1;
            if (turn.errorMessage !== undefined)
                failedToolResults += 1;
            const id = toolUseId(turn);
            const pending = id ? pendingCallsById.get(id) ?? 0 : 0;
            if (id && pending > 0) {
                matchedToolResults += 1;
                if (pending === 1)
                    pendingCallsById.delete(id);
                else
                    pendingCallsById.set(id, pending - 1);
            }
            else {
                unmatchedToolResults += 1;
            }
        }
    }
    const missingToolResults = toolCalls - matchedToolResults;
    const counts = {
        nonMetaTurns: turns.length,
        toolCalls,
        toolResults,
        matchedToolResults,
        missingToolResults,
        unmatchedToolResults,
        failedToolResults,
    };
    const gapCodes = [];
    if (turns.length === 0)
        gapCodes.push('empty_session');
    else {
        if (missingToolResults > 0)
            gapCodes.push('missing_tool_result');
        if (unmatchedToolResults > 0)
            gapCodes.push('unmatched_tool_result');
    }
    const coverage = turns.length === 0
        ? 'empty'
        : gapCodes.length > 0 ? 'partial' : 'complete';
    return { coverage, counts, gapCodes };
}