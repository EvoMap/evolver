import type { AssetRecord } from '../assetstore/provider.js';
export type DistillOutcome = 'success' | 'failed';
export interface DistillDraftRequest {
    transcript?: string;
    records?: unknown;
    ir?: unknown;
    summary?: string;
    strategy?: string[];
    signals?: string[];
    preconditions?: string[];
    validation?: string[];
    userPrompt?: string;
    finalAnswer?: string;
    outcome: DistillOutcome;
    title?: string;
    platform: string;
    identifiers?: string[];
}
interface DistillDraftQuality {
    ok: boolean;
    score: number;
    threshold: number;
    reasons: string[];
    reason: string | null;
    terms?: string[];
    field?: string;
}
export interface DistillDraftResult {
    status: 'draft' | 'skipped';
    quality: DistillDraftQuality;
    gene: AssetRecord | null;
    capsule: AssetRecord | null;
    antiGene: AssetRecord | null;
}
/**
 * The same normalization, gate, portability and answer-leak checks as `distillConversation`, run with nothing stored,
 * published or sent to a model. A failed outcome yields an AntiGene in place of the Gene/Capsule pair.
 */
export declare function distillDraft(request: DistillDraftRequest): Promise<DistillDraftResult>;
export {};