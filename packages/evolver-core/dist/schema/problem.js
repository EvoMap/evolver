import { z } from 'zod';
import { extensions, blastRadius } from './common.js';
/** value 命名因子, 禁黑盒 (军杰 §5.3). */
export const valueFactors = z.object({
    severity: z.number().default(0),
    reach: z.number().default(0),
    strategicFit: z.number().default(0),
    novelty: z.number().default(0),
    costEst: z.number().default(0),
});
export const problemPattern = z.object({
    id: z.string(),
    signature: z.string(),
    signatureV: z.number().int().positive().default(1),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    occurrences: z.number().int().nonnegative().default(0),
    linkedSignals: z.array(z.string()).default([]),
    resolvedBy: z.string().nullable().default(null),
    status: z.enum(['open', 'cooling', 'resolved', 'abandoned']).default('open'),
    value: valueFactors.default({}),
    consecutiveFailures: z.number().int().nonnegative().default(0),
    cooldownUntil: z.string().datetime().nullable().default(null),
    extensions,
});
export const problemInstance = z.object({
    instanceId: z.string(),
    signature: z.string(),
    signatureV: z.number().int().positive().default(1),
    occurredAt: z.string().datetime(),
    linkedSignal: z.string().optional(),
    extensions,
});
/** 解法边界 = gene 唯一登场处 (军杰 §4.4). */
export const resolutionScope = z.object({
    scopeId: z.string(),
    targetProblems: z.array(z.string()).default([]),
    proposedByGene: z.string().nullable().default(null),
    boundary: z.object({
        codePaths: z.array(z.string()).default([]),
        dataSurfaces: z.array(z.string()).default([]),
        blastRadius: blastRadius.default('module'),
    }),
    extensions,
});