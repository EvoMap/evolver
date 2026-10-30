import { algo, hub } from '@evomap/evolver-core';
import { LocalMemoryGraph } from './localMemoryGraph.js';
import type { BoundTriggerFeedbackCapability } from './triggerFeedbackHub.js';
export interface TriggerFeedbackSyncResult {
    snapshot: algo.TriggerFeedbackSnapshot;
    local: ReturnType<LocalMemoryGraph['applyKernelTriggerFeedback']>;
    remote: {
        status: 'confirmed' | 'unsupported' | 'rejected' | 'unverified';
        reason?: string;
        receipt?: hub.TriggerFeedbackReceipt;
        from?: 'durable-receipt';
    };
}
export declare function synchronizeTriggerFeedback(options: {
    snapshot: algo.TriggerFeedbackSnapshot;
    graph: LocalMemoryGraph;
    remote: BoundTriggerFeedbackCapability;
    readKernel: () => Promise<algo.TriggerFeedbackSnapshot>;
    local?: ReturnType<LocalMemoryGraph['applyKernelTriggerFeedback']>;
    requireReceipt?: (snapshot: algo.TriggerFeedbackSnapshot) => void;
    force?: boolean;
    signal?: AbortSignal;
}): Promise<TriggerFeedbackSyncResult>;