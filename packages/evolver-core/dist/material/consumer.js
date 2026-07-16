import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** consumer group + 进度游标 (at-least-once): committed 仅 ack 后推进, 防重复消费. */
export class ConsumerGroups {
    opts;
    committed = new Map();
    constructor(opts) {
        this.opts = opts;
        // A corrupt cursor (a crash mid-persist) must NOT crash the resident daemon at startup: degrade to empty
        // (re-claim from 0). At-least-once + idempotent downstream make re-processing safe, far better than a crash loop.
        if (opts.path && existsSync(opts.path)) {
            try {
                const o = JSON.parse(readFileSync(opts.path, 'utf8'));
                for (const [k, v] of Object.entries(o)) {
                    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
                        this.committed.set(k, v);
                }
            }
            catch { /* corrupt cursor → start from 0 (idempotent re-claim) */ }
        }
    }
    cur(group) { return this.committed.get(group) ?? 0; }
    /** 取下一批未 ack 的 (不推进 committed → 崩溃重启再 claim 拿到同批). */
    claim(group, batchSize) {
        return this.opts.store.readRange(this.cur(group), batchSize);
    }
    /** ack: 把 committed 推过 acked 的连续前缀. */
    ack(group, materialIds) {
        const ackSet = new Set(materialIds);
        let c = this.cur(group);
        const claimed = this.opts.store.readRange(c, ackSet.size);
        for (const record of claimed) {
            if (!ackSet.has(record.materialId))
                break;
            c += 1;
        }
        this.committed.set(group, c);
        this.persist();
    }
    /** reset: 'earliest' 重放全部历史 / 指定 index. */
    reset(group, to) {
        this.committed.set(group, to === 'earliest' ? 0 : to);
        this.persist();
    }
    position(group) { return this.cur(group); }
    persist() {
        if (!this.opts.path)
            return;
        mkdirSync(dirname(this.opts.path), { recursive: true });
        // Atomic write: a crash mid-write must leave the OLD cursor intact, not a truncated/corrupt file.
        const tmp = `${this.opts.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.committed)));
        renameSync(tmp, this.opts.path);
    }
}