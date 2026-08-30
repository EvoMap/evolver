const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// ---------------------------------------------------------------------------------------------------
// Version. Needs an identifier that pins THIS asset's immutable version. A record-format version
// (schema_version) is shared across the whole catalogue and cannot distinguish two versions of one asset,
// so it does not satisfy the coordinate even though it is always present.
// ---------------------------------------------------------------------------------------------------
const VERSION_FIELDS = ['asset_version', 'assetVersion', 'version', 'content_hash', 'contentHash'];
/** Content-addressed asset ids are immutable version pins (sha256 of canonical gene bytes). */
const CONTENT_ADDRESSED_ASSET_ID = /^sha256:[a-f0-9]{64}$/i;
export function decideVersion(rec) {
    for (const f of VERSION_FIELDS) {
        const v = str(rec[f]);
        if (v)
            return { decidable: true, resolved: `${f}=${v}`, reason: null };
    }
    // asset_id is the production content-address: intake always writes it, and it changes when any
    // coordinate-bearing field changes. Accepting it closes the version coordinate without inventing a
    // parallel asset_version field the gep-sdk schema does not yet declare.
    const assetId = str(rec['asset_id']);
    if (CONTENT_ADDRESSED_ASSET_ID.test(assetId)) {
        return { decidable: true, resolved: `asset_id=${assetId}`, reason: null };
    }
    const schemaVersion = str(rec['schema_version']);
    if (schemaVersion) {
        return {
            decidable: false,
            reason: `only schema_version=${schemaVersion} is present; that is the record format version, shared across assets, and does not identify this asset's immutable version`,
        };
    }
    return { decidable: false, reason: 'no asset version identifier present' };
}
// ---------------------------------------------------------------------------------------------------
// Claim. The closed claim vocabulary is a set of typed claim PREDICATES about what an asset asserts,
// distinct from `category`, which records the kind of intervention. A record carrying only `category` has
// an intervention type but no machine-checkable claim, so claim-level conflict detection has nothing to
// compare.
// ---------------------------------------------------------------------------------------------------
export const CLAIM_PREDICATES = Object.freeze([
    'source_of_truth',
    'requires_service',
    'requires_tool',
    'forbids_action',
    'output_contract',
    'ordering_constraint',
    'environment_precondition',
]);
const CLAIM_FIELDS = ['claim', 'claims', 'claim_predicate', 'claimPredicate'];
/** Extract candidate predicate STRINGS from a claim field value, accepting both the legacy string/string[] form
 * and the gep-sdk 1.13.0 object form `{predicate, kind}` (single or array). Non-conforming entries are dropped. */
function claimPredicateStrings(raw) {
    const fromOne = (v) => {
        if (typeof v === 'string')
            return v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const p = v['predicate'];
            return typeof p === 'string' ? p : null;
        }
        return null;
    };
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map(fromOne).filter((s) => typeof s === 'string' && s.trim().length > 0);
}
export function decideClaim(rec) {
    const known = new Set(CLAIM_PREDICATES);
    for (const f of CLAIM_FIELDS) {
        const raw = rec[f];
        if (raw === undefined || raw === null)
            continue;
        // A claim predicate names a closed-vocabulary term as its leading token — legacy `source_of_truth:...`
        // strings and the gep-sdk `{predicate:'source_of_truth(...)'}` object form both reduce to the same token.
        const candidates = claimPredicateStrings(raw);
        const named = candidates.map((c) => str(c).split(/[:=(]/, 1)[0] ?? '').filter(Boolean);
        const hit = named.find((n) => known.has(n));
        if (hit)
            return { decidable: true, resolved: hit, reason: null };
        if (named.length > 0) {
            return { decidable: false, reason: `claim predicate(s) ${named.join(', ')} are not in the closed claim vocabulary` };
        }
    }
    const category = str(rec['category']);
    if (category) {
        return {
            decidable: false,
            reason: `only category=${category} is present; category is the intervention kind, not a claim predicate from the closed vocabulary`,
        };
    }
    return { decidable: false, reason: 'no claim predicate present' };
}
// ---------------------------------------------------------------------------------------------------
// Scope. Must parse in the closed constraint language, because scope containment has to be decidable for
// set-inclusion precedence to work. We accept the forms the paper enumerates: identity sets, version
// intervals, repository-lineage prefixes, capability-set containment, time intervals, enumerated sets, and
// registered compatibility relations. A bare tag is an identity-set element ONLY when it is namespaced,
// so that two tags from different producers cannot silently collide; an unqualified free-text tag is not
// decidable against another producer's tag of the same name.
// ---------------------------------------------------------------------------------------------------
const SCOPE_TERM = /^(?:repo|lineage|pkg|lang|framework|capability|tool|model|time|env):[A-Za-z0-9._@/:-]+$/;
const VERSION_INTERVAL = /^[A-Za-z0-9._-]+@(?:[><=^~]{1,2})?\d[\w.*-]*(?:\s*-\s*\d[\w.*-]*)?$/;
/** Do all of `terms` parse in the closed constraint language? Shared by the dedicated `scope` field and the
 * legacy `signals_match` proxy so the SAME containment-decidability bar governs both. */
function decideScopeTerms(terms) {
    if (terms.length === 0)
        return { decidable: false, reason: 'signals_match is empty; no scope predicate' };
    const parses = (t) => SCOPE_TERM.test(t) || VERSION_INTERVAL.test(t);
    const undecidable = terms.filter((t) => {
        // A hard facet gates on a term; the term itself must parse, so strip the marker and test what remains.
        const bare = t.startsWith('required:') ? t.slice('required:'.length) : t;
        return !parses(bare);
    });
    if (undecidable.length === 0) {
        return { decidable: true, resolved: terms.join(','), reason: null };
    }
    return {
        decidable: false,
        reason: `${undecidable.length} of ${terms.length} scope term(s) do not parse in the closed constraint language (e.g. ${undecidable.slice(0, 3).join(', ')}); containment against another scope is therefore undecidable`,
    };
}
export function decideScope(rec) {
    // Dedicated coordinate first (gep-sdk 1.13.0 `scope: {signals, predicate?}`). Its `signals` list carries the
    // scope terms; a `predicate` is metadata for the reader, not a substitute for parseable signals. When the
    // dedicated field is present but its signals are empty we fall through to the proxy, so a malformed dedicated
    // field never DEMOTES a record that the legacy path would have admitted.
    const scope = rec['scope'];
    if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
        const signals = arr(scope['signals']).map((t) => str(t)).filter(Boolean);
        if (signals.length > 0)
            return decideScopeTerms(signals);
    }
    const terms = arr(rec['signals_match']).map((t) => str(t)).filter(Boolean);
    return decideScopeTerms(terms);
}
/** Apply the runtime bar to one resolved identity string, `src` naming where it came from for the reason text. */
function decideRuntimeName(name, src, registry) {
    if (!name)
        return { decidable: false, reason: `no ${src} recorded` };
    if (name.toLowerCase() === 'unknown') {
        return { decidable: false, reason: `${src} is the \`unknown\` sentinel, which denotes a runtime that could not be detected` };
    }
    if (registry && !registry.has(name)) {
        return { decidable: false, reason: `${src}=${name} does not resolve to a registered runtime profile` };
    }
    return { decidable: true, resolved: name, reason: null };
}
export function decideRuntime(rec, registry) {
    // Dedicated coordinate first (gep-sdk 1.13.0 `runtime_profile: {runtime, env_class?}`). Same registry bar as
    // the proxy. A present-but-empty runtime_profile falls through so it never demotes a record model_name admits.
    const rp = rec['runtime_profile'];
    if (rp && typeof rp === 'object' && !Array.isArray(rp)) {
        const runtime = str(rp['runtime']);
        if (runtime)
            return decideRuntimeName(runtime, 'runtime_profile.runtime', registry);
    }
    return decideRuntimeName(str(rec['model_name']), 'model_name', registry);
}
// ---------------------------------------------------------------------------------------------------
// Verifier. Must clear a minimum semantic bar: it has to exercise the asset's own claim, not merely prove
// that an interpreter exists. We reject the known placeholder shapes rather than counting any non-empty
// validation array. This is the coordinate where a permissive predicate would be most misleading, because
// a nominal verifier is worse than an absent one: absence is honest.
// ---------------------------------------------------------------------------------------------------
const PLACEHOLDER_VERIFIER = /^(?:node|python3?|ruby|deno|bun|go|java|npm|pnpm|yarn)\s+(?:--?v(?:ersion)?|-V)\s*$/i;
const TRIVIAL_VERIFIER = /^(?:true|:|echo\b.*|exit\s+0)\s*$/i;
const isSubstantiveVerifier = (c) => !PLACEHOLDER_VERIFIER.test(c) && !TRIVIAL_VERIFIER.test(c);
export function decideVerifier(rec) {
    // Dedicated coordinate first (gep-sdk 1.13.0 `verifier_profile: {verifier, decision?}`). The verifier IDENTITY
    // string must clear the SAME minimum semantic bar as a legacy validation command — a `node --version` identity
    // is as hollow here as it is there. A present-but-empty verifier_profile falls through to the proxy.
    const vp = rec['verifier_profile'];
    if (vp && typeof vp === 'object' && !Array.isArray(vp)) {
        const verifier = str(vp['verifier']);
        if (verifier) {
            if (isSubstantiveVerifier(verifier))
                return { decidable: true, resolved: verifier, reason: null };
            return {
                decidable: false,
                reason: `verifier_profile.verifier=${verifier} is a placeholder; it establishes that an interpreter exists, not that the asset's claim holds`,
            };
        }
    }
    const cmds = arr(rec['validation']).map((c) => str(c)).filter(Boolean);
    if (cmds.length === 0)
        return { decidable: false, reason: 'validation is empty; no verifier profile' };
    const substantive = cmds.filter(isSubstantiveVerifier);
    if (substantive.length === 0) {
        return {
            decidable: false,
            reason: `all ${cmds.length} validation entr${cmds.length === 1 ? 'y is' : 'ies are'} placeholders (e.g. ${cmds[0]}); they establish that an interpreter exists, not that the asset's claim holds`,
        };
    }
    return { decidable: true, resolved: substantive[0], reason: null };
}
/**
 * Decide K_auto membership for one record. All five coordinates must be decidable; we evaluate every
 * coordinate rather than short-circuiting, so aggregate reporting can attribute the shortfall.
 */
export function decideKauto(record, opts) {
    const rec = record;
    const coordinates = {
        version: decideVersion(rec),
        claim: decideClaim(rec),
        scope: decideScope(rec),
        runtime: decideRuntime(rec, opts?.runtimeRegistry),
        verifier: decideVerifier(rec),
    };
    const blockedBy = Object.entries(coordinates).filter(([, v]) => !v.decidable).map(([k]) => k);
    return { inKauto: blockedBy.length === 0, coordinates, blockedBy };
}
/**
 * The PRESENCE proxy the original production query implemented, kept so the two can be reported side by
 * side and the gap between them quantified rather than asserted.
 */
export function decideKautoPresenceProxy(record) {
    const rec = record;
    const CATEGORIES = new Set(['repair', 'optimize', 'innovate', 'explore']);
    return Boolean(str(rec['schema_version'])
        && CATEGORIES.has(str(rec['category']))
        && arr(rec['signals_match']).length > 0
        && str(rec['model_name'])
        && arr(rec['validation']).length > 0);
}
/**
 * The SECOND track of the dual-track report (user decision: 双轨并报). Where {@link decideKauto} answers "is each
 * coordinate machine-DECIDABLE" (strict, closed-vocabulary bar), this answers the strictly weaker, writer-side
 * question "did the producer EMIT the dedicated coordinate field at all, in its canonical minimal shape". The two
 * are reported side by side so the paper can separate two failure modes that a single number conflates:
 *   - the dedicated field is ABSENT (writer never emitted it) — the 0%-adoption problem this batch attacks; vs
 *   - the dedicated field is PRESENT but its content is not yet strict (e.g. a scope signal that is not namespaced,
 *     a claim predicate outside the closed vocabulary) — a content-quality gap, not an adoption gap.
 * Structural presence NEVER implies decidability; it is deliberately permissive so the adoption-vs-quality gap is
 * visible rather than hidden inside the single strict figure.
 */
export function decideKautoStructural(record) {
    const rec = record;
    // version has no separate dedicated shape — asset_version/content_hash IS the coordinate, so structural
    // presence coincides with strict decidability here (there is no semantic bar beyond "an immutable id exists").
    const version = decideVersion(rec).decidable;
    // claim: `claims: [{predicate}]` with at least one non-empty predicate string (closed-vocabulary check is the
    // strict track's job, not this one).
    const claim = claimPredicateStrings(rec['claims']).length > 0;
    // scope: `scope: {signals: [...]}` with at least one non-empty signal (parseability is the strict track's job).
    const scopeRaw = rec['scope'];
    const scope = Boolean(scopeRaw && typeof scopeRaw === 'object' && !Array.isArray(scopeRaw)
        && arr(scopeRaw['signals']).map((t) => str(t)).filter(Boolean).length > 0);
    // runtime: `runtime_profile: {runtime}` with a non-empty runtime string (registry/sentinel is the strict track).
    const rpRaw = rec['runtime_profile'];
    const runtime = Boolean(rpRaw && typeof rpRaw === 'object' && !Array.isArray(rpRaw)
        && str(rpRaw['runtime']));
    // verifier: `verifier_profile: {verifier}` with a non-empty verifier string (placeholder bar is the strict track).
    const vpRaw = rec['verifier_profile'];
    const verifier = Boolean(vpRaw && typeof vpRaw === 'object' && !Array.isArray(vpRaw)
        && str(vpRaw['verifier']));
    const coordinates = { version, claim, scope, runtime, verifier };
    const missing = Object.entries(coordinates).filter(([, present]) => !present).map(([k]) => k);
    return { structurallyComplete: missing.length === 0, coordinates, missing };
}