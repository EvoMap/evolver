import { type RelatedCapsuleQuery, type RelatedCapsuleResult } from './relatedCapsules.js';
import { type GeneReadSnapshot, type GeneSnapshotQuery } from './boundedSnapshot.js';
import type { GeneScanSessionV1 } from './geneScanV1.js';
import type { AssetKind, AssetRecord, AssetStoreProvider, ConditionalPutOptions, ConditionalPutResult, ContextLookupQueryV1, ContextReadOperationV1, PutResult, SearchQuery } from './provider.js';
export declare class UnionReadStore implements AssetStoreProvider {
    private readonly primary;
    static isBuiltInPromptReader(value: unknown): value is UnionReadStore;
    private readonly readOnly;
    /** Prompt-time capabilities exist only when every child can prove terminal cancellation. */
    readonly beginPromptGeneSnapshotV1?: (query: GeneSnapshotQuery) => ContextReadOperationV1<GeneReadSnapshot>;
    readonly beginPromptRelatedCapsulesV1?: (query: RelatedCapsuleQuery) => ContextReadOperationV1<RelatedCapsuleResult>;
    readonly beginPromptAssetGetV1?: (assetId: string, query: ContextLookupQueryV1) => ContextReadOperationV1<AssetRecord | null>;
    readonly beginPromptLogicalGeneLookupV1?: (id: string, query: ContextLookupQueryV1) => ContextReadOperationV1<AssetRecord[]>;
    readonly putConditional?: (asset: AssetRecord, options?: ConditionalPutOptions) => Promise<ConditionalPutResult>;
    readonly putBundle?: (assets: readonly AssetRecord[]) => Promise<PutResult[]>;
    readonly putBundleWithLocalContextV1?: AssetStoreProvider['putBundleWithLocalContextV1'];
    readonly readLocalContextsV1?: AssetStoreProvider['readLocalContextsV1'];
    readonly putFrozen?: (record: AssetRecord) => Promise<PutResult>;
    readonly putFrozenConditional?: (record: AssetRecord, options?: ConditionalPutOptions) => Promise<ConditionalPutResult>;
    readonly findByLogicalId?: (id: string, limit?: number, kind?: AssetKind) => Promise<AssetRecord[]>;
    readonly listRecent?: (kind: AssetKind, limit?: number) => Promise<AssetRecord[]>;
    /**
     * @param primary the writable pool this engine owns; every mutation lands here
     * @param readOnly additional pools to read, in precedence order after `primary`
     */
    constructor(primary: AssetStoreProvider, readOnly: readonly AssetStoreProvider[]);
    private get sources();
    /** Return the current children for prompt-adapter admission checks. */
    promptSourceTree(): readonly AssetStoreProvider[];
    /** Reject prompt admission after a caller replaces any constructor-owned V1 operation. */
    promptCapabilitiesUnmodified(): boolean;
    private promptLookupV1;
    private promptGeneSnapshot;
    private promptRelatedCapsules;
    /**
     * Merge one read across every source: deduplicate by asset_id with earlier sources winning, then fill
     * the result by {@link interleave} so every source gets a fair share of the cap.
     */
    private merged;
    queryGeneSnapshot(query?: GeneSnapshotQuery): Promise<GeneReadSnapshot>;
    beginGeneScanV1(query?: GeneSnapshotQuery): GeneScanSessionV1;
    queryRelatedCapsules(query: RelatedCapsuleQuery): Promise<RelatedCapsuleResult>;
    put(asset: AssetRecord): Promise<PutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    getMany(assetIds: readonly string[]): Promise<ReadonlyMap<string, AssetRecord>>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    search(q: SearchQuery): Promise<AssetRecord[]>;
}