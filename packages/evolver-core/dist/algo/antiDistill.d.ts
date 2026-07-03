import type { AssetRecord } from '../assetstore/provider.js';
export declare const ANTI_DISTILL_MIN_FAILURES = 2;
export declare const ANTI_DISTILL_TRIGGER_OVERLAP_MIN = 0.6;
export interface AntiDistillOptions {
    /** Minimum distinct failed capsules before a failure pattern is treated as reusable evidence. */
    minFailures?: number;
    /** Minimum pairwise trigger Jaccard overlap for capsules to share one cluster. */
    triggerOverlapMin?: number;
    /** Optional cap for callers that only want the strongest clusters. */
    maxClusters?: number;
}
export interface AntiDistillFailedCapsule {
    capsuleId: string;
    trigger: readonly string[];
    gene?: string;
    summary?: string;
    outcome?: unknown;
    proofOfWork?: unknown;
}
export interface AntiDistillFailureCluster {
    clusterId: string;
    trigger: readonly string[];
    sharedTrigger: readonly string[];
    capsuleIds: readonly string[];
    genes: readonly string[];
    failureCapsules: readonly AntiDistillFailedCapsule[];
}
export interface AntiDistillInput {
    dataHash: string;
    failedCapsuleCount: number;
    clusterableFailureCount: number;
    failureClusters: readonly AntiDistillFailureCluster[];
}
export declare function triggerOverlapScore(a: readonly string[], b: readonly string[]): number;
export declare function collectAntiDistillInput(capsules: readonly AssetRecord[], opts?: AntiDistillOptions): AntiDistillInput;