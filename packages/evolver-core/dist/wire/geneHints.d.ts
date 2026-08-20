/**
 * Gene routing / tool hints — OPTIONAL EvoX-side annotations a Gene MAY carry to bias the model-tier
 * router (routing_hint) or restrict tools (tool_policy). Ported from v1 src/gep/schemas/gene.js (PR #93,
 * "wire routing_hint and tool_policy into Gene schema").
 *
 * routing_hint / tool_policy and the K_auto coordinates are first-class in @evomap/gep-sdk 1.13.0, so they
 * are normalized here rather than stripped. generation_meta and model_name remain local-only annotations for
 * now. The advisory validateWire still surfaces any malformed shape — at intake on the local-only slice, and
 * via the evolver_gep_build pre-publish preview — plus the hub's own schema check on receipt; there is NO
 * enforced local egress gate (the publish/egress path is sanitize-only and does not call validateWire).
 *
 * Until a future schema bump, nothing in this repo wires these annotations to a runtime consumer yet (the
 * proxy model router's `gene_hint` seam is the eventual tier consumer — see
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
 * The full provenance + quality metadata block (V1 `gene._source`). Lives on Gene as the local-only field
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
 * K_auto projection-key coordinates a Gene MAY carry so its record is machine-decidable in the strict
 * automatic-governance subdomain (paper §K_auto; validator: algo/kautoValidator.ts). These four fields are the
 * DEDICATED, structured form of the coordinates that production previously expressed only through proxy fields
 * (category≈claim, signals_match≈scope, model_name≈runtime, validation≈verifier). The strict measurement
 * (bench/thesis/result-kauto-strict.json) found the dedicated fields populated at 0% and three coordinates
 * (version/claim/scope) undecidable for 100% of 5,665 real rows — the writer side simply never emitted them.
 *
 * Shapes mirror gep-sdk 1.13.0 gene.schema.json (PR: add Gene K_auto coordinates), the schema-authoritative
 * definition, EXACTLY so a gene minted here validates once the SDK bump lands:
 *   claims:           {predicate:string, kind?:'behavioral'|'structural'|'performance'|'safety'}[]
 *   scope:            {signals:string[], predicate?:string}
 *   runtime_profile:  {runtime:string, env_class?:'ci'|'local'|'prod'|'sandbox'}
 *   verifier_profile: {verifier:string, decision?:'pass'|'fail'|'inconclusive'}
 *
 * Since gep-sdk 1.13.0, these four coordinates are first-class Gene fields: the intake schema gate validates
 * their dedicated structure instead of stripping them as local-only hints. They still ride along in asset_id
 * (canonicalize hashes every own key), so a silent strip on the hub side would change the hashed bytes and fail
 * gene_asset_id_verification_failed; the hub allowlist admits them for exactly this reason.
 */
export declare const CLAIM_KINDS: readonly ["behavioral", "structural", "performance", "safety"];
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export interface GeneClaim {
    predicate: string;
    kind?: ClaimKind;
}
export declare const ENV_CLASSES: readonly ["ci", "local", "prod", "sandbox"];
export type EnvClass = (typeof ENV_CLASSES)[number];
export interface GeneRuntimeProfile {
    runtime: string;
    env_class?: EnvClass;
}
export declare const VERIFIER_DECISIONS: readonly ["pass", "fail", "inconclusive"];
export type VerifierDecision = (typeof VERIFIER_DECISIONS)[number];
export interface GeneVerifierProfile {
    verifier: string;
    decision?: VerifierDecision;
}
export interface GeneScope {
    signals: string[];
    predicate?: string;
}
/**
 * The still-local-only Gene field names, in one place — the intake gate strips these before the gep-sdk schema
 * check. IMPORTANT: when a gep-sdk gene-schema bump makes one of these first-class, REMOVE it from this list in
 * the same change. Otherwise intakeGene keeps stripping a now-validated field before validateWire (fail-open —
 * the field's new schema constraints go unchecked at intake) while asset_id still commits it.
 *
 * Only generation_meta and model_name remain local-only annotations for now, so the strip list is just those two.
 */
export declare const GENE_HINT_FIELDS: readonly ["generation_meta", "model_name"];
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
/**
 * Normalize an arbitrary claims fragment to a strict GeneClaim[] or null. A claim survives only with a
 * non-empty string `predicate`; `kind` is kept only if it is one of the closed enum members (a stray kind is
 * dropped, mirroring the enum typeguards for tier/severity). Predicates are trimmed and length-bounded so a
 * runaway string cannot bloat the hashed bytes. An empty result → null ("no explicit claim"), which keeps the
 * gene OUT of strict K_auto rather than fabricating a coordinate.
 */
export declare function normalizeClaims(raw: unknown): GeneClaim[] | null;
/**
 * Normalize an arbitrary scope fragment to a strict { signals, predicate? } object or null. `signals` keeps only
 * non-empty trimmed strings; the block collapses to null when none survive (an empty signal list is not a scope).
 * `predicate` is kept only as a non-empty trimmed string. Deliberately lossy like the hint normalizers.
 */
export declare function normalizeGeneScope(raw: unknown): GeneScope | null;
/**
 * Normalize an arbitrary runtime_profile fragment to { runtime, env_class? } or null. `runtime` must be a
 * non-empty trimmed string (the coordinate is meaningless without it); `env_class` is kept only if it is a
 * closed enum member. Note this is DISTINCT from the flat `model_name` field — model_name records WHICH LLM
 * produced the gene (an authorship/tier signal); runtime_profile records the EXECUTION environment class the
 * claims were established under. A producer may set either, both, or neither.
 */
export declare function normalizeRuntimeProfile(raw: unknown): GeneRuntimeProfile | null;
/**
 * Normalize an arbitrary verifier_profile fragment to { verifier, decision? } or null. `verifier` must be a
 * non-empty trimmed string; `decision` is kept only if it is a closed enum member. This is the verifier IDENTITY
 * axis (e.g. 'npm-test', 'gep-verify@1.4'); the substantive-command bar the strict validator applies is checked
 * downstream in kautoValidator.decideVerifier, not here — this layer only shapes the field.
 */
export declare function normalizeVerifierProfile(raw: unknown): GeneVerifierProfile | null;
/** Strip only local-only Gene annotations before validating against the gep-sdk schema. */
export declare function stripGeneHints(gene: Record<string, unknown>): Record<string, unknown>;