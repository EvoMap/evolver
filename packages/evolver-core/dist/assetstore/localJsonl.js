import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { normalizeForPut, } from './provider.js';
const FILES = { Gene: 'genes.jsonl', Capsule: 'capsules.jsonl', EvolutionEvent: 'events.jsonl', AntiGene: 'anti-genes.jsonl' };
function signalsOf(a) {
    const out = [];
    for (const key of ['signals_match', 'signals', 'trigger', 'trigger_signals']) {
        const v = a[key];
        if (Array.isArray(v))
            for (const s of v)
                if (typeof s === 'string')
                    out.push(s);
    }
    return out;
}
/**
 * 本地 jsonl 资产库(M3-2, 移植 v1 src/gep/assetStore.js 单写锁).
 * 每 kind 一文件(genes/capsules/events.jsonl); append-only; O_EXCL 文件锁防并发写撕裂;
 * 内存索引(asset_id→record)供 get/search; 同 asset_id 去重(内容寻址天然幂等).
 */
export class LocalJsonlProvider {
    baseDir;
    index = new Map();
    lockPath;
    loaded = false;
    // `baseDir` is public-readonly so callers that inject a store (e.g. the CLI under test) can co-locate sidecars
    // — the ReviewLedger/ProvenanceStore — in the SAME directory, instead of defaulting to the real ~/.evomap.
    constructor(baseDir) {
        this.baseDir = baseDir;
        mkdirSync(baseDir, { recursive: true });
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    ensureLoaded() {
        if (this.loaded)
            return;
        for (const file of Object.values(FILES)) {
            const p = join(this.baseDir, file);
            if (!existsSync(p))
                continue;
            for (const line of readFileSync(p, 'utf8').split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const r = JSON.parse(line);
                    if (r.asset_id)
                        this.index.set(r.asset_id, r);
                }
                catch { /* skip 坏行 */ }
            }
        }
        this.loaded = true;
    }
    async put(asset) {
        this.ensureLoaded();
        const { record, verified } = normalizeForPut(asset);
        if (this.index.has(record.asset_id))
            return { asset_id: record.asset_id, stored: false, verified };
        const file = join(this.baseDir, FILES[record.type]);
        acquireLock(this.lockPath);
        try {
            // 锁内复检(另一进程可能刚写)
            if (!this.index.has(record.asset_id)) {
                appendFileSync(file, `${JSON.stringify(record)}\n`);
                this.index.set(record.asset_id, record);
            }
            else {
                return { asset_id: record.asset_id, stored: false, verified };
            }
        }
        finally {
            releaseLock(this.lockPath);
        }
        return { asset_id: record.asset_id, stored: true, verified };
    }
    /**
     * 迁移专用(M8-2): 以**冻结 asset_id** 原样写入, 不经 normalizeForPut 重算/校验.
     * 仅 v1→v2 导入用(硬化 A6 存量冻结); 普通写一律走 put(). record 必须自带 asset_id.
     */
    async putFrozen(record) {
        this.ensureLoaded();
        if (!record.asset_id)
            throw new Error('putFrozen 需 record 自带冻结 asset_id');
        if (this.index.has(record.asset_id))
            return { asset_id: record.asset_id, stored: false, verified: false };
        const file = join(this.baseDir, FILES[record.type]);
        acquireLock(this.lockPath);
        try {
            if (this.index.has(record.asset_id))
                return { asset_id: record.asset_id, stored: false, verified: false };
            appendFileSync(file, `${JSON.stringify(record)}\n`);
            this.index.set(record.asset_id, record);
        }
        finally {
            releaseLock(this.lockPath);
        }
        return { asset_id: record.asset_id, stored: true, verified: false };
    }
    async get(assetId) {
        this.ensureLoaded();
        return this.index.get(assetId) ?? null;
    }
    async list(kind, limit = 1000) {
        this.ensureLoaded();
        const out = [];
        for (const r of this.index.values()) {
            if (!kind || r.type === kind)
                out.push(r);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    async search(q) {
        this.ensureLoaded();
        const out = [];
        for (const r of this.index.values()) {
            if (q.kind && r.type !== q.kind)
                continue;
            if (q.category) {
                const cat = r.category ?? r.intent;
                if (cat !== q.category)
                    continue;
            }
            if (q.gene && r.gene !== q.gene)
                continue;
            if (q.signalsAny && q.signalsAny.length > 0) {
                const sig = new Set(signalsOf(r));
                if (!q.signalsAny.some((s) => sig.has(s)))
                    continue;
            }
            if (q.text) {
                const summary = String(r.summary ?? '');
                if (!summary.includes(q.text))
                    continue;
            }
            out.push(r);
            if (out.length >= (q.limit ?? 1000))
                break;
        }
        return out;
    }
    /**
     * Opt-in log compaction: rewrite each kind's jsonl keeping ONE line per asset_id (last wins),
     * dropping duplicate/corrupt lines that accumulate across processes/restarts/migration. Lossless
     * because the store is content-addressed (one record per asset_id is all there ever was). This does
     * NOT evict assets — every unique asset is knowledge that stays. Atomic per file (temp + rename) under
     * the write lock. Returns kept/removed line counts.
     */
    async compact() {
        this.ensureLoaded();
        acquireLock(this.lockPath);
        try {
            let kept = 0, removed = 0;
            for (const [kind, file] of Object.entries(FILES)) {
                const p = join(this.baseDir, file);
                if (!existsSync(p))
                    continue;
                const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
                const byId = new Map(); // asset_id → raw line (last wins, matching load semantics)
                for (const line of lines) {
                    try {
                        const r = JSON.parse(line);
                        if (r.asset_id && r.type === kind)
                            byId.set(r.asset_id, line);
                    }
                    catch { /* drop corrupt line */ }
                }
                const out = byId.size ? `${[...byId.values()].join('\n')}\n` : '';
                const tmp = `${p}.compact.tmp`;
                writeFileSync(tmp, out);
                renameSync(tmp, p); // atomic replace; a crash mid-compact leaves the original intact
                kept += byId.size;
                removed += lines.length - byId.size;
            }
            return { kept, removed };
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
}