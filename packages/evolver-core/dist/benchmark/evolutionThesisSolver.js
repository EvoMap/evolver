// Wire the honest thesis A/B harness to the REAL evolution loop. The evolver arm runs runEvolutionCycle
// against the learned-gene pool (so selection can reuse a gene); the baseline arm runs against an empty
// store (so it always innovates). Both use the same injected `execute` (a fake in tests; makeSafeExecute
// in prod) and the same task. Objective outcome = the cycle reached 'solidified' (success, as decided by
// the execute/validation hook); reuse = a gene was selected. Nothing about reuse feeds the pass/fail.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ingestor } from '../events/ingest.js';
import { CycleEngine } from '../algo/cycleEngine.js';
import { runEvolutionCycle } from '../algo/orchestrator.js';
import { makeGeneSelectionPoint } from '../algo/geneSelection.js';
/**
 * Build a ThesisSolver that drives the real CycleEngine + orchestrator. Feed the resulting solver to
 * runThesis(). In production: pool = the gene pool, baseline = a fresh empty store, execute =
 * makeSafeExecute(repo, store, safety, { validate }) so `passed` reflects an objective validation.
 */
export function makeEvolutionThesisSolver(deps) {
    const now = deps.now ?? (() => Date.now());
    const eventsPath = deps.eventsPath
        ?? ((arm, taskId) => join(mkdtempSync(join(tmpdir(), 'thesis-')), `${arm}-${taskId}.jsonl`));
    return async (task, arm) => {
        const store = arm === 'evolver' ? deps.pool : deps.baseline;
        const engine = new CycleEngine({
            ingestor: new Ingestor({ path: eventsPath(arm, task.id), now }),
            selection: makeGeneSelectionPoint(),
            store,
            now,
        });
        const r = await runEvolutionCycle(engine, store, {
            cycleId: `${arm}-${task.id}`,
            ...deps.toCycleOpts(task),
            execute: deps.execute,
        });
        return {
            passed: r.finalStage === 'solidified', // success is decided by the execute/validation hook, not self-report
            reusedGene: !!r.decision?.selectedGeneId,
            cost: deps.cost ? deps.cost(r) : 1,
        };
    };
}