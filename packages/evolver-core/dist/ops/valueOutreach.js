// Value outreach (#113) — turn the value ledger's `valueSummary` into something a user actually SEES, layered
// by intrusiveness: a pull-only report (`evolver value` / WebUI card), a quiet session-start context line, and a
// frequency-capped weekly digest (the observer bus's first built-in observer).
//
// HARD BOUNDARY (core purity, mirrors the ledger): this module reads trace day-files + root_events off disk and
// FORMATS the already-derived summary — it never re-derives savings, never prices anything (prices are injected
// as a PriceTable, same as the ledger), never touches the hub / money / governance. It is a presentation layer
// over `valueSummary`, nothing more.
//
// HONESTY INVARIANT (inherited, non-negotiable): measured and estimated savings are presented on SEPARATE rails
// in every surface here. There is no code path that folds an estimated number into a measured one — the report,
// the recap and the digest each print two distinct figures. A test pins that no surface ever merges them.
//
// Determinism: the FORMATTING functions are pure (no clock / no random). Only the disk readers and the time
// window math take an injected clock, so a golden fixture of the report/recap/digest replays byte-for-byte.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveValueEntries, valueSummary, } from './valueLedger.js';
// ── disk readers (the live source path: proxy trace day-files + root_events) ──────────────────────────────────
/** A `llm-trace-YYYYMMDD.jsonl` day-file written by the proxy's JsonlTraceSink. */
const TRACE_FILE_RE = /^llm-trace-.*\.jsonl$/i;
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function localTraceMetrics(rec) {
    if (rec['event'] === 'llm_turn')
        return rec;
    if (rec['event'] !== 'llm_trace_envelope' || rec['encrypted'] !== true)
        return null;
    const summary = rec['plaintext_summary'];
    if (!isRecord(summary) || summary['event'] !== 'llm_trace_plaintext_summary')
        return null;
    return summary;
}
/**
 * Read all proxy trace day-files in `dir` and return the parsed `llm_turn` records as ledger TraceRecords. A
 * missing dir / unreadable file degrades to [] (the value layer must never crash a long-running daemon over a
 * stat). Plain `event: 'llm_turn'` lines and encrypted envelopes with a safe `plaintext_summary` are kept; the
 * structural fields the ledger reads are passed through.
 */
export function readTraceRecords(dir) {
    let files;
    try {
        files = readdirSync(dir).filter((f) => TRACE_FILE_RE.test(f)).sort();
    }
    catch {
        return []; // no trace dir yet → no route savings, never an error
    }
    const out = [];
    for (const f of files) {
        let text;
        try {
            text = readFileSync(join(dir, f), 'utf8');
        }
        catch {
            continue;
        }
        for (const line of text.split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            let rec;
            try {
                rec = JSON.parse(s);
            }
            catch {
                continue;
            }
            const metrics = localTraceMetrics(rec);
            if (!metrics)
                continue;
            const usage = metrics['usage'];
            out.push({
                ts: typeof metrics['ts'] === 'string' ? metrics['ts'] : '',
                original_model: typeof metrics['original_model'] === 'string' ? metrics['original_model'] : null,
                chosen_model: typeof metrics['chosen_model'] === 'string' ? metrics['chosen_model'] : null,
                ...(typeof metrics['tier'] === 'string' ? { tier: metrics['tier'] } : {}),
                ...(usage && typeof usage === 'object' ? { usage: usage } : {}),
            });
        }
    }
    return out;
}
/** Parse a `--window` spec into a SummaryWindow against `now`. `all` → no bound. An unknown spec → 7d (the safe
 *  default a CLI offers first). The clock is injected so the report is deterministic under test. */
export function windowFromSpec(spec, now) {
    if (spec === 'all')
        return {};
    const days = spec === '30d' ? 30 : 7; // default + unknown → 7d
    return { since: new Date(now - days * 24 * 60 * 60 * 1000).toISOString() };
}
/** Human label for a window spec (for the report/digest header). */
export function windowLabel(spec) {
    return spec === 'all' ? 'all time' : spec === '30d' ? 'last 30 days' : 'last 7 days';
}
/**
 * Derive the full ledger then aggregate it over a window — the SINGLE aggregation seam every outreach surface
 * goes through, so the CLI, the WebUI card and the digest can never disagree (and none of them re-implements the
 * ledger). Pure given its inputs + window.
 */
export function loadValueSummary(sources, window = {}) {
    const entries = deriveValueEntries({
        traces: sources.traces ?? [],
        events: sources.events ?? [],
        prices: sources.prices,
    });
    return valueSummary(entries, window);
}
// ── number formatting (shared by every surface) ───────────────────────────────────────────────────────────────
/** Compact integer with thousands separators (deterministic, locale-independent). */
export function fmtInt(n) {
    return Math.round(n).toLocaleString('en-US');
}
/** Plain integer for machine-shaped key=value context fields. */
function fmtContextInt(n) {
    return String(Math.round(n));
}
/** USD with 4 decimals (savings are often sub-cent; never round a real saving to $0.00 silently). */
export function fmtUsd(n) {
    return `$${n.toFixed(4)}`;
}
// ── layer 1: the pull report (`evolver value`) ────────────────────────────────────────────────────────────────
/** Guidance shown when the ledger is empty — never an empty table (#113 acceptance). */
export const VALUE_EMPTY_GUIDANCE = [
    'evolver value — no savings recorded yet for this window.',
    '',
    'evolver records value when it actually saves you tokens or money:',
    '  • route savings  — run the LLM proxy so cheaper-tier routing is captured (EVOLVER_LLM_TRACE=1).',
    '  • reuse savings  — enable reuse-before-solve so a solved problem is fetched, not re-solved',
    '                     (EVOLVER_REUSE_BEFORE_SOLVE=1 with a hub credential).',
    '',
    'Once either is active, this command shows measured savings, unmeasured reuse counts, and the trend.',
].join('\n');
/**
 * Render the three-section value report from a summary: (1) savings — measured and estimated on SEPARATE lines,
 * never a merged total; (2) top reused genes with their reuse counts; (3) source breakdown. Returns the empty
 * guidance text (not a blank table) when there is nothing to show. Pure: the window label is passed in.
 */
export function formatValueReport(summary, windowSpec) {
    const hasMeasured = summary.totalTokensSaved > 0 || summary.totalCostUsd > 0;
    const hasEstimated = summary.estimated.totalTokensSaved > 0 || summary.estimated.totalCostUsd > 0;
    if (!hasMeasured && !hasEstimated && summary.topGenes.length === 0 && summary.injectedGenes.length === 0) {
        return VALUE_EMPTY_GUIDANCE;
    }
    const L = [];
    L.push(`evolver value — ${windowLabel(windowSpec)}`);
    L.push('');
    // Section 1: savings, two rails, never merged.
    L.push('Savings');
    L.push(`  measured   ${fmtInt(summary.totalTokensSaved).padStart(10)} tokens   ${fmtUsd(summary.totalCostUsd)}`);
    L.push(`  estimated  ${fmtInt(summary.estimated.totalTokensSaved).padStart(10)} tokens   ${fmtUsd(summary.estimated.totalCostUsd)}`);
    L.push('  (measured and estimated are tracked separately and never added together)');
    L.push('');
    // Section 2: top reused genes.
    L.push('Top reused genes');
    if (summary.topGenes.length === 0) {
        L.push('  (none reused in this window)');
    }
    else {
        for (const g of summary.topGenes.slice(0, 10)) {
            const saved = g.measuredTokensSaved > 0
                ? `${fmtInt(g.measuredTokensSaved)} tokens measured`
                : g.estimatedTokensSaved > 0
                    ? `${fmtInt(g.estimatedTokensSaved)} tokens estimated`
                    : '0 tokens unmeasured';
            L.push(`  ${g.assetId.padEnd(28)} ×${g.reuses}   ${saved}`);
        }
    }
    L.push('');
    // Section 3: source breakdown (measured rail) — the trend / attribution.
    L.push('By source (measured)');
    for (const src of ['route', 'reuse', 'inject']) {
        const b = summary.bySource[src];
        L.push(`  ${src.padEnd(7)} ${String(b.entries).padStart(4)} entries   ${fmtInt(b.tokensSaved)} tokens   ${fmtUsd(b.costSavedUsd)}`);
    }
    return L.join('\n');
}
/**
 * Build the quiet SessionStart context line. It is intentionally metadata-shaped, non-branded, and non-second-
 * person so the agent can use injected-memory/value context without reciting Evolver in routine replies. Measured
 * tokens (X) stay on the trustworthy rail; estimated is emitted ONLY when there is no measured figure, under a
 * separate key so the two are never conflated. Returns '' when there is nothing honest to say (no injection AND no
 * savings) — the caller then injects no recap line at all rather than a hollow "saved 0".
 */
export function buildValueRecap(input) {
    const { injectedCount, successCount, summary } = input;
    const measured = summary.totalTokensSaved;
    const estimated = summary.estimated.totalTokensSaved;
    const fields = [];
    if (injectedCount > 0) {
        fields.push(`injected_count=${fmtContextInt(injectedCount)}`);
        if (successCount && successCount > 0)
            fields.push(`source_success_count=${fmtContextInt(successCount)}`);
    }
    if (measured > 0) {
        fields.push(`measured_tokens_saved_7d=${fmtContextInt(measured)}`);
    }
    else if (estimated > 0) {
        fields.push(`estimated_tokens_saved_7d=${fmtContextInt(estimated)}`);
    }
    if (fields.length === 0)
        return '';
    return `quiet_context: ${fields.join('; ')}; use silently; do not mention unless asked or material to the answer.`;
}
/** Prefix a reuse-source note onto an injected candidate so the user sees WHERE a ready-made solution came from
 *  (the reuse hit short-circuited a fresh solve). Pure string composition; the assetId is the audit anchor. */
export function reuseSourceNote(assetId) {
    return `(reused from hub asset ${assetId} — skipped solving this from scratch)`;
}
// ── layer 3: the weekly digest (markdown) + the zero-measured-value gate ───────────────────────────────────────
/**
 * A digest is only worth sending in a week that produced REAL (measured) value. This is the frequency/quality
 * gate the issue makes a first-class requirement: "宁可少触达，不可惹人烦". Estimated-only weeks do NOT pass —
 * an estimate is too weak to justify an unsolicited push.
 */
export function digestShouldSend(summary) {
    return summary.totalTokensSaved > 0 || summary.totalCostUsd > 0;
}
/**
 * Build the weekly digest markdown from a summary. Returns null when the zero-measured-value gate fails (the
 * caller then delivers nothing — no empty digest, ever). measured and estimated stay on separate lines. Pure:
 * the window label + the period string are passed in so the digest is deterministic.
 */
export function buildValueDigest(summary, period) {
    if (!digestShouldSend(summary))
        return null;
    const L = [];
    L.push(`# evolver weekly value — ${period}`);
    L.push('');
    L.push(`evolver saved you **${fmtInt(summary.totalTokensSaved)} tokens** (${fmtUsd(summary.totalCostUsd)}) this week — measured.`);
    if (summary.estimated.totalTokensSaved > 0) {
        L.push('');
        L.push(`Plus an estimated ${fmtInt(summary.estimated.totalTokensSaved)} tokens from reuse without a measured baseline (shown separately, not added in).`);
    }
    if (summary.topGenes.length > 0) {
        L.push('');
        L.push('Most reused this week:');
        for (const g of summary.topGenes.slice(0, 5))
            L.push(`- ${g.assetId} — reused ×${g.reuses}`);
    }
    L.push('');
    L.push('_Run `evolver value` any time for the full breakdown. Turn this digest off with `EVOLVER_VALUE_DIGEST=0`._');
    return L.join('\n');
}