// Gene intake — the structural part of skill distillation (ported from v1 src/gep/skillDistiller.js).
// v2's solidify produces Capsules but never Genes, so the reusable gene pool is otherwise static (only
// seeded/imported). This is the safe INTAKE gate for a distilled/proposed gene before it joins the pool:
// normalize defaults, validate structure + the gep-sdk schema, recompute asset_id, and reject a gene whose
// signals fully overlap an existing one (dedup, so the pool does not grow redundant). The gene's CONTENT
// is generated upstream (the agent runtime / a distillation prompt — generative, out of core scope); this
// slice is the structural gate. Pairs with capabilityCandidates (which proposes what to distill).
import { computeAssetId, validateWire, SCHEMA_VERSION, normalizeRoutingHint, normalizeToolPolicy, normalizeGenerationMeta, stripGeneHints, } from '../wire/index.js';
const VALID_CATEGORIES = ['repair', 'optimize', 'innovate', 'explore'];
const DEFAULT_FORBIDDEN_PATHS = ['.git', 'node_modules'];
const DEFAULT_MAX_FILES = 12;
/** Id prefix every distilled (skill-derived) gene carries. Recognised via {@link isDistilledGeneId}. */
const DISTILLED_ID_PREFIX = 'gene_distilled_';
/**
 * True when a gene id is in the `gene_distilled_` namespace. NB this prefix is now a NAMESPACE marker, NOT a
 * provenance tag: v1 used it to mean "skill-derived" (auto-evolved genes were `gene_auto_`), but v2's intakeGene
 * tags EVERY intaken gene this way regardless of origin. The authoritative provenance is {@link geneGenerationSource};
 * this prefix check remains as a back-compat fallback for legacy pooled genes that predate generation_meta, and for
 * call sites that only have a gene id (not the full record).
 */
export function isDistilledGeneId(id) {
    return typeof id === 'string' && id.startsWith(DISTILLED_ID_PREFIX);
}
/**
 * The authoritative gene-generation source: read `generation_meta.source` from a gene-shaped record (V1 #302). Falls
 * back to the id-prefix namespace when the record carries no generation_meta (legacy pooled genes predate the field),
 * returning 'distilled' for a `gene_distilled_` id and 'manual' otherwise — so the fallback never claims a higher
 * provenance tier than the prefix can vouch for. `null` means "undetermined" (no record, no recognizable id).
 */
export function geneGenerationSource(gene, geneId) {
    const meta = gene?.['generation_meta'];
    if (meta && typeof meta === 'object') {
        const src = meta['source'];
        if (typeof src === 'string' && (src === 'evolved' || src === 'distilled' || src === 'manual'))
            return src;
    }
    // Legacy fallback: a `gene_distilled_` id is at best a distilled gene (v2 minted it for ALL intake sources, so it
    // cannot be trusted as "evolved"); any other id is treated as manual (human-authored / externally seeded).
    const id = geneId ?? (typeof gene?.['id'] === 'string' ? String(gene['id']) : null);
    if (id && isDistilledGeneId(id))
        return 'distilled';
    if (id)
        return 'manual';
    return null;
}
function fnv1a(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}
const clean = (xs) => (xs ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
/** Returns the id of an existing gene whose signals are a superset of `signals` (i.e. the candidate is redundant), else null. */
function fullyOverlaps(signals, existing) {
    const newSet = signals.map((s) => s.toLowerCase());
    for (const eg of existing) {
        const egSet = new Set((eg.signals_match ?? []).map((s) => String(s).toLowerCase()));
        if (egSet.size === 0)
            continue;
        if (newSet.every((s) => egSet.has(s)))
            return eg.id ?? '?';
    }
    return null;
}
/**
 * Validate + normalize a distilled/proposed gene for pool insertion. On success returns the canonical Gene
 * (defaults filled, asset_id computed); otherwise the structural / dedup / schema errors.
 */
export function intakeGene(candidate, existing = []) {
    const errors = [];
    const signals = clean(candidate.signals_match);
    const strategy = clean(candidate.strategy);
    if (signals.length === 0)
        errors.push('signals_match is empty');
    if (strategy.length === 0)
        errors.push('strategy is empty');
    if (signals.length > 0) {
        const dup = fullyOverlaps(signals, existing);
        if (dup)
            errors.push(`signals_match fully overlaps existing gene: ${dup}`);
    }
    if (errors.length > 0)
        return { ok: false, errors };
    const category = VALID_CATEGORIES.includes(candidate.category) ? candidate.category : 'optimize';
    const id = candidate.id && candidate.id.startsWith(DISTILLED_ID_PREFIX) ? candidate.id : `${DISTILLED_ID_PREFIX}${fnv1a(signals.join('|'))}`;
    // v2-delta EvoX hints (v1 PR #93): normalized so a candidate carrying them lands canonical, dropped to
    // absent when malformed/empty. The router / tool-gate reads absent === "no opinion".
    const routingHint = normalizeRoutingHint(candidate.routing_hint);
    const toolPolicy = normalizeToolPolicy(candidate.tool_policy);
    // v2-delta provenance + quality metadata (v1 #302): normalized so a candidate carrying it lands canonical,
    // dropped to absent when malformed/no-recognized-source.
    const generationMeta = normalizeGenerationMeta(candidate.generation_meta);
    const gene = {
        type: 'Gene',
        schema_version: SCHEMA_VERSION,
        id,
        category,
        signals_match: signals,
        strategy,
        constraints: {
            max_files: candidate.constraints?.max_files ?? DEFAULT_MAX_FILES,
            forbidden_paths: [...(candidate.constraints?.forbidden_paths ?? DEFAULT_FORBIDDEN_PATHS)],
        },
        validation: candidate.validation ? [...candidate.validation] : [],
        summary: candidate.summary ?? `Strategy for: ${signals.slice(0, 3).join(', ')}`,
        ...(candidate.preconditions ? { preconditions: [...candidate.preconditions] } : {}),
        ...(routingHint ? { routing_hint: routingHint } : {}),
        ...(toolPolicy ? { tool_policy: toolPolicy } : {}),
        ...(generationMeta ? { generation_meta: generationMeta } : {}),
        asset_id: '',
    };
    // asset_id folds in the hints + generation_meta (intake's own canonical shape — gep-sdk canonicalize hashes every
    // own key). NB: this is NOT byte-equal to what v1's createGene would hash for the same logical gene — v1 always emits
    // routing_hint/tool_policy:null plus empty epigenetic_marks/learning_history/anti_patterns/preconditions that
    // v2 intake omits, so the canonical shapes differ. Self-consistent here; not a cross-impl parity guarantee.
    gene.asset_id = computeAssetId(gene) ?? '';
    // Structural gate validates the gep-sdk-known CORE. routing_hint / tool_policy / generation_meta are v2-delta
    // (pending a gene-schema bump), so strip them before the check — else additionalProperties:false rejects the
    // gene at intake. The full hinted gene stays schema-invalid until the SDK catches up — surfaced by the advisory
    // validateWire preview (evolver_gep_build) and enforced by the hub on receipt, NOT by a local egress gate
    // (the publish/egress path is sanitize-only). Same v2-delta contract Capsule's proof_of_work had pre-1.11.0.
    const v = validateWire(stripGeneHints(gene));
    if (!v.ok)
        return { ok: false, errors: v.errors };
    return { ok: true, gene, errors: [] };
}