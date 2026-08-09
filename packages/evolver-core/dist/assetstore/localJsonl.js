import { join } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { appendUtf8Durable, assertAssetStoreDirectory, assertOptionalRegularFile, ensureAssetStoreDirectory, readUtf8Regular, regularFileFingerprint, replaceUtf8Durable, } from './assetStoreStorage.js';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { FrozenAssetIdCollisionError, frozenAssetRecordsEqual, normalizeForPut, } from './provider.js';
function resultLogicalId(logicalId) {
    return logicalId !== undefined && logicalId.length > 0 && logicalId === logicalId.trim()
        ? logicalId
        : undefined;
}
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
 * 内存索引(asset_id→record)供 get/search; 文件指纹变化时在共享锁内重建索引，保证多个
 * CLI/daemon 进程之间可见; 写入也在锁内刷新后再按 asset_id 去重(内容寻址天然幂等).
 */
export class LocalJsonlProvider {
    baseDir;
    index = new Map();
    lockPath;
    fileState = new Map();
    loaded = false;
    // `baseDir` is public-readonly so callers that inject a store (e.g. the CLI under test) can co-locate sidecars
    // — the ReviewLedger/ProvenanceStore — in the SAME directory, instead of defaulting to the real ~/.evomap.
    constructor(baseDir) {
        this.baseDir = baseDir;
        ensureAssetStoreDirectory(baseDir);
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    captureFileState() {
        assertAssetStoreDirectory(this.baseDir);
        const state = new Map();
        for (const [kind, file] of Object.entries(LOCAL_ASSET_FILES)) {
            state.set(kind, regularFileFingerprint(join(this.baseDir, file)));
        }
        return state;
    }
    stateChanged(next) {
        if (!this.loaded || next.size !== this.fileState.size)
            return true;
        for (const [kind, fingerprint] of next) {
            if (this.fileState.get(kind) !== fingerprint)
                return true;
        }
        return false;
    }
    rebuildIndex(state) {
        const next = new Map();
        for (const file of Object.values(LOCAL_ASSET_FILES)) {
            const p = join(this.baseDir, file);
            const raw = readUtf8Regular(p);
            if (raw === null)
                continue;
            for (const line of raw.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const r = JSON.parse(line);
                    if (r.asset_id)
                        next.set(r.asset_id, r);
                }
                catch { /* skip 坏行 */ }
            }
        }
        this.index.clear();
        for (const [assetId, record] of next)
            this.index.set(assetId, record);
        this.fileState = state;
        this.loaded = true;
    }
    refreshUnderLock() {
        const state = this.captureFileState();
        if (this.stateChanged(state))
            this.rebuildIndex(state);
    }
    ensureFresh() {
        const state = this.captureFileState();
        if (!this.stateChanged(state))
            return;
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.refreshUnderLock();
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    updateFileStateAfterWrite() {
        this.fileState = this.captureFileState();
        this.loaded = true;
    }
    async put(asset) {
        return this.putConditional(asset, { allowLogicalCollision: true });
    }
    async putConditional(asset, options) {
        const { record, verified } = normalizeForPut(asset);
        const file = join(this.baseDir, LOCAL_ASSET_FILES[record.type]);
        const logicalId = typeof record.id === 'string' ? record.id : undefined;
        let collision;
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            // Refresh under the shared lock so another process cannot append between reload and dedupe.
            this.refreshUnderLock();
            const existing = this.index.get(record.asset_id);
            if (existing) {
                if (!frozenAssetRecordsEqual(existing, record))
                    throw new FrozenAssetIdCollisionError(record.asset_id);
                return {
                    asset_id: record.asset_id,
                    stored: false,
                    verified,
                    status: 'already_exists',
                    ...(resultLogicalId(logicalId) ? { logicalId } : {}),
                };
            }
            collision = logicalId === undefined
                ? undefined
                : [...this.index.values()].find((existing) => (existing.type === record.type
                    && existing.id === logicalId
                    && existing.asset_id !== record.asset_id));
            if (collision && !options?.allowLogicalCollision) {
                return {
                    asset_id: record.asset_id,
                    stored: false,
                    verified,
                    status: 'logical_collision',
                    ...(resultLogicalId(logicalId) ? { logicalId } : {}),
                    collisionWithAssetId: collision.asset_id,
                };
            }
            appendUtf8Durable(file, `${JSON.stringify(record)}\n`);
            this.index.set(record.asset_id, record);
            this.updateFileStateAfterWrite();
        }
        finally {
            releaseLock(this.lockPath);
        }
        return {
            asset_id: record.asset_id,
            stored: true,
            verified,
            status: 'stored',
            ...(collision ? {
                ...(resultLogicalId(logicalId) ? { logicalId } : {}),
                collisionWithAssetId: collision.asset_id,
            } : {}),
        };
    }
    /**
     * 迁移专用(M8-2): 以**冻结 asset_id** 原样写入, 不经 normalizeForPut 重算/校验.
     * 仅 v1→v2 导入用(硬化 A6 存量冻结); 普通写一律走 put(). record 必须自带 asset_id.
     */
    async putFrozen(record) {
        return this.putFrozenConditional(record, { allowLogicalCollision: true });
    }
    async putFrozenConditional(record, options = {}) {
        if (!record.asset_id)
            throw new Error('putFrozen 需 record 自带冻结 asset_id');
        const file = join(this.baseDir, LOCAL_ASSET_FILES[record.type]);
        let logicalId;
        let collision;
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.refreshUnderLock();
            const existing = this.index.get(record.asset_id);
            if (existing) {
                if (!frozenAssetRecordsEqual(existing, record))
                    throw new FrozenAssetIdCollisionError(record.asset_id);
                return { asset_id: record.asset_id, stored: false, verified: false, status: 'already_exists' };
            }
            logicalId = typeof record['id'] === 'string' && record['id'].length > 0
                ? record['id']
                : undefined;
            collision = logicalId === undefined
                ? undefined
                : [...this.index.values()].find((candidate) => (candidate.type === record.type
                    && candidate['id'] === logicalId
                    && candidate.asset_id !== record.asset_id));
            if (collision && !options.allowLogicalCollision) {
                return {
                    asset_id: record.asset_id,
                    stored: false,
                    verified: false,
                    status: 'logical_collision',
                    ...(resultLogicalId(logicalId) ? { logicalId } : {}),
                    collisionWithAssetId: collision.asset_id,
                };
            }
            appendUtf8Durable(file, `${JSON.stringify(record)}\n`);
            this.index.set(record.asset_id, record);
            this.updateFileStateAfterWrite();
        }
        finally {
            releaseLock(this.lockPath);
        }
        return {
            asset_id: record.asset_id,
            stored: true,
            verified: false,
            status: 'stored',
            ...(collision ? {
                ...(resultLogicalId(logicalId) ? { logicalId } : {}),
                collisionWithAssetId: collision.asset_id,
            } : {}),
        };
    }
    async get(assetId) {
        this.ensureFresh();
        return this.index.get(assetId) ?? null;
    }
    async findByLogicalId(id, limit = 2, kind) {
        this.ensureFresh();
        const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1_000, Math.floor(limit))) : 2;
        const out = [];
        for (const record of this.index.values()) {
            if (record['id'] !== id || (kind !== undefined && record.type !== kind))
                continue;
            out.push(record);
            if (out.length >= boundedLimit)
                break;
        }
        return out;
    }
    async list(kind, limit = 1000) {
        this.ensureFresh();
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
        this.ensureFresh();
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
                const sig = new Set(signalsOf(r).map((signal) => signal.trim().toLowerCase()));
                if (!q.signalsAny.some((signal) => sig.has(signal.trim().toLowerCase())))
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
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.refreshUnderLock();
            let kept = 0, removed = 0;
            for (const [kind, file] of Object.entries(LOCAL_ASSET_FILES)) {
                const p = join(this.baseDir, file);
                const raw = readUtf8Regular(p);
                if (raw === null)
                    continue;
                const lines = raw.split('\n').filter((l) => l.trim());
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
                replaceUtf8Durable(p, out);
                kept += byId.size;
                removed += lines.length - byId.size;
            }
            this.rebuildIndex(this.captureFileState());
            return { kept, removed };
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
}