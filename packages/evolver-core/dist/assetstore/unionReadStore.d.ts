import type { AssetKind, AssetRecord, AssetStoreProvider, ConditionalPutOptions, ConditionalPutResult, PutResult, SearchQuery } from './provider.js';
export declare class UnionReadStore implements AssetStoreProvider {
    private readonly primary;
    private readonly readOnly;
    readonly putConditional?: (asset: AssetRecord, options?: ConditionalPutOptions) => Promise<ConditionalPutResult>;
    readonly putBundle?: (assets: readonly AssetRecord[]) => Promise<PutResult[]>;
    readonly putFrozen?: (record: AssetRecord) => Promise<PutResult>;
    readonly putFrozenConditional?: (record: AssetRecord, options?: ConditionalPutOptions) => Promise<ConditionalPutResult>;
    readonly findByLogicalId?: (id: string, limit?: number, kind?: AssetKind) => Promise<AssetRecord[]>;
    /**
     * @param primary the writable pool this engine owns; every mutation lands here
     * @param readOnly additional pools to read, in precedence order after `primary`
     */
    constructor(primary: AssetStoreProvider, readOnly: readonly AssetStoreProvider[]);
    private get sources();
    /**
     * Merge one read across every source: deduplicate by asset_id with earlier sources winning, then fill
     * the result by {@link interleave} so every source gets a fair share of the cap.
     */
    private merged;
    put(asset: AssetRecord): Promise<PutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    search(q: SearchQuery): Promise<AssetRecord[]>;
}