import { type ProofOfWork } from '../schema/proofOfWork.js';
import type { AssetStoreProvider } from './provider.js';
/**
 * Gene 侧 learning_history 聚合视图(M3-4 后半 / M3-6). 批注#28: 不再把 learning_history 内联进 Gene 资产
 * (会改 asset_id 不稳), 而是按需从 Capsule 集合聚合派生.
 */
export interface GeneLearningView {
    geneId: string;
    total: number;
    success: number;
    failed: number;
    /**
     * Inert (zero-work) capsules: `success` outcome with no measurable produced value (#195). Tallied apart from
     * real `success` so a do-nothing gene's successRate is not inflated. Optional for back-compat with hand-built
     * views (absent ⇒ 0). When derived here, success + failed + inert === total.
     */
    inert?: number;
    successRate: number;
    avgScore: number;
    recentCapsuleIds: string[];
}
/** 扫该 gene 关联的 Capsule, 派生学习视图(只读, 不落库). */
export declare function aggregateLearningHistory(provider: AssetStoreProvider, geneId: string, recentN?: number): Promise<GeneLearningView>;
/** M3-5: 校验 agent 提交的 proof_of_work(zod). 返回规范化值或抛. */
export declare function validateProofOfWork(input: unknown): ProofOfWork;