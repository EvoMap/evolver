export type ConstraintKind = 'must' | 'must_not';
export type ConstraintTraceSource = 'plan' | 'task' | 'trace';
export type ConstraintSeverity = 'low' | 'medium' | 'high';
export type SensitiveClass = 'credential' | 'email' | 'filesystem_path';
export type TaskSuccessStatus = 'success' | 'failure' | 'unknown';
export type TaskSuccessSource = 'oracle' | 'task_status' | 'manual' | 'trace';
export type SensitivitySuccessComparison = 'success_constraint_sensitive' | 'success_constraint_insensitive' | 'failure_constraint_sensitive' | 'failure_constraint_insensitive' | 'unknown_success';
export interface ConstraintTrace {
    source: ConstraintTraceSource;
    text: string;
    traceId?: string;
}
export interface ExtractedConstraint {
    id: string;
    kind: ConstraintKind;
    textHash: string;
    redactedText: string;
    source: ConstraintTraceSource;
    traceId?: string;
    sensitiveClasses: SensitiveClass[];
}
export interface ConstraintAblatedPrompt {
    originalPromptHash: string;
    ablatedPromptHash: string;
    removedConstraintIds: string[];
    redactedPreview?: string;
}
export interface ConstraintViolation {
    constraintId: string;
    kind: ConstraintKind;
    severity: ConstraintSeverity;
    evidenceHash: string;
    matchedTerms: string[];
}
export interface TaskSuccessLabel {
    status: TaskSuccessStatus;
    source: TaskSuccessSource;
}
export interface ConstraintAblationScore {
    source: 'constraint_ablation_replay';
    sensitivity: number;
    ablationCount: number;
    baselineViolationCount: number;
    ablatedViolationCount: number;
    mustViolationCount: number;
    mustNotViolationCount: number;
    taskSuccess: TaskSuccessLabel;
    comparison: SensitivitySuccessComparison;
}
export interface ConstraintAblationScoreInput {
    baselineViolations: readonly ConstraintViolation[];
    ablatedViolations: readonly ConstraintViolation[];
    removedConstraintIds: readonly string[];
    ablationCount: number;
    taskSuccess: TaskSuccessLabel;
    sensitivityThreshold?: number;
}
export declare function redactConstraintText(text: string): string;
export declare function extractConstraints(traces: readonly ConstraintTrace[]): ExtractedConstraint[];
export declare function buildConstraintAblatedPrompts(prompt: string, constraints: readonly ExtractedConstraint[], opts?: {
    includeRedactedPreview?: boolean;
}): ConstraintAblatedPrompt[];
export declare function detectConstraintViolations(output: string, constraints: readonly ExtractedConstraint[]): ConstraintViolation[];
export declare function computeConstraintAblationScore(input: ConstraintAblationScoreInput): ConstraintAblationScore;