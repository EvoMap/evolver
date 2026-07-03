import { assetstore, benchmark, events } from '@evomap/evolver-core';
export interface AntiGeneRolloutCommandDeps {
    store?: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    readEvents?: (eventsPath?: string) => events.ReportEvent[];
    makeExecute?: benchmark.AntiGeneRolloutExecuteFactory;
    now?: () => number;
    log?: (line: string) => void;
}
export declare function parseAntiGeneRolloutValidationCommand(commandLine: string): {
    cmd: string;
    args: string[];
} | null;
export declare function runAntiGeneRolloutCommand(argv: readonly string[], deps?: AntiGeneRolloutCommandDeps): Promise<number>;