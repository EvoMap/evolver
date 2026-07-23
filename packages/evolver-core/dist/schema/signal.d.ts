import { z } from 'zod';
/** 三层签名·工程层 (军杰 §4.2). camelCase (内部类型, schema §0 / 硬化 A10). */
export declare const eventSignature: z.ZodString;
/** 三层签名·领域层 (军杰 §4.3), 不含 gene_id. */
export declare const problemSignature: z.ZodString;
/** 选择压. 三条腿: 结构化强 / corpus 弱 / agent 自标 (批注#13). */
export declare const signal: z.ZodObject<{
    signalId: z.ZodString;
    fromMaterial: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    kind: z.ZodEnum<["strong_structured", "weak_corpus", "agent_marked", "verified_success"]>;
    text: z.ZodString;
    score: z.ZodDefault<z.ZodNumber>;
    eventSignature: z.ZodString;
    problemSignature: z.ZodString;
    signatureV: z.ZodDefault<z.ZodNumber>;
    discoveredAt: z.ZodString;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    kind: "strong_structured" | "weak_corpus" | "agent_marked" | "verified_success";
    extensions: Record<string, unknown>;
    signalId: string;
    fromMaterial: string[];
    text: string;
    score: number;
    eventSignature: string;
    problemSignature: string;
    signatureV: number;
    discoveredAt: string;
}, {
    kind: "strong_structured" | "weak_corpus" | "agent_marked" | "verified_success";
    signalId: string;
    text: string;
    eventSignature: string;
    problemSignature: string;
    discoveredAt: string;
    extensions?: Record<string, unknown> | undefined;
    fromMaterial?: string[] | undefined;
    score?: number | undefined;
    signatureV?: number | undefined;
}>;
export type Signal = z.infer<typeof signal>;