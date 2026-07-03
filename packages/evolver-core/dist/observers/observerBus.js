export class InvalidObserverMetaError extends Error {
    constructor(msg) { super(`observer meta 非法: ${msg}`); this.name = 'InvalidObserverMetaError'; }
}
function deepFreeze(o) {
    if (o && typeof o === 'object') {
        for (const v of Object.values(o))
            deepFreeze(v);
        Object.freeze(o);
    }
    return o;
}
/** 进程内 observer bus (军杰§8): meta 强制 + quarantine + DLQ; 旁路, 故障绝不影响主写路径. */
export class ObserverBus {
    observers = new Map();
    quarantined = new Set();
    dlq = [];
    failCounts = new Map();
    inflight = [];
    poisonThreshold;
    constructor(opts = {}) { this.poisonThreshold = opts.poisonThreshold ?? 1; }
    register(observer) {
        const m = observer.meta;
        if (!m || typeof m.name !== 'string' || m.name.length === 0)
            throw new InvalidObserverMetaError('name 必填');
        if (typeof m.idempotent !== 'boolean')
            throw new InvalidObserverMetaError('idempotent 必填(boolean)');
        if (typeof m.timeoutMs !== 'number' || m.timeoutMs <= 0)
            throw new InvalidObserverMetaError('timeoutMs 必填(>0)');
        if (this.observers.has(m.name))
            throw new InvalidObserverMetaError(`重名 observer: ${m.name}`);
        this.observers.set(m.name, observer);
    }
    /** fan-out: 非阻塞, observer 故障隔离, 绝不向调用方抛. */
    dispatch(event) {
        const frozen = deepFreeze(structuredClone(event));
        for (const obs of this.observers.values()) {
            if (this.quarantined.has(obs.meta.name))
                continue;
            if (obs.meta.eventTypes && !obs.meta.eventTypes.includes(event.type))
                continue;
            this.inflight.push(this.run(obs, frozen));
        }
    }
    async run(obs, event) {
        try {
            await this.withTimeout(Promise.resolve(obs.handle(event)), obs.meta.timeoutMs, obs.meta.name);
            this.failCounts.delete(obs.meta.name);
        }
        catch (e) {
            const reason = e._timeout ? 'timeout' : 'throw';
            this.dlq.push({ observer: obs.meta.name, event, error: e.message, at: new Date().toISOString(), reason });
            const n = (this.failCounts.get(obs.meta.name) ?? 0) + 1;
            this.failCounts.set(obs.meta.name, n);
            if (n >= this.poisonThreshold || reason === 'timeout')
                this.quarantined.add(obs.meta.name);
        }
    }
    withTimeout(p, ms, name) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                const err = new Error(`observer ${name} 超时 ${ms}ms`);
                err._timeout = true;
                reject(err);
            }, ms);
            p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
        });
    }
    /** 等所有 inflight 完成 (优雅关闭/测试). */
    async drain() { const cur = this.inflight; this.inflight = []; await Promise.allSettled(cur); }
    isQuarantined(name) { return this.quarantined.has(name); }
    reset(name) { this.quarantined.delete(name); this.failCounts.delete(name); }
    deadLetters() { return this.dlq; }
}