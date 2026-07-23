export type AssetKind = 'Gene' | 'Capsule' | 'EvolutionEvent' | 'AntiGene';
/** 任意带 type/asset_id 的 wire 资产(schema SSOT=gep-sdk, 此处不重定义字段). */
export interface AssetRecord {
    type: AssetKind;
    asset_id: string;
    [k: string]: unknown;
}
export interface PutResult {
    asset_id: string;
    stored: boolean;
    verified: boolean;
}
export type ConditionalPutStatus = 'stored' | 'already_exists' | 'logical_collision';
export interface ConditionalPutOptions {
    /** Only explicit force-like callers may keep multiple content versions for the same type + logical id. */
    allowLogicalCollision?: boolean;
}
export interface ConditionalPutResult extends PutResult {
    status: ConditionalPutStatus;
    logicalId?: string;
    collisionWithAssetId?: string;
}
export type InvalidConditionalPutResultReason = 'malformed_result' | 'asset_id_mismatch' | 'inconsistent_status' | 'invalid_collision' | 'collision_bypass';
export declare class InvalidConditionalPutResultError extends Error {
    readonly reason: InvalidConditionalPutResultReason;
    readonly code = "INVALID_CONDITIONAL_PUT_RESULT";
    constructor(reason: InvalidConditionalPutResultReason);
}
/** Validate an injected provider response before callers treat it as an explicit write/no-write decision. */
export declare function validateConditionalPutResult(value: unknown, expectedAssetId: string, options?: ConditionalPutOptions): ConditionalPutResult;
export interface SearchQuery {
    kind?: AssetKind;
    signalsAny?: string[];
    category?: string;
    gene?: string;
    text?: string;
    limit?: number;
}
/**
 * 可插拔资产库接口(D19/M3-1). 一份接口, 多实现: LocalJsonlProvider(本地) + Remote(hub).
 * core 可同时连多个 provider(本地 + 远程), 不造第四套契约.
 */
export interface AssetStoreProvider {
    put(asset: AssetRecord): Promise<PutResult>;
    /** Optional atomic capability; use supportsAtomicConditionalPut() before calling through this interface. */
    putConditional?(asset: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    /** Optional direct lookup for non-content-addressed logical ids. Callers must handle 0, 1, or multiple matches. */
    findByLogicalId?(id: string, limit?: number): Promise<AssetRecord[]>;
    search(query: SearchQuery): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
}
export type AtomicConditionalPutProvider = AssetStoreProvider & {
    putConditional(asset: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
};
export declare function supportsAtomicConditionalPut(provider: AssetStoreProvider): provider is AtomicConditionalPutProvider;
export declare class AssetIdMismatchError extends Error {
    readonly claimed: string;
    readonly actual: string;
    constructor(claimed: string, actual: string);
}
export declare class CapsuleGeneBindingError extends Error {
    constructor();
}
/**
 * 落库前规范化(共享给各 provider): 计算/校验 asset_id + 强绑定校验.
 * - 缺 asset_id → 计算填入(verified=false 表示非入参自带).
 * - 带 asset_id → 必须自洽, 否则抛 AssetIdMismatchError.
 * - Capsule.gene 必须非空(M3-4 强绑定).
 */
export declare function normalizeForPut(asset: AssetRecord): {
    record: AssetRecord;
    verified: boolean;
};