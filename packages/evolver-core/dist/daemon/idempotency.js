import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** 闸4: cycle_id 幂等键. 同 cycleId+opKey 的副作用只执行一次(daemon 重启 replay/重试不重复). */
export class IdempotencyGuard {
    path;
    done = new Map();
    constructor(path) {
        this.path = path;
        if (path && existsSync(path))
            this.load();
    }
    k(cycleId, opKey) { return `${cycleId}\x1f${opKey}`; }
    has(cycleId, opKey) { return this.done.has(this.k(cycleId, opKey)); }
    async once(cycleId, opKey, fn) {
        const key = this.k(cycleId, opKey);
        if (this.done.has(key))
            return this.done.get(key);
        const r = await fn();
        this.done.set(key, r);
        this.persist();
        return r;
    }
    persist() {
        if (!this.path)
            return;
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.done)));
    }
    load() {
        if (!this.path)
            return;
        const o = JSON.parse(readFileSync(this.path, 'utf8'));
        for (const [k, v] of Object.entries(o))
            this.done.set(k, v);
    }
}