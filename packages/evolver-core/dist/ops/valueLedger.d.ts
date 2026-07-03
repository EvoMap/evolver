/** USD price per single token, split by token class (Anthropic-style usage breakdown). All optional: an
 *  absent class is treated as 0 so a sparse table still prices what it can. */
export interface ModelPrice {
    /** USD per input token. */
    input?: number;
    /** USD per output token. */
    output?: number;
    /** USD per cache-creation (write) input token. */
    cacheCreation?: number;
    /** USD per cache-read input token. */
    cacheRead?: number;
}
/**
 * Model → price lookup. INJECTED, never hardcoded in core (acceptance: a price update must not touch core
 * code). A lookup is tolerant: an unknown model returns undefined and that turn simply contributes no cost
 * (we never invent a price). The adapter owns the concrete data file + loader.
 */
export interface PriceTable {
    priceOf(model: string): ModelPrice | undefined;
}
/** Build a PriceTable from a plain {model: ModelPrice} map (the shape a JSON data file deserializes to). */
export declare function priceTableFromMap(map: Readonly<Record<string, ModelPrice>>): PriceTable;
/** Per-turn token usage, matching the proxy trace's `usage` block by field name (input_tokens, …). */
export interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
/**
 * A single LLM-turn trace record, as the proxy appends it to `llm-trace-YYYYMMDD.jsonl`. Declared structurally
 * here (only the fields the ledger reads) so core never imports the proxy package. The caller parses the JSONL
 * and passes the records in.
 */
export interface TraceRecord {
    /** ISO timestamp of the turn (the ledger's `at` for a route entry — never a local clock). */
    ts: string;
    /** What the client asked for. */
    original_model: string | null;
    /** What the router actually sent (a cheaper tier model when routing fired). */
    chosen_model: string | null;
    /** Routing tier, when the router rewrote the model. Absent/null → no route savings for this turn. */
    tier?: string | null;
    usage?: TokenUsage;
}
/** root_events type appended on a reuse-before-solve HIT — the replayable source for source=reuse entries. */
export declare const VALUE_REUSE_HIT_EVENT = "value.reuse_hit";
/**
 * Payload of a `value.reuse_hit` root_event. Carries exactly what the ledger needs to account a reuse saving:
 * which asset was reused, in which cycle, the actual token cost the fetch incurred (≈0 - metadata + payload,
 * no fresh solve), and an OPTIONAL measured baseline (historical avg solve-fresh tokens for this signal class).
 * When `baselineTokens` is present the saving is `measured`; when absent the ledger records the reuse with
 * unknown/zero savings instead of inventing a task-level token delta. The signal fingerprint is carried for
 * baseline attribution upstream.
 */
export interface ReuseHitPayload {
    assetId: string;
    cycleId: string;
    /** Signal fingerprint of the reused problem (for baseline cohorting / explainability). */
    signalFingerprint?: string;
    /** Tokens the fetch actually consumed (cache/payload pull — typically 0). Defaults to 0. */
    fetchTokens?: number;
    /** Measured baseline: historical avg solve-fresh token cost for this signal class. Absent → estimated. */
    baselineTokens?: number;
    /** Model whose price values the saved tokens (so cost uses the real tier, not a guess). Optional. */
    model?: string;
}
/** A minimal root_event view the ledger reads (matches the events module's ReportEvent shape). */
export interface LedgerRootEvent {
    type: string;
    ts: string;
    payload?: Record<string, unknown>;
}
/** root_events type appended when SessionStart injects genes — recorded for outcome attribution only. */
export declare const VALUE_INJECT_EVENT = "value.inject";
/** Payload of a `value.inject` root_event: which genes were injected and the session outcome. No savings. */
export interface InjectPayload {
    geneIds: readonly string[];
    cycleId?: string;
    /** The runtime session id this injection went into, when known (#205). Lets recall tie an inject to the exact
     *  session transcript it produced, rather than assuming "the most recent inject". Absent for runtimes with no id. */
    sessionId?: string;
    /** Free-form session outcome label (solved/abandoned/…); attribution only, never scored into a number. */
    outcome?: string;
}
export type ValueSource = 'route' | 'reuse' | 'inject';
export type ValueConfidence = 'measured' | 'estimated';
/**
 * One derived ledger entry. Append-only + content-derived: replaying the same trace + root_events yields the
 * identical entry. `tokensSaved` is the token delta (0 for route — routing saves cost on the SAME tokens, not
 * tokens; and 0 for inject — inject reports no number). `costSavedUsd` is the USD delta. `refs` ties the entry
 * back to its source material (assetId, cycleId, models) for audit / drift checks.
 */
export interface ValueEntry {
    /** Timestamp from the source record (route: trace.ts; reuse/inject: event.ts). Never a local clock. */
    at: string;
    source: ValueSource;
    tokensSaved: number;
    costSavedUsd: number;
    confidence: ValueConfidence;
    refs: {
        assetId?: string;
        cycleId?: string;
        originalModel?: string;
        chosenModel?: string;
        /** gene ids, for inject entries (and topGenes attribution). */
        geneIds?: readonly string[];
        /** free-form outcome, for inject entries. */
        outcome?: string;
    };
}
/** Legacy savings-core E1 coefficient for "one cross-node asset reuse". The value ledger no longer uses this
 *  as a fallback baseline for live `value.reuse_hit` events: without a measured baseline, reuse savings stay
 *  zero/unknown. Kept exported so savings-core conformance and older consumers can detect spec drift. */
export declare const ESTIMATED_SOLVE_FRESH_TOKENS: number;
/**
 * Derive route-downgrade savings from trace records. A turn saves COST (not tokens) only when the router
 * actually rewrote the model (`original_model !== chosen_model`, both present): the saving is the price delta
 * of the SAME usage between the model the client asked for and the cheaper model that ran. Always `measured`
 * (the usage is real). A turn whose price delta is ≤0 (no cheaper, or model unpriced) contributes nothing.
 */
export declare function deriveRouteEntries(traces: readonly TraceRecord[], prices: PriceTable): ValueEntry[];
/**
 * Derive reuse savings from `value.reuse_hit` root_events. Saving = (baseline solve-fresh tokens) - (actual
 * fetch tokens), but only when the event carries `baselineTokens` (a real historical average for the signal
 * class). Without that measured baseline, the entry still records the reuse but keeps tokensSaved/costSavedUsd
 * at zero so a small-step reuse inside a large task cannot be promoted into fabricated whole-task ROI.
 * Each entry's refs point at the real `assetId` + `cycleId` from the hit - the audit anchor.
 */
export declare function deriveReuseEntries(events: readonly LedgerRootEvent[], prices: PriceTable): ValueEntry[];
/**
 * Derive inject records from `value.inject` root_events. Attribution-only: which genes were injected and the
 * session outcome. tokensSaved / costSavedUsd are ALWAYS 0 (the issue: inject is a weak signal — record it,
 * never report a savings number). Marked `estimated` so it can never land on the measured rail, and the
 * summary excludes inject from both savings totals regardless.
 */
export declare function deriveInjectEntries(events: readonly LedgerRootEvent[]): ValueEntry[];
export interface DeriveInput {
    /** Parsed proxy trace records (one per LLM turn). */
    traces?: readonly TraceRecord[];
    /** Parsed root_events (the reuse-hit + inject records live here). */
    events?: readonly LedgerRootEvent[];
    /** Injected price table — core never hardcodes prices. */
    prices: PriceTable;
}
/**
 * Derive the full set of value entries from trace + root_events, sorted by `at` (stable, ties broken by source
 * then assetId/models) so the ledger is a deterministic, replayable timeline. Pure: same input → same output,
 * byte-for-byte. This is the function a `replay` re-runs after discarding the materialized ledger.
 */
export declare function deriveValueEntries(input: DeriveInput): ValueEntry[];
/** Serialize entries to append-only JSONL (one entry per line). Deterministic given the entries. */
export declare function serializeLedger(entries: readonly ValueEntry[]): string;
/** Parse a ledger JSONL back into entries (the materialized view; the source of truth is still trace+events). */
export declare function parseLedger(jsonl: string): ValueEntry[];
export interface SourceBucket {
    tokensSaved: number;
    costSavedUsd: number;
    entries: number;
}
/**
 * The aggregated value view. CRITICAL HONESTY INVARIANT: `measured` and `estimated` are SEPARATE rails — the
 * top-level totals (`totalTokensSaved` / `totalCostUsd`) count ONLY measured savings, and estimated savings
 * live solely under `estimated`. There is no field that merges the two. A consumer that wants a combined figure
 * must add them itself and label it — the ledger never does it silently.
 */
export interface ValueSummary {
    /** MEASURED savings only (the trustworthy number). */
    totalTokensSaved: number;
    totalCostUsd: number;
    /** Per-source breakdown (measured rail). */
    bySource: Record<ValueSource, SourceBucket>;
    /** ESTIMATED savings, on their OWN rail — never folded into the totals above. */
    estimated: {
        totalTokensSaved: number;
        totalCostUsd: number;
        entries: number;
    };
    /** Top reused genes by frequency, with measured/estimated saving kept separate per gene. */
    topGenes: Array<{
        assetId: string;
        reuses: number;
        measuredTokensSaved: number;
        estimatedTokensSaved: number;
    }>;
    /** Inject attribution (no savings number): genes injected, by frequency. */
    injectedGenes: Array<{
        geneId: string;
        injections: number;
    }>;
    /** Number of entries considered (after window filter). */
    entries: number;
}
export interface SummaryWindow {
    /** Inclusive lower bound (ISO). Entries with `at` < since are excluded. */
    since?: string;
    /** Exclusive upper bound (ISO). Entries with `at` >= until are excluded. */
    until?: string;
}
/**
 * Aggregate entries into a ValueSummary over an optional time window. Pure. Measured and estimated are summed
 * on separate rails by construction — there is deliberately NO branch that adds an estimated entry into the
 * measured totals (the honesty invariant; a test asserts no such path exists).
 */
export declare function valueSummary(entries: readonly ValueEntry[], window?: SummaryWindow): ValueSummary;