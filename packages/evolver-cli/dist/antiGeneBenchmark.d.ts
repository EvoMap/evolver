import { assetstore, events } from '@evomap/evolver-core';
export interface AntiGeneBenchmarkCommandDeps {
    store?: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    readEvents?: (eventsPath?: string) => events.ReportEvent[];
    now?: () => number;
    log?: (line: string) => void;
}
export declare function runAntiGeneBenchmarkCommand(argv: readonly string[], deps?: AntiGeneBenchmarkCommandDeps): Promise<number>;