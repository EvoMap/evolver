import { acquireLock, releaseLock } from '../util/fileLock.js';
import { DrainController } from '../daemon/drain.js';
/**
 * Mailbox daemon 循环(M2-9), 整进军杰附录 A 四闸:
 * - 闸1 cycle-local: 每 tick 独立(dispatcher 无跨 tick 可变态).
 * - 闸2 drain: draining 时拒新 tick, 排空进行中再退.
 * - 闸3 watchdog: 暴露 lastWriteAt 供外部 watchdog 判挂死.
 * - 闸4 幂等: dispatcher 经 store idempotency 表(无时间窗)去重副作用.
 * 单写: 可选 O_EXCL 文件锁.
 */
export class MailboxDaemon {
    deps;
    drain;
    lastActivityAt;
    ticks = 0;
    locked = false;
    constructor(deps) {
        this.deps = deps;
        this.drain = deps.drain ?? new DrainController();
        this.lastActivityAt = deps.now();
    }
    start() {
        if (this.deps.lockPath && !this.locked) {
            acquireLock(this.deps.lockPath);
            this.locked = true;
        }
        this.lastActivityAt = this.deps.now();
    }
    /** 一个处理周期: pump(core+proxy) + waker.tick + 周期性 TTL 扫描. */
    async tick() {
        if (!this.drain.acceptCycle())
            return { skipped: true, dispatched: [], woken: [], expired: 0 };
        this.drain.beginCycle();
        try {
            const now = this.deps.now();
            const dispatched = await this.deps.dispatcher.pump({ handlers: this.deps.pumpHandlers });
            const woken = this.deps.waker ? await this.deps.waker.tick() : [];
            let expired = 0;
            this.ticks += 1;
            if (this.ticks % (this.deps.expireEveryTicks ?? 60) === 0)
                expired = this.deps.store.expireOld(now);
            if (dispatched.length > 0 || woken.some((w) => w.action !== 'none') || expired > 0)
                this.lastActivityAt = now;
            return { skipped: false, dispatched, woken, expired };
        }
        finally {
            this.drain.endCycle();
        }
    }
    /** 闸3: root_events/活动最后写入时间, 喂外部 Watchdog. */
    lastWriteAt() { return this.lastActivityAt; }
    /** 闸2: 优雅停机 — 停接新 tick, 排空进行中, 释放锁. */
    async stop() {
        await this.drain.drain();
        if (this.deps.lockPath && this.locked) {
            releaseLock(this.deps.lockPath);
            this.locked = false;
        }
    }
    get isDraining() { return this.drain.isDraining; }
}