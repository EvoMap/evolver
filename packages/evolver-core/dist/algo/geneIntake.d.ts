import { type EnvClass, type Gene, type GeneClaim, type GeneRuntimeProfile, type GeneScope, type GeneVerifierProfile, type GenerationSource } from '../wire/index.js';
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
    /**
     * Runtime profile: which LLM produced this gene. This is the \(K_{auto}\) runtime coordinate, and it was the
     * binding constraint on automatic-governance eligibility in production (32.9% populated vs 99%+ for the
     * retrieval coordinates, bench/thesis/result-kauto-coverage.json) — because intake never populated it, so it
     * only appeared when some other writer happened to set it. Intake now fills it from the SAME producer the
     * environment fingerprint already uses (detectModelName), which resolves an explicit EVOLVER_MODEL_NAME or a
     * host CLI's model env var. Callers may pass it explicitly to override detection.
     *
     * The literal 'unknown' is what detectModelName returns when nothing is discoverable, and it is deliberately
     * NOT written: an undetectable runtime is not a machine-decidable coordinate, and recording 'unknown' would
     * inflate K_auto coverage with rows that cannot actually be governed by runtime. Absent therefore keeps its
     * existing meaning (not recorded), and a present value always names a real runtime.
     */
    model_name?: string;
    routing_hint?: unknown;
    tool_policy?: unknown;
    generation_meta?: unknown;
    claims?: unknown;
    scope?: unknown;
    runtime_profile?: unknown;
    verifier_profile?: unknown;
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
 * Map free-text retrieval signals into the closed constraint language so scope containment is decidable.
 * Already-namespaced terms and version intervals pass through; bare tokens become `capability:<token>`.
 * Hard facets (`required:…`) keep the marker around the namespaced term.
 */
export declare function namespaceScopeSignals(signals: readonly string[]): string[];
/** Detect a coarse env_class for runtime_profile from process env (CI → ci, else local). */
export declare function detectEnvClass(env?: NodeJS.ProcessEnv): EnvClass;
/**
 * Honest defaults for K_auto coordinates the producer did not state. Never invents a coordinate from
 * nothing: each default is grounded in fields the gene already carries (signals, model, validation).
 */
export declare function deriveDefaultKautoCoordinates(input: {
    signals: readonly string[];
    modelName?: string;
    validation: readonly string[];
    claims?: GeneClaim[] | null;
    scope?: GeneScope | null;
    runtime_profile?: GeneRuntimeProfile | null;
    verifier_profile?: GeneVerifierProfile | null;
    env?: NodeJS.ProcessEnv;
}): {
    claims: GeneClaim[] | null;
    scope: GeneScope | null;
    runtime_profile: GeneRuntimeProfile | null;
    verifier_profile: GeneVerifierProfile | null;
};
/**
 * Validate + normalize a distilled/proposed gene for pool insertion. On success returns the canonical Gene
 * (defaults filled, asset_id computed); otherwise the structural / dedup / schema errors.
 */
export declare function intakeGene(candidate: GeneCandidate, existing?: readonly ExistingGeneRef[]): GeneIntakeResult;