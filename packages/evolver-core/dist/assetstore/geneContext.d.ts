import type { AssetRecord, AssetStoreProvider } from './provider.js';
import type { ProvenanceRecord } from './provenance.js';
import type { ReviewRecord } from './reviewLedger.js';
import { type BenchmarkContext, type SourceEligibilityReceipt } from './sourceQualification.js';
import { type RelatedCapsuleSource, type RelatedCapsuleQuery } from './relatedCapsules.js';
import { type ReferenceScope } from '../reference/guard.js';
export type GeneContextContentMode = 'summary' | 'strategy' | 'context';
export type GeneContextPrivacyMode = 'off' | 'shadow' | 'enforce';
export type GeneContextRelation = 'canonical' | 'logical_history';
export type GeneContextEvidence = 'recorded_success' | 'recorded_resolved_by_evidence' | 'recorded_failed' | 'outcome_unknown';
export type GeneContextOmissionReason = 'privacy_off' | 'privacy_shadow' | 'cancelled' | 'timeout' | 'unsupported_provider' | 'source_unavailable' | 'query_truncated' | 'invalid_identity' | 'ambiguous_relation' | 'unbound_relation' | 'not_success' | 'reference_only' | 'trust_rejected' | 'review_rejected' | 'qualification_rejected' | 'qualification_unavailable' | 'unsafe_or_oversize_field' | 'preconditions_rejected' | 'empty_content' | 'method_budget' | 'example_budget' | 'example_limit';
export interface GeneContextOmission {
    geneAssetId?: string;
    capsuleAssetId?: string;
    reason: GeneContextOmissionReason;
}
/** Explicit fresh caller-owned eligibility for selected Genes. This API does not select/rank Genes.
 * For an injected/union provider, the caller must resolve selected Genes' originating sidecars first.
 * Capsule qualification is ALWAYS taken from queryRelatedCapsules' source, not from these maps.
 */
export interface GeneContextEligibility {
    provenance: ReadonlyMap<string, ProvenanceRecord>;
    review: ReadonlyMap<string, ReviewRecord>;
    benchmark?: BenchmarkContext;
    referenceScope?: ReferenceScope;
}
export interface GeneContextExample {
    assetId: string;
    relation: GeneContextRelation;
    evidence: GeneContextEvidence;
    /** A historical outcome or resolution flag is NOT a host verification receipt. */
    verification: 'not_verified_by_this_read';
    summary: string;
    trigger: string[];
    strategy: string[];
}
export interface GeneContextProjection {
    assetId: string;
    logicalId?: string;
    summary: string;
    strategy: string[];
    preconditions: string[];
    /** Sticky across re-projection: rejected recorded conditions are not an absent condition list. */
    preconditionsRejected?: boolean;
    validationPlan: string[];
    examples: GeneContextExample[];
}
export interface GeneContextBudget {
    /** UTF-16 code units, including all rendered headings/quotation prefixes/newlines. */
    maxChars?: number;
    /** Independent global example ceiling inside maxChars; examples cannot evict methods. */
    maxExampleChars?: number;
    maxExampleCharsPerGene?: number;
    /** Default 1; zero disables the local query entirely. Hard maximum 3. */
    maxExamplesPerGene?: number;
}
export interface GeneContextSection {
    geneAssetId: string;
    capsuleAssetId?: string;
    kind: 'summary' | 'strategy' | 'preconditions' | 'validation_plan' | 'example';
    /** Exact offsets into final text, never into an intermediate/truncated rendering. */
    start: number;
    end: number;
    digest: string;
    /** Index of the intact strategy step in the safe projection, when applicable. */
    itemIndex?: number;
}
export interface RenderedGeneContext {
    text: string;
    digest: string;
    geneAssetIds: string[];
    capsuleAssetIds: string[];
    sections: GeneContextSection[];
    omissions: GeneContextOmission[];
}
export interface AssembleGeneContextOptions {
    selectedGenes: readonly AssetRecord[];
    store?: AssetStoreProvider;
    eligibility: GeneContextEligibility;
    contentMode?: GeneContextContentMode;
    /** Ephemeral task text for ranking already-qualified cases; never returned or persisted. */
    taskText?: string;
    /** Off/shadow return no bodies, projections, ids or sections; digest is only the empty-text digest. */
    privacyMode?: GeneContextPrivacyMode;
    budget?: GeneContextBudget;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Use this when a caller's outer timeout has already started. The earlier deadline always wins. */
    deadlineAt?: number;
    queryBudget?: Pick<RelatedCapsuleQuery, 'maxRecords' | 'maxCapsules'>;
    /** Product composition may recheck a provider immediately before optional V1 dispatch. */
    assertPromptAdapter?: () => void;
}
export interface AssembledGeneContext extends RenderedGeneContext {
    contentMode: GeneContextContentMode;
    privacyMode: GeneContextPrivacyMode;
    /** Only projections that contributed to final text; examples omitted by budget are not returned. */
    projections: GeneContextProjection[];
    qualifications: SourceEligibilityReceipt[];
    coverage: {
        status: RelatedCapsuleSource['status'];
        scanned: number;
        identityComplete: boolean;
    }[];
    counts: {
        selected: number;
        eligible: number;
        rendered: number;
        examples: number;
    };
}
/** Pure whitelist projection for real legacy producers (solidify/conversationDistiller/skill2gep).
 * No generic solution/validation assumption; content.excerpt, artifacts, execution_trace and diff are ignored.
 * New producers may use context_projection.schema=gene-context-projection.v1, but cannot assert verification.
 */
export declare function projectGeneContext(gene: AssetRecord): GeneContextProjection;
export declare function projectCapsuleContext(capsule: AssetRecord, relation: GeneContextRelation): GeneContextExample;
/** Pure deterministic renderer. Methods across ALL Genes have priority over any example.
 * Each strategy step is an atomic unit; no command, JSON line or code fence is sliced to fit.
 * Explicit summary/strategy modes intentionally never render examples (legacy caller support).
 */
export declare function renderGeneContext(projections: readonly GeneContextProjection[], options?: {
    contentMode?: GeneContextContentMode;
    budget?: GeneContextBudget;
}): RenderedGeneContext;
/** Shared render/recall gate. The caller must supply this asset's own source maps, including for a Capsule. */
export declare function assetContextEligibilityReason(asset: AssetRecord, eligibility: GeneContextEligibility): GeneContextOmissionReason | undefined;
/** Assemble already-selected Genes without changing their selection order or reading remote assets.
 * @example
 * const result = await assetstore.assembleGeneContext({
 *   selectedGenes, store,
 *   eligibility: { provenance: provenance.snapshot(), review: review.snapshot(), benchmark, referenceScope: store.referenceScope },
 *   contentMode: 'context', privacyMode: 'enforce',
 *   budget: { maxChars: 16000, maxExampleChars: 3000, maxExamplesPerGene: 1 },
 *   signal, deadlineAt: outerDeadline,
 * });
 * // Only result.text is prompt material. Log result.digest/sections/IDs/omissions, not raw records.
 * // summary/strategy skip the example query; off/shadow return no prompt material or candidate body digest.
 * // This read never executes validation plans, follows artifact paths, or establishes host verification.
 */
export declare function assembleGeneContext(options: AssembleGeneContextOptions): Promise<AssembledGeneContext>;