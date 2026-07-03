import { z } from 'zod';
/** 产出证据 (批注#19): 解锁非 coding agent, 不再"无 git 变动=没产出". */
export const proofOfWork = z.object({
    kind: z.enum(['git_diff', 'artifact_hash', 'external_receipt', 'tool_call_trace']),
    gitDiff: z.object({ files: z.number().int(), lines: z.number().int(), patchRef: z.string().optional() }).optional(),
    artifactHash: z.object({ sha256: z.string(), mime: z.string().optional(), size: z.number().int() }).optional(),
    externalReceipt: z.object({ provider: z.string(), receiptId: z.string(), ts: z.string() }).optional(),
    toolCallTrace: z.object({ calls: z.number().int(), ref: z.string().optional() }).optional(),
});