import { proofOfWork } from '../schema/proofOfWork.js';
import { proofIndicatesOutput } from '../algo/solidify.js';
/** 扫该 gene 关联的 Capsule, 派生学习视图(只读, 不落库). */
export async function aggregateLearningHistory(provider, geneId, recentN = 10) {
    const caps = await provider.search({ kind: 'Capsule', gene: geneId, limit: 10_000 });
    let success = 0, failed = 0, inert = 0, scoreSum = 0;
    for (const c of caps) {
        const outcome = c.outcome;
        if (outcome?.status === 'failed') {
            failed += 1;
        }
        else if (outcome?.status === 'success') {
            // #195: a success that produced no measurable value (no ProofOfWork output — the same `producedValue`
            // signal solidify uses to mark it `suppressed_observationally`) is INERT, not a real success. Counting it
            // would inflate successRate for a gene that only ever does nothing. Inert is neutral, not a failure: it is
            // excluded from BOTH sides of successRate, so it neither builds nor erodes confidence.
            const proof = c.proof_of_work;
            if (proofIndicatesOutput(proof))
                success += 1;
            else
                inert += 1;
        }
        if (typeof outcome?.score === 'number')
            scoreSum += outcome.score;
    }
    const total = caps.length;
    const decisive = success + failed; // inert excluded from the success-rate denominator (neutral)
    return {
        geneId, total, success, failed, inert,
        successRate: decisive > 0 ? success / decisive : 0,
        avgScore: total > 0 ? scoreSum / total : 0,
        recentCapsuleIds: caps.slice(-recentN).map((c) => c.asset_id),
    };
}
/** M3-5: 校验 agent 提交的 proof_of_work(zod). 返回规范化值或抛. */
export function validateProofOfWork(input) {
    return proofOfWork.parse(input);
}