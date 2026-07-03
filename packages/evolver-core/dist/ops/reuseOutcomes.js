// Reuse-outcome accounting (#268 slice C) — the cross-runtime keep/prune SIGNAL, derived purely from root_events.
//
// Slice A/B made `evolver_asset_reuse_result` work in every mode and emit a `value.reuse_hit` on SUCCESS (the $
// rail). This module records the OTHER outcomes too and rolls the whole distribution up per gene, so the question
// "is this gene worth keeping?" can be answered from EVERY runtime's reuse (MCP-native agents included), not only
// from the hook/daemon transcript-recall path. It is the foreign-agent analogue of summarizeRecall.
//
// PURE + read-only: a function over already-emitted events. It does NOT actuate (it never mutates gene health,
// selection weight, or the store) — wiring this signal into selection/health is a separate, explicitly-gated step
// (it touches the keep/prune actuator). This module only makes the signal visible and accountable.
//
// Two event sources (decoupled by design): a SUCCESS reuse credits the $ ledger via `value.reuse_hit` (slice A/B),
// so success is counted from THAT; the non-success verdicts (failed/mismatched/stale/unsafe) are recorded as
// `value.reuse_outcome`. Reading both yields the full per-gene success-vs-negative picture without a redundant
// second event on the success path.
import { VALUE_REUSE_HIT_EVENT } from './valueLedger.js';
import { VALUE_RECALL_EVENT } from './recall.js';
/** root_events type appended for a NON-success MCP reuse-result — the negative half of the keep/prune signal. */
export const VALUE_REUSE_OUTCOME_EVENT = 'value.reuse_outcome';
const NEG = ['failed', 'mismatched', 'stale', 'unsafe'];
function assetIdOf(e) {
    const id = e.payload?.['assetId'];
    return typeof id === 'string' && id.length > 0 ? id : null;
}
/**
 * Roll reuse signals up per gene from root_events: SUCCESS from `value.reuse_hit`, the negative verdicts from
 * `value.reuse_outcome`. Pure; deterministic ordering. Unknown/garbled payloads are skipped, never counted.
 */
export function summarizeReuseOutcomes(events) {
    const agg = new Map();
    const get = (assetId) => {
        let g = agg.get(assetId);
        if (!g) {
            g = { assetId, success: 0, negative: 0, byOutcome: { failed: 0, mismatched: 0, stale: 0, unsafe: 0 } };
            agg.set(assetId, g);
        }
        return g;
    };
    let total = 0;
    for (const e of events) {
        if (e.type === VALUE_REUSE_HIT_EVENT) {
            const assetId = assetIdOf(e);
            if (!assetId)
                continue;
            get(assetId).success += 1;
            total += 1;
        }
        else if (e.type === VALUE_REUSE_OUTCOME_EVENT) {
            const assetId = assetIdOf(e);
            const outcome = e.payload?.['outcome'];
            if (!assetId || typeof outcome !== 'string' || !NEG.includes(outcome))
                continue;
            const g = get(assetId);
            g.negative += 1;
            g.byOutcome[outcome] += 1;
            total += 1;
        }
    }
    const perGene = [...agg.values()].sort((a, b) => b.negative - a.negative || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    const pruneCandidates = perGene.filter((g) => g.negative > 0 && g.success === 0).map((g) => g.assetId);
    return { total, perGene, pruneCandidates };
}
/**
 * Map a reuse-outcome summary to per-id reuse COUNTS (#268 phase 1) — the input to a SOFT selection re-order.
 * Keyed by the id the events recorded (which may be a logical geneId OR a content asset_id), so the store-aware
 * consumer (candidateAssembly) can fold all of a gene's ids together via `reuseSentiment` before ranking. Only ids
 * with at least one reuse signal are included. Pure; the cycle injects it via RunCycleOptions.reuseOutcomes.
 */
export function reuseCountsFromSummary(summary) {
    const out = new Map();
    for (const g of summary.perGene) {
        if (g.success + g.negative <= 0)
            continue;
        out.set(g.assetId, { success: g.success, negative: g.negative });
    }
    return out;
}
/** Net reuse sentiment in [-1, 1] from combined counts: (success − negative) / (success + negative). all-success
 *  → +1, all-negative → −1, balanced → 0. Zero total → 0. The WEIGHT/clamping that bounds its selection influence
 *  lives in geneSelection (it can never override the hard trust/review/ban gates, which run before scoring). */
export function reuseSentiment(counts) {
    const denom = counts.success + counts.negative;
    return denom > 0 ? (counts.success - counts.negative) / denom : 0;
}
/** Weight of an OBSERVED recall verdict (#274 slice 3) relative to a reported reuse outcome. < 1 because a
 *  transcript-observed `used`/`unused` is weaker evidence than an agent (or daemon) explicitly reporting that a
 *  reuse WORKED or FAILED — being applied/ignored is softer than working/breaking. */
export const RECALL_WEIGHT = 0.5;
/**
 * Per-gene reuse COUNTS contributed by OBSERVED `value.recall` events (#274 slice 3): `used` → success, `unused` →
 * negative, each weighted RECALL_WEIGHT (weaker than a reported reuse outcome); `unknown` is ignored. Keyed by the
 * recall payload's geneId. Pure. Merged into the reuse-outcome counts upstream so recall SOFTLY re-orders selection
 * — it never reaches the quarantine path (summarizeReuseOutcomes reads only the reuse-outcome events, not recall).
 */
export function recallCountsFromEvents(events) {
    // Collapse to ONE verdict per (session, gene) first: within a session `used` is terminal and WINS over an earlier
    // provisional `unused`, so a within-session upgrade is not double-counted (it would otherwise cancel to neutral —
    // #274 Bugbot). Then accumulate ACROSS sessions, so a gene reused (un)successfully in many sessions adds up.
    const perSession = new Map(); // key: `${sessionId}|${geneId}` (per-session collapse)
    const geneOf = new Map();
    for (const e of events) {
        if (e.type !== VALUE_RECALL_EVENT)
            continue;
        const id = e.payload?.['geneId'];
        const recalled = e.payload?.['recalled'];
        if (typeof id !== 'string' || (recalled !== 'used' && recalled !== 'unused'))
            continue;
        const sid = typeof e.payload?.['sessionId'] === 'string' ? e.payload['sessionId'] : '';
        const key = `${sid}|${id}`;
        if (perSession.get(key) === 'used')
            continue; // terminal for this session
        perSession.set(key, recalled === 'used' ? 'used' : 'unused');
        geneOf.set(key, id);
    }
    const out = new Map();
    for (const [key, verdict] of perSession) {
        const id = geneOf.get(key);
        const c = out.get(id) ?? { success: 0, negative: 0 };
        if (verdict === 'used')
            c.success += RECALL_WEIGHT;
        else
            c.negative += RECALL_WEIGHT;
        out.set(id, c);
    }
    return out;
}