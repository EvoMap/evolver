import { workflow } from '@evomap/evolver-core';
import { type ProductionWorkflowRuntimeOptions } from './workflowRuntime.js';
export declare const WORKFLOW_SUBCOMMANDS: readonly ["start", "submit", "list", "status", "history", "pause", "resume", "cancel", "approve", "reject"];
type OutputStream = Pick<NodeJS.WriteStream, 'write'>;
type RuntimeControlOptions = {
    actor: string;
    reason?: string;
};
type WorkflowRuntimeLike = {
    start(spec: workflow.WorkflowSpec, options?: {
        runId?: string;
    }): Promise<unknown>;
    pause?: (runId: string, options: RuntimeControlOptions) => Promise<unknown>;
    resume?: (runId: string, options?: RuntimeControlOptions) => Promise<unknown>;
    cancel?: (runId: string, options: RuntimeControlOptions) => Promise<unknown>;
    approve?: (runId: string, gateId: string, options: RuntimeControlOptions) => Promise<unknown>;
    reject?: (runId: string, gateId: string, options: RuntimeControlOptions) => Promise<unknown>;
};
type WorkflowStoreLike = {
    read(runId: string): workflow.WorkflowRunState;
    listRunIds(): string[];
    history?: (runId: string) => unknown;
    readHistory?: (runId: string) => unknown;
    listHistory?: (runId: string) => unknown;
    requestPause?: (runId: string, options: RuntimeControlOptions) => void;
    requestCancel?: (runId: string, options: RuntimeControlOptions) => void;
    approve?: (runId: string, gateId: string, options: RuntimeControlOptions) => void;
    reject?: (runId: string, gateId: string, options: RuntimeControlOptions) => void;
};
export interface WorkflowCommandDeps {
    stateDir?: string;
    stdout?: OutputStream;
    stderr?: OutputStream;
    createStore?: (stateDir: string) => WorkflowStoreLike;
    createRuntime?: (stateDir: string) => WorkflowRuntimeLike;
    productionRuntimeOptions?: ProductionWorkflowRuntimeOptions;
}
export declare function runWorkflowCommand(argv: string[], deps?: WorkflowCommandDeps): Promise<number>;
export {};