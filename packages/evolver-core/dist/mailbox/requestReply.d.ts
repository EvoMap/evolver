import type { Envelope } from './envelope.js';
import type { MailboxStore } from './store.js';
/** 应答超时. correlationId 保留以便审计/重试. */
export declare class ReplyTimeoutError extends Error {
    readonly correlationId: string;
    constructor(correlationId: string, reason?: string);
}
/**
 * 进程内应答等待器(M2-5). 一个 daemon 生命周期内: request 注册 waiter, dispatch 收到 inbound 即 notify 唤醒.
 * 不持有定时器(由 sweep(now) 推进 deadline), 测试可确定性驱动; durable 兜底走 store.getReply.
 */
export declare class ReplyRegistry {
    private readonly waiters;
    /** 注册等待 correlationId 的应答; 由 notify 解决, 由 sweep/expire 拒绝. */
    await(correlationId: string, requestId: string, deadline: number): Promise<Envelope>;
    /** 收到 envelope: 若是匹配关联的应答(非请求自身)则唤醒对应 waiter. */
    notify(e: Envelope): boolean;
    /** 推进时钟: deadline 已过的 waiter 全部超时拒绝. 返回过期数. */
    sweep(now: number): number;
    /** 显式过期单个关联(如收到 failed/expired 终态). */
    expire(correlationId: string, reason?: string): boolean;
    pending(): number;
}
/**
 * 请求-应答门面: 绑定 store(durable) + registry(live).
 * request 投递并注册 waiter; 应答既可经 notify 实时唤醒, 也可经 store.getReply durable 兜底.
 */
export declare class RequestReply {
    private readonly store;
    readonly registry: ReplyRegistry;
    constructor(store: MailboxStore, registry?: ReplyRegistry);
    /** 投递请求, 返回 correlationId/requestId; 应答到达前先查 durable 已存(幂等重入). */
    request(env: Envelope, timeoutMs: number, now: number): {
        correlationId: string;
        requestId: string;
        reply: Promise<Envelope>;
    };
    /** dispatch 收到 inbound 时调用: 唤醒等待者. */
    deliver(e: Envelope): boolean;
}