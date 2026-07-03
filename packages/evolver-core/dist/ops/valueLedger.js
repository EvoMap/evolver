// Value ledger (#112) — "how many tokens did evolver save you" as a PURE, event-sourced, append-only ledger.
// The raw material already exists but no code turns it into savings: the proxy captures per-turn LLM usage
// (route decisions: original_model vs chosen_model) and reuse-before-solve hits land a replayable root_event.
// This module DERIVES value entries from that material — it never measures, mutates, pays, or settles anything.
//
// HARD BOUNDARY (core purity, #112): zero hub / zero economic decision / zero governance. The ledger is a
// read-only accounting view. Prices are INJECTED as a PriceTable (a data interface) — core hardcodes no model
// price, so a price update is a data-file change, never a core code change. This file does not import the
// adapter (the adapter reverse-injects prices) and emits no money movement.
//
// HONESTY INVARIANT (the user-trust line,呼应 money-safety): `measured` and `estimated` confidence are tracked
// and reported on SEPARATE rails. There is no code path that folds an estimated number into a measured total.
// `valueSummary` exposes them as two distinct buckets so a UI can never present an inflated single figure.
//
// Determinism: every function here is pure. No Date.now / Math.random — all timestamps come from the event or
// trace records themselves, so a golden fixture replays byte-for-byte.
import { ENTROPY_EVENT_TOKENS_EST } from './savingsCore.js';
/** Build a PriceTable from a plain {model: ModelPrice} map (the shape a JSON data file deserializes to). */
export function priceTableFromMap(map) {
    return { priceOf: (model) => map[model] };
}
// ── the reuse root_event the ledger derives source=reuse entries from ─────────────────────────────────────
/** root_events type appended on a reuse-before-solve HIT — the replayable source for source=reuse entries. */
export const VALUE_REUSE_HIT_EVENT = 'value.reuse_hit';
// ── the injected gene-injection record (inject source — recorded, NEVER given a savings number) ───────────
/** root_events type appended when SessionStart injects genes — recorded for outcome attribution only. */
export const VALUE_INJECT_EVENT = 'value.inject';
/** Legacy savings-core E1 coefficient for "one cross-node asset reuse". The value ledger no longer uses this
 *  as a fallback baseline for live `value.reuse_hit` events: without a measured baseline, reuse savings stay
 *  zero/unknown. Kept exported so savings-core conformance and older consumers can detect spec drift. */
export const ESTIMATED_SOLVE_FRESH_TOKENS = ENTROPY_EVENT_TOKENS_EST.fetch_reuse;
function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
}
/** USD cost of a usage block under a price (absent price class → 0, never invented). */
function costOf(price, usage) {
    if (!price || !usage)
        return 0;
    return (n(usage.input_tokens) * n(price.input) +
        n(usage.output_tokens) * n(price.output) +
        n(usage.cache_creation_input_tokens) * n(price.cacheCreation) +
        n(usage.cache_read_input_tokens) * n(price.cacheRead));
}
// ── derivation: route (measured) ──────────────────────────────────────────────────────────────────────────
/**
 * Derive route-downgrade savings from trace records. A turn saves COST (not tokens) only when the router
 * actually rewrote the model (`original_model !== chosen_model`, both present): the saving is the price delta
 * of the SAME usage between the model the client asked for and the cheaper model that ran. Always `measured`
 * (the usage is real). A turn whose price delta is ≤0 (no cheaper, or model unpriced) contributes nothing.
 */
export function deriveRouteEntries(traces, prices) {
    const out = [];
    for (const t of traces) {
        const orig = t.original_model;
        const chosen = t.chosen_model;
        if (!orig || !chosen || orig === chosen)
            continue;
        const origCost = costOf(prices.priceOf(orig), t.usage);
        const chosenCost = costOf(prices.priceOf(chosen), t.usage);
        const saved = origCost - chosenCost;
        if (!(saved > 0))
            continue; // routing to an equal/pricier model saves nothing — never record a negative
        out.push({
            at: t.ts,
            source: 'route',
            tokensSaved: 0, // routing runs the SAME tokens on a cheaper model — it saves money, not tokens
            costSavedUsd: saved,
            confidence: 'measured',
            refs: { originalModel: orig, chosenModel: chosen },
        });
    }
    return out;
}
// ── derivation: reuse (measured when the event carries a baseline, else zero/unknown) ─────────────────────
/**
 * Derive reuse savings from `value.reuse_hit` root_events. Saving = (baseline solve-fresh tokens) - (actual
 * fetch tokens), but only when the event carries `baselineTokens` (a real historical average for the signal
 * class). Without that measured baseline, the entry still records the reuse but keeps tokensSaved/costSavedUsd
 * at zero so a small-step reuse inside a large task cannot be promoted into fabricated whole-task ROI.
 * Each entry's refs point at the real `assetId` + `cycleId` from the hit - the audit anchor.
 */
export function deriveReuseEntries(events, prices) {
    const out = [];
    for (const e of events) {
        if (e.type !== VALUE_REUSE_HIT_EVENT)
            continue;
        const p = (e.payload ?? {});
        const assetId = typeof p.assetId === 'string' ? p.assetId : '';
        const cycleId = typeof p.cycleId === 'string' ? p.cycleId : '';
        if (!assetId || !cycleId)
            continue; // a reuse entry without its audit anchors is not accountable
        const fetchTokens = Math.max(0, n(p.fetchTokens));
        const hasMeasuredBaseline = typeof p.baselineTokens === 'number' && Number.isFinite(p.baselineTokens) && p.baselineTokens > 0;
        const tokensSaved = hasMeasuredBaseline ? Math.max(0, n(p.baselineTokens) - fetchTokens) : 0;
        const price = typeof p.model === 'string' ? prices.priceOf(p.model) : undefined;
        // Value the saved tokens as input-side cost (a conservative single-rail price for a token bundle). When the
        // model is unpriced/absent, or when there is no measured baseline, cost is 0.
        const perToken = price ? n(price.input) : 0;
        const costSavedUsd = tokensSaved * perToken;
        out.push({
            at: e.ts,
            source: 'reuse',
            tokensSaved,
            costSavedUsd,
            confidence: hasMeasuredBaseline ? 'measured' : 'estimated',
            refs: { assetId, cycleId },
        });
    }
    return out;
}
// ── derivation: inject (recorded, NEVER a savings number) ─────────────────────────────────────────────────
/**
 * Derive inject records from `value.inject` root_events. Attribution-only: which genes were injected and the
 * session outcome. tokensSaved / costSavedUsd are ALWAYS 0 (the issue: inject is a weak signal — record it,
 * never report a savings number). Marked `estimated` so it can never land on the measured rail, and the
 * summary excludes inject from both savings totals regardless.
 */
export function deriveInjectEntries(events) {
    const out = [];
    for (const e of events) {
        if (e.type !== VALUE_INJECT_EVENT)
            continue;
        const p = (e.payload ?? {});
        const geneIds = Array.isArray(p.geneIds) ? p.geneIds.filter((g) => typeof g === 'string') : [];
        if (geneIds.length === 0)
            continue;
        out.push({
            at: e.ts,
            source: 'inject',
            tokensSaved: 0,
            costSavedUsd: 0,
            confidence: 'estimated',
            refs: {
                geneIds,
                ...(typeof p.cycleId === 'string' ? { cycleId: p.cycleId } : {}),
                ...(typeof p.outcome === 'string' ? { outcome: p.outcome } : {}),
            },
        });
    }
    return out;
}
/**
 * Derive the full set of value entries from trace + root_events, sorted by `at` (stable, ties broken by source
 * then assetId/models) so the ledger is a deterministic, replayable timeline. Pure: same input → same output,
 * byte-for-byte. This is the function a `replay` re-runs after discarding the materialized ledger.
 */
export function deriveValueEntries(input) {
    const traces = input.traces ?? [];
    const events = input.events ?? [];
    const entries = [
        ...deriveRouteEntries(traces, input.prices),
        ...deriveReuseEntries(events, input.prices),
        ...deriveInjectEntries(events),
    ];
    entries.sort((a, b) => {
        if (a.at !== b.at)
            return a.at < b.at ? -1 : 1;
        if (a.source !== b.source)
            return a.source < b.source ? -1 : 1;
        const ka = a.refs.assetId ?? a.refs.chosenModel ?? '';
        const kb = b.refs.assetId ?? b.refs.chosenModel ?? '';
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return entries;
}
// ── serialization (append-only JSONL, replayable) ─────────────────────────────────────────────────────────
/** Serialize entries to append-only JSONL (one entry per line). Deterministic given the entries. */
export function serializeLedger(entries) {
    return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}
/** Parse a ledger JSONL back into entries (the materialized view; the source of truth is still trace+events). */
export function parseLedger(jsonl) {
    const out = [];
    for (const line of jsonl.split('\n')) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            out.push(JSON.parse(s));
        }
        catch { /* skip a corrupt tail line — replay rebuilds it */ }
    }
    return out;
}
function emptyBucket() { return { tokensSaved: 0, costSavedUsd: 0, entries: 0 }; }
/**
 * Aggregate entries into a ValueSummary over an optional time window. Pure. Measured and estimated are summed
 * on separate rails by construction — there is deliberately NO branch that adds an estimated entry into the
 * measured totals (the honesty invariant; a test asserts no such path exists).
 */
export function valueSummary(entries, window = {}) {
    const inWindow = (at) => (window.since === undefined || at >= window.since) && (window.until === undefined || at < window.until);
    const scoped = entries.filter((e) => inWindow(e.at));
    const bySource = { route: emptyBucket(), reuse: emptyBucket(), inject: emptyBucket() };
    const estimated = { totalTokensSaved: 0, totalCostUsd: 0, entries: 0 };
    let totalTokensSaved = 0;
    let totalCostUsd = 0;
    const geneAgg = new Map();
    const injectAgg = new Map();
    for (const e of scoped) {
        const bucket = bySource[e.source];
        bucket.entries += 1;
        if (e.confidence === 'measured') {
            // MEASURED rail — and ONLY the measured rail feeds the headline totals.
            bucket.tokensSaved += e.tokensSaved;
            bucket.costSavedUsd += e.costSavedUsd;
            totalTokensSaved += e.tokensSaved;
            totalCostUsd += e.costSavedUsd;
        }
        else {
            // ESTIMATED rail — kept wholly separate; never touches bucket.tokensSaved or the totals above.
            estimated.totalTokensSaved += e.tokensSaved;
            estimated.totalCostUsd += e.costSavedUsd;
            estimated.entries += 1;
        }
        if (e.source === 'reuse' && e.refs.assetId) {
            const g = geneAgg.get(e.refs.assetId) ?? { reuses: 0, measuredTokensSaved: 0, estimatedTokensSaved: 0 };
            g.reuses += 1;
            if (e.confidence === 'measured')
                g.measuredTokensSaved += e.tokensSaved;
            else
                g.estimatedTokensSaved += e.tokensSaved;
            geneAgg.set(e.refs.assetId, g);
        }
        if (e.source === 'inject' && e.refs.geneIds) {
            for (const gid of e.refs.geneIds)
                injectAgg.set(gid, (injectAgg.get(gid) ?? 0) + 1);
        }
    }
    const topGenes = [...geneAgg.entries()]
        .map(([assetId, v]) => ({ assetId, ...v }))
        .sort((a, b) => b.reuses - a.reuses || b.measuredTokensSaved - a.measuredTokensSaved || (a.assetId < b.assetId ? -1 : 1));
    const injectedGenes = [...injectAgg.entries()]
        .map(([geneId, injections]) => ({ geneId, injections }))
        .sort((a, b) => b.injections - a.injections || (a.geneId < b.geneId ? -1 : 1));
    return { totalTokensSaved, totalCostUsd, bySource, estimated, topGenes, injectedGenes, entries: scoped.length };
}