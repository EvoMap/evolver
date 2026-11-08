import type { assetstore, hub as hubNs } from '@evomap/evolver-core';
type DistillOutcomeStatus = 'stored' | 'draft' | 'rejected' | 'skipped';
export interface DistillOutcome {
    at: string;
    status: DistillOutcomeStatus;
    reason?: string;
}
export interface DistillationStatus {
    window_hours: number;
    stored: number;
    drafts: number;
    /** Drafts the quality gate refused, by reason. */
    rejected: Record<string, number>;
    /** Requests that never became a draft (IR structure, references, contracts, repairs, too little to go on), by reason. */
    skipped: Record<string, number>;
}
export interface TrialControl {
    asset_id: string;
    withheld_id: string;
    task_id: string;
    passed: boolean;
    platform?: string;
    at: string;
}
interface TrialArm {
    runs: number;
    passed: number;
}
export interface TrialEffect {
    gene_asset_id: string;
    title: string;
    treated: TrialArm;
    control: TrialArm;
}
export declare function distillOutcomeOf(result: hubNs.ConversationDistillResult, at: Date): DistillOutcome;
export declare class DistillOutcomeLog {
    private readonly log;
    constructor(assetStoreDir: string);
    record(outcome: DistillOutcome): void;
    summary(now: Date): DistillationStatus;
}
export declare class TrialControlLog {
    private readonly log;
    private readonly withholdings;
    constructor(assetStoreDir: string);
    /** Records one withholding and names it; the turn that went without the draft reports its control under this id. */
    withheld(assetId: string, at: Date): string;
    /** A control counts only against the withholding it names: of that draft, in the last day, and only once. */
    record(entry: TrialControl): 'recorded' | 'duplicate' | 'not_withheld';
    list(): TrialControl[];
}
/**
 * Keyed by the Gene's own id, not its asset id: the asset id also hashes runtime metadata (model, `env_class`), so the
 * same draft would land in another arm on another machine.
 */
export declare function isTrialHoldout(geneId: string, recallText: string): boolean;
/** Each trial draft with a control arm: how often checks passed with it recalled, and without. */
export declare function trialEffect(store: assetstore.AssetStoreProvider, controls: TrialControlLog): Promise<TrialEffect[]>;
export {};