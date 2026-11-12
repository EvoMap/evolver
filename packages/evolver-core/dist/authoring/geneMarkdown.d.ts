import { type AuthoringLocale } from './locale.js';
export declare const DEFAULT_FORBIDDEN_PATHS: readonly string[];
export declare const USE_WHEN = "Use when: ";
export declare const DO_NOT_USE_WHEN = "Do not use when: ";
export type Section = 'use' | 'notUse' | 'preconditions' | 'steps' | 'validation' | 'success';
export declare const HEADINGS: Record<Section, Record<AuthoringLocale, string>>;
export interface AuthoringIssue {
    path: string;
    code: string;
    message: string;
}
export interface ParsedGeneMarkdown {
    gene: Record<string, unknown>;
    title: string;
    supersedes?: string;
    issues: AuthoringIssue[];
}
/** A GENE.md document read into the Gene fields it can carry; parse problems are reported, never fatal. */
export declare function parseGeneMarkdown(text: string, locale: AuthoringLocale): ParsedGeneMarkdown;
export declare function yamlScalar(value: unknown): string;
/** The canonical GENE.md rendering of a Gene: every field the grammar carries, in the requested locale. */
export declare function renderGeneMarkdown(gene: Record<string, unknown>, locale: AuthoringLocale): string;