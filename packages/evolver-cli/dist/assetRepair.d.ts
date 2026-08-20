import { assetstore } from '@evomap/evolver-core';
import { type CliContractDeps } from './cliContracts.js';
export interface AssetRepairDeps extends CliContractDeps {
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    store?: assetstore.AssetStoreProvider;
    readRejection?: (path: string) => string;
}
interface ParsedArgs {
    refs: string[];
    rejectionPath?: string;
    apply: boolean;
    jsonOut: boolean;
}
export declare function runAssetRepairCommand(argv: readonly string[], deps?: AssetRepairDeps): Promise<number>;
export declare function parseAssetRepairArgs(argv: readonly string[]): {
    ok: true;
    value: ParsedArgs;
} | {
    ok: false;
    error: string;
    value?: ParsedArgs;
};
export {};