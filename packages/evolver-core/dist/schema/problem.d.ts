import { z } from 'zod';
/** value 命名因子, 禁黑盒 (军杰 §5.3). */
export declare const valueFactors: z.ZodObject<{
    severity: z.ZodDefault<z.ZodNumber>;
    reach: z.ZodDefault<z.ZodNumber>;
    strategicFit: z.ZodDefault<z.ZodNumber>;
    novelty: z.ZodDefault<z.ZodNumber>;
    costEst: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    severity: number;
    reach: number;
    strategicFit: number;
    novelty: number;
    costEst: number;
}, {
    severity?: number | undefined;
    reach?: number | undefined;
    strategicFit?: number | undefined;
    novelty?: number | undefined;
    costEst?: number | undefined;
}>;
export type ValueFactors = z.infer<typeof valueFactors>;
export declare const problemPattern: z.ZodObject<{
    id: z.ZodString;
    signature: z.ZodString;
    signatureV: z.ZodDefault<z.ZodNumber>;
    firstSeenAt: z.ZodString;
    lastSeenAt: z.ZodString;
    occurrences: z.ZodDefault<z.ZodNumber>;
    linkedSignals: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    resolvedBy: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    status: z.ZodDefault<z.ZodEnum<["open", "cooling", "resolved", "abandoned"]>>;
    value: z.ZodDefault<z.ZodObject<{
        severity: z.ZodDefault<z.ZodNumber>;
        reach: z.ZodDefault<z.ZodNumber>;
        strategicFit: z.ZodDefault<z.ZodNumber>;
        novelty: z.ZodDefault<z.ZodNumber>;
        costEst: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        severity: number;
        reach: number;
        strategicFit: number;
        novelty: number;
        costEst: number;
    }, {
        severity?: number | undefined;
        reach?: number | undefined;
        strategicFit?: number | undefined;
        novelty?: number | undefined;
        costEst?: number | undefined;
    }>>;
    consecutiveFailures: z.ZodDefault<z.ZodNumber>;
    cooldownUntil: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    value: {
        severity: number;
        reach: number;
        strategicFit: number;
        novelty: number;
        costEst: number;
    };
    status: "open" | "cooling" | "resolved" | "abandoned";
    extensions: Record<string, unknown>;
    signatureV: number;
    id: string;
    signature: string;
    firstSeenAt: string;
    lastSeenAt: string;
    occurrences: number;
    linkedSignals: string[];
    resolvedBy: string | null;
    consecutiveFailures: number;
    cooldownUntil: string | null;
}, {
    id: string;
    signature: string;
    firstSeenAt: string;
    lastSeenAt: string;
    value?: {
        severity?: number | undefined;
        reach?: number | undefined;
        strategicFit?: number | undefined;
        novelty?: number | undefined;
        costEst?: number | undefined;
    } | undefined;
    status?: "open" | "cooling" | "resolved" | "abandoned" | undefined;
    extensions?: Record<string, unknown> | undefined;
    signatureV?: number | undefined;
    occurrences?: number | undefined;
    linkedSignals?: string[] | undefined;
    resolvedBy?: string | null | undefined;
    consecutiveFailures?: number | undefined;
    cooldownUntil?: string | null | undefined;
}>;
export type ProblemPattern = z.infer<typeof problemPattern>;
export declare const problemInstance: z.ZodObject<{
    instanceId: z.ZodString;
    signature: z.ZodString;
    signatureV: z.ZodDefault<z.ZodNumber>;
    occurredAt: z.ZodString;
    linkedSignal: z.ZodOptional<z.ZodString>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    extensions: Record<string, unknown>;
    signatureV: number;
    signature: string;
    instanceId: string;
    occurredAt: string;
    linkedSignal?: string | undefined;
}, {
    signature: string;
    instanceId: string;
    occurredAt: string;
    extensions?: Record<string, unknown> | undefined;
    signatureV?: number | undefined;
    linkedSignal?: string | undefined;
}>;
export type ProblemInstance = z.infer<typeof problemInstance>;
/** 解法边界 = gene 唯一登场处 (军杰 §4.4). */
export declare const resolutionScope: z.ZodObject<{
    scopeId: z.ZodString;
    targetProblems: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    proposedByGene: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    boundary: z.ZodObject<{
        codePaths: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        dataSurfaces: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        blastRadius: z.ZodDefault<z.ZodEnum<["file", "module", "package", "system"]>>;
    }, "strip", z.ZodTypeAny, {
        codePaths: string[];
        dataSurfaces: string[];
        blastRadius: "file" | "module" | "package" | "system";
    }, {
        codePaths?: string[] | undefined;
        dataSurfaces?: string[] | undefined;
        blastRadius?: "file" | "module" | "package" | "system" | undefined;
    }>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    extensions: Record<string, unknown>;
    scopeId: string;
    targetProblems: string[];
    proposedByGene: string | null;
    boundary: {
        codePaths: string[];
        dataSurfaces: string[];
        blastRadius: "file" | "module" | "package" | "system";
    };
}, {
    scopeId: string;
    boundary: {
        codePaths?: string[] | undefined;
        dataSurfaces?: string[] | undefined;
        blastRadius?: "file" | "module" | "package" | "system" | undefined;
    };
    extensions?: Record<string, unknown> | undefined;
    targetProblems?: string[] | undefined;
    proposedByGene?: string | null | undefined;
}>;
export type ResolutionScope = z.infer<typeof resolutionScope>;