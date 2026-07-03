export interface ToolEvent {
    toolName?: string;
    toolResult?: string;
    errorMessage?: string;
}
export interface SamplingConfig {
    defaultRate: number;
    toolRates?: Record<string, number>;
    collapseConsecutive: boolean;
    maxPerBatch?: number;
}
export declare const CONSERVATIVE_SAMPLING: SamplingConfig;
/** tool_event 采样/过滤 (批注#12): 强信号(error)全留, 低价值降采样, 连续折叠, 突发限速. */
export declare class ToolEventSampler {
    private readonly cfg;
    private readonly counts;
    private lastTool;
    constructor(cfg: SamplingConfig);
    shouldKeep(e: ToolEvent): boolean;
    filter(events: readonly ToolEvent[]): ToolEvent[];
}