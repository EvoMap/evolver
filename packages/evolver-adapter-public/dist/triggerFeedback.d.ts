import { hub } from '@evomap/evolver-core';
export type TriggerFeedbackHttp = (method: 'POST', path: string, body: Record<string, unknown>) => Promise<unknown>;
export declare function createTriggerFeedbackCapability(call: TriggerFeedbackHttp): hub.TriggerFeedbackCapability;