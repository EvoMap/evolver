import { assetstore, algo, events, exec, material as materialNs, personality, verify } from '@evomap/evolver-core';
type RunnerName = NonNullable<exec.AutonomousSafety['runner']>;
type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
type SandboxedValidationRunner = typeof verify.runSandboxedValidation;
type MaterialCycleAction = 'cycle' | 'observe' | 'skip' | 'fail';
type MaterialCycleStatus = exec.AutoExecVerdict['status'] | 'observed' | 'already_consumed' | 'already_terminal' | 'already_running' | 'no_signals' | 'parse_failed' | 'pending';
interface MaterialCycleItem {
    materialId: string;
    action: MaterialCycleAction;
    status: MaterialCycleStatus;
    cycleId?: string;
    reason?: string;
}
export interface MaterialCycleResult {
    claimed: number;
    processed: number;
    items: MaterialCycleItem[];
}
export interface MaterialCycleWatchIteration {
    ok: true;
    group: 'cycle.watch';
    iteration: number;
    claimed: number;
    processed: number;
    cursor: number;
    idle: boolean;
    nextDelayMs: number;
    items: MaterialCycleItem[];
}
export interface MaterialCycleWatchResult {
    ok: true;
    group: 'cycle.watch';
    iterations: number;
    claimed: number;
    processed: number;
    idleIterations: number;
    failedItems: number;
    cursor: number;
    stopped: 'max_iterations' | 'max_idle' | 'cancelled';
}
export interface MaterialCycleWatchState {
    ok: true;
    group: 'cycle.watch.state';
    updatedAt: string;
    running: boolean;
    iteration: number;
    cursor: number;
    claimed: number;
    processed: number;
    idleIterations: number;
    failedItems: number;
    lastIteration?: MaterialCycleWatchIteration;
    stopped?: MaterialCycleWatchResult['stopped'] | 'state_write_failed';
}
export interface MaterialCycleOptions {
    repo: string;
    limit?: number;
    target?: string;
    expectedEffect?: string;
    validationCmds?: readonly string[];
    validate?: exec.AutoExecDeps['validate'];
    runner?: RunnerName;
    timeoutMs?: number;
    signal?: AbortSignal;
    safety?: Partial<exec.AutonomousSafety>;
    agent?: exec.AgentRunner;
    git?: exec.GitRunner;
}
export interface MaterialCycleWatchOptions extends MaterialCycleOptions {
    idleMs?: number;
    maxIdleMs?: number;
    backoffMultiplier?: number;
    maxIdle?: number;
    maxIterations?: number;
}
export interface MaterialCycleDeps {
    materialStore?: materialNs.MaterialStore;
    consumer?: materialNs.ConsumerGroups;
    store?: assetstore.AssetStoreProvider;
    provenance?: assetstore.ProvenanceStore;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    engine?: algo.CycleEngine;
    personality?: personality.PersonalityStore;
    memoryGraph?: algo.MemoryGraphProvider;
    validate?: exec.AutoExecDeps['validate'];
    /** Test/composition seam for the external validator; production defaults to the hardened core runner. */
    runSandboxedValidation?: SandboxedValidationRunner;
    agent?: exec.AgentRunner;
    git?: exec.GitRunner;
    safety?: Partial<exec.AutonomousSafety>;
    sleep?: SleepFn;
    watchStateWriter?: (path: string, state: MaterialCycleWatchState) => void;
}
export declare function cycleIdForMaterial(materialId: string): string;
export declare function cycleLockPathForMaterial(materialStorePath: string, materialId: string): string;
export declare function runMaterialCycleConsumer(opts: MaterialCycleOptions, injectedDeps?: MaterialCycleDeps): Promise<MaterialCycleResult>;
export declare function runMaterialCycleWatch(opts: MaterialCycleWatchOptions, injectedDeps?: MaterialCycleDeps, hooks?: {
    onIteration?: (iteration: MaterialCycleWatchIteration) => void;
}): Promise<MaterialCycleWatchResult>;
export declare function runCycleCommand(argv: readonly string[], injectedDeps?: MaterialCycleDeps): Promise<number>;
export {};