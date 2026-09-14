import type { AssetRecord } from '../assetstore/provider.js';
export declare const MAX_REFERENCE_BATCH_BYTES: number;
export declare const MAX_REFERENCE_BATCH = 100;
export declare const MAX_REFERENCE_TEXT_BYTES: number;
export declare const REFERENCE_ELIGIBILITY: Readonly<{
    executable: false;
    evidence_eligible: false;
    reward_eligible: false;
    task_result_eligible: false;
}>;
export interface ReferencePair {
    gene: AssetRecord;
    capsule: AssetRecord;
}
export interface ReferenceResult extends ReferencePair {
    bundle_id?: string;
    asset_id: string;
    type: 'Capsule' | 'Gene';
    payload: AssetRecord;
    evidence_mode: 'reference_only';
    source_node_id?: string;
    executable: false;
    evidence_eligible: false;
    reward_eligible: false;
    task_result_eligible: false;
}
export interface ReferenceQuery {
    query?: string;
    signals?: string[];
    asset_ids?: string[];
    content_hash?: string;
    max_assets?: number;
    cursor?: string;
    asset_type?: 'Gene' | 'Capsule';
}
export interface ReferencePage {
    evidence_mode: 'reference_only';
    results: ReferenceResult[];
    count: number;
    next_cursor: string | null;
}
export interface ReferenceCapability {
    fetch(query: ReferenceQuery): Promise<ReferencePage>;
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function decodeReferencePair(value: unknown): ReferencePair;
export declare function decodeReferenceBatch(value: unknown): ReferencePair[];
export declare function referenceBundleId(pair: ReferencePair): string;
export declare function validReferencePublisher(value: unknown): value is string;
export declare function referenceResult(pair: ReferencePair, sourceNodeId?: string, type?: 'Gene' | 'Capsule'): ReferenceResult;
export declare function decodeReferencePage(value: unknown, requireSourceNodeId?: boolean): ReferencePage;
export declare function normalizeReferenceQuery(value: ReferenceQuery): ReferenceQuery;