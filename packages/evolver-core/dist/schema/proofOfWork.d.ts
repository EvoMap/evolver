import { z } from 'zod';
/** 产出证据 (批注#19): 解锁非 coding agent, 不再"无 git 变动=没产出". */
export declare const proofOfWork: z.ZodObject<{
    kind: z.ZodEnum<["git_diff", "artifact_hash", "external_receipt", "tool_call_trace"]>;
    gitDiff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
        patchRef: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        files: number;
        lines: number;
        patchRef?: string | undefined;
    }, {
        files: number;
        lines: number;
        patchRef?: string | undefined;
    }>>;
    artifactHash: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        sha256: string;
        size: number;
        mime?: string | undefined;
    }, {
        sha256: string;
        size: number;
        mime?: string | undefined;
    }>>;
    externalReceipt: z.ZodOptional<z.ZodObject<{
        provider: z.ZodString;
        receiptId: z.ZodString;
        ts: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        receiptId: string;
        ts: string;
    }, {
        provider: string;
        receiptId: string;
        ts: string;
    }>>;
    toolCallTrace: z.ZodOptional<z.ZodObject<{
        calls: z.ZodNumber;
        ref: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        calls: number;
        ref?: string | undefined;
    }, {
        calls: number;
        ref?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    kind: "git_diff" | "artifact_hash" | "external_receipt" | "tool_call_trace";
    gitDiff?: {
        files: number;
        lines: number;
        patchRef?: string | undefined;
    } | undefined;
    artifactHash?: {
        sha256: string;
        size: number;
        mime?: string | undefined;
    } | undefined;
    externalReceipt?: {
        provider: string;
        receiptId: string;
        ts: string;
    } | undefined;
    toolCallTrace?: {
        calls: number;
        ref?: string | undefined;
    } | undefined;
}, {
    kind: "git_diff" | "artifact_hash" | "external_receipt" | "tool_call_trace";
    gitDiff?: {
        files: number;
        lines: number;
        patchRef?: string | undefined;
    } | undefined;
    artifactHash?: {
        sha256: string;
        size: number;
        mime?: string | undefined;
    } | undefined;
    externalReceipt?: {
        provider: string;
        receiptId: string;
        ts: string;
    } | undefined;
    toolCallTrace?: {
        calls: number;
        ref?: string | undefined;
    } | undefined;
}>;
export type ProofOfWork = z.infer<typeof proofOfWork>;