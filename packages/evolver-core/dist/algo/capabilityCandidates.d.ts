/** The "five-question shape" of a capability proposal (ported verbatim from v1). */
export interface FiveQuestionShape {
    title: string;
    input: string;
    output: string;
    invariants: string;
    params: string;
    failure_points: string;
    evidence: string;
}
export interface CapabilityCandidate {
    type: 'CapabilityCandidate';
    id: string;
    title: string;
    source: 'transcript' | 'signals' | 'failed_capsules';
    signals: string[];
    tags: string[];
    shape: FiveQuestionShape;
}
export interface FailedCapsuleLike {
    trigger?: readonly string[];
    failure_reason?: string;
    gene?: string;
    outcome?: {
        status?: string;
    };
}
export interface ExtractCandidatesInput {
    /** Tool-call names observed (e.g. extracted from the runtime transcript). A name repeated >=3 times becomes a candidate. */
    toolCalls?: readonly string[];
    signals?: readonly string[];
    failedCapsules?: readonly FailedCapsuleLike[];
}
/**
 * Mine capability candidates from three sources (ported v1): repeated tool calls (>=3), active opportunity
 * signals, and clusters of failed capsules (>=2 in the same dominant-problem group). Deduped by stable id.
 */
export declare function extractCapabilityCandidates(inp: ExtractCandidatesInput): CapabilityCandidate[];