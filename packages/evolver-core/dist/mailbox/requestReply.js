/** 应答超时. correlationId 保留以便审计/重试. */
export class ReplyTimeoutError extends Error {
    correlationId;
    constructor(correlationId, reason = 'reply timeout') {
        super(`关联 ${correlationId} 应答超时: ${reason}`);
        this.correlationId = correlationId;
        this.name = 'ReplyTimeoutError';
    }
}
/**
 * 进程内应答等待器(M2-5). 一个 daemon 生命周期内: request 注册 waiter, dispatch 收到 inbound 即 notify 唤醒.
 * 不持有定时器(由 sweep(now) 推进 deadline), 测试可确定性驱动; durable 兜底走 store.getReply.
 */
export class ReplyRegistry {
    waiters = new Map();
    /** 注册等待 correlationId 的应答; 由 notify 解决, 由 sweep/expire 拒绝. */
    await(correlationId, requestId, deadline) {
        return new Promise((resolve, reject) => {
            const prev = this.waiters.get(correlationId);
            if (prev)
                prev.reject(new ReplyTimeoutError(correlationId, '被同关联新等待覆盖'));
            this.waiters.set(correlationId, { resolve, reject, requestId, deadline });
        });
    }
    /** 收到 envelope: 若是匹配关联的应答(非请求自身)则唤醒对应 waiter. */
    notify(e) {
        const w = this.waiters.get(e.correlationId);
        if (!w || e.id === w.requestId)
            return false; // 没人等 / 是请求自身
        this.waiters.delete(e.correlationId);
        w.resolve(e);
        return true;
    }
    /** 推进时钟: deadline 已过的 waiter 全部超时拒绝. 返回过期数. */
    sweep(now) {
        let n = 0;
        for (const [cid, w] of this.waiters) {
            if (w.deadline <= now) {
                this.waiters.delete(cid);
                w.reject(new ReplyTimeoutError(cid));
                n += 1;
            }
        }
        return n;
    }
    /** 显式过期单个关联(如收到 failed/expired 终态). */
    expire(correlationId, reason) {
        const w = this.waiters.get(correlationId);
        if (!w)
            return false;
        this.waiters.delete(correlationId);
        w.reject(new ReplyTimeoutError(correlationId, reason));
        return true;
    }
    pending() { return this.waiters.size; }
}
/**
 * 请求-应答门面: 绑定 store(durable) + registry(live).
 * request 投递并注册 waiter; 应答既可经 notify 实时唤醒, 也可经 store.getReply durable 兜底.
 */
export class RequestReply {
    store;
    registry;
    constructor(store, registry = new ReplyRegistry()) {
        this.store = store;
        this.registry = registry;
    }
    /** 投递请求, 返回 correlationId/requestId; 应答到达前先查 durable 已存(幂等重入). */
    request(env, timeoutMs, now) {
        this.store.send(env);
        const existing = this.store.getReply(env.correlationId, env.id);
        const reply = existing ? Promise.resolve(existing) : this.registry.await(env.correlationId, env.id, now + timeoutMs);
        return { correlationId: env.correlationId, requestId: env.id, reply };
    }
    /** dispatch 收到 inbound 时调用: 唤醒等待者. */
    deliver(e) { return this.registry.notify(e); }
}