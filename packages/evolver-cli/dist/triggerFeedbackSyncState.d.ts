import type { algo } from '@evomap/evolver-core';
export type TriggerFeedbackDeliveryStatus = 'pending' | 'ambiguous' | 'confirmed' | 'blocked';
export interface TriggerFeedbackDeliveryState {
    version: 1;
    destinationId: string;
    consentEpoch: string;
    desiredRevision: number;
    desiredOperationId: string | null;
    acknowledgedRevision: number | null;
    acknowledgedOperationId: string | null;
    status: TriggerFeedbackDeliveryStatus;
    attempted: boolean;
    retryAt: number;
    reason?: string;
    claim?: {
        id: string;
        revision: number;
        operationId: string | null;
        expiresAt: number;
    };
    retired: Array<{
        destinationId: string;
        revision: number;
        status: TriggerFeedbackDeliveryStatus;
        acknowledgedRevision: number | null;
    }>;
}
export declare function parseTriggerFeedbackDelivery(raw: unknown): TriggerFeedbackDeliveryState | undefined;
export declare function advanceTriggerFeedbackDelivery(prior: TriggerFeedbackDeliveryState | undefined, snapshot: algo.TriggerFeedbackSnapshot, epoch: string): TriggerFeedbackDeliveryState | undefined;
export declare function authorizeTriggerFeedbackDelivery(prior: TriggerFeedbackDeliveryState | undefined, snapshot: algo.TriggerFeedbackSnapshot, epoch: string, destinationId: string): TriggerFeedbackDeliveryState;
export declare function claimTriggerFeedbackDelivery(prior: TriggerFeedbackDeliveryState, destinationId: string, id: string, now: number): {
    state: TriggerFeedbackDeliveryState;
    claimed: boolean;
    reconcile: boolean;
};
export declare function markTriggerFeedbackDispatched(prior: TriggerFeedbackDeliveryState, id: string, now?: number): TriggerFeedbackDeliveryState;
export declare function settleTriggerFeedbackDelivery(prior: TriggerFeedbackDeliveryState, id: string, result: {
    status: TriggerFeedbackDeliveryStatus;
    revision?: number;
    operationId?: string | null;
    reason?: string;
}, now: number): TriggerFeedbackDeliveryState;