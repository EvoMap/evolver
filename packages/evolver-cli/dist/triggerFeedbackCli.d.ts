import { algo } from '@evomap/evolver-core';
import { LocalMemoryGraph } from './localMemoryGraph.js';
import { type KernelTriggerFeedbackBinding, type KernelTriggerFeedbackPage } from './kernelTriggerFeedback.js';
import { type BoundTriggerFeedbackCapability } from './triggerFeedbackHub.js';
export interface TriggerFeedbackCommandDeps {
    env?: Record<string, string | undefined>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    now?: () => number;
    readKernel?: (binding: KernelTriggerFeedbackBinding, runId: string, signal?: AbortSignal) => Promise<algo.TriggerFeedbackSnapshot>;
    listKernel?: (binding: KernelTriggerFeedbackBinding, after: string | null, signal?: AbortSignal) => Promise<KernelTriggerFeedbackPage>;
    createGraph?: (dir: string) => LocalMemoryGraph;
    createRemote?: (binding: KernelTriggerFeedbackBinding, env: Readonly<Record<string, string | undefined>>, signal?: AbortSignal) => BoundTriggerFeedbackCapability;
}
export declare function runTriggerFeedbackCommand(argv: readonly string[], deps?: TriggerFeedbackCommandDeps): Promise<number>;