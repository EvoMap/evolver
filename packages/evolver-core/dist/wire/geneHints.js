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
export const ROUTING_TIERS = ['cheap', 'mid', 'expensive'];
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];
export const TOOL_POLICY_SEVERITIES = ['warn', 'block'];
/**
 * The v2-delta hint field names, in one place — the intake gate strips these before the gep-sdk schema check.
 * IMPORTANT: when a gep-sdk gene-schema bump makes one of these first-class, REMOVE it from this list in the
 * same change. Otherwise intakeGene keeps stripping a now-validated field before validateWire (fail-open — the
 * field's new schema constraints go unchecked at intake) while asset_id still commits it.
 */
export const GENE_HINT_FIELDS = ['routing_hint', 'tool_policy'];
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
/** Strip the v2-delta hint fields from a gene-shaped object (used to validate the gep-sdk-known core). */
export function stripGeneHints(gene) {
    const hidden = GENE_HINT_FIELDS;
    const out = {};
    for (const [k, v] of Object.entries(gene))
        if (!hidden.includes(k))
            out[k] = v;
    return out;
}