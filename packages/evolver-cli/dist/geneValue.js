// `evolver gene-value` (thesis slice 1) — OBSERVATIONAL per-gene pass rate, read from the real cycle ledger.
// Each terminal cycle (cycle.solidified / cycle.failed) carries the gene that ran; we aggregate pass/fail per
// gene. This is NOT a controlled A/B (that needs a live execute + external verifier — a later slice): it reports
// what actually happened in production, with the innovate ('ad-hoc') cycles surfaced separately as the no-gene
// baseline so a gene's pass rate can be read against "no gene at all".
import { events } from '@evomap/evolver-core';
import { readEvents } from './commands.js';
/** The innovate / no-gene cycles: a cycle that selected no existing gene records gene='ad-hoc'. */
const AD_HOC = 'ad-hoc';
const toStat = (geneId, a) => {
    const cycles = a.passed + a.failed;
    return { geneId, cycles, passed: a.passed, failed: a.failed, passRate: cycles ? a.passed / cycles : 0 };
};
/**
 * Aggregate observed per-gene cycle outcomes from a terminal-cycle event stream (pure). A cycle.solidified is a
 * pass, a cycle.failed is a fail; both carry `payload.gene`. Events without a string gene tag (pre-epigenetic) are
 * skipped. The 'ad-hoc' gene is split out as the no-gene baseline.
 */
export function summarizeGeneValue(evts) {
    const agg = new Map();
    for (const e of evts) {
        if (e.type !== 'cycle.solidified' && e.type !== 'cycle.failed')
            continue;
        const gene = e.payload?.gene;
        if (typeof gene !== 'string' || !gene)
            continue; // untagged terminal event → cannot credit a gene
        const a = agg.get(gene) ?? { passed: 0, failed: 0 };
        if (e.type === 'cycle.solidified')
            a.passed += 1;
        else
            a.failed += 1;
        agg.set(gene, a);
    }
    const baselineAgg = agg.get(AD_HOC);
    const stats = [...agg.entries()]
        .filter(([g]) => g !== AD_HOC)
        .map(([g, a]) => toStat(g, a))
        .sort((x, y) => y.cycles - x.cycles || y.passRate - x.passRate);
    const totalCycles = [...agg.values()].reduce((n, a) => n + a.passed + a.failed, 0);
    return { stats, baseline: baselineAgg ? toStat(AD_HOC, baselineAgg) : null, totalCycles };
}
const pct = (r) => `${(r * 100).toFixed(0)}%`;
/**
 * `evolver gene-value [--gene <id>] [--json]` — print the observational per-gene pass rate from the cycle ledger.
 * Reports, never measures a controlled A/B; the verdict-bearing with-vs-without harness is a separate slice.
 */
export function runGeneValue(argv, deps = {}) {
    let geneFilter;
    let asJson = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json')
            asJson = true;
        else if (a === '--gene') {
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                geneFilter = next;
                i += 1;
            }
        }
    }
    const path = deps.eventsPath ?? events.rootEventsPath();
    const evts = deps.read ? deps.read(path) : readEvents(path);
    const report = summarizeGeneValue(evts);
    // `ad-hoc` lives in report.baseline, not report.stats — so `--gene ad-hoc` must target the baseline, else the
    // filter can never reach the innovate row (Bugbot #147).
    const rows = !geneFilter
        ? report.stats
        : geneFilter === AD_HOC
            ? (report.baseline ? [report.baseline] : [])
            : report.stats.filter((s) => s.geneId === geneFilter);
    if (asJson) {
        process.stdout.write(JSON.stringify(geneFilter ? { stats: rows } : report) + '\n');
        return 0;
    }
    if (rows.length === 0) {
        if (geneFilter)
            process.stdout.write(`gene-value: no observed cycles for gene ${geneFilter}\n`);
        // No gene rows but a baseline exists means only innovate (no-gene) cycles ran — say that, don't claim there are
        // no cycles to run yet (Bugbot #147).
        else if (report.baseline)
            process.stdout.write(`gene-value: only innovate (ad-hoc / no-gene) cycles observed so far — no gene has run yet\n  baseline (ad-hoc / no gene)  cycles=${report.baseline.cycles} pass=${report.baseline.passed} fail=${report.baseline.failed} passRate=${pct(report.baseline.passRate)}\n`);
        else
            process.stdout.write('gene-value: no terminal cycles in the ledger yet (run some cycles first)\n');
        return 0;
    }
    process.stdout.write('gene-value (observational, from the cycle ledger — NOT a controlled A/B):\n');
    for (const s of rows) {
        process.stdout.write(`  ${s.geneId}  cycles=${s.cycles} pass=${s.passed} fail=${s.failed} passRate=${pct(s.passRate)}\n`);
    }
    // Trailing baseline block only in the unfiltered view (when filtering, the chosen rows already are the answer;
    // a `--gene ad-hoc` filter already shows the baseline as its row).
    if (!geneFilter && report.baseline) {
        process.stdout.write(`  --\n  baseline (ad-hoc / no gene)  cycles=${report.baseline.cycles} pass=${report.baseline.passed} fail=${report.baseline.failed} passRate=${pct(report.baseline.passRate)}\n`);
    }
    return 0;
}