import { queryLocalRelatedCapsules } from './relatedCapsules.js';
import { beginLocalGeneScanV1, readLocalGeneSnapshot } from './boundedSnapshot.js';
import { beginLocalContextReadV1 } from './contextReadOperationV1.js';
import { assertExecutionEligible, isExecutionEligible } from '../reference/guard.js';
import { loadReferenceFence } from '../reference/store.js';
import { assertLocalContextBundle, isBoundLocalContext, mergeLocalProjectContexts, readLocalProjectContexts, validateLocalProjectContext, writeLocalProjectContexts } from './localProjectContext.js';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { appendUtf8Durable, assertAssetStoreDirectory, assertNoExperienceTransaction, EXPERIENCE_BUNDLE_SCHEMA, ExperienceRecoveryRequiredError, assertOptionalRegularFile, ensureAssetStoreDirectory, fsyncDirectoryBestEffort, readUtf8Regular, regularFileFingerprint, replaceUtf8Durable, } from './assetStoreStorage.js';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { FrozenAssetIdCollisionError, frozenAssetRecordsEqual, normalizeForPut, } from './provider.js';
function resultLogicalId(logicalId) {
    return logicalId !== undefined && logicalId.length > 0 && logicalId === logicalId.trim()
        ? logicalId
        : undefined;
}
const BUNDLE_JOURNAL_FILE = '.assetstore-bundle.json';
const BUNDLE_JOURNAL_SCHEMA = 'evolver.assetstore-bundle.v1';
const CONTEXT_BUNDLE_JOURNAL_SCHEMA = 'evolver.assetstore-bundle.v2';
const MAX_BUNDLE_ASSETS = 64;
const MAX_BUNDLE_JOURNAL_BYTES = 4 * 1024 * 1024;
/** Signal names a record advertises, across the four key spellings the pool uses. */
export function signalsOf(a) {
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
const builtInPromptLocalReaders = new WeakSet();
export class LocalJsonlProvider {
    baseDir;
    static isBuiltInPromptReader(value) {
        return typeof value === 'object' && value !== null && builtInPromptLocalReaders.has(value);
    }
    index = new Map();
    lockPath;
    bundleJournalPath;
    fileState = new Map();
    loaded = false;
    referenceScope;
    // `baseDir` is public-readonly so callers that inject a store (e.g. the CLI under test) can co-locate sidecars
    // — the ReviewLedger/ProvenanceStore — in the SAME directory, instead of defaulting to the real ~/.evomap.
    constructor(baseDir) {
        this.baseDir = baseDir;
        // Prompt snapshots and their related-case reads must use one source root.
        // A mutable public readonly field (readonly is only a TS check) permits
        // an injected ledger callback to retarget a later optional V1 read.
        Object.defineProperty(this, 'baseDir', { value: baseDir, enumerable: true, writable: false, configurable: false });
        builtInPromptLocalReaders.add(this);
        ensureAssetStoreDirectory(baseDir);
        this.referenceScope = loadReferenceFence(baseDir);
        this.lockPath = join(baseDir, '.assetstore.lock');
        this.bundleJournalPath = join(baseDir, BUNDLE_JOURNAL_FILE);
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
                        next.set(r.asset_id, r); // preserve legacy read behavior
                }
                catch { /* skip 坏行 for legacy readers */ }
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
        if (!this.hasPendingBundle() && !this.stateChanged(state))
            return;
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.recoverPendingBundleUnderLock();
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
    readPendingBundle() {
        if (assertOptionalRegularFile(this.bundleJournalPath, 'temp_file') === null)
            return undefined;
        const raw = readUtf8Regular(this.bundleJournalPath, MAX_BUNDLE_JOURNAL_BYTES);
        if (raw === null)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('asset store bundle journal is malformed');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('asset store bundle journal is malformed');
        }
        const journal = parsed;
        if (journal['schema'] === EXPERIENCE_BUNDLE_SCHEMA)
            throw new ExperienceRecoveryRequiredError();
        const assets = journal['assets'];
        const hasContext = journal['schema'] === CONTEXT_BUNDLE_JOURNAL_SCHEMA;
        if ((!hasContext && journal['schema'] !== BUNDLE_JOURNAL_SCHEMA) || !Array.isArray(assets) || assets.length === 0 || assets.length > MAX_BUNDLE_ASSETS) {
            throw new Error('asset store bundle journal is invalid');
        }
        const records = assets.map((asset) => {
            if (!asset || typeof asset !== 'object' || Array.isArray(asset))
                throw new Error('asset store bundle journal is invalid');
            const record = asset;
            if (typeof record.type !== 'string' || !Object.prototype.hasOwnProperty.call(LOCAL_ASSET_FILES, record.type)
                || typeof record.asset_id !== 'string' || record.asset_id.length === 0) {
                throw new Error('asset store bundle journal is invalid');
            }
            return record;
        });
        const rawContexts = journal['localContexts'];
        if (hasContext ? !Array.isArray(rawContexts) || rawContexts.length === 0 || rawContexts.length > MAX_BUNDLE_ASSETS
            : rawContexts !== undefined)
            throw new Error('asset store bundle journal context is invalid');
        const localContexts = hasContext ? rawContexts.map(validateLocalProjectContext) : [];
        for (const context of localContexts)
            assertLocalContextBundle(context, records);
        return { assets: records, localContexts };
    }
    recoverPendingBundleUnderLock() {
        const pending = this.readPendingBundle();
        if (!pending)
            return;
        this.refreshUnderLock();
        const contextBody = pending.localContexts.length > 0 ? mergeLocalProjectContexts(this.baseDir, pending.localContexts) : undefined;
        for (const pendingRecord of pending.assets) {
            const { record } = normalizeForPut(pendingRecord, this.referenceScope);
            if (record.asset_id !== pendingRecord.asset_id)
                throw new Error('asset store bundle journal asset_id mismatch');
            const existing = this.index.get(record.asset_id);
            if (existing) {
                if (!frozenAssetRecordsEqual(existing, record))
                    throw new FrozenAssetIdCollisionError(record.asset_id);
                continue;
            }
            appendUtf8Durable(join(this.baseDir, LOCAL_ASSET_FILES[record.type]), `${JSON.stringify(record)}\n`);
            this.index.set(record.asset_id, record);
        }
        if (contextBody !== undefined)
            writeLocalProjectContexts(this.baseDir, contextBody);
        unlinkSync(this.bundleJournalPath);
        fsyncDirectoryBestEffort(this.baseDir);
        this.updateFileStateAfterWrite();
    }
    hasPendingBundle() {
        return assertOptionalRegularFile(this.bundleJournalPath, 'temp_file') !== null;
    }
    queryGeneSnapshot(query = {}) {
        return readLocalGeneSnapshot(this.baseDir, query);
    }
    beginPromptGeneSnapshotV1(query) {
        return beginLocalContextReadV1(query.signal, signal => this.queryGeneSnapshot({ ...query, signal }));
    }
    beginPromptRelatedCapsulesV1(query) {
        return beginLocalContextReadV1(query.signal, signal => this.queryRelatedCapsules({ ...query, signal }));
    }
    beginPromptAssetGetV1(assetId, query) {
        return beginLocalContextReadV1(query.signal, () => {
            if (!Number.isFinite(query.deadlineAt) || Date.now() >= query.deadlineAt)
                throw new Error('context_deadline');
            return this.get(assetId);
        });
    }
    beginPromptLogicalGeneLookupV1(id, query) {
        return beginLocalContextReadV1(query.signal, () => {
            if (!Number.isFinite(query.deadlineAt) || Date.now() >= query.deadlineAt)
                throw new Error('context_deadline');
            return this.findByLogicalId(id, 2, 'Gene');
        });
    }
    beginGeneScanV1(query = {}) {
        return beginLocalGeneScanV1(this.baseDir, query);
    }
    queryRelatedCapsules(query) {
        return queryLocalRelatedCapsules(this.baseDir, query);
    }
    async put(asset) {
        return this.putConditional(asset, { allowLogicalCollision: true });
    }
    async putConditional(asset, options) {
        const { record, verified } = normalizeForPut(asset, this.referenceScope);
        const file = join(this.baseDir, LOCAL_ASSET_FILES[record.type]);
        const logicalId = typeof record.id === 'string' ? record.id : undefined;
        let collision;
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.recoverPendingBundleUnderLock();
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
    async putBundle(assets) {
        return this.putBundleRecords(assets);
    }
    async putBundleWithLocalContextV1(assets, value) {
        const context = validateLocalProjectContext(value);
        if (assets.length === 0)
            throw new Error('local_project_context_bundle_mismatch');
        return this.putBundleRecords(assets, context);
    }
    async readLocalContextsV1(capsuleAssetIds) {
        if (capsuleAssetIds.length > 20_000 || capsuleAssetIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id))) {
            throw new Error('local_project_context_query_invalid');
        }
        if (capsuleAssetIds.length === 0)
            return [];
        assertAssetStoreDirectory(this.baseDir);
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.recoverPendingBundleUnderLock();
            this.refreshUnderLock();
            const ids = new Set(capsuleAssetIds);
            return readLocalProjectContexts(this.baseDir).filter((context) => ids.has(context.capsuleAssetId)
                && isBoundLocalContext(context, [this.index.get(context.capsuleAssetId), this.index.get(context.geneAssetId)]));
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    async putBundleRecords(assets, context) {
        if (assets.length === 0)
            return [];
        if (assets.length > MAX_BUNDLE_ASSETS)
            throw new Error('asset store bundle is too large');
        const normalized = assets.map((asset) => normalizeForPut(asset, this.referenceScope));
        if (context)
            assertLocalContextBundle(context, normalized.map(({ record }) => record));
        const seen = new Map();
        for (const normalizedRecord of normalized) {
            const { record } = normalizedRecord;
            const previous = seen.get(record.asset_id);
            if (previous && !frozenAssetRecordsEqual(previous.record, record))
                throw new FrozenAssetIdCollisionError(record.asset_id);
            if (!previous)
                seen.set(record.asset_id, normalizedRecord);
        }
        const results = [];
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.recoverPendingBundleUnderLock();
            this.refreshUnderLock();
            const pending = [];
            for (const { record, verified } of seen.values()) {
                const existing = this.index.get(record.asset_id);
                if (existing) {
                    if (!frozenAssetRecordsEqual(existing, record))
                        throw new FrozenAssetIdCollisionError(record.asset_id);
                    results.push({ asset_id: record.asset_id, stored: false, verified });
                    continue;
                }
                pending.push(record);
                results.push({ asset_id: record.asset_id, stored: true, verified });
            }
            if (pending.length === 0 && !context)
                return results;
            const contextBody = context ? mergeLocalProjectContexts(this.baseDir, [context]) : undefined;
            const journal = `${JSON.stringify(context
                ? { schema: CONTEXT_BUNDLE_JOURNAL_SCHEMA, assets: normalized.map(({ record }) => record), localContexts: [context] }
                : { schema: BUNDLE_JOURNAL_SCHEMA, assets: pending })}\n`;
            if (Buffer.byteLength(journal, 'utf8') > MAX_BUNDLE_JOURNAL_BYTES) {
                throw new Error('asset store bundle is too large');
            }
            replaceUtf8Durable(this.bundleJournalPath, journal);
            for (const record of pending) {
                appendUtf8Durable(join(this.baseDir, LOCAL_ASSET_FILES[record.type]), `${JSON.stringify(record)}\n`);
                this.index.set(record.asset_id, record);
            }
            if (contextBody !== undefined)
                writeLocalProjectContexts(this.baseDir, contextBody);
            unlinkSync(this.bundleJournalPath);
            fsyncDirectoryBestEffort(this.baseDir);
            this.updateFileStateAfterWrite();
        }
        finally {
            releaseLock(this.lockPath);
        }
        return results;
    }
    /**
     * 迁移专用(M8-2): 以**冻结 asset_id** 原样写入, 不经 normalizeForPut 重算/校验.
     * 仅 v1→v2 导入用(硬化 A6 存量冻结); 普通写一律走 put(). record 必须自带 asset_id.
     */
    async putFrozen(record) {
        return this.putFrozenConditional(record, { allowLogicalCollision: true });
    }
    async putFrozenConditional(record, options = {}) {
        assertExecutionEligible(record, this.referenceScope);
        if (!record.asset_id)
            throw new Error('putFrozen 需 record 自带冻结 asset_id');
        const file = join(this.baseDir, LOCAL_ASSET_FILES[record.type]);
        let logicalId;
        let collision;
        assertOptionalRegularFile(this.lockPath, 'lock_file');
        acquireLock(this.lockPath);
        try {
            this.recoverPendingBundleUnderLock();
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
        const asset = this.index.get(assetId);
        return asset && isExecutionEligible(asset, this.referenceScope) ? asset : null;
    }
    async findByLogicalId(id, limit = 2, kind) {
        this.ensureFresh();
        const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1_000, Math.floor(limit))) : 2;
        const out = [];
        for (const record of this.index.values()) {
            if (!isExecutionEligible(record, this.referenceScope))
                continue;
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
            if (isExecutionEligible(r, this.referenceScope) && (!kind || r.type === kind))
                out.push(r);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    listAll(kind) {
        this.ensureFresh();
        return [...this.index.values()].filter((record) => isExecutionEligible(record, this.referenceScope) && (kind === undefined || record.type === kind));
    }
    async search(q) {
        this.ensureFresh();
        const out = [];
        for (const r of this.index.values()) {
            if (!isExecutionEligible(r, this.referenceScope))
                continue;
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
            assertNoExperienceTransaction(this.baseDir);
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