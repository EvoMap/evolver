import { z } from 'zod';
/** value 命名因子, 禁黑盒 (军杰 §5.3). */
export declare const valueFactors: z.ZodObject<{
    severity: z.ZodDefault<z.ZodNumber>;
    reach: z.ZodDefault<z.ZodNumber>;
    strategicFit: z.ZodDefault<z.ZodNumber>;
    novelty: z.ZodDefault<z.ZodNumber>;
    costEst: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ValueFactors = z.infer<typeof valueFactors>;
export declare const problemPattern: z.ZodObject<{
    id: z.ZodString;
    signature: z.ZodString;
    signatureV: z.ZodDefault<z.ZodNumber>;
    firstSeenAt: z.ZodString;
    lastSeenAt: z.ZodString;
    occurrences: z.ZodDefault<z.ZodNumber>;
    linkedSignals: z.ZodDefault<z.ZodArray<z.ZodString>>;
    resolvedBy: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    status: z.ZodDefault<z.ZodEnum<{
        open: "open";
        abandoned: "abandoned";
        cooling: "cooling";
        resolved: "resolved";
    }>>;
    value: z.ZodPrefault<z.ZodObject<{
        severity: z.ZodDefault<z.ZodNumber>;
        reach: z.ZodDefault<z.ZodNumber>;
        strategicFit: z.ZodDefault<z.ZodNumber>;
        novelty: z.ZodDefault<z.ZodNumber>;
        costEst: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    consecutiveFailures: z.ZodDefault<z.ZodNumber>;
    cooldownUntil: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type ProblemPattern = z.infer<typeof problemPattern>;
export declare const problemInstance: z.ZodObject<{
    instanceId: z.ZodString;
    signature: z.ZodString;
    signatureV: z.ZodDefault<z.ZodNumber>;
    occurredAt: z.ZodString;
    linkedSignal: z.ZodOptional<z.ZodString>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type ProblemInstance = z.infer<typeof problemInstance>;
/** 解法边界 = gene 唯一登场处 (军杰 §4.4). */
export declare const resolutionScope: z.ZodObject<{
    scopeId: z.ZodString;
    targetProblems: z.ZodDefault<z.ZodArray<z.ZodString>>;
    proposedByGene: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    boundary: z.ZodObject<{
        codePaths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        dataSurfaces: z.ZodDefault<z.ZodArray<z.ZodString>>;
        blastRadius: z.ZodDefault<z.ZodEnum<{
            file: "file";
            module: "module";
            package: "package";
            system: "system";
        }>>;
    }, z.core.$strip>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type ResolutionScope = z.infer<typeof resolutionScope>;