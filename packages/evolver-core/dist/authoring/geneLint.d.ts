import { type AuthoringLocale } from './locale.js';
export declare const GENE_LINT_RULES_VERSION = "gene-lint.v1";
export type LintLevel = 'block' | 'warn' | 'info';
export interface LintFinding {
    rule: string;
    level: LintLevel;
    field: string;
    message: string;
    fix: string;
}
export interface GeneLintResult {
    rulesVersion: typeof GENE_LINT_RULES_VERSION;
    findings: LintFinding[];
    blocking: number;
    warnings: number;
    gate: {
        score: number;
        threshold: number;
    };
    publishable: boolean;
    replayable: boolean;
}
type Gene = Record<string, unknown>;
/** Quality findings for a hand-written Gene: the deep schema plus the rules the distiller and publish path apply. */
export declare function lintGene(gene: Gene, locale: AuthoringLocale, env: Record<string, string | undefined>): GeneLintResult;
export {};