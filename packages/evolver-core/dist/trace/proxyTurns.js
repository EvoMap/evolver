// Proxy llm_turn → run fold (Learning Ops slice 5): collect the per-request llm_turn records the LLM proxy
// captured DURING one agent run's wall-clock window, normalized as TraceTurnDrafts ready for
// AgentRunTraceRecorder.recordLlmTurn. This is what upgrades a run's trajectory from the bridge's single
// coarse model.called (the headless runner is a black box) to real per-request fidelity
// (provider/model/usage/latency/stop_reason + tool-call detail).
//
// Correlation contract (why time window + session-first-turn, not session_id alone): the headless runner does
// not report its session id back to the bridge (`claude -p --output-format text` is opaque), and llm_turn rows
// carry no cwd — so the run has no exact key to look up. What the run DOES own is its wall-clock window on the
// same host the proxy writes from (one shared clock, no skew). A turn belongs to the run iff:
//   1. its ts falls inside [startMs, endMs], AND
//   2. its session's FIRST observed turn also falls inside the window — a session spawned by this run cannot
//      have traffic predating the run, while a concurrent interactive session (started earlier) is excluded by
//      its pre-window history. Sessionless turns (session_id null) fall back to the window test alone.
// Callers that DO know the spawned agent's session id (e.g. a future runner passing --session-id) can pass
// `sessionId` for exact-match correlation instead of the heuristic.
//
// Residual risk, accepted + documented: an interactive session whose very first request starts inside the run
// window is indistinguishable from the run's own agent. On an unattended daemon host this is rare, and the
// fold is observability-only — it can bias a trace, never a verdict.
//
// Everything degrades silently to [] (missing dir, unreadable file, undecryptable envelope, bad ts): the
// learning trace must never fail or slow a task.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTraceRowsFromJsonl } from './trajectoryExport.js';
import { traceRecordToTurnDraft } from './trajectory.js';
/** Any proxy day-file (`llm-trace-*.jsonl`). */
const TRACE_FILE_RE = /^llm-trace-.*\.jsonl$/i;
/** The canonical day-stamped name the proxy's JsonlTraceSink writes (`llm-trace-YYYYMMDD.jsonl`, UTC). */
const DAY_STAMPED_FILE_RE = /^llm-trace-(\d{8})\.jsonl$/i;
function utcDayStamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
/**
 * Keep day-stamped files that could contain the window's turns. One extra preceding day is included so the
 * session-first-turn heuristic can see the pre-window history of a session that started before midnight.
 * Non-day-stamped `llm-trace-*.jsonl` names (custom sinks/tests) are kept conservatively — the ts window
 * filter below is the authority; the filename filter only trims read volume.
 */
function fileCoversWindow(name, window) {
    const match = DAY_STAMPED_FILE_RE.exec(name);
    if (!match)
        return true;
    const stamp = match[1];
    return stamp >= utcDayStamp(window.startMs - 24 * 60 * 60 * 1000) && stamp <= utcDayStamp(window.endMs);
}
function turnTsMs(turn) {
    if (turn.ts === null)
        return null;
    const ms = Date.parse(turn.ts);
    return Number.isFinite(ms) ? ms : null;
}
/**
 * Pure selector (unit-testable without fs): pick the turns that belong to the run per the correlation
 * contract above, sorted by ts ascending (stable — equal timestamps keep day-file append order, and the
 * recorder's fold order becomes the sequence order).
 */
export function selectRunLlmTurns(turns, window, opts = {}) {
    const stamped = turns
        .map((turn) => ({ turn, tsMs: turnTsMs(turn) }))
        .filter((entry) => entry.tsMs !== null);
    let selected;
    if (opts.sessionId !== undefined) {
        selected = stamped.filter(({ turn }) => turn.session_id === opts.sessionId);
    }
    else {
        // First observed turn per session across ALL provided turns (including pre-window rows from the same
        // day files) — this is what tells an in-run spawned session apart from an older concurrent one.
        const firstTsBySession = new Map();
        for (const { turn, tsMs } of stamped) {
            if (turn.session_id === null)
                continue;
            const prev = firstTsBySession.get(turn.session_id);
            if (prev === undefined || tsMs < prev)
                firstTsBySession.set(turn.session_id, tsMs);
        }
        selected = stamped.filter(({ turn, tsMs }) => {
            if (tsMs < window.startMs || tsMs > window.endMs)
                return false;
            if (turn.session_id === null)
                return true;
            const firstTs = firstTsBySession.get(turn.session_id);
            return firstTs !== undefined && firstTs >= window.startMs;
        });
    }
    return selected
        .map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => a.tsMs - b.tsMs || a.index - b.index)
        .map(({ turn }) => turn);
}
/**
 * Read the proxy trace day-files in `dir` and return this run's llm_turns (see the correlation contract
 * above), ready to fold via recordLlmTurn. Reuses readTraceRowsFromJsonl (decryption + row parsing) and
 * traceRecordToTurnDraft (normalization). Never throws: any failure — no proxy, missing dir, unreadable
 * file, undecryptable rows — degrades to [].
 */
export function collectRunLlmTurns(dir, window, opts = {}) {
    try {
        if (!(window.endMs >= window.startMs))
            return [];
        const names = readdirSync(dir)
            .filter((name) => TRACE_FILE_RE.test(name) && fileCoversWindow(name, window))
            .sort();
        const turns = [];
        for (const name of names) {
            let text;
            try {
                text = readFileSync(join(dir, name), 'utf8');
            }
            catch {
                continue;
            }
            // allowPartial forced on: an undecryptable envelope is a coverage gap, never a fold failure.
            const { rows } = readTraceRowsFromJsonl(text, { ...(opts.readOptions ?? {}), allowPartial: true });
            for (const row of rows) {
                const turn = traceRecordToTurnDraft(row);
                if (turn !== null)
                    turns.push(turn);
            }
        }
        return selectRunLlmTurns(turns, window, opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {});
    }
    catch {
        return [];
    }
}