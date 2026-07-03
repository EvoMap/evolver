export interface GeneValueStat {
    geneId: string;
    cycles: number;
    passed: number;
    failed: number;
    /** passed / cycles, 0 when no cycles. */
    passRate: number;
}
export interface GeneValueReport {
    /** Per-gene stats (excludes the ad-hoc baseline), sorted by cycles desc then passRate desc. */
    stats: GeneValueStat[];
    /** The ad-hoc (innovate / no-gene) cycles as a baseline row, or null if none observed. */
    baseline: GeneValueStat | null;
    /** Total terminal cycles counted (genes + baseline). */
    totalCycles: number;
}
type TerminalEvent = {
    type: string;
    payload?: unknown;
};
/**
 * Aggregate observed per-gene cycle outcomes from a terminal-cycle event stream (pure). A cycle.solidified is a
 * pass, a cycle.failed is a fail; both carry `payload.gene`. Events without a string gene tag (pre-epigenetic) are
 * skipped. The 'ad-hoc' gene is split out as the no-gene baseline.
 */
export declare function summarizeGeneValue(evts: readonly TerminalEvent[]): GeneValueReport;
export interface GeneValueDeps {
    eventsPath?: string;
    /** Injected event reader for tests; defaults to the real ledger. */
    read?: (path: string) => TerminalEvent[];
}
/**
 * `evolver gene-value [--gene <id>] [--json]` — print the observational per-gene pass rate from the cycle ledger.
 * Reports, never measures a controlled A/B; the verdict-bearing with-vs-without harness is a separate slice.
 */
export declare function runGeneValue(argv: readonly string[], deps?: GeneValueDeps): number;
export {};