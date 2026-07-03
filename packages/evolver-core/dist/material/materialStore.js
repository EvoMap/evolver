import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { material } from '../schema/material.js';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { assertMaterialSource } from './boundary.js';
/** 原材料库 (append-only jsonl + single-writer + materialId 去重). */
export class MaterialStore {
    path;
    lockPath;
    seen = new Set();
    chain = Promise.resolve();
    constructor(opts) {
        this.path = opts.path;
        this.lockPath = `${opts.path}.lock`;
        mkdirSync(dirname(this.path), { recursive: true });
        for (const m of this.readAll())
            this.seen.add(m.materialId);
    }
    /** 幂等 put: 已存在 materialId 跳过. */
    async put(input) {
        const run = this.chain.then(() => this.putLocked(input));
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    putLocked(input) {
        const m = material.parse(input);
        assertMaterialSource(m);
        if (this.seen.has(m.materialId))
            return { material: m, stored: false };
        acquireLock(this.lockPath);
        try {
            const fd = openSync(this.path, 'a');
            try {
                writeSync(fd, `${JSON.stringify(m)}\n`);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            this.seen.add(m.materialId);
            return { material: m, stored: true };
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    get(materialId) {
        for (const m of this.readAll())
            if (m.materialId === materialId)
                return m;
        return undefined;
    }
    readAll() {
        if (!existsSync(this.path))
            return [];
        const out = [];
        for (const l of readFileSync(this.path, 'utf8').split('\n')) {
            if (!l)
                continue;
            try {
                out.push(material.parse(JSON.parse(l)));
            }
            catch { /* skip */ }
        }
        return out;
    }
    *iterate(opts = {}) {
        for (const m of this.readAll()) {
            if (opts.consumerGroup !== undefined && m.consumerGroup !== opts.consumerGroup)
                continue;
            if (opts.since !== undefined && m.capturedAt < opts.since)
                continue;
            yield m;
        }
    }
}