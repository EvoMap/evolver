// savings-core — token-savings formula, TS implementation for evolver-v2.
//
// Single source of truth: EvoMap/savings-core (spec v0.3.0). The constants and formula semantics
// here MUST match the repo-root vendored copies (conformance/savings-core/constants.json) and
// reproduce conformance/savings-core/golden-vectors.json bit-for-bit — savingsCore.test.ts is the
// gate (it reads the vendored files at runtime, so this module stays free of cross-rootDir JSON
// imports), and savings-core's daily drift-check locks the vendored copies to upstream. To change a
// coefficient: change savings-core first, regenerate vectors there, bump spec_version, then
// re-vendor here AND in evomap-hub / evomap-private / evox-online-deck / evomap-desktop / evox /
// evolver-private-dev / evolver-v2-enterprise-dev.
//
// Core purity contract holds: no I/O, no Date.now/Math.random — pure functions over numbers.
export const SAVINGS_SPEC_VERSION = '0.3.0';
// E1 — per-event estimated tokens saved.
export const ENTROPY_EVENT_TOKENS_EST = Object.freeze({
    dedup_quarantine: 12_000,
    dedup_warning: 3_600,
    hub_search_hit: 8_000,
    hub_search_miss: 0,
    fetch_reuse: 4_000,
});
// E2 — node-level fetch-usage estimates, per asset type.
export const FETCH_USAGE_TOKENS_EST = Object.freeze({
    Gene: 1_500,
    Capsule: 3_500,
    EvolutionEvent: 0,
});
// E3 — blast-radius reuse estimator parameters (anchor: 120000 + 75×800 = the legacy 180k blanket).
export const REUSE_ESTIMATOR = Object.freeze({
    derive_base_tokens: 120_000,
    tokens_per_changed_line: 800,
    derive_cap_tokens: 600_000,
    typical_changed_lines: 75,
    reference_saving_fraction: 0.4,
});
// U1 — blended $/1M tokens across input+output.
export const USD_PER_M_TOKENS_BLENDED = 9.0;
// C1 — $ saved per 1M prompt-cache-read tokens, per provider.
export const CACHE_READ_SAVED_USD_PER_M_TOKENS = Object.freeze({
    anthropic: 2.7,
});
export const SAVINGS_BASIS_PRECEDENCE = Object.freeze(['measured', 'cost_index', 'estimator']);
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round((x + Number.EPSILON) * 10000) / 10000;
const coerce = (x) => Math.max(0, Math.round(Number(x) || 0));
// R1 — measured savings from a raw/optimized token pair (preferred basis).
export function measuredSavings(rawTokens, optimizedTokens) {
    const raw = coerce(rawTokens);
    const optimized = coerce(optimizedTokens);
    const saved = Math.max(0, raw - optimized);
    const rate = raw > 0 ? Math.max(0, 1 - optimized / raw) : 0;
    return { tokens_saved: saved, savings_pct: round2(rate * 100) };
}
// R2 — rollout-folding rate.
export function rolloutFoldPct(nAvgRollouts) {
    const n = Number(nAvgRollouts) || 0;
    return n >= 1 ? round2((1 - 1 / n) * 100) : 0;
}
// E1 — aggregate estimated savings over entropy events (unknown types skipped).
export function entropyTotal(events) {
    let tokens = 0;
    let count = 0;
    for (const e of events ?? []) {
        let per;
        if (e.tokensEstSaved !== undefined && e.tokensEstSaved !== null) {
            per = coerce(e.tokensEstSaved);
        }
        else {
            const coeff = ENTROPY_EVENT_TOKENS_EST[e.type];
            if (coeff === undefined)
                continue;
            per = coeff;
        }
        const n = coerce(e.count ?? 1);
        tokens += per * n;
        count += n;
    }
    return { total_tokens_saved: tokens, total_events: count };
}
// E2 — node fetch-usage estimate; unknown asset types contribute 0.
export function fetchUsageEstimate(byType) {
    let sum = 0;
    for (const [type, n] of Object.entries(byType ?? {})) {
        sum += (FETCH_USAGE_TOKENS_EST[type] ?? 0) * coerce(n);
    }
    return sum;
}
// E3 — blast-radius reuse estimator (the `estimator` basis fallback).
export function reuseEstimate(blastRadiusLines, mode) {
    const n = Number(blastRadiusLines);
    const valid = Number.isFinite(n) && n > 0;
    const basis = valid ? 'estimated_blast_radius' : 'estimated_default';
    const lines = valid ? n : REUSE_ESTIMATOR.typical_changed_lines;
    const full = Math.min(REUSE_ESTIMATOR.derive_base_tokens + lines * REUSE_ESTIMATOR.tokens_per_changed_line, REUSE_ESTIMATOR.derive_cap_tokens);
    const tokens = Math.round(mode === 'reference' ? full * REUSE_ESTIMATOR.reference_saving_fraction : full);
    return { tokens_saved: tokens, basis };
}
// H1 — search hit rate as a 2-dp percentage.
export function hitRatePct(hits, misses) {
    const h = coerce(hits);
    const m = coerce(misses);
    return h + m > 0 ? round2((h / (h + m)) * 100) : 0;
}
// U1 — USD value of saved tokens at the blended rate.
export function usdSaved(tokens) {
    return round2((coerce(tokens) / 1_000_000) * USD_PER_M_TOKENS_BLENDED);
}
// C1 — prompt-cache savings in USD (4 dp); unknown providers contribute 0.
export function cacheSavedUsd(provider, cacheReadTokens) {
    const rate = CACHE_READ_SAVED_USD_PER_M_TOKENS[provider] ?? 0;
    return round4((coerce(cacheReadTokens) / 1_000_000) * rate);
}