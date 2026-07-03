// Signal extraction from the LLM proxy's per-turn trace records (the `llm-trace-*.jsonl` files written by
// the proxy's JsonlTraceSink). Trace records are TURN METADATA — models, tier decision, status, latency,
// usage, stop_reason — never conversation text, so the signals here are the economic/reliability ones the
// session transcripts can't see: upstream failures, credential breakage, router fallbacks, truncation
// pressure, sustained latency. This closes the loop opened by the proxy's trace-capture seam: the proxy
// captures turn metadata, and `evolver ingest` mines it through this extractor.
//
// Three-leg mapping: every rule below is a zero-cost structured judgment over counters, so every emitted
// signal is `strong` with `needsAnalysis: false`. The `agent` and `weak` legs do not apply to metadata —
// there is no free text for an agent marker or difficulty wording to live in.
import { ulid as makeUlid } from 'ulid';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const strong = (kind, text) => ({ id: makeUlid(), strength: 'strong', kind, text: text.slice(0, 2000), needsAnalysis: false });
/**
 * Extract economic/reliability signals from a batch of llm-trace records. Returns the SAME signal shape as
 * `extractSignals` (one batch-aggregated signal per fired rule, not one per record — a day file holds
 * thousands of turns and per-record emission would flood every downstream consumer with duplicates).
 * Records whose `event` is not `'llm_turn'` are ignored, so callers can pass a raw parsed JSONL batch.
 */
export function extractTraceSignals(records, cfg = {}) {
    const min5xx = cfg.min5xx ?? 2;
    const minRateLimited = cfg.minRateLimited ?? 3;
    const minAuthFailures = cfg.minAuthFailures ?? 2;
    const minTruncations = cfg.minTruncations ?? 3;
    const minPolicyFallbacks = cfg.minPolicyFallbacks ?? 3;
    const slowTtfbMs = cfg.slowTtfbMs ?? 30_000;
    const minSlowTurns = cfg.minSlowTurns ?? 5;
    const minSlowShare = cfg.minSlowShare ?? 0.2;
    const handlerErrors = new Map(); // normalized error text → count
    const fallbacks = new Map(); // fallback reason → count
    const fiveXxStatuses = new Map(); // 5xx status → count
    let authFailures = 0;
    let rateLimited = 0;
    let truncations = 0;
    let eligibleTurns = 0; // successful turns with a measured TTFB — the latency denominator
    let slowTurns = 0;
    for (const r of records) {
        if (r.event !== 'llm_turn')
            continue;
        const status = num(r.status);
        const error = str(r.error);
        const fallback = str(r.fallback);
        const stopReason = str(r.stop_reason);
        const ttfb = num(r.ttfb_ms);
        // Handler/transport errors (upstream unreachable, drain failure, …). Auth statuses are carved out into
        // their own rule below so a 401's "x-api-key required" error text is not double-counted.
        if (error && status !== 401 && status !== 403) {
            const key = error.replace(/\s+/g, ' ').trim().slice(0, 200);
            handlerErrors.set(key, (handlerErrors.get(key) ?? 0) + 1);
        }
        if (status === 401 || status === 403)
            authFailures++;
        if (status !== null && status >= 500)
            fiveXxStatuses.set(status, (fiveXxStatuses.get(status) ?? 0) + 1);
        if (status === 429)
            rateLimited++;
        if (fallback)
            fallbacks.set(fallback, (fallbacks.get(fallback) ?? 0) + 1);
        if (stopReason === 'max_tokens')
            truncations++;
        if (status === 200 && ttfb !== null) {
            eligibleTurns++;
            if (ttfb >= slowTtfbMs)
                slowTurns++;
        }
    }
    const out = [];
    // RULE: handler error — the proxy could not complete the turn at all (e.g. ECONNREFUSED, drain timeout).
    // Threshold 1: a hard transport/handler failure is never routine, mirroring how a single tool error is a
    // strong signal in the session extractor. Grouped by error text so a repeated failure stays one signal.
    for (const [text, count] of handlerErrors) {
        out.push(strong('trace_handler_error', `LLM proxy handler error ×${count}: ${text}`));
    }
    // RULE: upstream 5xx — server-side failures that survived the route's own retry. Threshold 2: a single
    // 5xx is normal API weather (overload blips happen and the handler already retries rewritten requests);
    // two or more in one ingested batch is a reliability pattern worth surfacing.
    const total5xx = [...fiveXxStatuses.values()].reduce((s, n) => s + n, 0);
    if (total5xx >= min5xx) {
        const breakdown = [...fiveXxStatuses.keys()].sort((a, b) => a - b).join('/');
        out.push(strong('trace_upstream_5xx', `upstream 5xx ×${total5xx} (status ${breakdown}) — upstream reliability degraded`));
    }
    // RULE: rate limiting — 429s are the purest economic signal in the trace (quota/budget pressure).
    // Threshold 3: occasional 429s are expected under bursty load; sustained ones mean the tier/quota
    // configuration is mismatched with real usage.
    if (rateLimited >= minRateLimited) {
        out.push(strong('trace_rate_limited', `upstream 429 rate-limited ×${rateLimited} — quota/tier pressure`));
    }
    // RULE: auth failures — 401/403 from the credential path. Threshold 2: a single 401 can be one client's
    // typo; repeated ones mean the proxy or its clients are misconfigured (broken key, missing env cred).
    if (authFailures >= minAuthFailures) {
        out.push(strong('trace_auth_failure', `auth failures (401/403) ×${authFailures} — credential configuration broken`));
    }
    // RULE: router fallbacks, split by what the reason MEANS:
    //   - classifier_error / rewrite_error: the router's own code threw. Threshold 1 — a throwing classifier
    //     is a bug, never routine operation.
    //   - downgrade_blocked: the safety guard refused an intra-family downgrade. Threshold 3 — single blocks
    //     are the guard working as designed; a sustained pattern means the tier config conflicts with what
    //     clients actually request and routing silently does nothing.
    //   - anything else (future reasons): threshold 2 — unknown but repeated is worth a look.
    for (const [reason, count] of fallbacks) {
        const min = reason === 'classifier_error' || reason === 'rewrite_error' ? 1
            : reason === 'downgrade_blocked' ? minPolicyFallbacks
                : 2;
        if (count >= min) {
            out.push(strong('trace_router_fallback', `router fallback ${reason} ×${count} — routing degraded to passthrough`));
        }
    }
    // RULE: truncation pressure — turns that stopped at max_tokens. Threshold 3: a single truncation is often
    // deliberate (caller set a tight cap); repeated ones mean responses are systematically being cut off,
    // which silently corrupts agent behavior and wastes the tokens already paid for.
    if (truncations >= minTruncations) {
        out.push(strong('trace_truncation', `stop_reason=max_tokens ×${truncations} — output truncation pressure`));
    }
    // RULE: sustained high TTFB. TTFB (time to upstream response headers), NOT total latency_ms, because total
    // latency scales with legitimate output length — long generations are normal, slow first bytes are queue/
    // network/server pressure. Two-part gate so single spikes never fire: an absolute count (>= minSlowTurns)
    // AND a meaningful share of successful turns (>= minSlowShare) must be slow.
    if (slowTurns >= minSlowTurns && eligibleTurns > 0 && slowTurns / eligibleTurns >= minSlowShare) {
        out.push(strong('trace_slow_ttfb', `sustained high TTFB: ${slowTurns}/${eligibleTurns} successful turns ≥ ${slowTtfbMs}ms`));
    }
    return out;
}