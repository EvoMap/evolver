import { openSync, writeSync, fsyncSync, closeSync, statSync, readSync, mkdirSync, existsSync, truncateSync, readFileSync, } from 'node:fs';
import { dirname } from 'node:path';
import { monotonicFactory } from 'ulid';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { readRootEventHistory, readRootEventHistoryStrict } from './eventArchive.js';
// Monotonic ULIDs: plain ulid() randomizes the low 80 bits, so two ids minted in the SAME millisecond can sort
// out of order — the event log wants time-sortable eventIds (and a flaky CI test proved it). The monotonic
// factory increments within a millisecond, guaranteeing each successive eventId is strictly greater.
const makeUlid = monotonicFactory();
import { rootEvent, EVENT_SCHEMA_VERSION } from './eventSchema.js';
/** 单行字节上限, 保 O_APPEND+write 在 ext4 的原子性 (军杰 §3.2). */
export const MAX_LINE_BYTES = 4096;
export class LineTooLargeError extends Error {
    bytes;
    constructor(bytes) {
        super(`root_event line ${bytes}B exceeds ${MAX_LINE_BYTES}B; 大 payload 须走 artifact 引用`);
        this.bytes = bytes;
        this.name = 'LineTooLargeError';
    }
}
/** 唯一权威事件流 (AE). single-writer / append-only / seq 递增 / fsync. */
export class EventStore {
    path;
    lockPath;
    now;
    chain = Promise.resolve();
    constructor(opts) {
        this.path = opts.path;
        this.lockPath = `${opts.path}.lock`;
        this.now = opts.now ?? Date.now;
        mkdirSync(dirname(this.path), { recursive: true });
    }
    /** 唯一写路径: 生成 seq/eventId/ts, 校验, 原子 append + fsync. */
    async append(raw) {
        const run = this.chain.then(() => this.appendLocked(raw));
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    appendLocked(raw) {
        // Crash-recoverable, pid-aware O_EXCL lock shared with every other persistence path (localJsonl /
        // materialStore / mailbox / pendingSignals): it reclaims a stale lock left by a crashed writer instead of
        // deadlocking every future append until the .lock is deleted by hand.
        acquireLock(this.lockPath);
        try {
            const seq = this.lastSeqFromFile() + 1;
            const evt = rootEvent.parse({
                seq,
                eventId: makeUlid(),
                ts: new Date(this.now()).toISOString(),
                type: raw.type,
                schemaVersion: raw.schemaVersion ?? EVENT_SCHEMA_VERSION,
                replayability: raw.replayability ?? 'deterministic',
                payload: raw.payload ?? {},
                human: raw.human,
                actor: raw.actor ?? { kind: 'machine' },
            });
            const line = `${JSON.stringify(evt)}\n`;
            const bytes = Buffer.byteLength(line, 'utf8');
            if (bytes > MAX_LINE_BYTES)
                throw new LineTooLargeError(bytes);
            const fd = openSync(this.path, 'a');
            try {
                writeSync(fd, line);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            return evt;
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    /** 读全部事件 (跳过尾部半行/损坏行). */
    readAll() {
        return readRootEventHistory(this.path);
    }
    /** Fail-closed replay for decision policies that cannot safely consume a partial history. */
    readAllStrict() {
        return readRootEventHistoryStrict(this.path);
    }
    *iterate(fromSeq = 0) {
        for (const e of this.readAll())
            if (e.seq >= fromSeq)
                yield e;
    }
    tail(n = 1) {
        const all = this.readAll();
        return all.slice(Math.max(0, all.length - n));
    }
    /** 截断尾部半行 (崩溃恢复). */
    recover() {
        if (!existsSync(this.path))
            return { truncated: false };
        const buf = readFileSync(this.path);
        if (buf.length === 0)
            return { truncated: false };
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl === buf.length - 1)
            return { truncated: false };
        truncateSync(this.path, lastNl + 1);
        return { truncated: true };
    }
    lastSeqFromFile() {
        if (!existsSync(this.path))
            return 0;
        const size = statSync(this.path).size;
        if (size === 0)
            return 0;
        const readBytes = Math.min(8192, size);
        const fd = openSync(this.path, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, size - readBytes);
            const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const o = JSON.parse(lines[i]);
                    if (typeof o.seq === 'number')
                        return o.seq;
                }
                catch { /* skip */ }
            }
            return 0;
        }
        finally {
            closeSync(fd);
        }
    }
}