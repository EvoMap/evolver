import { ulid as makeUlid } from 'ulid';
import { computeAssetId, SCHEMA_VERSION } from '../wire/index.js';
/** ProofOfWork 是否表明有实际产出(解锁非 coding agent, 批注#17/#19). */
export function proofIndicatesOutput(p) {
    if (!p)
        return false;
    switch (p.kind) {
        case 'git_diff': return (p.gitDiff?.files ?? 0) > 0 || (p.gitDiff?.lines ?? 0) > 0;
        case 'artifact_hash': return Boolean(p.artifactHash?.sha256);
        case 'external_receipt': return Boolean(p.externalReceipt?.receiptId);
        case 'tool_call_trace': return (p.toolCallTrace?.calls ?? 0) > 0;
        default: return false;
    }
}
/**
 * 两级 resolution(M4A-8) + ProofOfWork 判价值(M4A-5):
 * - 失败: 分 < 阈 → regressed, 否则 inconclusive.
 * - 成功 + 强证据(proofOfWork 有产出 ∧ strongEvidence) → resolved_by_evidence.
 * - 成功但仅观测(无证据) → suppressed_observationally.
 * 默认**不自动**从 suppressed 升级到 resolved(军杰§6).
 */
export function decideResolution(input) {
    const reasons = [];
    const producedValue = proofIndicatesOutput(input.proofOfWork);
    if (input.outcome.status === 'failed') {
        const status = input.outcome.score < (input.regressThreshold ?? 0.3) ? 'regressed' : 'inconclusive';
        reasons.push(`失败 score=${input.outcome.score} → ${status}`);
        return { status, producedValue, reasons };
    }
    if (producedValue && input.strongEvidence) {
        reasons.push('成功 + ProofOfWork 有产出 + 强证据 → resolved_by_evidence');
        return { status: 'resolved_by_evidence', producedValue, reasons };
    }
    reasons.push(producedValue ? '成功 + 有产出但无强证据 → suppressed_observationally(不自动升级)' : '成功但无 ProofOfWork 产出证据 → suppressed_observationally');
    return { status: 'suppressed_observationally', producedValue, reasons };
}
/**
 * solidify: 把执行结果固化成 Capsule(表现型/纯产物). resolution_status/proof_of_work 是 v2-delta
 * (本地存得下; 发 hub 须先 gep-sdk bump, 由 wire/schemaGate 把关).
 */
export function solidify(input) {
    const { status, producedValue, reasons } = decideResolution(input);
    // blast_radius is only a real measurement for git_diff proofs. For non-git_diff proofs
    // (artifact_hash/external_receipt/tool_call_trace) gd is undefined and blast falls back to {0,0} — which here
    // means "blast unknown", NOT "no change". Consumers that read blast=0 as a no-op signal (e.g. cycleFailure's
    // local_gene_no_blast bucket) MUST first confirm the proof kind is git_diff; the cycleEngine guard does this.
    const gd = input.proofOfWork?.kind === 'git_diff' ? input.proofOfWork.gitDiff : undefined;
    const base = {
        type: 'Capsule',
        schema_version: SCHEMA_VERSION,
        id: makeUlid(),
        trigger: [...input.trigger],
        gene: input.geneId,
        summary: input.summary,
        confidence: input.confidence,
        blast_radius: { files: gd?.files ?? 0, lines: gd?.lines ?? 0 },
        outcome: input.outcome,
        resolution_status: status,
        ...(input.proofOfWork ? { proof_of_work: input.proofOfWork } : {}),
    };
    const asset_id = computeAssetId(base);
    return { capsule: { ...base, asset_id }, resolutionStatus: status, producedValue, reasons };
}