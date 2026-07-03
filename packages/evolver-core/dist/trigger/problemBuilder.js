import { problemSignature, SIGNATURE_V } from '../signatures/signatures.js';
import { deriveValueFactors } from './valueModel.js';
/**
 * Assemble a triggerable ProblemPattern. The value factors come from {@link deriveValueFactors} so a vague
 * high-volume catch-all cannot out-trigger a specific, actionable problem by sheer volume (observation tuning,
 * #53). `classified` is auto-detected from the kind/failureMode being specific.
 */
export function buildProblemPattern(input) {
    const sigInput = {
        problemKind: input.problemKind,
        ...(input.domainTags ? { domainTags: input.domainTags } : {}),
        ...(input.affectedSurface ? { affectedSurface: input.affectedSurface } : {}),
        ...(input.failureMode ? { failureMode: input.failureMode } : {}),
    };
    const signature = input.signature ?? problemSignature(sigInput);
    const classified = input.classified ?? (input.problemKind !== 'general' && (input.failureMode ?? 'unknown') !== 'unknown');
    return {
        id: input.id ?? signature,
        signature,
        signatureV: SIGNATURE_V,
        firstSeenAt: input.firstSeenAt,
        lastSeenAt: input.lastSeenAt,
        occurrences: input.occurrences,
        linkedSignals: [...(input.linkedSignals ?? [])],
        resolvedBy: null,
        status: 'open',
        value: deriveValueFactors({ occurrences: input.occurrences, classified, ...(input.severity !== undefined ? { severity: input.severity } : {}) }),
        consecutiveFailures: 0,
        cooldownUntil: null,
        extensions: {},
    };
}