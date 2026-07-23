/** 信号源的最小结构(结构化匹配 runtime-adapters 的 NormalizedTurn; core 不跨包依赖, 守边界). */
export interface SignalSourceTurn {
    text?: string;
    toolName?: string;
    toolResult?: string;
    errorMessage?: string;
    isMeta?: boolean;
}
/** 信号强度四条腿(批注#13): strong=零成本结构化错误判断 / agent=自标记 / weak=需 LLM 分析 / success=成功信号(Issue#578). */
export type SignalStrength = 'strong' | 'agent' | 'weak' | 'success';
export interface ExtractedSignal {
    id: string;
    strength: SignalStrength;
    kind: string;
    text: string;
    toolName?: string;
    needsAnalysis: boolean;
}
/** Whether a candidate signal text is harness-coordination noise rather than a real engineering problem. */
export declare function isHarnessNoise(text: string): boolean;
/**
 * 从 tool_use/tool_result/assistant 文本提取信号(M4A-2). **不读文件内容**, 只看 tool 事件+文本(批注#7/#11).
 * 三条腿: tool 错误结果/显式 Error=strong; agent 标记=agent; 困难措辞无结构=weak(defer LLM).
 */
export declare function extractSignals(turns: readonly SignalSourceTurn[]): ExtractedSignal[];