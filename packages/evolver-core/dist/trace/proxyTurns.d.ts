import { type TraceReadOptions } from './trajectoryExport.js';
import { type TraceTurnDraft } from './trajectory.js';
/** One agent run's wall-clock window (epoch ms, same host clock as the proxy's ts). */
export interface RunTurnWindow {
    startMs: number;
    endMs: number;
}
export interface SelectRunLlmTurnsOptions {
    /**
     * Exact-match correlation key: when the caller knows the spawned agent's session id, only that session's
     * turns are returned (the window heuristic is skipped — the id is authoritative).
     */
    sessionId?: string;
}
export interface CollectRunLlmTurnsOptions extends SelectRunLlmTurnsOptions {
    /** Decryption material forwarded to readTraceRowsFromJsonl. allowPartial is always forced on. */
    readOptions?: TraceReadOptions;
}
/**
 * Pure selector (unit-testable without fs): pick the turns that belong to the run per the correlation
 * contract above, sorted by ts ascending (stable — equal timestamps keep day-file append order, and the
 * recorder's fold order becomes the sequence order).
 */
export declare function selectRunLlmTurns(turns: readonly TraceTurnDraft[], window: RunTurnWindow, opts?: SelectRunLlmTurnsOptions): TraceTurnDraft[];
/**
 * Read the proxy trace day-files in `dir` and return this run's llm_turns (see the correlation contract
 * above), ready to fold via recordLlmTurn. Reuses readTraceRowsFromJsonl (decryption + row parsing) and
 * traceRecordToTurnDraft (normalization). Never throws: any failure — no proxy, missing dir, unreadable
 * file, undecryptable rows — degrades to [].
 */
export declare function collectRunLlmTurns(dir: string, window: RunTurnWindow, opts?: CollectRunLlmTurnsOptions): TraceTurnDraft[];