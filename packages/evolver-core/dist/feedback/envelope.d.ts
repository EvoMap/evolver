export declare const PRIORITY_AXES: readonly ["task_success", "user_preference", "quality", "safety", "cost", "latency", "other"];
export declare const LABELS: readonly ["positive", "negative", "mixed", "neutral"];
export declare const ATTENTION_LEVELS: readonly ["full", "limited", "skimmed", "unknown"];
export declare const EVIDENCE_KINDS: readonly ["evolution_event", "evolution_outcome", "user_override", "review", "turn", "external"];
export type FeedbackPriorityAxis = typeof PRIORITY_AXES[number];
export type FeedbackLabel = typeof LABELS[number];
export type EvaluatorAttentionLevel = typeof ATTENTION_LEVELS[number];
export type FeedbackEvidenceKind = typeof EVIDENCE_KINDS[number];
export interface EvaluatorAttention {
    level: EvaluatorAttentionLevel;
    observed_items?: number;
    elapsed_ms?: number;
}
export interface FeedbackEvidenceRef {
    kind: FeedbackEvidenceKind;
    id: string;
    summary?: string;
}
export interface FeedbackEnvelope {
    priority_axis: FeedbackPriorityAxis;
    label: FeedbackLabel;
    scalar: number;
    indecision: boolean;
    conflict: boolean;
    evaluator_attention: EvaluatorAttention;
    evidence_ref: FeedbackEvidenceRef;
    uncertainty: number;
}
export interface FeedbackAggregate {
    dominant_label: 'positive' | 'negative' | null;
    uncertainty: number;
    sample_count: number;
}
export interface FeedbackEnvelopeInput {
    priority_axis?: unknown;
    priorityAxis?: unknown;
    scalar?: unknown;
    indecision?: unknown;
    conflict?: unknown;
    evaluator_attention?: unknown;
    evaluatorAttention?: unknown;
    evidence_ref?: unknown;
    evidenceRef?: unknown;
}
export interface FeedbackOutcomeLike {
    score?: unknown;
    user_override?: unknown;
}
export declare function clamp01(value: unknown): number;
export declare function labelFromScalar(value: unknown): FeedbackLabel;
export declare function normalizeAttention(input: unknown): EvaluatorAttention;
export declare function evidenceRef(kind: unknown, id: unknown, options?: {
    summary?: unknown;
}): FeedbackEvidenceRef;
export declare function normalizeEvidenceRef(input: unknown): FeedbackEvidenceRef;
export declare function envelopeUncertainty(scalar: unknown, attentionLevel: EvaluatorAttentionLevel, indecision: boolean, conflict: boolean): number;
export declare function fromScalarFeedback(options?: FeedbackEnvelopeInput | null): FeedbackEnvelope;
export declare function fromOutcomeScalar(outcome: unknown, options?: Omit<FeedbackEnvelopeInput, 'scalar'>): FeedbackEnvelope | null;
export declare function withConflict(envelope: FeedbackEnvelope): FeedbackEnvelope;
export declare function withIndecision(envelope: FeedbackEnvelope): FeedbackEnvelope;
export declare function aggregateFeedbackEnvelopes(envelopes: readonly FeedbackEnvelope[] | null | undefined): FeedbackAggregate;