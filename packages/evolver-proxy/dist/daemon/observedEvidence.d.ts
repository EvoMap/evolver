import { assetstore, hub as hubNs, verify } from '@evomap/evolver-core';
export interface VerificationContext {
    geneAssetId: string;
    geneId: string;
    root: string;
    head: string;
    diff?: string;
    commands: string[];
    checks: readonly verify.ObservedCheck[];
    planDigest?: string;
    distillInput: Record<string, unknown>;
    recordedAt: string;
    verifiedAt?: string;
    failedAtVerification?: number;
    lastAttempt?: {
        at: string;
        result: string;
    };
    published?: {
        at: string;
        envelopeId: string;
        assetIds: string[];
    };
}
export declare class VerificationContextStore {
    private readonly dir;
    constructor(assetStoreDir: string);
    private pathOf;
    get(geneAssetId: string): VerificationContext | undefined;
    /** A Gene is addressed by its content, so once it is published a later plan for it keeps that mark. */
    put(context: VerificationContext): void;
    list(): VerificationContext[];
}
/** Old sidecars may already have lost cwd occurrences and must be observed again. */
export declare function hasVerificationPlan(context: VerificationContext): context is VerificationContext & {
    planDigest: string;
};
/** The project state a host hook recorded with an observed distillation, or none when it cannot be replayed. */
export declare function verificationContextOf(body: hubNs.ConversationDistillInput, gene: assetstore.AssetRecord, now: Date, checks: readonly verify.ObservedCheck[] | undefined): VerificationContext | undefined;
/** Whether a host hook observed the reused turn's last check and its result; agent-reported evidence never qualifies. */
export declare function isObservedCheckEvidence(evidence: Record<string, unknown> | undefined): boolean;
export type ObservedReuseRecording = 'recorded' | 'duplicate' | 'not_local' | 'no_task';
export declare function recordObservedReuse(store: assetstore.AssetStoreProvider, assetId: string, taskId: string | undefined, passed: boolean): Promise<ObservedReuseRecording>;