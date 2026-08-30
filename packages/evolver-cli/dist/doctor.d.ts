import { type MemoryGraphOperatorStatus } from './localMemoryGraph.js';
type DoctorStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck {
    name: string;
    status: DoctorStatus;
    detail: string;
}
type DoctorProfile = 'general' | 'private-runtime';
type EnvCatalogState = 'set' | 'empty' | 'unset';
export interface EnvCatalogEntry {
    name: string;
    group: string;
    purpose: string;
    requiredFor?: string;
    defaultValue?: string;
    aliases?: string[];
    secret: boolean;
    state: EnvCatalogState;
    sources: string[];
    setKeys: string[];
}
type EnvFileReadiness = {
    status: 'missing_pointer';
} | {
    status: 'readable';
} | {
    status: 'unusable';
    detail: string;
};
/** Mask token-like runs (>=16 chars of base64/hex/url-safe) so doctor output can never leak a secret value. */
export declare function redact(s: string): string;
export interface DoctorDeps {
    env?: Record<string, string | undefined>;
    configRoot?: string;
    readFile?: (p: string) => string;
    exists?: (p: string) => boolean;
    statMode?: (p: string) => number | undefined;
    profile?: DoctorProfile;
    label?: string;
    memoryGraphStatus?: (env: Record<string, string | undefined>) => MemoryGraphOperatorStatus;
    /** Runtime platform override (tests). Defaults to process.platform. */
    platform?: NodeJS.Platform;
    /** Test seam for the read-only legacy v1 Windows scheduled-task probe (#956). */
    legacyWindowsTasks?: (options: {
        env: NodeJS.ProcessEnv;
        platform?: NodeJS.Platform;
    }) => {
        conclusive: boolean;
        legacy: string[];
        detail: string;
    };
}
export interface EnvCatalogResult {
    profile: DoctorProfile;
    envFile: EnvFileReadiness;
    entries: EnvCatalogEntry[];
}
/**
 * Run the read-only doctor checks. Pure given its (injectable) deps — no config mutation, no env-file load into the
 * process. Returns the check list; the CLI formats + sets the exit code.
 */
export declare function runDoctorChecks(deps?: DoctorDeps): DoctorCheck[];
export declare function buildEnvCatalog(deps?: DoctorDeps): EnvCatalogResult;
export declare function runDoctor(argv: readonly string[], deps?: DoctorDeps): Promise<number>;
/** Registry-shaped handler (argv -> exit code). */
export declare const runDoctorCommand: (argv: string[]) => Promise<number>;
export {};