import { hub, type algo } from '@evomap/evolver-core';
export type TriggerFeedbackDelivery = {
    status: 'confirmed';
    receipt: hub.TriggerFeedbackReceipt;
} | {
    status: 'unsupported' | 'rejected' | 'unverified';
    reason: string;
};
export declare function deliverTriggerFeedback(snapshot: algo.TriggerFeedbackSnapshot, remote: hub.TriggerFeedbackCapability): Promise<TriggerFeedbackDelivery>;