import type { TriggerFeedbackCommandDeps } from './triggerFeedbackCli.js';
export interface TriggerFeedbackRecoveryReport {
    ok: boolean;
    schemaVersion: 1;
    command: 'recover';
    localCommitted: boolean;
    scanned: number;
    localChanged: number;
    hubConfirmed: number;
    pending: number;
    blocked: number;
    partial: boolean;
    reasons: Record<string, number>;
}
export declare function recoverTriggerFeedback(deps: TriggerFeedbackCommandDeps, localOnly: boolean): Promise<TriggerFeedbackRecoveryReport>;