import { type ValueSummary, type TraceRecord, type LedgerRootEvent, type PriceTable, type SummaryWindow } from './valueLedger.js';
/**
 * Read all proxy trace day-files in `dir` and return the parsed `llm_turn` records as ledger TraceRecords. A
 * missing dir / unreadable file degrades to [] (the value layer must never crash a long-running daemon over a
 * stat). Plain `event: 'llm_turn'` lines and encrypted envelopes with a safe `plaintext_summary` are kept; the
 * structural fields the ledger reads are passed through.
 */
export declare function readTraceRecords(dir: string): TraceRecord[];
export type ValueWindowSpec = '7d' | '30d' | 'all';
/** Parse a `--window` spec into a SummaryWindow against `now`. `all` → no bound. An unknown spec → 7d (the safe
 *  default a CLI offers first). The clock is injected so the report is deterministic under test. */
export declare function windowFromSpec(spec: string | undefined, now: number): SummaryWindow;
/** Human label for a window spec (for the report/digest header). */
export declare function windowLabel(spec: string | undefined): string;
export interface ValueSources {
    /** Parsed proxy trace records (route source). Default []. */
    traces?: readonly TraceRecord[];
    /** Parsed root_events (reuse + inject source). Default []. */
    events?: readonly LedgerRootEvent[];
    prices: PriceTable;
}
/**
 * Derive the full ledger then aggregate it over a window — the SINGLE aggregation seam every outreach surface
 * goes through, so the CLI, the WebUI card and the digest can never disagree (and none of them re-implements the
 * ledger). Pure given its inputs + window.
 */
export declare function loadValueSummary(sources: ValueSources, window?: SummaryWindow): ValueSummary;
/** Compact integer with thousands separators (deterministic, locale-independent). */
export declare function fmtInt(n: number): string;
/** USD with 4 decimals (savings are often sub-cent; never round a real saving to $0.00 silently). */
export declare function fmtUsd(n: number): string;
/** Guidance shown when the ledger is empty — never an empty table (#113 acceptance). */
export declare const VALUE_EMPTY_GUIDANCE: string;
/**
 * Render the three-section value report from a summary: (1) savings — measured and estimated on SEPARATE lines,
 * never a merged total; (2) top reused genes with their reuse counts; (3) source breakdown. Returns the empty
 * guidance text (not a blank table) when there is nothing to show. Pure: the window label is passed in.
 */
export declare function formatValueReport(summary: ValueSummary, windowSpec: string | undefined): string;
export interface RecapInput {
    /** Genes injected this session (N). */
    injectedCount: number;
    /** Past successes those genes came from (M) — e.g. distinct solidified cycles. Optional. */
    successCount?: number;
    /** The summary for the recap window (defaults to last 7 days at the call site). */
    summary: ValueSummary;
}
/**
 * Build the quiet SessionStart context line. It is intentionally metadata-shaped, non-branded, and non-second-
 * person so the agent can use injected-memory/value context without reciting Evolver in routine replies. Measured
 * tokens (X) stay on the trustworthy rail; estimated is emitted ONLY when there is no measured figure, under a
 * separate key so the two are never conflated. Returns '' when there is nothing honest to say (no injection AND no
 * savings) — the caller then injects no recap line at all rather than a hollow "saved 0".
 */
export declare function buildValueRecap(input: RecapInput): string;
/** Prefix a reuse-source note onto an injected candidate so the user sees WHERE a ready-made solution came from
 *  (the reuse hit short-circuited a fresh solve). Pure string composition; the assetId is the audit anchor. */
export declare function reuseSourceNote(assetId: string): string;
/**
 * A digest is only worth sending in a week that produced REAL (measured) value. This is the frequency/quality
 * gate the issue makes a first-class requirement: "宁可少触达，不可惹人烦". Estimated-only weeks do NOT pass —
 * an estimate is too weak to justify an unsolicited push.
 */
export declare function digestShouldSend(summary: ValueSummary): boolean;
/**
 * Build the weekly digest markdown from a summary. Returns null when the zero-measured-value gate fails (the
 * caller then delivers nothing — no empty digest, ever). measured and estimated stay on separate lines. Pure:
 * the window label + the period string are passed in so the digest is deterministic.
 */
export declare function buildValueDigest(summary: ValueSummary, period: string, extras?: {
    pendingReviewCount?: number;
}): string | null;