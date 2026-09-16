import type { AssetRecord } from './provider.js';
import type { ProvenanceRecord } from './provenance.js';
export declare const SOURCE_QUALIFICATION_SCHEMA = "benchmark-source-qualification.v1";
declare const RESOURCE_KINDS: readonly ["task_test", "self_test", "task_material", "self_material", "documentation", "external_solution", "external_test", "unknown"];
declare const ACCESS_OUTCOMES: readonly ["read", "attempted", "failed", "blocked"];
export interface BenchmarkContext {
    benchmarkId: string;
}
export interface SourceAccessEvidence {
    callId: string;
    eventDigest: string;
    resourceDigest: string;
    kind: (typeof RESOURCE_KINDS)[number];
    outcome: (typeof ACCESS_OUTCOMES)[number];
    resultDigest?: string;
}
export interface SourceQualificationRequest {
    benchmarkId: string;
    runId: string;
    trajectoryDigest: string;
    assetId: string;
    assetContentId: string;
    coverage: 'complete' | 'partial';
    events: readonly SourceAccessEvidence[];
}
export interface SourceQualification extends SourceQualificationRequest {
    schema: typeof SOURCE_QUALIFICATION_SCHEMA;
    state: 'eligible' | 'ineligible' | 'unknown';
    evidenceDigest: string;
    by: string;
    reason: string;
    at: string;
    exception?: {
        by: string;
        reason: string;
    };
}
export interface SourceEligibilityDecision {
    allowed: boolean;
    state: SourceQualification['state'] | 'not_applicable';
    reason: 'standard_mode' | 'missing_evidence' | 'content_mismatch' | 'external_reference' | 'review_incomplete' | 'qualified' | 'explicit_exception' | 'trust_rejected' | 'review_rejected' | 'review_unavailable';
    evidenceDigest?: string;
    trajectoryDigest?: string;
    runId?: string;
}
export interface SourceEligibilityReceipt extends SourceEligibilityDecision {
    assetId: string;
    benchmarkId: string;
}
export interface SourceQualificationReference {
    assetId: string;
    evidenceDigest: string;
    state: SourceQualification['state'];
    reason: 'qualified' | 'explicit_exception';
    allowed: true;
}
/** root_event有4096B上限：公共context只记一次，原始run/event/trajectory从append-only provenance追溯。 */
export declare function compactQualificationReceipts(receipts: readonly SourceEligibilityReceipt[]): {
    sourceQualificationSchema?: 'benchmark-source-references.v1';
    sourceBenchmarkId?: string;
    sourceQualifications?: SourceQualificationReference[];
};
export interface SourceSelectionOptions {
    benchmark?: BenchmarkContext;
    onQualification?: (receipts: readonly SourceEligibilityReceipt[]) => void;
}
/** composition层显式传入env值；core不自行读取进程环境，不改变普通运行。 */
export declare function benchmarkContext(value: unknown): BenchmarkContext | undefined;
export declare function parseSourceQualificationRequest(value: unknown): SourceQualificationRequest | null;
export declare function qualifySource(value: unknown, by: string, reason: string, at: string, exceptionReason?: string): SourceQualification;
export declare function parseSourceQualification(value: unknown): SourceQualification | null;
export declare function parseSourceQualifications(value: unknown, assetId: string): readonly SourceQualification[] | null;
/** 资格不取代既有trust/review；每次使用fresh provenance，撤销无需改asset内容。 */
export declare function assessSourceEligibility(asset: AssetRecord, provenance: ProvenanceRecord | null | undefined, context?: BenchmarkContext): SourceEligibilityDecision;
export {};