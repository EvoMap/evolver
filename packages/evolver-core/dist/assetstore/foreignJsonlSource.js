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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readUtf8Regular } from './assetStoreStorage.js';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { signalsOf } from './localJsonl.js';
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
            if (record.asset_id)
                out.push(record);
        }
        catch { /* skip corrupt line, same tolerance LocalJsonlProvider applies */ }
    }
    return out;
}
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
 * Read-only provider over a foreign asset directory. Re-reads on every call rather than caching: the
 * owning engine appends to these files behind our back, and a stale cache would silently freeze a gene's
 * evidence at whatever it was when this process started.
 */
export class ForeignJsonlSource {
    baseDir;
    reportedUnreadable = new Set();
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    /**
     * Read one foreign file, degrading it to "empty" on ANY failure.
     *
     * `readUtf8Regular` returns null only for a missing file and THROWS for a symlink, a non-regular file,
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
            return readUtf8Regular(path);
        }
        catch (error) {
            if (!this.reportedUnreadable.has(path)) {
                this.reportedUnreadable.add(path);
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[ForeignAssetPool] Failed to read ${path} (non-fatal, treated as empty): ${message}`);
            }
            return null;
        }
    }
    read(kind) {
        const files = kind ? [LOCAL_ASSET_FILES[kind]] : Object.values(LOCAL_ASSET_FILES);
        const byAssetId = new Map();
        for (const file of files) {
            const raw = this.readOrDegrade(join(this.baseDir, file));
            if (raw === null)
                continue;
            for (const record of parseJsonlRecords(raw))
                byAssetId.set(record.asset_id, record);
        }
        return [...byAssetId.values()];
    }
    async put(asset) {
        throw new ForeignStoreReadOnlyError(this.baseDir, asset.type);
    }
    async get(assetId) {
        return this.read().find((record) => record.asset_id === assetId) ?? null;
    }
    /** Filters by logical id BEFORE the cap, so `limit` bounds matches returned, never records scanned. */
    async findByLogicalId(id, limit = 1000, kind) {
        return this.read(kind)
            .filter((record) => record['id'] === id && (kind === undefined || record.type === kind))
            .slice(0, Math.max(1, limit));
    }
    async list(kind, limit = 1000) {
        return this.read(kind).slice(0, limit);
    }
    async search(q) {
        return this.read(q.kind).filter((record) => matchesQuery(record, q)).slice(0, q.limit ?? 1000);
    }
}