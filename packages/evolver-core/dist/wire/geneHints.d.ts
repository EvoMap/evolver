/**
 * Gene routing / tool hints — OPTIONAL EvoX-side annotations a Gene MAY carry to bias the model-tier
 * router (routing_hint) or restrict tools (tool_policy). Ported from v1 src/gep/schemas/gene.js (PR #93,
 * "wire routing_hint and tool_policy into Gene schema").
 *
 * v2-delta (feature-gate): these fields are NOT yet in @evomap/gep-sdk's gene.schema.json
 * (additionalProperties:false), so a Gene carrying them is not a schema-valid gep-sdk asset until a
 * gep-sdk gene-schema bump — exactly how Capsule's proof_of_work / resolution_status were v2-delta before
 * the 1.11.0 bump made them first-class. That invalidity is surfaced ONLY by the advisory validateWire
 * (wire/schemaGate) — at intake on the hint-stripped core, and via the evolver_gep_build pre-publish
 * preview — plus the hub's own schema check on receipt; there is NO enforced local egress gate (the
 * publish/egress path is sanitize-only and does not call validateWire). Until a bump the hints ride along
 * LOCALLY (intake pool + v1→v2 import fidelity); nothing in this repo wires them to a runtime consumer yet
 * (the proxy model router's `gene_hint` seam is the eventual tier consumer — see
 * packages/evolver-proxy/src/router/modelRouter.ts).
 *
 * Enum strings are matched case-sensitively by the consuming router / tool-gate — keep them EXACT. The
 * router tier set (proxy/modelRouter.ts `Tier`) is the consumer-side mirror of ROUTING_TIERS; the two MUST
 * agree. Normalization is deliberately lossy: unknown enum members are dropped (not coerced to a default),
 * mirroring the consumer's exhaustive match where a stray value is simply ignored rather than mis-routed.
 */
export declare const ROUTING_TIERS: readonly ["cheap", "mid", "expensive"];
export type RoutingTier = (typeof ROUTING_TIERS)[number];
export declare const REASONING_LEVELS: readonly ["off", "low", "medium", "high"];
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export declare const TOOL_POLICY_SEVERITIES: readonly ["warn", "block"];
export type ToolPolicySeverity = (typeof TOOL_POLICY_SEVERITIES)[number];
export interface GeneRoutingHint {
    tier?: RoutingTier;
    reasoning_level?: ReasoningLevel;
}
export interface GeneToolPolicy {
    allow_only?: string[];
    deny?: string[];
    severity?: ToolPolicySeverity;
}
/**
 * Provenance classification (V1 #302 classifyProvenance, aligned with TaskGenome Bench §3.1): a Gene's value
 * depends on WHERE it came from, not on being short. The three tiers:
 *   evolved   -- distilled from a real solve -> fail -> mutate -> pass trajectory; beats Skills (+8.7..+15.5pp)
 *   distilled -- transcribed from reference/teacher text with no real failing trajectory; WORSE than Skills (-3.2..-11.2pp)
 *   manual    -- pure human transcription, no execution evidence at all
 * The high-value payload of an evolved Gene is the corrective_insight that flipped the outcome.
 */
export declare const GENERATION_SOURCES: readonly ["evolved", "distilled", "manual"];
export type GenerationSource = (typeof GENERATION_SOURCES)[number];
export interface GeneGenerationHeuristics {
    strategy_steps?: number;
    avoid_count?: number;
    validation_declared_count?: number;
    validation_runnable_count?: number;
    signals_extracted?: number;
    preconditions_extracted?: number;
    trajectory_depth?: number;
    has_corrective_insight?: boolean;
}
/**
 * The full provenance + quality metadata block (V1 `gene._source`). Lives on Gene as the v2-delta field
 * `generation_meta`. `source` is the only required key; the rest is descriptive for reviewers / future
 * governance. `quality_score` is a coarse [0,1] tier-anchored score (evolved 0.7 / distilled 0.4 / manual 0.3
 * baseline + bonuses); `overcame_errors` is the mutation_log copy that the trajectory overcame.
 */
export interface GenerationMeta {
    source: GenerationSource;
    quality_score?: number;
    quality_heuristics?: GeneGenerationHeuristics;
    overcame_errors?: string[];
}
/**
 * The v2-delta hint field names, in one place — the intake gate strips these before the gep-sdk schema check.
 * IMPORTANT: when a gep-sdk gene-schema bump makes one of these first-class, REMOVE it from this list in the
 * same change. Otherwise intakeGene keeps stripping a now-validated field before validateWire (fail-open — the
 * field's new schema constraints go unchecked at intake) while asset_id still commits it.
 */
export declare const GENE_HINT_FIELDS: readonly ["routing_hint", "tool_policy", "generation_meta"];
/**
 * Normalize an arbitrary routing_hint fragment to a strict { tier?, reasoning_level? } object, or null.
 * Unknown enum values are dropped (a stray tier would fail the consumer's exhaustive match and route as if
 * no hint existed, so we mirror that here rather than emit JSON that misleads). Empty result → null
 * ("no opinion — let the router take its default path").
 */
export declare function normalizeRoutingHint(raw: unknown): GeneRoutingHint | null;
/**
 * Normalize an arbitrary tool_policy fragment. allow_only / deny are TOOL-NAME lists: only non-empty STRING
 * entries are kept — non-string entries (objects, numbers, null, booleans) are DROPPED, not String()-coerced.
 * This is a deliberate tightening over v1 (which did `.map(String)` and leaked garbage like "[object Object]"
 * into a tool-name list); it mirrors the case-sensitive typeguards used for tier/severity here, and never
 * drops a LEGITIMATE restriction — a partly-garbage list keeps its valid names, and an all-garbage list
 * collapses exactly like an all-empty one. A list is kept only if something survives: a raw
 * { allow_only: ['', ''] } must NOT leak through as allow_only:[], which a consuming tool-gate reads as
 * "allow zero tools" and would block every tool call when the gene only meant to carry a deny list. severity
 * defaults to 'warn' when a list is present; the whole object collapses to null when neither list survives.
 */
export declare function normalizeToolPolicy(raw: unknown): GeneToolPolicy | null;
/**
 * Normalize an arbitrary generation_meta fragment to a strict { source, quality_score?, quality_heuristics?,
 * overcame_errors? } object, or null. Lossy (mirrors normalizeRoutingHint / normalizeToolPolicy): unknown source
 * values are dropped (the whole block collapses to null — a generation_meta with no recognized source carries no
 * usable provenance signal); quality_score is clamped to [0,1]; heuristics keeps only its numeric/boolean fields;
 * overcame_errors keeps only non-empty strings. A block with a valid source but all-else-empty still survives (source
 * alone is a meaningful provenance tag); only a missing/unknown source yields null.
 */
export declare function normalizeGenerationMeta(raw: unknown): GenerationMeta | null;
/** Strip the v2-delta hint fields from a gene-shaped object (used to validate the gep-sdk-known core). */
export declare function stripGeneHints(gene: Record<string, unknown>): Record<string, unknown>;