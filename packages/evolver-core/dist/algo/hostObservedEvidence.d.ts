import { type Capsule } from '../wire/index.js';
import { type ProofOfWork } from '../schema/proofOfWork.js';
export declare const HOST_OBSERVED_TRACE_REF = "host-observed";
export declare function hostObservedProof(calls: number): ProofOfWork;
/**
 * A capsule whose outcome a host hook observed but no verifier re-ran. It counts toward local, reversible
 * probation (D2 in docs/local-distill-closed-loop.md) and never toward publish eligibility.
 */
export declare function isHostObservedCapsule(capsule: Record<string, unknown>): boolean;
export interface ObservedReuseInput {
    geneId: string;
    geneAssetId: string;
    trigger: readonly string[];
    taskId: string;
    /** The host plugin's verdict for the turn; a piped command can exit 0 while the check itself failed. */
    passed: boolean;
}
export declare function observedReuseCapsuleId(geneAssetId: string, taskId: string): string;
export declare function observedReuseCapsule(input: ObservedReuseInput): Capsule;