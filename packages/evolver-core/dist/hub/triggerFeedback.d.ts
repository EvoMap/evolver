import { type TriggerFeedbackSnapshot, type TriggerRatingCommit } from '../algo/triggerFeedback.js';
export interface TriggerFeedbackReport {
    schema_version: 1;
    run_id: string;
    trigger_id: string;
    committed: {
        run_id: string;
        trigger_id: string;
        revision: number;
        operation_id: string;
        rating: 'good' | 'bad' | null;
    } | null;
    machine_baseline: {
        event_id: string;
        evaluated_at: string;
        outcome: {
            status: string;
            score: number | null;
            user_override: number | null;
            override_source: {
                kind: 'human' | 'judge_code' | 'goal_loop' | 'unknown';
            };
        };
        genes_used: string[];
        signals: string[];
    } | null;
}
export interface TriggerFeedbackReceipt {
    runId: string;
    triggerId: string;
    committed: TriggerRatingCommit | null;
    effectiveScore: number | null;
    entryId: string | null;
    duplicate: boolean;
}
export interface TriggerFeedbackCapability {
    commit(report: TriggerFeedbackReport): Promise<TriggerFeedbackReceipt>;
    get(runId: string): Promise<TriggerFeedbackReceipt>;
}
export declare function triggerFeedbackReport(snapshot: TriggerFeedbackSnapshot): TriggerFeedbackReport;
export declare function normalizeTriggerFeedbackReport(report: TriggerFeedbackReport): TriggerFeedbackReport;
export declare function parseTriggerFeedbackReceipt(raw: unknown, runId: string): TriggerFeedbackReceipt;
export declare function triggerFeedbackReceiptMatches(receipt: TriggerFeedbackReceipt, report: TriggerFeedbackReport): boolean;