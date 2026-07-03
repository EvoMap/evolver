/** 来源边界 (批注#37): Material 只来自 session/tool log, 杜绝 root_events/asset/MV 回灌. */
const FORBIDDEN = [
    /root_events\.jsonl/, /genes\.jsonl/, /capsules\.jsonl/, /\bevents\.jsonl/,
    /[/\\]mv[/\\]/, /[/\\]assets[/\\]/,
];
export class MaterialBoundaryError extends Error {
    constructor(msg) { super(`来源边界违规: ${msg}`); this.name = 'MaterialBoundaryError'; }
}
export function assertMaterialSource(m) {
    if (m.kind !== 'session_log' && m.kind !== 'tool_event' && m.kind !== 'llm_trace')
        throw new MaterialBoundaryError(`非法 kind: ${m.kind} (只允许 session_log/tool_event/llm_trace)`);
    if (FORBIDDEN.some((re) => re.test(m.sourcePath)))
        throw new MaterialBoundaryError(`禁止把资产/事件层回灌为 Material: ${m.sourcePath}`);
}