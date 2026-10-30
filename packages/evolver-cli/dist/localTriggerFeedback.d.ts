import { algo } from '@evomap/evolver-core';
import { type TriggerFeedbackDeliveryState } from './triggerFeedbackSyncState.js';
export declare const TRIGGER_FEEDBACK_FILE = "memory_graph.trigger_feedback.json";
export declare const MAX_TRIGGER_FEEDBACK_BYTES: number;
export interface LocalTriggerFeedbackRow {
    userScope: string;
    workspaceScope: string | null;
    epochId: string;
    state: algo.TriggerFeedbackState;
    delivery?: TriggerFeedbackDeliveryState;
    sourceAvailable?: boolean;
}
export interface LocalTriggerFeedbackFile {
    version: 2;
    rows: LocalTriggerFeedbackRow[];
    recoveryCursors?: Record<string, string | null>;
    deliveryCursors?: Record<string, string | null>;
}
export declare function readLocalTriggerFeedback(bytes: Buffer | null): LocalTriggerFeedbackFile;
export declare function upsertLocalTriggerFeedback(file: LocalTriggerFeedbackFile, snapshot: algo.TriggerFeedbackSnapshot, owner: {
    userScope: string;
    workspaceScope: string | null;
    epochId: string;
}): {
    file: LocalTriggerFeedbackFile;
    changed: boolean;
    row: LocalTriggerFeedbackRow;
    resetSuppressed: boolean;
};
export declare function triggerFeedbackRecords(file: LocalTriggerFeedbackFile, userScopes: ReadonlySet<string>, workspaceScope: string, epochId: string): algo.MemoryGraphOutcomeRecord[];