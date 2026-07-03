import { assetstore, algo, events, exec, material as materialNs, personality } from '@evomap/evolver-core';
type RunnerName = NonNullable<exec.AutonomousSafety['runner']>;
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
export interface MaterialCycleOptions {
    repo: string;
    limit?: number;
    target?: string;
    expectedEffect?: string;
    runner?: RunnerName;
    timeoutMs?: number;
    safety?: Partial<exec.AutonomousSafety>;
    agent?: exec.AgentRunner;
    git?: exec.GitRunner;
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
}
export declare function cycleIdForMaterial(materialId: string): string;
export declare function cycleLockPathForMaterial(materialStorePath: string, materialId: string): string;
export declare function runMaterialCycleConsumer(opts: MaterialCycleOptions, injectedDeps?: MaterialCycleDeps): Promise<MaterialCycleResult>;
export declare function runCycleCommand(argv: readonly string[], injectedDeps?: MaterialCycleDeps): Promise<number>;
export {};