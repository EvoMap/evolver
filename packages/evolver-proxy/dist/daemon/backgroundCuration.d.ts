import { assetstore, type hub as hubNs, type verify } from '@evomap/evolver-core';
import { type VerificationContextStore } from './observedEvidence.js';
export declare const CURATION_INTERVAL_MS: number;
export declare const CURATION_IDLE_MS: number;
export type ExecutionVerifier = (input: hubNs.ConversationDistillInput, signal: AbortSignal) => Promise<hubNs.ConversationDistillVerifiedExecution | null>;
export interface CuratedPublication {
    queued: boolean;
    reason?: string;
    envelopeId?: string;
    assetIds?: string[];
}
export type CuratedMailboxCommit = (send: () => boolean) => 'stored' | 'not_stored' | 'review_not_approved' | 'verification_plan_changed';
/** Where each check runs inside the copy, and which project lends the copy its installed dependencies. */
export interface VerificationPlan {
    checks: readonly verify.ObservedCheck[];
    dependencySourceRoot: string;
}
export interface CurationDeps {
    store: assetstore.AssetStoreProvider;
    review: assetstore.ReviewLedger;
    contexts: VerificationContextStore;
    /** Absent where read-only isolation is unavailable: genes then wait, never published unverified. */
    verifierForRoot: ((root: string, plan?: VerificationPlan) => ExecutionVerifier) | undefined;
    verify: (body: hubNs.ConversationDistillInput, verifier: ExecutionVerifier, planDigest: string) => Promise<hubNs.ConversationDistillVerifiedExecution | undefined>;
    enqueue: (body: hubNs.ConversationDistillInput, verified: hubNs.ConversationDistillVerifiedExecution, planDigest: string, commit: CuratedMailboxCommit) => Promise<CuratedPublication>;
    now: () => Date;
    scratchDir?: string;
}
export interface CurationReport {
    promoted: string[];
    attempted?: {
        geneAssetId: string;
        result: string;
    };
}
/**
 * One idle pass: promote probation drafts that earned it, then verify and publish at most one promoted Gene.
 * Every refusal leaves the Gene local and is retried on a later pass.
 */
export declare function runCurationTick(deps: CurationDeps): Promise<CurationReport>;
export interface CurationStatus {
    publish_verifier: 'available' | 'unavailable';
    publish_verifier_reason?: 'read_only_isolation_unavailable';
    awaiting_verification: number;
    published: number;
    last_attempt?: {
        gene_asset_id: string;
        result: string;
        at: string;
    };
}
/** Why promoted genes are or are not leaving this machine, for /proxy/status and the plugin's status command. */
export declare function curationStatus(contexts: VerificationContextStore, review: assetstore.ReviewLedger, verifierAvailable: boolean): CurationStatus;