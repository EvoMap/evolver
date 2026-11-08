import type { GeneReadSnapshot, GeneSnapshotQuery } from './boundedSnapshot.js';
import type { GeneScanSessionV1 } from './geneScanV1.js';
import type { RelatedCapsuleQuery, RelatedCapsuleResult } from './relatedCapsules.js';
import { type ReferenceScope } from '../reference/guard.js';
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
export declare class FrozenAssetIdCollisionError extends Error {
    readonly assetId: string;
    readonly code = "FROZEN_ASSET_ID_COLLISION";
    constructor(assetId: string);
}
export declare class InvalidFrozenPutResultError extends Error {
    readonly code = "INVALID_FROZEN_PUT_RESULT";
    constructor();
}
export declare function frozenAssetRecordsEqual(left: AssetRecord, right: AssetRecord): boolean;
export declare function validateFrozenPutResult(value: unknown, expectedAssetId: string): PutResult;
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
export type RecallContext = {
    readonly [field: string]: unknown;
};
export interface SearchQuery {
    kind?: AssetKind;
    signalsAny?: string[];
    category?: string;
    gene?: string;
    text?: string;
    /** Task-domain scope (hub taxonomy slug, e.g. "software_engineering"). Local providers may ignore it; the hub applies it as a recall fence. */
    domain?: string;
    /**
     * What the caller is working on, for the hub to judge a text recall's fit by; never used to recall. A JSON object
     * whose fields the hub defines (`task`, `trigger`, `language`, ...): clients forward it whole, so a new field needs
     * no client release.
     */
    context?: RecallContext;
    limit?: number;
}
/** A bounded external read owns every dispatched side effect until terminal settlement.
 * The operation handle is returned synchronously, before any asynchronous I/O.
 * `cancelAndSettle` must not resolve merely because an AbortSignal was sent: it
 * resolves only when the adapter has stopped its worker and cannot mutate state
 * or publish a late result. Built-in local readers perform no external writes.
 */
export interface ContextReadOperationV1<T> {
    readonly version: 1;
    readonly result: Promise<T>;
    cancelAndSettle(): Promise<void>;
}
/** Lookup budget shared by execution-context identity reads. */
export interface ContextLookupQueryV1 {
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
}
/**
 * 可插拔资产库接口(D19/M3-1). 一份接口, 多实现: LocalJsonlProvider(本地) + Remote(hub).
 * core 可同时连多个 provider(本地 + 远程), 不造第四套契约.
 */
export interface LocalProjectContextV1 {
    readonly version: 1;
    readonly capsuleAssetId: string;
    readonly geneAssetId: string;
    readonly notes: readonly string[];
    readonly projectFingerprint?: string;
}
export interface AssetStoreProvider {
    readonly referenceScope?: ReferenceScope;
    /** Async read-only Gene + own qualification snapshot. Never loads optional Capsule/event pools.
     * Rejects on unknown authority, mutation or exhausted budget; no partial local-default trust. */
    queryGeneSnapshot?(query?: GeneSnapshotQuery): Promise<GeneReadSnapshot>;
    /** Required for prompt-time use of an injected provider. Legacy callbacks
     * cannot attest terminal cancellation and are refused before dispatch. */
    beginPromptGeneSnapshotV1?(query: GeneSnapshotQuery): ContextReadOperationV1<GeneReadSnapshot>;
    /** Bounded, versioned raw-row scan with one retained cleanup owner. Required
     * for authoritative multi-source Union reads; the legacy method alone cannot
     * prove scanned rows or safely continue an exhausted source. */
    beginGeneScanV1?(query?: GeneSnapshotQuery): GeneScanSessionV1;
    /** Local-only, bounded batch of related Capsules WITH their own source qualification.
     * Unsupported providers must not be emulated with remote search or unbounded list scans. */
    queryRelatedCapsules?(query: RelatedCapsuleQuery): Promise<RelatedCapsuleResult>;
    beginPromptRelatedCapsulesV1?(query: RelatedCapsuleQuery): ContextReadOperationV1<RelatedCapsuleResult>;
    /** Exact content-addressed lookup for bounded execution context. */
    beginPromptAssetGetV1?(assetId: string, query: ContextLookupQueryV1): ContextReadOperationV1<AssetRecord | null>;
    /** Exact Gene logical-id lookup, capped at two matches to detect ambiguity. */
    beginPromptLogicalGeneLookupV1?(id: string, query: ContextLookupQueryV1): ContextReadOperationV1<AssetRecord[]>;
    put(asset: AssetRecord): Promise<PutResult>;
    /** 可选的可崩溃恢复批量写入，用于保持相关资产（例如 Gene/Capsule 对）的一致性。
     * 需要持久化相关资产组的调用方必须先确认此能力存在，不得退回顺序单条写入。
     * 返回结果按唯一 asset_id 各一条（同 bundle 内重复条目按幂等去重），调用方必须按 asset_id 键控消费结果，不得按索引与输入条目对齐。 */
    putBundle?(assets: readonly AssetRecord[]): Promise<PutResult[]>;
    /** Atomic local context + asset transaction. Never emulate with two separate writes. */
    putBundleWithLocalContextV1?(assets: readonly AssetRecord[], context: LocalProjectContextV1): Promise<PutResult[]>;
    readLocalContextsV1?(capsuleAssetIds: readonly string[]): Promise<LocalProjectContextV1[]>;
    /** Optional atomic capability; use supportsAtomicConditionalPut() before calling through this interface. */
    putConditional?(asset: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
    get(assetId: string): Promise<AssetRecord | null>;
    /** Exact all-kind identity/source priority as get, preserving source reference denials; missing ids are omitted.
     * Optional so legacy and remote providers retain their mandatory single-id protocol. */
    getMany?(assetIds: readonly string[]): Promise<ReadonlyMap<string, AssetRecord>>;
    /** Optional direct lookup for non-content-addressed logical ids. Callers must handle 0, 1, or multiple matches. */
    findByLogicalId?(id: string, limit?: number, kind?: AssetKind): Promise<AssetRecord[]>;
    /**
     * Optional frozen write: store the record under its OWN declared asset_id without recomputing or
     * normalizing it (bypasses {@link normalizeForPut}'s self-consistency check). Only providers backing a
     * content-addressed local pool implement it. Callers that must preserve a hash-inconsistent asset —
     * v1 migration import, and unverified hub reuse of a hub-rewritten payload (see `ingestUnverified`) —
     * feature-detect it rather than assuming it exists.
     */
    putFrozen?(record: AssetRecord): Promise<PutResult>;
    /** Atomic frozen variant that also enforces the type + logical-id condition under the provider write lock. */
    putFrozenConditional?(record: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
    search(query: SearchQuery): Promise<AssetRecord[]>;
    list(kind?: AssetKind, limit?: number): Promise<AssetRecord[]>;
    /** 可选最近语料能力：单源按首次不同 asset_id 写入顺序倒序，幂等重复不刷新年龄。
     * limit 为 1..1000；不改变 list 的历史顺序。组合源采用稳定 round-robin，不宣称全局时间。 */
    listRecent?(kind: AssetKind, limit?: number): Promise<AssetRecord[]>;
}
/** Capture optional batch authority once; explicit absence preserves an overridden get. */
export declare function getAssetsById(store: AssetStoreProvider, assetIds: readonly string[], capturedReader?: AssetStoreProvider['getMany']): Promise<ReadonlyMap<string, AssetRecord>>;
export type AtomicConditionalPutProvider = AssetStoreProvider & {
    putConditional(asset: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
};
export declare function supportsAtomicConditionalPut(provider: AssetStoreProvider): provider is AtomicConditionalPutProvider;
export type AtomicFrozenConditionalPutProvider = AssetStoreProvider & {
    putFrozenConditional(record: AssetRecord, options?: ConditionalPutOptions): Promise<ConditionalPutResult>;
};
export declare function supportsAtomicFrozenConditionalPut(provider: AssetStoreProvider): provider is AtomicFrozenConditionalPutProvider;
export declare class AssetIdMismatchError extends Error {
    readonly claimed: string;
    readonly actual: string;
    constructor(claimed: string, actual: string);
}
export declare class CapsuleGeneBindingError extends Error {
    constructor();
}
/**
 * M3-4 强绑定校验: Capsule.gene 必须非空(否则一条无来源基因的经验会污染选择池).
 * 抽成独立 helper 以便 normalizeForPut(校验落库路径)与 ingestUnverified(冻结落库路径,
 * 绕过 normalizeForPut)共用同一条不变量,不让降级路径把绑定校验漏掉.
 */
export declare function assertCapsuleGeneBinding(asset: AssetRecord, scope?: ReferenceScope): void;
/**
 * 落库前规范化(共享给各 provider): 计算/校验 asset_id + 强绑定校验.
 * - 缺 asset_id → 计算填入(verified=false 表示非入参自带).
 * - 带 asset_id → 必须自洽, 否则抛 AssetIdMismatchError.
 * - Capsule.gene 必须非空(M3-4 强绑定).
 */
export declare function normalizeForPut(asset: AssetRecord, scope?: ReferenceScope): {
    record: AssetRecord;
    verified: boolean;
};