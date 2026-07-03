import { type Gene } from '../wire/index.js';
/**
 * True when a gene id is a distilled (skill-derived) gene. Single source of truth for the prefix check — also
 * consumed by candidate assembly / selection to recognise the broadly-applicable distilled genes that may be
 * reused as a last-resort fallback when no gene matches the live signals (ported from v1 #97).
 */
export declare function isDistilledGeneId(id: string | undefined | null): boolean;
export interface GeneCandidate {
    id?: string;
    category?: string;
    signals_match?: readonly string[];
    strategy?: readonly string[];
    summary?: string;
    preconditions?: readonly string[];
    constraints?: {
        max_files?: number;
        forbidden_paths?: readonly string[];
    };
    validation?: readonly string[];
    routing_hint?: unknown;
    tool_policy?: unknown;
}
/** Minimal shape of an existing gene needed for dedup. */
export interface ExistingGeneRef {
    id?: string;
    signals_match?: readonly string[];
}
export interface GeneIntakeResult {
    ok: boolean;
    gene?: Gene;
    errors: string[];
}
/**
 * Validate + normalize a distilled/proposed gene for pool insertion. On success returns the canonical Gene
 * (defaults filled, asset_id computed); otherwise the structural / dedup / schema errors.
 */
export declare function intakeGene(candidate: GeneCandidate, existing?: readonly ExistingGeneRef[]): GeneIntakeResult;