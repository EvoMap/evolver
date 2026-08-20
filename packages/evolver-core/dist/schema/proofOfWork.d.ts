import { z } from 'zod';
export declare const proofOfWork: z.ZodObject<{
    kind: z.ZodEnum<["git_diff", "artifact_hash", "external_receipt", "tool_call_trace"]>;
    git_diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>>;
    artifact_hash: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>;
    external_receipt: z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>>;
    tool_call_trace: z.ZodOptional<z.ZodObject<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>>;
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
        ts: string;
        receiptId: string;
    }, {
        provider: string;
        ts: string;
        receiptId: string;
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
    git_diff?: z.objectOutputType<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    artifact_hash?: z.objectOutputType<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    external_receipt?: z.objectOutputType<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    tool_call_trace?: z.objectOutputType<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
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
        ts: string;
        receiptId: string;
    } | undefined;
    toolCallTrace?: {
        calls: number;
        ref?: string | undefined;
    } | undefined;
}, {
    kind: "git_diff" | "artifact_hash" | "external_receipt" | "tool_call_trace";
    git_diff?: z.objectInputType<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    artifact_hash?: z.objectInputType<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    external_receipt?: z.objectInputType<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    tool_call_trace?: z.objectInputType<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
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
        ts: string;
        receiptId: string;
    } | undefined;
    toolCallTrace?: {
        calls: number;
        ref?: string | undefined;
    } | undefined;
}>;
export type ProofOfWork = z.infer<typeof proofOfWork>;
/** #961 兼容读: snake_case 优先, 旧别名只补齐部分迁移 payload 缺失的字段. */
export declare function gitDiffOf(p: ProofOfWork | undefined): ProofOfWork['git_diff'] | ProofOfWork['gitDiff'] | undefined;
export declare function artifactHashOf(p: ProofOfWork | undefined): ProofOfWork['artifact_hash'] | undefined;
export declare function externalReceiptOf(p: ProofOfWork | undefined): ProofOfWork['external_receipt'] | ProofOfWork['externalReceipt'] | undefined;
export declare function toolCallTraceOf(p: ProofOfWork | undefined): ProofOfWork['tool_call_trace'] | undefined;
/** #961 写边界: 兼容读到的旧 camelCase proof 必须规范化后才能进入新 Capsule。 */
export declare function proofOfWorkForWrite(p: ProofOfWork): ProofOfWork;
/** Accept either canonical snake_case or legacy camelCase stored proof without lossy conversion. */
export declare function normalizeProofOfWork(input: unknown): ProofOfWork | undefined;
export interface WireProofOfWork {
    kind: ProofOfWork['kind'];
    git_diff?: {
        files?: number;
        lines?: number;
        patch_ref?: string;
    };
    artifact_hash?: {
        sha256?: string;
        mime?: string;
        size?: number;
    };
    external_receipt?: {
        provider?: string;
        receipt_id?: string;
        ts?: string;
    };
    tool_call_trace?: {
        calls?: number;
        ref?: string;
    };
}
/** Convert a proof to the gep-sdk wire shape while preserving canonical nested fields and extensions. */
export declare function toWireProofOfWork(proof: ProofOfWork): WireProofOfWork;