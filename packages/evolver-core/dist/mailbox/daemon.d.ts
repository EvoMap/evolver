import { DrainController } from '../daemon/drain.js';
import type { MailboxStore } from './store.js';
import type { Dispatcher, DispatchResult } from './dispatch.js';
import type { AgentWaker, WakeOutcome } from './wake.js';
import type { Handler } from './catalog.js';
export interface MailboxDaemonDeps {
    store: MailboxStore;
    dispatcher: Dispatcher;
    waker?: AgentWaker;
    /** 闸2 drain: 注入共享或自建. */
    drain?: DrainController;
    /** 单写文件锁(可选); 防多 daemon 同时 pump 同信箱. */
    lockPath?: string;
    now: () => number;
    /** 每 N 个 tick 跑一次 TTL 扫描(默认 60). */
    expireEveryTicks?: number;
    pumpHandlers?: Handler[];
}
export interface TickReport {
    skipped: boolean;
    dispatched: DispatchResult[];
    woken: WakeOutcome[];
    expired: number;
}
/**
 * Mailbox daemon 循环(M2-9), 整进军杰附录 A 四闸:
 * - 闸1 cycle-local: 每 tick 独立(dispatcher 无跨 tick 可变态).
 * - 闸2 drain: draining 时拒新 tick, 排空进行中再退.
 * - 闸3 watchdog: 暴露 lastWriteAt 供外部 watchdog 判挂死.
 * - 闸4 幂等: dispatcher 经 store idempotency 表(无时间窗)去重副作用.
 * 单写: 可选 O_EXCL 文件锁.
 */
export declare class MailboxDaemon {
    private readonly deps;
    private readonly drain;
    private lastActivityAt;
    private ticks;
    private locked;
    constructor(deps: MailboxDaemonDeps);
    start(): void;
    /** 一个处理周期: pump(core+proxy) + waker.tick + 周期性 TTL 扫描. */
    tick(): Promise<TickReport>;
    /** 闸3: root_events/活动最后写入时间, 喂外部 Watchdog. */
    lastWriteAt(): number;
    /** 闸2: 优雅停机 — 停接新 tick, 排空进行中, 释放锁. */
    stop(): Promise<void>;
    get isDraining(): boolean;
}