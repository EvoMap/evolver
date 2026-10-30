import { z } from 'zod';
export declare const proofOfWork: z.ZodObject<{
    kind: z.ZodEnum<{
        git_diff: "git_diff";
        artifact_hash: "artifact_hash";
        external_receipt: "external_receipt";
        tool_call_trace: "tool_call_trace";
    }>;
    git_diff: z.ZodOptional<z.ZodObject<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    artifact_hash: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    external_receipt: z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    tool_call_trace: z.ZodOptional<z.ZodObject<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    gitDiff: z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
        patchRef: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    artifactHash: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodNumber;
    }, z.core.$strip>>;
    externalReceipt: z.ZodOptional<z.ZodObject<{
        provider: z.ZodString;
        receiptId: z.ZodString;
        ts: z.ZodString;
    }, z.core.$strip>>;
    toolCallTrace: z.ZodOptional<z.ZodObject<{
        calls: z.ZodNumber;
        ref: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ProofOfWork = z.infer<typeof proofOfWork>;
export declare const proofOfWorkInput: z.ZodPipe<z.ZodUnknown, z.ZodObject<{
    kind: z.ZodEnum<{
        git_diff: "git_diff";
        artifact_hash: "artifact_hash";
        external_receipt: "external_receipt";
        tool_call_trace: "tool_call_trace";
    }>;
    git_diff: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        files: z.ZodOptional<z.ZodNumber>;
        lines: z.ZodOptional<z.ZodNumber>;
        patch_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>>;
    artifact_hash: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        sha256: z.ZodOptional<z.ZodString>;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>>>;
    external_receipt: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        ts: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>>;
    tool_call_trace: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        calls: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>>;
    gitDiff: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        files: z.ZodNumber;
        lines: z.ZodNumber;
        patchRef: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>>;
    artifactHash: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
        mime: z.ZodOptional<z.ZodString>;
        size: z.ZodNumber;
    }, z.core.$strip>>>>;
    externalReceipt: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        provider: z.ZodString;
        receiptId: z.ZodString;
        ts: z.ZodString;
    }, z.core.$strip>>>>;
    toolCallTrace: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodOptional<z.ZodObject<{
        calls: z.ZodNumber;
        ref: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>>;
}, z.core.$strip>>;
export declare function parseProofOfWork(input: unknown): ProofOfWork;
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