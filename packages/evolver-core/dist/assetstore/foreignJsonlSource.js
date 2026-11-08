// Read-only view over ANOTHER evolution engine's local asset pool (#195 follow-up).
//
// Why this exists: gene health (algo/geneHealth.ts) is derived from capsule outcomes via
// aggregateLearningHistory, which can only see what the injected provider sees. EvoX runs write their
// capsules to EvoX's own pool (`~/.evox/agent/evolver/assets`), not to `~/.evomap`, so every EvoX-produced
// gene aggregates to an empty view here and scores 0 no matter how its runs actually went. Pointing a
// LocalJsonlProvider at that directory is NOT an option: its constructor creates the directory and its
// reads take a lock file inside it, i.e. it would WRITE into a store this engine does not own.
//
// The boundary is symmetric and deliberate. EvoX blocks its own agent from writing into `~/.evomap`
// (`evox-agent-core::foreign_store_guard`) while explicitly leaving reads unguarded — "inspecting a
// foreign store is legitimate diagnosis; mutating it is not". This module is the mirror of that rule:
// every write path throws, nothing is created, no lock is taken, and the foreign directory is left
// byte-identical.
//
// The on-disk layout is shared (one jsonl per kind, content-addressed records), so reading is just
// parsing — no format adapter and no second wire contract.
import { queryLocalRelatedCapsules } from './relatedCapsules.js';
import { beginLocalGeneScanV1, readLocalGeneSnapshot } from './boundedSnapshot.js';
import { beginLocalContextReadV1 } from './contextReadOperationV1.js';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readUtf8Regular, regularFileFingerprint } from './assetStoreStorage.js';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { signalsOf } from './localJsonl.js';
import { assertRecentLimit, recentRecords } from './recentRecords.js';
import { getAssetsById } from './provider.js';
/** Thrown by every mutating method: a foreign pool is readable, never writable. */
export class ForeignStoreReadOnlyError extends Error {
    baseDir;
    kind;
    code = 'FOREIGN_STORE_READ_ONLY';
    constructor(baseDir, kind) {
        super(`refusing to write ${kind ?? 'an asset'} into a foreign evolution store: ${baseDir}`);
        this.baseDir = baseDir;
        this.kind = kind;
        this.name = 'ForeignStoreReadOnlyError';
    }
}
/**
 * EvoX's asset directory: `EVOX_ASSETS_DIR`, else `~/.evox/agent/evolver/assets`. Returns the path
 * whether or not it exists; {@link ForeignJsonlSource} treats a missing directory as an empty pool.
 *
 * The name is engine-scoped on purpose, matching the EVOLVER_HOME / EVOMAP_HOME split. It deliberately
 * does NOT honour `GEP_ASSETS_DIR`: in THIS repo that variable relocates evolver's OWN pool
 * (`pendingSignals.legacyV1BaseDir`, README.npm.md), so a user who moved their own store per our own
 * documentation would silently get a union of the primary with itself and never read EvoX at all.
 */
export function evoxAssetDir(env = process.env) {
    const override = env['EVOX_ASSETS_DIR']?.trim();
    if (override)
        return resolve(override);
    return join(homedir(), '.evox', 'agent', 'evolver', 'assets');
}
function parseJsonlRecords(raw) {
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const record = JSON.parse(line);
            if (typeof record.asset_id === 'string' && record.asset_id.length > 0)
                out.push(record);
        }
        catch { /* skip corrupt line, same tolerance LocalJsonlProvider applies */ }
    }
    return out;
}
// 每个 kind 最多缓存 4 MiB/10,000 行的解析结果；大文件仍按原完整读取路径处理，不截断资产。
const MAX_CACHED_FOREIGN_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_FOREIGN_RECORDS = 10_000;
function matchesQuery(record, q) {
    if (q.kind && record.type !== q.kind)
        return false;
    if (q.gene && record.gene !== q.gene)
        return false;
    if (q.category) {
        const category = record.category
            ?? record.intent;
        if (category !== q.category)
            return false;
    }
    if (q.text && !String(record.summary ?? '').includes(q.text))
        return false;
    if (q.signalsAny && q.signalsAny.length > 0) {
        const advertised = new Set(signalsOf(record).map((signal) => signal.trim().toLowerCase()));
        if (!q.signalsAny.some((signal) => advertised.has(signal.trim().toLowerCase())))
            return false;
    }
    return true;
}
/**
 * Read-only provider over a foreign asset directory. Every call reads a fresh regular-file snapshot;
 * only its content digest can reuse bounded parsed data. Another engine's writes, replacement,
 * deletion or access failure never cause previously cached bytes to be returned instead.
 */
const builtInPromptForeignReaders = new WeakSet();
export class ForeignJsonlSource {
    baseDir;
    static isBuiltInPromptReader(value) {
        return typeof value === 'object' && value !== null && builtInPromptForeignReaders.has(value);
    }
    reportedUnreadable = new Set();
    parsedFiles = new Map();
    constructor(baseDir) {
        this.baseDir = baseDir;
        Object.defineProperty(this, 'baseDir', { value: baseDir, enumerable: true, writable: false, configurable: false });
        builtInPromptForeignReaders.add(this);
    }
    /**
     * Read one foreign file, degrading it to "empty" on ANY failure.
     *
     * The readable-generation probe and payload reader reject symlinks, non-regular files,
     * EACCES, ELOOP or ENOTDIR. This read runs inside gene selection (aggregateLearningHistory →
     * candidateAssembly), where an exception would abort the host's whole cycle — a pool we do not own, and
     * whose contents are optional extra evidence, must never have that power. Degrading is per file so one
     * unreadable capsules.jsonl does not also hide genes.jsonl.
     *
     * Warned once per path per instance: reads are re-run on every call by design, and a per-call warning
     * would bury the cycle's real output.
     */
    readOrDegrade(path) {
        try {
            const before = regularFileFingerprint(path);
            if (before === 'missing') {
                this.parsedFiles.delete(path);
                return [];
            }
            const cached = this.parsedFiles.get(path);
            this.parsedFiles.delete(path);
            const raw = readUtf8Regular(path);
            if (raw === null || regularFileFingerprint(path) !== before) {
                throw new Error('foreign asset file changed while reading');
            }
            // 不把 metadata 当作不可伪造的 generation；所有平台读取内容摘要后才能复用解析结果。
            const digest = createHash('sha256').update(raw).digest('hex');
            if (cached?.digest === digest) {
                this.parsedFiles.set(path, cached);
                return cached.records;
            }
            const records = parseJsonlRecords(raw);
            if (Buffer.byteLength(raw, 'utf8') <= MAX_CACHED_FOREIGN_BYTES
                && records.length <= MAX_CACHED_FOREIGN_RECORDS) {
                this.parsedFiles.set(path, { digest, records });
            }
            return records;
        }
        catch (error) {
            this.parsedFiles.delete(path);
            if (!this.reportedUnreadable.has(path)) {
                this.reportedUnreadable.add(path);
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[ForeignAssetPool] Failed to read ${path} (non-fatal, treated as empty): ${message}`);
            }
            return [];
        }
    }
    read(kind) {
        const files = kind ? [LOCAL_ASSET_FILES[kind]] : Object.values(LOCAL_ASSET_FILES);
        const byAssetId = new Map();
        for (const file of files) {
            for (const record of this.readOrDegrade(join(this.baseDir, file)))
                byAssetId.set(record.asset_id, record);
        }
        return [...byAssetId.values()];
    }
    detach(records) {
        try {
            return structuredClone(records);
        }
        catch {
            // 极深但合法的 JSON 可能超过 clone 深度；清空派生缓存后返回本次独占数据，维持旧读取能力。
            this.parsedFiles.clear();
            return records;
        }
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
        throw new ForeignStoreReadOnlyError(this.baseDir, asset.type);
    }
    /** One fresh all-kind read for Union authority, retaining only requested identities.
     * This is operation-local evidence, not an atomic snapshot across files or a persistent index. */
    existingAssetIds(requested) {
        return new Set(this.read().filter(record => requested.has(record.asset_id)).map(record => record.asset_id));
    }
    async get(assetId) {
        return this.detach(this.read().filter((record) => record.asset_id === assetId).slice(0, 1))[0] ?? null;
    }
    async getMany(assetIds) {
        if (this.get !== ForeignJsonlSource.prototype.get)
            return getAssetsById(this, assetIds, undefined);
        const requested = new Set(assetIds);
        if (requested.size === 0)
            return new Map();
        const records = this.detach(this.read().filter(record => requested.has(record.asset_id)));
        return new Map(records.map(record => [record.asset_id, record]));
    }
    /** Filters by logical id BEFORE the cap, so `limit` bounds matches returned, never records scanned. */
    async findByLogicalId(id, limit = 1000, kind) {
        return this.detach(this.read(kind)
            .filter((record) => record['id'] === id && (kind === undefined || record.type === kind))
            .slice(0, Math.max(1, limit)));
    }
    async list(kind, limit = 1000) {
        return this.detach(this.read(kind).slice(0, limit));
    }
    async listRecent(kind, limit = 1000) {
        assertRecentLimit(limit);
        return this.detach(recentRecords(this.read(kind), kind, limit));
    }
    async search(q) {
        return this.detach(this.read(q.kind).filter((record) => matchesQuery(record, q)).slice(0, q.limit ?? 1000));
    }
}