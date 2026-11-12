import type { AssetRecord } from './provider.js';
export declare const EVIDENCE_FILE = "experience-evidence.jsonl";
export declare const EVIDENCE_KINDS: readonly ["trial", "experiment"];
export declare const EVIDENCE_OUTCOMES: readonly ["success", "failed", "unused"];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number] | 'capture';
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];
export interface EvidenceMetrics {
    durationMs?: number;
    tokens?: number;
    checkPassed?: boolean;
}
export interface EvidenceInput {
    assetId: string;
    kind: (typeof EVIDENCE_KINDS)[number];
    outcome: EvidenceOutcome;
    summary: string;
    metrics: EvidenceMetrics;
    taskId?: string;
}
/** One sidecar row. Evidence lives beside the asset store, never in capsules.jsonl: user-reported trials must not feed promotion or publish eligibility. */
export interface ExperienceEvidenceRow {
    schema: 1;
    evidenceId: string;
    assetId: string;
    kind: EvidenceKind;
    outcome: EvidenceOutcome;
    summary: string;
    metrics: EvidenceMetrics;
    taskId?: string;
    at: string;
    capsule: AssetRecord | null;
    operationId?: string;
}
/** Validates an `experience evidence` request at the boundary. */
export declare function evidenceInputOf(raw: Record<string, unknown>): EvidenceInput;
/** The user-authored Capsule a trial yields, bound to the Gene's content id; an unused trial proves nothing, so it yields none. */
export declare function evidenceCapsule(gene: AssetRecord, input: Omit<EvidenceInput, 'assetId' | 'taskId'>, at: string): AssetRecord | null;
/** Trial and experiment evidence per Gene, plus the Capsule a capture brought along. */
export declare class ExperienceEvidence {
    private readonly baseDir;
    private readonly now;
    private readonly path;
    constructor(baseDir: string, now?: () => number);
    list(assetId?: string): ExperienceEvidenceRow[];
    record(gene: AssetRecord, input: EvidenceInput): ExperienceEvidenceRow;
}
/** The row a capture commits beside its Gene when the caller brought the Capsule distilled with it. */
export declare function captureEvidenceRow(capsule: AssetRecord, assetId: string, operationId: string, at: string): ExperienceEvidenceRow;