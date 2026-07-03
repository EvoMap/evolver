import type { AssetStoreProvider } from '../assetstore/provider.js';
import { type CycleInput, type CycleResult } from '../algo/cycleEngine.js';
import { type RunCycleOptions } from '../algo/orchestrator.js';
import type { ThesisArm, ThesisSolver, ThesisTask } from './thesis.js';
export interface EvolutionThesisDeps<I> {
    /** evolver arm store: the learned-gene pool (assembleCandidates pulls candidates from here). */
    pool: AssetStoreProvider;
    /** baseline arm store: no relevant genes, so the cycle innovates (no reuse). */
    baseline: AssetStoreProvider;
    /** Agent work; a deterministic fake in tests, makeSafeExecute(...) in prod. */
    execute: CycleInput['execute'];
    /** Map a thesis task to the cycle inputs (problem / signals / category / target / ...). */
    toCycleOpts: (task: ThesisTask<I>) => Omit<RunCycleOptions, 'cycleId' | 'execute'>;
    now?: () => number;
    /** Event-log path per run (default: a fresh temp file per run). */
    eventsPath?: (arm: ThesisArm, taskId: string) => string;
    /** Normalized cost from the cycle result (default 1). */
    cost?: (r: CycleResult) => number;
}
/**
 * Build a ThesisSolver that drives the real CycleEngine + orchestrator. Feed the resulting solver to
 * runThesis(). In production: pool = the gene pool, baseline = a fresh empty store, execute =
 * makeSafeExecute(repo, store, safety, { validate }) so `passed` reflects an objective validation.
 */
export declare function makeEvolutionThesisSolver<I>(deps: EvolutionThesisDeps<I>): ThesisSolver<I>;