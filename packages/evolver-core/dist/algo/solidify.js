import { ulid as makeUlid } from 'ulid';
import { computeAssetId, SCHEMA_VERSION } from '../wire/index.js';
import { gitDiffOf, artifactHashOf, externalReceiptOf, toolCallTraceOf, proofOfWorkForWrite } from '../schema/proofOfWork.js';
/** ProofOfWork 是否表明有实际产出(解锁非 coding agent, 批注#17/#19). #961: 兼容读 helper(snake_case 优先, 回退旧 camelCase 存量). */
export function proofIndicatesOutput(p) {
    if (!p)
        return false;
    switch (p.kind) {
        case 'git_diff': return (gitDiffOf(p)?.files ?? 0) > 0 || (gitDiffOf(p)?.lines ?? 0) > 0;
        case 'artifact_hash': return Boolean(artifactHashOf(p)?.sha256);
        case 'external_receipt': {
            const r = externalReceiptOf(p);
            return Boolean(r?.receipt_id ?? r?.receiptId);
        }
        case 'tool_call_trace': return (toolCallTraceOf(p)?.calls ?? 0) > 0;
        default: return false;
    }
}
function nonEmpty(s) {
    return typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined;
}
function failureIdentityTrace(input) {
    if (input.outcome.status !== 'failed' || !input.failureIdentity)
        return undefined;
    const trace = { stage: 'validate' };
    const root = nonEmpty(input.failureIdentity.rootAttemptId);
    const execution = nonEmpty(input.failureIdentity.executionId);
    const failure = nonEmpty(input.failureIdentity.failureId);
    const verifier = nonEmpty(input.failureIdentity.verifierDigest);
    const artifact = nonEmpty(input.failureIdentity.artifactDigest);
    if (root)
        trace['root_attempt_id'] = root;
    if (execution)
        trace['execution_id'] = execution;
    if (failure)
        trace['failure_id'] = failure;
    if (verifier)
        trace['verifier_digest'] = verifier;
    if (artifact)
        trace['artifact_digest'] = artifact;
    return Object.keys(trace).length > 1 ? [trace] : undefined;
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
    const gd = input.proofOfWork?.kind === 'git_diff' ? gitDiffOf(input.proofOfWork) : undefined;
    const identityTrace = failureIdentityTrace(input);
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
        ...(input.proofOfWork ? { proof_of_work: proofOfWorkForWrite(input.proofOfWork) } : {}),
        ...(identityTrace ? { execution_trace: identityTrace } : {}),
    };
    const asset_id = computeAssetId(base);
    return { capsule: { ...base, asset_id }, resolutionStatus: status, producedValue, reasons };
}