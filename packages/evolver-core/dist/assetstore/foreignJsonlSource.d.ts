import { type RelatedCapsuleQuery, type RelatedCapsuleResult } from './relatedCapsules.js';
import { type GeneSnapshotQuery, type GeneReadSnapshot } from './boundedSnapshot.js';
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
export declare class ForeignJsonlSource implements AssetStoreProvider {
    readonly baseDir: string;
    static isBuiltInPromptReader(value: unknown): value is ForeignJsonlSource;
    private readonly reportedUnreadable;
    private readonly parsedFiles;
    constructor(baseDir: string);
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
    private readOrDegrade;
    private read;
    private detach;
    queryGeneSnapshot(query?: GeneSnapshotQuery): Promise<GeneReadSnapshot>;
    beginPromptGeneSnapshotV1(query: GeneSnapshotQuery): import("./provider.js").ContextReadOperationV1<GeneReadSnapshot>;
    beginPromptRelatedCapsulesV1(query: RelatedCapsuleQuery): import("./provider.js").ContextReadOperationV1<RelatedCapsuleResult>;
    beginPromptAssetGetV1(assetId: string, query: {
        deadlineAt: number;
        signal: AbortSignal;
    }): import("./provider.js").ContextReadOperationV1<AssetRecord | null>;
    beginPromptLogicalGeneLookupV1(id: string, query: {
        deadlineAt: number;
        signal: AbortSignal;
    }): import("./provider.js").ContextReadOperationV1<AssetRecord[]>;
    beginGeneScanV1(query?: GeneSnapshotQuery): import("./geneScanV1.js").GeneScanSessionV1;
    queryRelatedCapsules(query: RelatedCapsuleQuery): Promise<RelatedCapsuleResult>;
    put(asset: AssetRecord): Promise<PutResult>;
    /** One fresh all-kind read for Union authority, retaining only requested identities.
     * This is operation-local evidence, not an atomic snapshot across files or a persistent index. */
    existingAssetIds(requested: ReadonlySet<string>): ReadonlySet<string>;
    get(assetId: string): Promise<AssetRecord | null>;
    getMany(assetIds: readonly string[]): Promise<ReadonlyMap<string, AssetRecord>>;
    /** Filters by logical id BEFORE the cap, so `limit` bounds matches returned, never records scanned. */
    findByLogicalId(id: string, limit?: number, kind?: AssetKind): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    listRecent(kind: AssetKind, limit?: number): Promise<AssetRecord[]>;
    search(q: SearchQuery): Promise<AssetRecord[]>;
}