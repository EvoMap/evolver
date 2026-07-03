/** 闸1: cycle-local 状态每轮 reset (D15/军杰附录A). 新 cycle = 新 context, 结束销毁. */
export class CycleContext {
    cycleId;
    local = new Map();
    disposed = false;
    constructor(cycleId) { this.cycleId = cycleId; }
    set(k, v) { this.assertLive(); this.local.set(k, v); }
    get(k) { return this.local.get(k); }
    has(k) { return this.local.has(k); }
    dispose() { this.local.clear(); this.disposed = true; }
    assertLive() { if (this.disposed)
        throw new Error('CycleContext 已销毁: cycle-local 不可跨 cycle'); }
}