import { MailboxStore } from '../mailbox/store.js';
/**
 * shadow 包 MailboxStore(M8-1-shadow-d). MailboxStore 含 private db, wrapper 无法结构赋值 →
 * **继承** override complete/fail: shadow 下记 WOULD_MAILBOX_* 但 SQL no-op(消息留 in_flight, enforce 可再处理)。
 * markProcessed/isProcessed/getProcessed 继承真写(保 Dispatcher 幂等, gotcha #3); claim/send/state 等全继承真行为。
 */
export class ShadowMailboxStore extends MailboxStore {
    sink;
    mode;
    constructor(opts, sink, mode) {
        super(opts);
        this.sink = sink;
        this.mode = mode;
    }
    complete(id, now) {
        if (this.mode === 'enforce')
            return super.complete(id, now);
        this.sink.record({ action: 'WOULD_MAILBOX_COMPLETE' }); // no-op: 留 in_flight
    }
    fail(id, err, now, maxAttempts) {
        if (this.mode === 'enforce')
            return super.fail(id, err, now, maxAttempts);
        this.sink.record({ action: 'WOULD_MAILBOX_FAIL' }); // no-op
    }
}