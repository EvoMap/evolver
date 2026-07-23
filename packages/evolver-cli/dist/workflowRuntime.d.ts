import { assetstore, exec, verify, workflow } from '@evomap/evolver-core';
import { type AutoExecConfig } from './autoexecConfig.js';
declare const POLICY_CONTEXT_SCHEMA_VERSION = 2;
interface WorkflowPolicyContext {
    schemaVersion: typeof POLICY_CONTEXT_SCHEMA_VERSION;
    homeId: string;
    policyId: string;
}
interface WorkflowPolicyExpectation extends WorkflowPolicyContext {
    legacyPolicyId: string;
    allowLegacyPolicyExact: boolean;
}
export interface ProductionWorkflowAgentDependencies {
    store?: assetstore.AssetStoreProvider;
    provenance?: assetstore.ProvenanceStore;
    review?: assetstore.ReviewLedger;
    agent?: exec.AgentRunner;
    git?: exec.GitRunner;
    runValidation?: typeof verify.runSandboxedValidation;
}
export interface ProductionWorkflowRuntimeOptions extends ProductionWorkflowAgentDependencies {
    env?: Readonly<NodeJS.ProcessEnv>;
    stateDir?: string;
    maxQueuedRuns?: number;
    assetsDir?: string;
    autoExecHome?: string;
    autoExecConfig?: AutoExecConfig;
    writeDiagnostic?: (message: string) => void;
}
export interface WorkflowRecoveryRuntime {
    recoverPending(): Promise<unknown>;
}
export interface WorkflowAgentExecutionSummary {
    status: 'accepted';
    score: number;
    changedFiles: number;
    changedLines: number;
    validation: 'not_requested' | 'passed';
}
export declare function defaultWorkflowAutoExecHome(env?: Readonly<NodeJS.ProcessEnv>): string;
export declare function resolveWorkflowAutoExecHome(options?: Pick<ProductionWorkflowRuntimeOptions, 'autoExecHome' | 'env'>): string;
/**
 * Compose the production workflow AgentBridge from the existing hardened execution primitive.
 * The workflow may select only an operator-configured validation profile; raw validation commands are not accepted.
 */
export declare function createProductionWorkflowAgentBridge(config: AutoExecConfig, options?: ProductionWorkflowRuntimeOptions, expectedPolicyContext?: WorkflowPolicyExpectation): workflow.AgentBridge;
export declare function resolveWorkflowMaxConcurrentRuns(env?: Readonly<NodeJS.ProcessEnv>): number;
/** Create the shared production runtime used by CLI commands and daemon recovery. */
export declare function createProductionWorkflowRuntime(options?: ProductionWorkflowRuntimeOptions): workflow.DurableWorkflowRuntime;
/**
 * Start recovery exactly once without awaiting it. A hung workflow may occupy a scheduler slot, but it cannot delay
 * construction of the resident loop or daemon readiness.
 */
export declare function scheduleWorkflowStartupRecovery(runtime: WorkflowRecoveryRuntime, writeDiagnostic?: (message: string) => void): void;
interface WorkflowStartupRecoveryDependencies {
    createRuntime?: (options: ProductionWorkflowRuntimeOptions) => WorkflowRecoveryRuntime;
    scheduleRecovery?: (runtime: WorkflowRecoveryRuntime, writeDiagnostic: (message: string) => void) => void;
    writeDiagnostic?: (message: string) => void;
}
/**
 * Initialize daemon startup recovery without making workflow state availability a prerequisite for autoexec.
 * Runtime construction can fail on corrupt state, insecure permissions, or concurrent access; those failures are
 * reported as a bounded code while the independent task queue remains available.
 */
export declare function initializeWorkflowStartupRecovery(options: ProductionWorkflowRuntimeOptions, dependencies?: WorkflowStartupRecoveryDependencies): boolean;
export {};