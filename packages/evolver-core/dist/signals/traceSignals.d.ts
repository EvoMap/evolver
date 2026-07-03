import type { ExtractedSignal } from './extractor.js';
/**
 * Minimal structural shape of one parsed llm-trace JSONL record. snake_case on purpose: these are the
 * on-disk wire field names of the proxy's LlmTurnTrace. The shape is DUPLICATED structurally rather than
 * imported because evolver-core must stay proxy-agnostic (the same boundary discipline as
 * SignalSourceTurn vs runtime-adapters' NormalizedTurn). Fields are `unknown` because the input is
 * untrusted JSON — every rule narrows with typeof checks, and a corrupt record simply matches no rule.
 */
export interface LlmTraceRecord {
    event?: unknown;
    status?: unknown;
    fallback?: unknown;
    stop_reason?: unknown;
    ttfb_ms?: unknown;
    latency_ms?: unknown;
    error?: unknown;
    upstream_mode?: unknown;
}
/** Thresholds for the aggregate rules. Defaults are deliberately conservative — see each rule's comment. */
export interface TraceSignalThresholds {
    /** Min upstream 5xx responses in the batch before they count as a pattern. Default 2. */
    min5xx?: number;
    /** Min upstream 429 responses before rate-limit pressure is a signal. Default 3. */
    minRateLimited?: number;
    /** Min 401/403 responses before credential breakage is assumed. Default 2. */
    minAuthFailures?: number;
    /** Min `stop_reason: max_tokens` turns before truncation pressure is a signal. Default 3. */
    minTruncations?: number;
    /** Min occurrences of a POLICY fallback (downgrade_blocked) before it is a signal. Default 3. */
    minPolicyFallbacks?: number;
    /** TTFB at/above this many ms counts as a slow turn. Default 30000. */
    slowTtfbMs?: number;
    /** Min slow turns before sustained latency fires. Default 5. */
    minSlowTurns?: number;
    /** Min share of eligible (successful) turns that must be slow. Default 0.2. */
    minSlowShare?: number;
}
/**
 * Extract economic/reliability signals from a batch of llm-trace records. Returns the SAME signal shape as
 * `extractSignals` (one batch-aggregated signal per fired rule, not one per record — a day file holds
 * thousands of turns and per-record emission would flood every downstream consumer with duplicates).
 * Records whose `event` is not `'llm_turn'` are ignored, so callers can pass a raw parsed JSONL batch.
 */
export declare function extractTraceSignals(records: readonly LlmTraceRecord[], cfg?: TraceSignalThresholds): ExtractedSignal[];