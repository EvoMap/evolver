import { type Gene, type GenerationSource } from '../wire/index.js';
/**
 * True when a gene id is in the `gene_distilled_` namespace. NB this prefix is now a NAMESPACE marker, NOT a
 * provenance tag: v1 used it to mean "skill-derived" (auto-evolved genes were `gene_auto_`), but v2's intakeGene
 * tags EVERY intaken gene this way regardless of origin. The authoritative provenance is {@link geneGenerationSource};
 * this prefix check remains as a back-compat fallback for legacy pooled genes that predate generation_meta, and for
 * call sites that only have a gene id (not the full record).
 */
export declare function isDistilledGeneId(id: string | undefined | null): boolean;
/**
 * The authoritative gene-generation source: read `generation_meta.source` from a gene-shaped record (V1 #302). Falls
 * back to the id-prefix namespace when the record carries no generation_meta (legacy pooled genes predate the field),
 * returning 'distilled' for a `gene_distilled_` id and 'manual' otherwise — so the fallback never claims a higher
 * provenance tier than the prefix can vouch for. `null` means "undetermined" (no record, no recognizable id).
 */
export declare function geneGenerationSource(gene: Record<string, unknown> | null | undefined, geneId?: string | null): GenerationSource | null;
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
    generation_meta?: unknown;
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