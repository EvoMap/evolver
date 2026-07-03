import { MailboxStore } from '../mailbox/store.js';
import type { ShadowSink, ShadowMode } from './sink.js';
/**
 * shadow 包 MailboxStore(M8-1-shadow-d). MailboxStore 含 private db, wrapper 无法结构赋值 →
 * **继承** override complete/fail: shadow 下记 WOULD_MAILBOX_* 但 SQL no-op(消息留 in_flight, enforce 可再处理)。
 * markProcessed/isProcessed/getProcessed 继承真写(保 Dispatcher 幂等, gotcha #3); claim/send/state 等全继承真行为。
 */
export declare class ShadowMailboxStore extends MailboxStore {
    private readonly sink;
    private readonly mode;
    constructor(opts: {
        path: string;
        busyTimeoutMs?: number;
    }, sink: ShadowSink, mode: ShadowMode);
    complete(id: string, now: number): void;
    fail(id: string, err: string, now: number, maxAttempts?: number): void;
}