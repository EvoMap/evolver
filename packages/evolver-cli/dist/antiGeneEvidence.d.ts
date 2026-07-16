import type { assetstore } from '@evomap/evolver-core';
type AntiGeneEvidenceStrength = 'strong' | 'weak';
type AntiGeneReviewState = 'approved' | 'quarantined' | 'rejected' | 'unreviewed';
export interface AntiGeneEvidenceSummary {
    failureCount: number | null;
    sourceClusterCount: number;
    evidenceCapsuleCount: number;
    observedDecisionCount: number;
    strength: AntiGeneEvidenceStrength;
    weakReasons: string[];
}
export declare function summarizeAntiGeneEvidence(asset: assetstore.AssetRecord, observedDecisionCount?: number): AntiGeneEvidenceSummary;
export declare function formatAntiGeneEvidenceSummary(summary: AntiGeneEvidenceSummary): string;
export declare function formatAntiGeneEvidenceAction(summary: AntiGeneEvidenceSummary, state: AntiGeneReviewState): string;
export {};