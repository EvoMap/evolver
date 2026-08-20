import { type Capsule } from '../wire/index.js';
import { type ProofOfWork } from '../schema/proofOfWork.js';
export type ResolutionStatus = 'pending' | 'suppressed_observationally' | 'resolved_by_evidence' | 'regressed' | 'inconclusive';
export interface FailureEvidenceIdentityInput {
    failureId?: string;
    rootAttemptId?: string;
    executionId?: string;
    verifierDigest?: string;
    artifactDigest?: string;
}
export interface SolidifyInput {
    geneId: string;
    trigger: readonly string[];
    summary: string;
    confidence: number;
    outcome: {
        status: 'success' | 'failed';
        score: number;
    };
    proofOfWork?: ProofOfWork;
    /** Failure-threshold identity. Stored only for failed Capsules; retry roots dedupe automatic fan-out. */
    failureIdentity?: FailureEvidenceIdentityInput;
    /** 是否有强证据(validation/测试在证据下通过). 默认 false → 不自动升级到 resolved. */
    strongEvidence?: boolean;
    /** regressed 判定阈: 失败且分低于此 → regressed, 否则 inconclusive. 默认 0.3. */
    regressThreshold?: number;
}
export interface SolidifyResult {
    capsule: Capsule;
    resolutionStatus: ResolutionStatus;
    producedValue: boolean;
    reasons: string[];
}
/** ProofOfWork 是否表明有实际产出(解锁非 coding agent, 批注#17/#19). #961: 兼容读 helper(snake_case 优先, 回退旧 camelCase 存量). */
export declare function proofIndicatesOutput(p?: ProofOfWork): boolean;
/**
 * 两级 resolution(M4A-8) + ProofOfWork 判价值(M4A-5):
 * - 失败: 分 < 阈 → regressed, 否则 inconclusive.
 * - 成功 + 强证据(proofOfWork 有产出 ∧ strongEvidence) → resolved_by_evidence.
 * - 成功但仅观测(无证据) → suppressed_observationally.
 * 默认**不自动**从 suppressed 升级到 resolved(军杰§6).
 */
export declare function decideResolution(input: SolidifyInput): {
    status: ResolutionStatus;
    producedValue: boolean;
    reasons: string[];
};
/**
 * solidify: 把执行结果固化成 Capsule(表现型/纯产物). resolution_status/proof_of_work 是 v2-delta
 * (本地存得下; 发 hub 须先 gep-sdk bump, 由 wire/schemaGate 把关).
 */
export declare function solidify(input: SolidifyInput): SolidifyResult;