import { bootstrap } from '@evomap/evolver-core';
export interface MigrateEnvOptions {
    /** Path to a dotenv file to scan. When omitted, scans process env only. */
    file?: string;
    /** Also scan process.env (default true when file set). File values win, matching the runtime loader. */
    includeProcessEnv?: boolean;
    json?: boolean;
    /** Optional path to write a suggested dotenv fragment (non-secret mapped keys only). */
    writeSuggestions?: string;
}
export interface MigrateEnvResult {
    report: bootstrap.V1EnvTranslationReport;
    scannedKeys: string[];
    source: 'process' | 'file' | 'file+process';
}
export declare function runMigrateEnvScan(opts: MigrateEnvOptions, processEnv?: Record<string, string | undefined>): MigrateEnvResult;
/** Build a dotenv fragment for mappable keys only (never writes secret values for keep/GITHUB). */
export declare function formatMappedDotenvFragment(report: bootstrap.V1EnvTranslationReport): string;
export declare function parseMigrateEnvArgs(argv: readonly string[]): MigrateEnvOptions | {
    error: string;
};
export declare function runMigrateEnvCommand(argv: readonly string[], io?: {
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    env?: Record<string, string | undefined>;
}): Promise<number>;