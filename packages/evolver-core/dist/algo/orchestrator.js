import { CycleEngine } from './cycleEngine.js';
import { assembleSelectionPool } from './candidateAssembly.js';
import { mergePendingSignalsForStore } from '../assetstore/pendingSignals.js';
import { reuseCountsFromSummary, recallCountsFromEvents } from '../ops/reuseOutcomes.js';
/** Drive one full evolution cycle end-to-end: assemble candidates from the store, then run the cycle. */
export async function runEvolutionCycle(engine, store, opts) {
    let signals = [...opts.signals];
    if (opts.consumePendingSignals !== false) {
        try {
            const explicit = mergePendingSignalsForStore(store, opts.signals, opts.pendingSignalsContext);
            signals = explicit.signals;
            if (explicit.injected > 0) {
                console.log(`[ExplicitSignals] Injected ${explicit.injected} user-declared signal(s) from pending_signals.json.`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[ExplicitSignals] Failed to consume pending signals (non-fatal): ${message}`);
        }
    }
    // #268 phase 1 + #274 slice 3: fold cross-runtime reuse counts AND observed recall into the pool (soft re-order).
    // Absent both → no map → default-off. Recall is folded at a lower weight (RECALL_WEIGHT). Assembly sums a gene's
    // ids → sentiment; bounded + clamped in geneSelection; the hard trust/review/ban gates in assembly run first.
    const reuseCounts = opts.reuseOutcomes ? reuseCountsFromSummary(opts.reuseOutcomes) : new Map();
    if (opts.recallEvents && opts.recallEvents.length > 0) {
        for (const [id, rc] of recallCountsFromEvents(opts.recallEvents)) {
            const c = reuseCounts.get(id) ?? { success: 0, negative: 0 };
            c.success += rc.success;
            c.negative += rc.negative;
            reuseCounts.set(id, c);
        }
    }
    const asmOpts = {
        ...(opts.candidateLimit ? { limit: opts.candidateLimit } : {}),
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
        ...(opts.review ? { review: opts.review } : {}),
        ...(opts.includeProbation ? { includeProbation: true } : {}),
        ...(opts.hubCandidates && opts.hubCandidates.length > 0 ? { hubCandidates: opts.hubCandidates } : {}),
        ...(reuseCounts.size > 0 ? { reuseCounts } : {}),
    };
    const { candidates, distilledFallback, antiWarnings } = await assembleSelectionPool(store, signals, asmOpts);
    return engine.runCycle({
        cycleId: opts.cycleId,
        problem: opts.problem,
        signals,
        category: opts.category,
        ...(opts.strategyName !== undefined ? { strategyName: opts.strategyName } : {}),
        candidates,
        target: opts.target,
        expectedEffect: opts.expectedEffect,
        summary: opts.summary,
        confidence: opts.confidence,
        ...(opts.selectionFloor !== undefined ? { selectionFloor: opts.selectionFloor } : {}),
        ...(opts.forcedGeneId !== undefined ? { forcedGeneId: opts.forcedGeneId } : {}),
        execute: opts.execute,
        ...(opts.failureContext !== undefined ? { failureContext: opts.failureContext } : {}),
        ...(opts.solidifyPermit ? { solidifyPermit: opts.solidifyPermit } : {}),
        // #97: forward the distilled-gene fallback pool so a no-signal-match cycle reuses a distilled strategy
        // (instead of a blind innovate) when nothing clears the floor.
        ...(distilledFallback.length > 0 ? { distilledFallback } : {}),
        ...(antiWarnings.length > 0 ? { antiWarnings } : {}),
    });
}