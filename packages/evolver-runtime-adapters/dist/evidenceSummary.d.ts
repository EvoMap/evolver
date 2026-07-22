import type { NormalizedSession } from './types.js';
export type RuntimeSessionEvidenceCoverage = 'complete' | 'partial' | 'empty';
export type RuntimeSessionEvidenceGapCode = 'empty_session' | 'missing_tool_result' | 'unmatched_tool_result';
export interface RuntimeSessionEvidenceCounts {
    nonMetaTurns: number;
    toolCalls: number;
    toolResults: number;
    matchedToolResults: number;
    missingToolResults: number;
    unmatchedToolResults: number;
    failedToolResults: number;
}
export interface RuntimeSessionEvidenceSummary {
    coverage: RuntimeSessionEvidenceCoverage;
    counts: RuntimeSessionEvidenceCounts;
    gapCodes: RuntimeSessionEvidenceGapCode[];
}
/** Summarizes transcript structure only; complete coverage does not verify the task outcome. */
export declare function summarizeSessionEvidence(session: Pick<NormalizedSession, 'turns'>): RuntimeSessionEvidenceSummary;