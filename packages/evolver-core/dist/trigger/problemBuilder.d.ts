import type { ProblemPattern } from '../schema/problem.js';
export interface ProblemPatternInput {
    problemKind: string;
    failureMode?: string;
    domainTags?: readonly string[];
    affectedSurface?: string;
    occurrences: number;
    firstSeenAt: string;
    lastSeenAt: string;
    linkedSignals?: readonly string[];
    /** 0..1 severity hint (caller maps its failure-mode taxonomy → a number). Default 0.5. */
    severity?: number;
    /** Override the classified heuristic; default: true unless kind is 'general' or failureMode is 'unknown'. */
    classified?: boolean;
    /** Override the derived id/signature. */
    id?: string;
    signature?: string;
}
/**
 * Assemble a triggerable ProblemPattern. The value factors come from {@link deriveValueFactors} so a vague
 * high-volume catch-all cannot out-trigger a specific, actionable problem by sheer volume (observation tuning,
 * #53). `classified` is auto-detected from the kind/failureMode being specific.
 */
export declare function buildProblemPattern(input: ProblemPatternInput): ProblemPattern;