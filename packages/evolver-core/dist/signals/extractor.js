import { ulid as makeUlid } from 'ulid';
/** agent 显式信号标记(第三条腿; 与 evolver 显式信号注入旁枝呼应). */
const AGENT_MARKERS = [/\bEVOLVE_SIGNAL:\s*(.+)/i, /\[SIGNAL\]\s*(.+)/i];
/** 结构化强信号: 栈/退出码/显式 Error — 零成本判断, 不动 LLM. */
const STRONG_TEXT = /(^|\n)\s*(Error:|Traceback|Exception|FAILED|panic:|\bexit code [1-9])/;
/** 弱信号: 表达困难但无结构, 需 LLM 拼语境. */
const DIFFICULTY = /(无法|失败|搞不定|stuck|can'?t|unable to|not working|fail(?:ed|ing|ure)?|broken|did not pass|no tests? passed|报错|卡住)/i;
/** 成功信号: 工具执行成功/测试通过/构建成功 — 零成本结构化判断, 不动 LLM(Issue#578).
 *  注意: bare `verified` 和 `green` 已移至 SUCCESS_PROSE(needsAnalysis:true), 因为它们在非成功语境下高频出现
 *  ("verified the bug exists" / "green field" / "green button") 且 SUCCESS_TEXT 的 needsAnalysis:false 无 LLM 兜底.
 *  Emoji are accepted only with test-result context; a bare checklist mark is not proof of session success. */
const SUCCESS_TEXT = /\b(exit code:?\s*0|all tests?\s+pass(ed)?|tests?\s+pass(ed)?|validation\s+pass(ed)?|build\s+succeed(ed)?|published\s+successfully|completed\s+successfully)\b|(?:^|\n)\s*(?:✓\s*(?:\d+\s+)?(?:tests?\s+)?pass(ed)?\b|(?:Tests|Test Files):?\s+[1-9]\d*\s+pass(ed)?\b|(?:=+\s*)?[1-9]\d*\s+pass(ed)?(?:\s+in\s+\d+(?:\.\d+)?s?|\s*=*\s*$)|PASS\s+\S+|ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))(?:\s|$))|\btests?\s+🟢(?:\s|$)/im;
/** Deterministic success must fail closed when the same result carries a current negative outcome. */
const SUCCESS_CONFLICT = /\b(?:no|zero|0)(?:\s+of\s+\d+)?\s+tests?\s+pass(ed)?\b|\bsome\s+tests?\s+pass(ed)?\b|\b(?:tests?|validation|verification|build)\s+(?:fail(?:ed|ing|ure)?|did\s+not\s+pass)\b|\b\d+\s+(?:tests?\s+)?failed\b|\b(?:implementation\s+)?(?:still\s+|remains?\s+)(?:broken|failing|not\s+working)\b|\b(?:not|never|did\s+not|has\s+not|hasn't|have\s+not|haven't)\s+(?:succeed(ed)?|complete(d)?\s+successfully)\b/i;
/** 成功措辞(非结构化但表达完成/解决): 需上下文确认(Issue#578). bare `verified` 也在此层: "verified the fix" vs "verified the bug" 需 LLM 判断. */
const SUCCESS_PROSE = /\b(successful(?:ly)?|verified|resolved|fixed|working\s+now|works\s+correctly|problem\s+solved|issue\s+resolved|done|complete)\b/i;
/**
 * Harness-coordination noise — agent/tool mechanics, NOT engineering problems to evolve genes for.
 * Observation showed these dominate the "strong" leg (tool errors) and drown out real problems: the agent
 * re-reads a stale file, a string-replace misses, a permission is declined, a request aborts. Dropping them
 * keeps the signal corpus about the environment's *engineering* problems, not the harness's own retry chatter.
 */
const HARNESS_NOISE = /(tool_use_error|has not been read yet|has been modified since|modified since read|String to replace not found|old_string|InputValidationError|permission denied by user|user doesn't want|Request was aborted|operation was aborted|File has not been read)/i;
/** Whether a candidate signal text is harness-coordination noise rather than a real engineering problem. */
export function isHarnessNoise(text) {
    return HARNESS_NOISE.test(text);
}
/**
 * 从 tool_use/tool_result/assistant 文本提取信号(M4A-2). **不读文件内容**, 只看 tool 事件+文本(批注#7/#11).
 * 三条腿: tool 错误结果/显式 Error=strong; agent 标记=agent; 困难措辞无结构=weak(defer LLM).
 */
export function extractSignals(turns) {
    const out = [];
    for (const t of turns) {
        if (t.isMeta)
            continue;
        // 腿1 strong: tool_result 报错(is_error) — 但先滤掉 harness 协调噪声(不是工程问题)
        if (t.errorMessage) {
            if (!isHarnessNoise(t.errorMessage)) {
                out.push({ id: makeUlid(), strength: 'strong', kind: 'error_result', text: t.errorMessage.slice(0, 2000), ...(t.toolName ? { toolName: t.toolName } : {}), needsAnalysis: false });
            }
            continue;
        }
        const text = t.text ?? '';
        const toolResult = t.toolResult ?? '';
        if (!text.trim() && !toolResult.trim())
            continue;
        // 腿3 agent: 显式标记
        const marker = AGENT_MARKERS.map((re) => text.match(re)).find(Boolean);
        if (marker) {
            out.push({ id: makeUlid(), strength: 'agent', kind: 'agent_marked', text: (marker[1] ?? text).trim().slice(0, 2000), needsAnalysis: false });
            continue;
        }
        // Leg 1 strong: inspect both fields. Some adapters populate only toolResult, while older callers may populate
        // text as well; a failure in either representation must outrank a positive substring in the other.
        const resultText = toolResult.trim() ? toolResult : text;
        const structuredFailureText = STRONG_TEXT.test(text) ? text : (STRONG_TEXT.test(toolResult) ? toolResult : '');
        if (structuredFailureText) {
            if (!isHarnessNoise(structuredFailureText)) {
                out.push({ id: makeUlid(), strength: 'strong', kind: 'structured_error', text: structuredFailureText.slice(0, 2000), ...(t.toolName ? { toolName: t.toolName } : {}), needsAnalysis: false });
            }
            continue;
        }
        // Leg 4 success: prefer the actual tool result; adapters intentionally keep tool-turn text empty.
        if (SUCCESS_TEXT.test(resultText) && !SUCCESS_CONFLICT.test(resultText)) {
            if (!isHarnessNoise(resultText)) {
                out.push({ id: makeUlid(), strength: 'success', kind: 'verified_success', text: resultText.slice(0, 2000), ...(t.toolName ? { toolName: t.toolName } : {}), needsAnalysis: false });
            }
            continue;
        }
        // 腿2 weak: 困难措辞无结构 → 交 LLM
        if (DIFFICULTY.test(text)) {
            out.push({ id: makeUlid(), strength: 'weak', kind: 'difficulty', text: text.slice(0, 2000), needsAnalysis: true });
            continue;
        }
        // 腿4 success: 非结构化成功措辞(resolved/fixed/working now 等) → 需上下文确认(Issue#578)
        if (SUCCESS_PROSE.test(text)) {
            out.push({ id: makeUlid(), strength: 'success', kind: 'success_prose', text: text.slice(0, 2000), needsAnalysis: true });
        }
    }
    return out;
}