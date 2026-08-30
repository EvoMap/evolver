import { z } from 'zod';
/** 产出证据 (批注#19): 解锁非 coding agent, 不再"无 git 变动=没产出". */
/**
 * #961: 字段名对齐 gep-sdk 官方 capsule.schema.json(snake_case) —— evolver-core 曾是全生态唯一
 * camelCase 偏离实现, 导致 Hub zod `.strip()` mutate payload 后 verifyAssetId 死锁、静态 proof
 * 评估丢分。写路径一律 snake_case; camelCase 键仅为解析本地存量旧资产的兼容别名(不声明会被
 * zod `.strip()` 剥掉 → canonicalize 漂移 → asset_id 对不上), 永不用于新写入, v3 major 移除。
 */
const nonnegativeInteger = z.number().int().nonnegative();
const legacyInteger = z.number().int();
const gitDiffWire = z.object({
    files: nonnegativeInteger.optional(),
    lines: nonnegativeInteger.optional(),
    patch_ref: z.string().optional(),
}).passthrough();
const artifactHashWire = z.object({
    sha256: z.string().optional(),
    mime: z.string().optional(),
    size: nonnegativeInteger.optional(),
}).passthrough();
const externalReceiptWire = z.object({
    provider: z.string().optional(),
    receipt_id: z.string().optional(),
    ts: z.string().optional(),
}).passthrough();
const toolCallTraceWire = z.object({
    calls: nonnegativeInteger.optional(),
    ref: z.string().optional(),
}).passthrough();
export const proofOfWork = z.object({
    kind: z.enum(['git_diff', 'artifact_hash', 'external_receipt', 'tool_call_trace']),
    git_diff: gitDiffWire.optional(),
    artifact_hash: artifactHashWire.optional(),
    external_receipt: externalReceiptWire.optional(),
    tool_call_trace: toolCallTraceWire.optional(),
    // ── #961 兼容读别名(仅旧资产解析; 新写入禁止使用) ──
    gitDiff: z.object({ files: legacyInteger, lines: legacyInteger, patchRef: z.string().optional() }).optional(),
    artifactHash: z.object({ sha256: z.string(), mime: z.string().optional(), size: legacyInteger }).optional(),
    externalReceipt: z.object({ provider: z.string(), receiptId: z.string(), ts: z.string() }).optional(),
    toolCallTrace: z.object({ calls: legacyInteger, ref: z.string().optional() }).optional(),
});
/** #961 兼容读: snake_case 优先, 旧别名只补齐部分迁移 payload 缺失的字段. */
export function gitDiffOf(p) {
    const snake = p?.git_diff;
    const legacy = p?.gitDiff;
    if (!legacy)
        return snake;
    if (!snake)
        return legacy;
    return { files: legacy.files, lines: legacy.lines, ...(typeof legacy.patchRef === 'string' ? { patch_ref: legacy.patchRef } : {}), ...snake };
}
export function artifactHashOf(p) {
    const snake = p?.artifact_hash;
    const legacy = p?.artifactHash;
    return legacy ? { ...legacy, ...snake } : snake;
}
export function externalReceiptOf(p) {
    const snake = p?.external_receipt;
    const legacy = p?.externalReceipt;
    if (!legacy)
        return snake;
    if (!snake)
        return legacy;
    return { provider: legacy.provider, receipt_id: legacy.receiptId, ts: legacy.ts, ...snake };
}
export function toolCallTraceOf(p) {
    const snake = p?.tool_call_trace;
    const legacy = p?.toolCallTrace;
    return legacy ? { ...legacy, ...snake } : snake;
}
function normalizeGitDiff(value) {
    if (!value)
        return undefined;
    const raw = value;
    const { patchRef, ...wire } = raw;
    return { ...wire, ...(typeof raw.patch_ref === 'string' ? { patch_ref: raw.patch_ref } : typeof patchRef === 'string' ? { patch_ref: patchRef } : {}) };
}
function normalizeExternalReceipt(value) {
    if (!value)
        return undefined;
    const raw = value;
    const { receiptId, ...wire } = raw;
    return { ...wire, ...(typeof raw.receipt_id === 'string' ? { receipt_id: raw.receipt_id } : typeof receiptId === 'string' ? { receipt_id: receiptId } : {}) };
}
/** #961 写边界: 兼容读到的旧 camelCase proof 必须规范化后才能进入新 Capsule。 */
export function proofOfWorkForWrite(p) {
    const { gitDiff: _gitDiff, artifactHash: _artifactHash, externalReceipt: _externalReceipt, toolCallTrace: _toolCallTrace, ...wire } = p;
    const normalized = {
        ...wire,
        ...(gitDiffOf(p) ? { git_diff: normalizeGitDiff(gitDiffOf(p)) } : {}),
        ...(artifactHashOf(p) ? { artifact_hash: artifactHashOf(p) } : {}),
        ...(externalReceiptOf(p) ? { external_receipt: normalizeExternalReceipt(externalReceiptOf(p)) } : {}),
        ...(toolCallTraceOf(p) ? { tool_call_trace: toolCallTraceOf(p) } : {}),
    };
    return proofOfWork.parse(normalized);
}
/** Accept either canonical snake_case or legacy camelCase stored proof without lossy conversion. */
export function normalizeProofOfWork(input) {
    const parsed = proofOfWork.safeParse(input);
    return parsed.success ? parsed.data : undefined;
}
/** Convert a proof to the gep-sdk wire shape while preserving canonical nested fields and extensions. */
export function toWireProofOfWork(proof) {
    const normalized = proofOfWorkForWrite(proof);
    const { kind, ...fields } = normalized;
    return { kind: kind, ...fields };
}