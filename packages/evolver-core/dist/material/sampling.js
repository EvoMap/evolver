export const CONSERVATIVE_SAMPLING = {
    defaultRate: 1, toolRates: { read: 100, ls: 100, glob: 50, grep: 20 }, collapseConsecutive: true, maxPerBatch: 500,
};
/** tool_event 采样/过滤 (批注#12): 强信号(error)全留, 低价值降采样, 连续折叠, 突发限速. */
export class ToolEventSampler {
    cfg;
    counts = new Map();
    lastTool;
    constructor(cfg) {
        this.cfg = cfg;
    }
    shouldKeep(e) {
        if (e.errorMessage) {
            this.lastTool = e.toolName;
            return true;
        } // 错误 100% 保留
        const name = e.toolName ?? '';
        if (this.cfg.collapseConsecutive && name === this.lastTool) {
            return false;
        } // 折叠连续相同
        this.lastTool = name;
        const rate = this.cfg.toolRates?.[name] ?? this.cfg.defaultRate;
        if (rate <= 1)
            return true;
        const n = (this.counts.get(name) ?? 0) + 1;
        this.counts.set(name, n);
        return n % rate === 1; // 每 N 留第 1 个
    }
    filter(events) {
        const out = [];
        for (const e of events) {
            if (this.cfg.maxPerBatch !== undefined && out.length >= this.cfg.maxPerBatch)
                break;
            if (this.shouldKeep(e))
                out.push(e);
        }
        return out;
    }
}