import { type personality as PersonalityNamespace } from '@evomap/evolver-core';
export declare const PERSONALITY_DIAGNOSTICS_MAX_STATS = 40;
export declare const PERSONALITY_DIAGNOSTICS_MAX_HISTORY = 60;
export type PersonalityAxisValues = Pick<PersonalityNamespace.PersonalityState, 'rigor' | 'creativity' | 'verbosity' | 'risk_tolerance' | 'obedience'>;
export interface PersonalityDiagnosticStat {
    key: string;
    success: number;
    fail: number;
    avgScore: number;
    n: number;
    updatedAt: string | null;
}
export interface PersonalityDiagnosticHistoryEntry {
    at: string;
    key: string;
    outcome: string;
    score: number | null;
}
export interface PersonalityDiagnosticData {
    current: PersonalityAxisValues;
    updatedAt: string | null;
    stats: PersonalityDiagnosticStat[];
    history: PersonalityDiagnosticHistoryEntry[];
    truncated: {
        stats: boolean;
        history: boolean;
    };
}
export type PersonalityDiagnosticsResult = {
    available: true;
    data: PersonalityDiagnosticData;
} | {
    available: false;
    error: 'personality_unavailable';
};
export type PersonalityDiagnosticsReader = () => unknown | Promise<unknown>;
export interface PersonalityDiagnosticsOptions {
    maxStats?: number;
    maxHistory?: number;
}
export declare function readPersonalityDiagnostics(reader: PersonalityDiagnosticsReader | undefined, options?: PersonalityDiagnosticsOptions): Promise<PersonalityDiagnosticsResult>;