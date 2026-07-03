/**
 * 选择性 Material 判定(M2-7). 默认遵目录 feedsMaterial; 两类在 dispatch 决定:
 * - asset_publish_result: 仅 rejected 进(失败=养料 #40); 通过无需.
 * - swarm.*: 仅带结论的进; 中间消息不进.
 */
export function shouldFeedMaterial(e) {
    if (e.type === 'asset_publish_result') {
        return e.payload?.status === 'rejected';
    }
    if (e.type.startsWith('swarm.')) {
        const p = e.payload;
        return p?.conclusion !== undefined || p?.final === true;
    }
    return e.feedsMaterial;
}
/**
 * 三-handler 分派器(M2-7). 谁 claim 谁 complete:
 * - daemon 侧 pump core+proxy(确定性/hub 往返).
 * - agent 类常由外部 runtime 经 IPC(M2-6) claim+complete; 嵌入式可显式 pump ['agent'].
 */
export class Dispatcher {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async dispatchOne(e) {
        const now = this.deps.now();
        // 副作用幂等: 业务键(非默认=id)命中 → 跳过不二次执行, 直接 complete (money-safety A7/A13)
        const sideEffecting = e.handler !== 'agent' && e.idempotencyKey !== e.id;
        if (sideEffecting && this.deps.store.isProcessed(e.idempotencyKey)) {
            this.deps.store.complete(e.id, now);
            return { id: e.id, handler: e.handler, handled: true, fedMaterial: false, note: 'idempotent-skip' };
        }
        try {
            const result = await this.deps.handlers[e.handler](e);
            let fedMaterial = false;
            if (this.deps.onMaterial && shouldFeedMaterial(e)) {
                await this.deps.onMaterial(e);
                fedMaterial = true;
            }
            if (sideEffecting)
                this.deps.store.markProcessed(e.idempotencyKey, result ?? null, now);
            this.deps.store.complete(e.id, now);
            return { id: e.id, handler: e.handler, handled: true, fedMaterial };
        }
        catch (err) {
            this.deps.store.fail(e.id, err instanceof Error ? err.message : String(err), now);
            return { id: e.id, handler: e.handler, handled: false, fedMaterial: false, note: 'failed' };
        }
    }
    /** 拉一批并分派. 默认 daemon 侧 core+proxy; agent 由 runtime 经 IPC 拉取. */
    async pump(opts = {}) {
        const kinds = opts.handlers ?? ['core', 'proxy'];
        const out = [];
        for (const k of kinds) {
            const batch = this.deps.store.claim(k, opts.limit ?? 16, opts.leaseMs ?? 30_000, this.deps.now(), opts.runtimeNamespace);
            for (const e of batch)
                out.push(await this.dispatchOne(e));
        }
        return out;
    }
}