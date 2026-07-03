import type { AssetCallLog } from './assetCallLog.js';
export interface ReviewOutcome {
    status?: string;
    score?: number;
}
export interface ConstraintCheck {
    violations?: readonly unknown[];
}
/** Submit a review to the hub. Resolve {ok:false,error} for a rejection; reject/throw for a transport error. */
export type ReviewSubmitter = (assetId: string, review: {
    sender_id?: string;
    rating: number;
    content: string;
}) => Promise<{
    ok: boolean;
    status?: number;
    error?: string;
}>;
export interface ReviewHistoryStore {
    has(assetId: string): boolean;
    mark(assetId: string, rec: {
        rating: number;
        success: boolean;
        at: number;
    }): void;
}
/** Derive a 1-5 rating from the cycle outcome. success→{5 if score≥0.85 else 4}; failure→{1 if constraint-violating else 2}. */
export declare function deriveRating(outcome?: ReviewOutcome, constraintCheck?: ConstraintCheck): number;
export interface ReviewContentParams {
    outcome?: ReviewOutcome;
    gene?: {
        id?: string;
        category?: string;
    };
    signals?: readonly string[];
    blast?: {
        files?: number;
        lines?: number;
    };
    sourceType?: string;
}
/** Human-readable review body summarising the reuse outcome (capped 2000 chars). */
export declare function buildReviewContent({ outcome, gene, signals, blast, sourceType }: ReviewContentParams): string;
export interface SubmitHubReviewDeps {
    submit: ReviewSubmitter;
    history?: ReviewHistoryStore;
    assetLog?: Pick<AssetCallLog, 'append'>;
    senderId?: string;
    now?: () => number;
}
export interface SubmitHubReviewParams {
    reusedAssetId: string;
    /** Only 'reused' / 'reference' are hub-sourced (others are skipped). */
    sourceType: string;
    outcome?: ReviewOutcome;
    gene?: {
        id?: string;
        category?: string;
    };
    signals?: readonly string[];
    blast?: {
        files?: number;
        lines?: number;
    };
    constraintCheck?: ConstraintCheck;
    runId?: string | null;
}
export interface SubmitHubReviewResult {
    submitted: boolean;
    reason?: string;
    rating?: number;
    asset_id?: string;
}
/**
 * Submit a usage-verified review for a reused hub asset. Skips when: not hub-sourced, no asset id, or already
 * reviewed. Never throws — a transport error is logged and swallowed (solidify must not be affected).
 */
export declare function submitHubReview(deps: SubmitHubReviewDeps, params: SubmitHubReviewParams): Promise<SubmitHubReviewResult>;
/** File-backed ReviewHistoryStore: a JSON map assetId → {at,rating,success}, capped to the most recent N (atomic write). */
export declare class FileReviewHistory implements ReviewHistoryStore {
    private readonly path;
    private readonly max;
    constructor(path: string, max?: number);
    private load;
    has(assetId: string): boolean;
    mark(assetId: string, rec: {
        rating: number;
        success: boolean;
        at: number;
    }): void;
}