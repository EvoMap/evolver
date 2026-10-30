import { algo } from '@evomap/evolver-core';
export interface KernelTriggerFeedbackBinding {
    executable: string;
    agentDir: string;
    env: Readonly<Record<string, string | undefined>>;
}
export interface KernelTriggerFeedbackPage {
    snapshots: algo.TriggerFeedbackSnapshot[];
    nextAfter: string | null;
}
export declare function kernelTriggerFeedbackBinding(env: Readonly<Record<string, string | undefined>>): KernelTriggerFeedbackBinding;
export declare function readKernelTriggerFeedback(binding: KernelTriggerFeedbackBinding, runId: string, signal?: AbortSignal): Promise<algo.TriggerFeedbackSnapshot>;
export declare function listKernelTriggerFeedback(binding: KernelTriggerFeedbackBinding, after?: string | null, signal?: AbortSignal): Promise<KernelTriggerFeedbackPage>;