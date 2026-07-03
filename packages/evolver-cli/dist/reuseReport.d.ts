import { events, assetstore, algo } from '@evomap/evolver-core';
export interface ReuseReportDeps {
    /** Test seam: read root_events. Default reads the real root_events log. */
    readEvents?: (eventsPath?: string) => events.ReportEvent[];
    /** Store to resolve reuse-event ids and to list AntiGene assets for the #326 report. */
    store?: Pick<assetstore.AssetStoreProvider, 'get' | 'list'>;
    /** Review ledger to quarantine into or read from. Structural so fakes are trivial. */
    review?: {
        quarantine(assetId: string, reason?: string): unknown;
        get?(assetId: string): assetstore.ReviewRecord | null;
        records?(): assetstore.ReviewRecord[];
    };
    /** Test seam for `--promote`: returns the probation status list. Default scans the real store + review ledger
     *  via algo.scanProbationGenes (the SAME predicate the daemon's auto-promote acts on). */
    scanProbation?: () => Promise<algo.ProbationStatus[]>;
    log?: (line: string) => void;
}
export declare function runReuseReport(argv: readonly string[], deps?: ReuseReportDeps): Promise<number>;
/** Registry-shaped handler (argv -> exit code). */
export declare const runReuseReportCommand: (argv: string[]) => Promise<number>;