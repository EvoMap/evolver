import { hub } from '@evomap/evolver-core';
import type { KernelTriggerFeedbackBinding } from './kernelTriggerFeedback.js';
export interface BoundTriggerFeedbackCapability extends hub.TriggerFeedbackCapability {
    readonly destinationId: string;
    isCurrent(): boolean;
}
export declare function createBoundTriggerFeedbackHub(binding: KernelTriggerFeedbackBinding, env: Readonly<Record<string, string | undefined>>, signal?: AbortSignal): BoundTriggerFeedbackCapability;