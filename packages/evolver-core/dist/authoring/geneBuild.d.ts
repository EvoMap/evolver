import { type AuthoringIssue } from './geneMarkdown.js';
import { type AuthoringLocale } from './locale.js';
export type GeneSourceFormat = 'markdown' | 'json';
export interface GeneBuildRequest {
    format: GeneSourceFormat;
    source: string;
    supersedes?: string;
    locale: AuthoringLocale;
}
export interface GeneBuildResult {
    valid: boolean;
    gene: Record<string, unknown> | null;
    markdown: string;
    errors: AuthoringIssue[];
}
/** Every Draft-07 violation of the gep-sdk Gene schema, located by JSON pointer, after local-only hints are stripped. */
export declare function geneSchemaErrors(gene: Record<string, unknown>, locale: AuthoringLocale): AuthoringIssue[];
/** `generation_meta` never reaches the wire schema (it is stripped as a local hint), so build and lint both check it here. */
export declare function generationMetaErrors(meta: unknown, locale: AuthoringLocale): AuthoringIssue[];
/** GENE.md or Gene JSON in, a complete Gene out: full schema validation, every violation listed, the Gene kept when invalid. */
export declare function buildGene(request: GeneBuildRequest): GeneBuildResult;