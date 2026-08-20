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
export const ROUTING_TIERS = ['cheap', 'mid', 'expensive'];
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];
export const TOOL_POLICY_SEVERITIES = ['warn', 'block'];
/**
 * Provenance classification (V1 #302 classifyProvenance, aligned with TaskGenome Bench §3.1): a Gene's value
 * depends on WHERE it came from, not on being short. The three tiers:
 *   evolved   -- distilled from a real solve -> fail -> mutate -> pass trajectory; beats Skills (+8.7..+15.5pp)
 *   distilled -- transcribed from reference/teacher text with no real failing trajectory; WORSE than Skills (-3.2..-11.2pp)
 *   manual    -- pure human transcription, no execution evidence at all
 * The high-value payload of an evolved Gene is the corrective_insight that flipped the outcome.
 */
export const GENERATION_SOURCES = ['evolved', 'distilled', 'manual'];
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
export const CLAIM_KINDS = ['behavioral', 'structural', 'performance', 'safety'];
export const ENV_CLASSES = ['ci', 'local', 'prod', 'sandbox'];
export const VERIFIER_DECISIONS = ['pass', 'fail', 'inconclusive'];
/**
 * The still-local-only Gene field names, in one place — the intake gate strips these before the gep-sdk schema
 * check. IMPORTANT: when a gep-sdk gene-schema bump makes one of these first-class, REMOVE it from this list in
 * the same change. Otherwise intakeGene keeps stripping a now-validated field before validateWire (fail-open —
 * the field's new schema constraints go unchecked at intake) while asset_id still commits it.
 *
 * Only generation_meta and model_name remain local-only annotations for now, so the strip list is just those two.
 */
export const GENE_HINT_FIELDS = ['generation_meta', 'model_name'];
function includesEnum(set, v) {
    return typeof v === 'string' && set.includes(v);
}
/**
 * Normalize an arbitrary routing_hint fragment to a strict { tier?, reasoning_level? } object, or null.
 * Unknown enum values are dropped (a stray tier would fail the consumer's exhaustive match and route as if
 * no hint existed, so we mirror that here rather than emit JSON that misleads). Empty result → null
 * ("no opinion — let the router take its default path").
 */
export function normalizeRoutingHint(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const out = {};
    const tier = r['tier'];
    if (includesEnum(ROUTING_TIERS, tier))
        out.tier = tier;
    const reasoning = r['reasoning_level'];
    if (includesEnum(REASONING_LEVELS, reasoning))
        out.reasoning_level = reasoning;
    return Object.keys(out).length > 0 ? out : null;
}
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
export function normalizeToolPolicy(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const out = {};
    const allow = cleanToolList(r['allow_only']);
    if (allow)
        out.allow_only = allow;
    const deny = cleanToolList(r['deny']);
    if (deny)
        out.deny = deny;
    if (out.allow_only === undefined && out.deny === undefined)
        return null;
    const severity = r['severity'];
    out.severity = includesEnum(TOOL_POLICY_SEVERITIES, severity) ? severity : 'warn';
    return out;
}
/**
 * A tool-name list survives only as its non-empty string members. Non-strings are dropped (not coerced) —
 * see normalizeToolPolicy. Returns undefined when nothing survives, so the caller omits the field entirely.
 */
function cleanToolList(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const cleaned = raw.filter((x) => typeof x === 'string' && x.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
}
/**
 * Normalize an arbitrary generation_meta fragment to a strict { source, quality_score?, quality_heuristics?,
 * overcame_errors? } object, or null. Lossy (mirrors normalizeRoutingHint / normalizeToolPolicy): unknown source
 * values are dropped (the whole block collapses to null — a generation_meta with no recognized source carries no
 * usable provenance signal); quality_score is clamped to [0,1]; heuristics keeps only its numeric/boolean fields;
 * overcame_errors keeps only non-empty strings. A block with a valid source but all-else-empty still survives (source
 * alone is a meaningful provenance tag); only a missing/unknown source yields null.
 */
export function normalizeGenerationMeta(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const source = r['source'];
    if (!includesEnum(GENERATION_SOURCES, source))
        return null;
    const out = { source };
    const qs = r['quality_score'];
    if (typeof qs === 'number' && Number.isFinite(qs))
        out.quality_score = Math.max(0, Math.min(1, qs));
    const eh = r['quality_heuristics'];
    if (eh && typeof eh === 'object') {
        const h = eh;
        const heuristics = {};
        const numFields = [
            'strategy_steps', 'avoid_count', 'validation_declared_count', 'validation_runnable_count',
            'signals_extracted', 'preconditions_extracted', 'trajectory_depth',
        ];
        for (const k of numFields) {
            const v = h[k];
            if (typeof v === 'number' && Number.isFinite(v))
                heuristics[k] = v;
        }
        if (typeof h['has_corrective_insight'] === 'boolean')
            heuristics.has_corrective_insight = h['has_corrective_insight'];
        if (Object.keys(heuristics).length > 0)
            out.quality_heuristics = heuristics;
    }
    const errs = cleanToolList(r['overcame_errors']);
    if (errs)
        out.overcame_errors = errs;
    return out;
}
/**
 * Normalize an arbitrary claims fragment to a strict GeneClaim[] or null. A claim survives only with a
 * non-empty string `predicate`; `kind` is kept only if it is one of the closed enum members (a stray kind is
 * dropped, mirroring the enum typeguards for tier/severity). Predicates are trimmed and length-bounded so a
 * runaway string cannot bloat the hashed bytes. An empty result → null ("no explicit claim"), which keeps the
 * gene OUT of strict K_auto rather than fabricating a coordinate.
 */
export function normalizeClaims(raw) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const r = item;
        const predicate = typeof r['predicate'] === 'string' ? r['predicate'].trim().slice(0, 500) : '';
        if (!predicate)
            continue;
        const claim = { predicate };
        if (includesEnum(CLAIM_KINDS, r['kind']))
            claim.kind = r['kind'];
        out.push(claim);
    }
    return out.length > 0 ? out : null;
}
/**
 * Normalize an arbitrary scope fragment to a strict { signals, predicate? } object or null. `signals` keeps only
 * non-empty trimmed strings; the block collapses to null when none survive (an empty signal list is not a scope).
 * `predicate` is kept only as a non-empty trimmed string. Deliberately lossy like the hint normalizers.
 */
export function normalizeGeneScope(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const r = raw;
    // Trim signals and drop whitespace-only ones (cleanToolList keeps by raw length, which would leak '  ' and an
    // untrimmed ' x ' into the hashed bytes). A scope signal is an identity/constraint term, so its canonical form
    // is the trimmed token — the strict validator reads it trimmed anyway (decideScope maps through str()).
    const signals = Array.isArray(r['signals'])
        ? r['signals'].filter((x) => typeof x === 'string').map((s) => s.trim()).filter((s) => s.length > 0)
        : [];
    if (signals.length === 0)
        return null;
    const out = { signals };
    const predicate = typeof r['predicate'] === 'string' ? r['predicate'].trim().slice(0, 500) : '';
    if (predicate)
        out.predicate = predicate;
    return out;
}
/**
 * Normalize an arbitrary runtime_profile fragment to { runtime, env_class? } or null. `runtime` must be a
 * non-empty trimmed string (the coordinate is meaningless without it); `env_class` is kept only if it is a
 * closed enum member. Note this is DISTINCT from the flat `model_name` field — model_name records WHICH LLM
 * produced the gene (an authorship/tier signal); runtime_profile records the EXECUTION environment class the
 * claims were established under. A producer may set either, both, or neither.
 */
export function normalizeRuntimeProfile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const r = raw;
    const runtime = typeof r['runtime'] === 'string' ? r['runtime'].trim().slice(0, 100) : '';
    if (!runtime)
        return null;
    const out = { runtime };
    if (includesEnum(ENV_CLASSES, r['env_class']))
        out.env_class = r['env_class'];
    return out;
}
/**
 * Normalize an arbitrary verifier_profile fragment to { verifier, decision? } or null. `verifier` must be a
 * non-empty trimmed string; `decision` is kept only if it is a closed enum member. This is the verifier IDENTITY
 * axis (e.g. 'npm-test', 'gep-verify@1.4'); the substantive-command bar the strict validator applies is checked
 * downstream in kautoValidator.decideVerifier, not here — this layer only shapes the field.
 */
export function normalizeVerifierProfile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const r = raw;
    const verifier = typeof r['verifier'] === 'string' ? r['verifier'].trim().slice(0, 100) : '';
    if (!verifier)
        return null;
    const out = { verifier };
    if (includesEnum(VERIFIER_DECISIONS, r['decision']))
        out.decision = r['decision'];
    return out;
}
/** Strip only local-only Gene annotations before validating against the gep-sdk schema. */
export function stripGeneHints(gene) {
    const hidden = GENE_HINT_FIELDS;
    const out = {};
    for (const [k, v] of Object.entries(gene))
        if (!hidden.includes(k))
            out[k] = v;
    return out;
}