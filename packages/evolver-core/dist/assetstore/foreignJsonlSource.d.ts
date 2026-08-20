import type { AssetKind, AssetRecord, AssetStoreProvider, PutResult, SearchQuery } from './provider.js';
/** Thrown by every mutating method: a foreign pool is readable, never writable. */
export declare class ForeignStoreReadOnlyError extends Error {
    readonly baseDir: string;
    readonly kind?: AssetKind | undefined;
    readonly code = "FOREIGN_STORE_READ_ONLY";
    constructor(baseDir: string, kind?: AssetKind | undefined);
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
export declare function evoxAssetDir(env?: NodeJS.ProcessEnv): string;
/**
 * Read-only provider over a foreign asset directory. Re-reads on every call rather than caching: the
 * owning engine appends to these files behind our back, and a stale cache would silently freeze a gene's
 * evidence at whatever it was when this process started.
 */
export declare class ForeignJsonlSource implements AssetStoreProvider {
    readonly baseDir: string;
    private readonly reportedUnreadable;
    constructor(baseDir: string);
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
    private readOrDegrade;
    private read;
    put(asset: AssetRecord): Promise<PutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    /** Filters by logical id BEFORE the cap, so `limit` bounds matches returned, never records scanned. */
    findByLogicalId(id: string, limit?: number, kind?: AssetKind): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    search(q: SearchQuery): Promise<AssetRecord[]>;
}