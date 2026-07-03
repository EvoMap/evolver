import { ulid as makeUlid } from 'ulid';
/** agent 显式信号标记(第三条腿; 与 evolver 显式信号注入旁枝呼应). */
const AGENT_MARKERS = [/\bEVOLVE_SIGNAL:\s*(.+)/i, /\[SIGNAL\]\s*(.+)/i];
/** 结构化强信号: 栈/退出码/显式 Error — 零成本判断, 不动 LLM. */
const STRONG_TEXT = /(^|\n)\s*(Error:|Traceback|Exception|FAILED|panic:|\bexit code [1-9])/;
/** 弱信号: 表达困难但无结构, 需 LLM 拼语境. */
const DIFFICULTY = /(无法|失败|搞不定|stuck|can'?t|unable to|not working|报错|卡住)/i;
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
        if (!text.trim())
            continue;
        // 腿3 agent: 显式标记
        const marker = AGENT_MARKERS.map((re) => text.match(re)).find(Boolean);
        if (marker) {
            out.push({ id: makeUlid(), strength: 'agent', kind: 'agent_marked', text: (marker[1] ?? text).trim().slice(0, 2000), needsAnalysis: false });
            continue;
        }
        // 腿1 strong: 结构化 Error 文本(同样滤掉 harness 噪声)
        if (STRONG_TEXT.test(text)) {
            if (!isHarnessNoise(text)) {
                out.push({ id: makeUlid(), strength: 'strong', kind: 'structured_error', text: text.slice(0, 2000), needsAnalysis: false });
            }
            continue;
        }
        // 腿2 weak: 困难措辞无结构 → 交 LLM
        if (DIFFICULTY.test(text)) {
            out.push({ id: makeUlid(), strength: 'weak', kind: 'difficulty', text: text.slice(0, 2000), needsAnalysis: true });
        }
    }
    return out;
}