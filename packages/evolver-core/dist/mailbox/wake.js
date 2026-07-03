/**
 * Agent 唤醒器(M2-8). 监视各 namespace 的 pending agent 消息, 去抖后唤醒 runtime:
 * - resident 且存活 → signal(轻量 poke).
 * - one-shot 或 resident 已死 → spawn(拉起进程).
 * runtime 起来后经 IPC(M2-6) claim('agent') 自取消息.
 */
export class AgentWaker {
    deps;
    lastWake = new Map();
    cooldownMs;
    constructor(deps) {
        this.deps = deps;
        this.cooldownMs = deps.cooldownMs ?? 2000;
    }
    resolveTargets() {
        return typeof this.deps.targets === 'function' ? this.deps.targets() : this.deps.targets;
    }
    /** 扫一轮: 对有 pending agent 工作且过了冷却的 namespace 触发唤醒. */
    async tick() {
        const now = this.deps.now();
        const out = [];
        for (const t of this.resolveTargets()) {
            const pending = this.deps.store.countPending('agent', t.runtimeNamespace);
            if (pending === 0) {
                out.push({ runtimeNamespace: t.runtimeNamespace, action: 'none', pending, reason: 'idle' });
                continue;
            }
            const last = this.lastWake.get(t.runtimeNamespace) ?? -Infinity;
            if (now - last < this.cooldownMs) {
                out.push({ runtimeNamespace: t.runtimeNamespace, action: 'none', pending, reason: 'cooldown' });
                continue;
            }
            const alive = t.mode === 'resident' && (t.isAlive ? t.isAlive() : true);
            let action = 'none';
            if (alive && t.signal) {
                await t.signal();
                action = 'signal';
            }
            else if (t.spawn) {
                await t.spawn();
                action = 'spawn';
            }
            else if (t.signal) {
                await t.signal();
                action = 'signal';
            } // 无 spawn 回退 signal
            if (action !== 'none')
                this.lastWake.set(t.runtimeNamespace, now);
            out.push({ runtimeNamespace: t.runtimeNamespace, action, pending });
        }
        return out;
    }
    /** 测试/强制: 清冷却(下次 tick 必唤醒). */
    resetCooldown(runtimeNamespace) {
        if (runtimeNamespace)
            this.lastWake.delete(runtimeNamespace);
        else
            this.lastWake.clear();
    }
}