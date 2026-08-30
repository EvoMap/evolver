// Gene intake — the structural part of skill distillation (ported from v1 src/gep/skillDistiller.js).
// v2's solidify produces Capsules but never Genes, so the reusable gene pool is otherwise static (only
// seeded/imported). This is the safe INTAKE gate for a distilled/proposed gene before it joins the pool:
// normalize defaults, validate structure + the gep-sdk schema, recompute asset_id, and reject a gene whose
// signals fully overlap an existing one (dedup, so the pool does not grow redundant). The gene's CONTENT
// is generated upstream (the agent runtime / a distillation prompt — generative, out of core scope); this
// slice is the structural gate. Pairs with capabilityCandidates (which proposes what to distill).
import { detectModelName } from '../bootstrap/envFingerprint.js';
import { computeAssetId, validateWire, SCHEMA_VERSION, normalizeRoutingHint, normalizeToolPolicy, normalizeGenerationMeta, normalizeClaims, normalizeGeneScope, normalizeRuntimeProfile, normalizeVerifierProfile, stripGeneHints, ENV_CLASSES, } from '../wire/index.js';
const VALID_CATEGORIES = ['repair', 'optimize', 'innovate', 'explore'];
const DEFAULT_FORBIDDEN_PATHS = ['.git', 'node_modules'];
const DEFAULT_MAX_FILES = 12;
/** Id prefix every distilled (skill-derived) gene carries. Recognised via {@link isDistilledGeneId}. */
const DISTILLED_ID_PREFIX = 'gene_distilled_';
const LEGACY_CONVERSATION_ID_PREFIX = 'gene_conversation_';
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
const nonEmptyModel = (v) => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t.slice(0, 100) : undefined;
};
const clean = (xs) => (xs ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
/** Already-namespaced closed-constraint scope terms (kautoValidator.SCOPE_TERM prefixes). */
const NAMESPACED_SCOPE = /^(?:repo|lineage|pkg|lang|framework|capability|tool|model|time|env):[A-Za-z0-9._@/:-]+$/;
const VERSION_INTERVAL_SCOPE = /^[A-Za-z0-9._-]+@(?:[><=^~]{1,2})?\d[\w.*-]*(?:\s*-\s*\d[\w.*-]*)?$/;
const PLACEHOLDER_VERIFIER = /^(?:node|python3?|ruby|deno|bun|go|java|npm|pnpm|yarn)\s+(?:--?v(?:ersion)?|-V)\s*$/i;
const TRIVIAL_VERIFIER = /^(?:true|:|echo\b.*|exit\s+0)\s*$/i;
/**
 * Map free-text retrieval signals into the closed constraint language so scope containment is decidable.
 * Already-namespaced terms and version intervals pass through; bare tokens become `capability:<token>`.
 * Hard facets (`required:…`) keep the marker around the namespaced term.
 */
export function namespaceScopeSignals(signals) {
    const out = [];
    for (const raw of signals) {
        const t = String(raw ?? '').trim();
        if (!t)
            continue;
        const required = t.startsWith('required:');
        const bare = required ? t.slice('required:'.length).trim() : t;
        if (!bare)
            continue;
        const namespaced = (NAMESPACED_SCOPE.test(bare) || VERSION_INTERVAL_SCOPE.test(bare))
            ? bare
            : `capability:${bare.replace(/[^A-Za-z0-9._@/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)}`;
        if (!namespaced || namespaced === 'capability:')
            continue;
        out.push(required ? `required:${namespaced}` : namespaced);
    }
    return out;
}
/** Detect a coarse env_class for runtime_profile from process env (CI → ci, else local). */
export function detectEnvClass(env = process.env) {
    const truthy = (v) => {
        const t = (v ?? '').trim().toLowerCase();
        return t !== '' && t !== '0' && t !== 'false' && t !== 'no';
    };
    if (truthy(env['CI']) || truthy(env['GITHUB_ACTIONS']) || truthy(env['GITLAB_CI'])
        || truthy(env['BUILDKITE']) || truthy(env['CIRCLECI']) || truthy(env['TRAVIS'])) {
        return 'ci';
    }
    if (truthy(env['EVOLVER_ENV_CLASS'])) {
        const v = String(env['EVOLVER_ENV_CLASS']).trim().toLowerCase();
        if (ENV_CLASSES.includes(v))
            return v;
    }
    return 'local';
}
/**
 * Honest defaults for K_auto coordinates the producer did not state. Never invents a coordinate from
 * nothing: each default is grounded in fields the gene already carries (signals, model, validation).
 */
export function deriveDefaultKautoCoordinates(input) {
    const claims = input.claims ?? (input.signals.length > 0
        ? [{ predicate: 'output_contract', kind: 'behavioral' }]
        : null);
    const scope = input.scope ?? (() => {
        const namespaced = namespaceScopeSignals(input.signals);
        return namespaced.length > 0 ? { signals: namespaced } : null;
    })();
    const runtime_profile = input.runtime_profile ?? (input.modelName
        ? { runtime: input.modelName, env_class: detectEnvClass(input.env) }
        : null);
    const verifier_profile = input.verifier_profile ?? (() => {
        const cmds = input.validation.map((c) => String(c).trim()).filter(Boolean);
        if (cmds.length === 0)
            return null;
        const substantive = cmds.find((c) => !PLACEHOLDER_VERIFIER.test(c) && !TRIVIAL_VERIFIER.test(c));
        // Light distill validation deliberately keeps `node --version` for sandbox safety; the gene still
        // passed through evolver's sandboxed validation gate, which is a real verifier identity (not a
        // shell placeholder). Prefer a substantive command when present; else name the gate.
        return { verifier: substantive ?? 'evolver-sandboxed-validation', decision: 'pass' };
    })();
    return { claims, scope, runtime_profile, verifier_profile };
}
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
    // First-class EvoX hints (v1 PR #93): normalized so a candidate carrying them lands canonical, not dropped, and
    // absent when malformed/empty. The router / tool-gate reads absent === "no opinion".
    const routingHint = normalizeRoutingHint(candidate.routing_hint);
    const toolPolicy = normalizeToolPolicy(candidate.tool_policy);
    // Local provenance + quality metadata (v1 #302): normalized so a candidate carrying it lands canonical,
    // dropped to absent when malformed/no-recognized-source.
    const generationMeta = normalizeGenerationMeta(candidate.generation_meta);
    // 只有调用方明确证明记录来自蒸馏时，才保留 intake 之前的会话命名空间。
    // 这样既兼容重试和下游逻辑 ID 查询，也不允许任意调用方 ID 绕过 intake 的命名空间所有权规则。
    const preservesLegacyConversationId = generationMeta?.source === 'distilled'
        && typeof candidate.id === 'string'
        && candidate.id.startsWith(LEGACY_CONVERSATION_ID_PREFIX);
    const id = candidate.id && (candidate.id.startsWith(DISTILLED_ID_PREFIX) || preservesLegacyConversationId)
        ? candidate.id : `${DISTILLED_ID_PREFIX}${fnv1a(signals.join('|'))}`;
    // K_auto runtime coordinate. Explicit caller value wins; otherwise detect from the environment using the same
    // producer the env fingerprint uses. 'unknown' means undetectable, so it is dropped rather than recorded (see
    // GeneCandidate.model_name) — absent keeps meaning "not recorded", never "runtime is literally unknown".
    const detectedModel = nonEmptyModel(candidate.model_name) ?? nonEmptyModel(detectModelName());
    const modelName = detectedModel === 'unknown' ? undefined : detectedModel;
    // First-class K_auto projection-key coordinates. Producer-supplied values win when they normalize; otherwise
    // derive honest defaults grounded in signals/model/validation so forward intake can clear strict K_auto
    // without fabricating coordinates from nothing. Still ride along in asset_id and strip before validateWire.
    const validation = candidate.validation ? [...candidate.validation] : [];
    const derived = deriveDefaultKautoCoordinates({
        signals,
        ...(modelName ? { modelName } : {}),
        validation,
        claims: normalizeClaims(candidate.claims),
        scope: normalizeGeneScope(candidate.scope),
        runtime_profile: normalizeRuntimeProfile(candidate.runtime_profile),
        verifier_profile: normalizeVerifierProfile(candidate.verifier_profile),
    });
    const claims = derived.claims;
    const scope = derived.scope;
    const runtimeProfile = derived.runtime_profile;
    const verifierProfile = derived.verifier_profile;
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
        validation,
        summary: candidate.summary ?? `Strategy for: ${signals.slice(0, 3).join(', ')}`,
        ...(modelName ? { model_name: modelName } : {}),
        ...(candidate.preconditions ? { preconditions: [...candidate.preconditions] } : {}),
        ...(routingHint ? { routing_hint: routingHint } : {}),
        ...(toolPolicy ? { tool_policy: toolPolicy } : {}),
        ...(generationMeta ? { generation_meta: generationMeta } : {}),
        ...(claims ? { claims } : {}),
        ...(scope ? { scope } : {}),
        ...(runtimeProfile ? { runtime_profile: runtimeProfile } : {}),
        ...(verifierProfile ? { verifier_profile: verifierProfile } : {}),
        asset_id: '',
    };
    // asset_id folds in the hints + generation_meta (intake's own canonical shape — gep-sdk canonicalize hashes every
    // own key). NB: this is NOT byte-equal to what v1's createGene would hash for the same logical gene — v1 always emits
    // routing_hint/tool_policy:null plus empty epigenetic_marks/learning_history/anti_patterns/preconditions that
    // v2 intake omits, so the canonical shapes differ. Self-consistent here; not a cross-impl parity guarantee.
    gene.asset_id = computeAssetId(gene) ?? '';
    // Structural gate validates the gep-sdk-known Gene shape. gep-sdk 1.13.0 made routing_hint/tool_policy plus the
    // K_auto coordinates first-class, so stripGeneHints removes only local annotations (generation_meta/model_name)
    // before the check. That keeps SDK constraints active for every first-class field while preserving local-only
    // metadata in asset_id and in the returned gene.
    const v = validateWire(stripGeneHints(gene));
    if (!v.ok)
        return { ok: false, errors: v.errors };
    return { ok: true, gene, errors: [] };
}