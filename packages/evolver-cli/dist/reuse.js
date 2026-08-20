// `evolver reuse --id <asset_id> [--mode reference|direct] [--run <run_id>] [--json]`
//
// FR-C5 完整态 native write path (docs/evomap-write-flows-design.md §4): pull ONE global asset by id into this
// machine's local recall library + record one `asset_reuse` audit line. One-shot writes are owned by evolver-cli
// (主题 C 写通道方案 B); the proxy HTTP surface stays read/connectivity-oriented.
//
// The `--json` output is the STABLE `reuse.v1` machine contract consumed by evox-desktop's
// EvolverProxyAPI.ReuseAsset (backend/bindings/evolver_proxy.go `evolverReuseEnvelope`, locked per evox-desktop
// #1008). That adapter parses stdout JSON ONLY (never stderr/interactive output), keys on `contract === "reuse.v1"`,
// and degrades to the agent `/pack apply` path on any non-ok result. Two hard rules follow:
//   1. Print EXACTLY ONE envelope object to STDOUT on BOTH success and failure (in --json mode).
//   2. NEVER let a token/secret reach any stream — error text is mapped to fixed messages / redacted.
import { assetrepair, assetstore, events, hub as hubNs, wire } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubUnreachableError, connectPublicHub, isHubDryRunEnabled, stripHubDeliveryMetadataForIntegrity, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv, proxyClientFromEnv } from '@evomap/evolver-mcp';
import { createRecipeHubFromEnv } from './recipe.js';
import { getCliVersion } from './version.js';
const REUSE_CONTRACT = 'reuse.v1';
const MAX_ID_LENGTH = 200;
const REUSE_USAGE = [
    'usage: evolver reuse --id <asset_id> --json [--mode reference|direct] [--run <run_id>]',
    '       evolver reuse <asset_id> --json [--mode reference|direct] [--run <run_id>]',
].join('\n');
// Flags that consume the following token as their value. firstPositional must skip those values so a flag value
// (e.g. the `reference` in `--mode reference`) is never mistaken for a bare positional asset id.
const VALUE_FLAGS = new Set(['--id', '--mode', '--run']);
export async function runReuseCommand(argv, deps = {}) {
    const ctx = {
        jsonOut: argv.includes('--json'),
        stdout: deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); }),
        stderr: deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); }),
    };
    if (argv.includes('--help') || argv.includes('-h')) {
        if (ctx.jsonOut) {
            ctx.stdout(JSON.stringify({
                ok: true,
                contract: REUSE_CONTRACT,
                status: 'ok',
                reason: 'help',
                message: REUSE_USAGE,
            }));
            return 0;
        }
        ctx.stdout(REUSE_USAGE);
        return 0;
    }
    const parsed = parseReuseArgs(argv);
    if (!parsed.ok)
        return emit({ ok: false, status: parsed.status ?? 'invalid_arg', message: parsed.error }, ctx);
    const opts = parsed.value;
    try {
        const env = deps.env ?? process.env;
        // Keep the native reuse path aligned with publish/contract transport: env-file values must be present before
        // dry-run checks and Hub construction. The loader mutates `env` and does not expose secret values.
        const envFile = loadEnvFileFromEnv(env);
        if (envFile.error)
            throw new Error('failed to load EVOLVER_ENV_FILE');
        const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir(env));
        // 1) Already in the local recall library → reuse is idempotent: log + ok, no hub round-trip.
        const local = await resolveLocalReuseAsset(store, opts.id);
        if (local) {
            const disposition = localReuseDisposition(local, store, deps);
            if (disposition === 'revoked') {
                return emit({ ok: false, status: 'integrity_failed', message: 'local asset has been revoked' }, ctx);
            }
            if (disposition === 'reusable') {
                logReuse(deps, opts, local, 'local');
                return emit({ ok: true, status: 'ok', message: 'asset already in local recall library' }, ctx);
            }
        }
        // 2) Dry-run: describe the intended pull, touch nothing.
        if (isHubDryRunEnabled(env)) {
            return emit({ ok: true, status: 'dry_run', message: 'would fetch the requested asset and write it to the local recall library' }, ctx);
        }
        // 3) Pull the global asset by id, write it into the local recall library (put dedups → idempotent on repeat).
        const hub = deps.hub ?? createReuseFetcherFromEnv(env, deps);
        // One-shot CLIs never heartbeat, so the hub may hold no env fingerprint for this node and its anti-abuse
        // layer then 403s /a2a/fetch (`bulk_fetch_blocked: IP antibody`, #555). A fingerprinted hello
        // (rotate:false + preserveCredentials:true) neither requests nor applies credential mutation while establishing
        // trust. Best-effort by design:
        // a hello failure must not block the fetch — the fetch's own error path classifies precisely.
        await establishReuseTrust(hub);
        // This command owns the quarantine path below. Keep the shared adapter strict for every other caller and
        // explicitly request an exact declared-ID delivery only where we will revalidate and freeze it as unverified.
        const delivery = await fetchReuseDelivery(hub, opts.id);
        if (delivery.status === 'absent')
            return emit({ ok: false, status: 'not_found', message: 'asset not found on the hub' }, ctx);
        if (delivery.status === 'rejected')
            return emit(rejectedDeliveryOutcome(delivery.reason), ctx);
        const { record, verified, repaired } = await ingestHubAsset(store, deps, delivery.asset, opts.id);
        logReuse(deps, opts, record, 'hub');
        // Both land the asset (exit 0). A verified reuse is a plain success; an unverified one is a first-class
        // success too — the operator's save happened — but carries reason `unverified` so the desktop adapter can
        // surface "added (unverified)" instead of a plain "added". status stays `ok` so older desktop builds, which
        // key success on status==='ok' and ignore reason, keep working unchanged.
        if (verified)
            return emit({ ok: true, status: 'ok', message: 'reused into local recall library' }, ctx);
        return emit({
            ok: true,
            status: 'ok',
            reason: 'unverified',
            message: repaired
                ? 'reused into local recall library as untrusted: hub-delivered content was incomplete and was repaired to a schema-valid record; it does not match its content fingerprint and could not be verified'
                : 'reused into local recall library as untrusted: hub-delivered content does not match its content fingerprint and could not be verified',
        }, ctx);
    }
    catch (e) {
        return emit(mapError(e), ctx);
    }
}
function createReuseFetcherFromEnv(env, deps) {
    const hubMode = configuredHubMode(env);
    if (hubMode === 'public') {
        return createRecipeHubFromEnv(env, deps.connectHub ?? connectPublicHub);
    }
    const proxy = (deps.resolveProxyClient ?? proxyClientFromEnv)(env);
    if (!proxy)
        throw new Error('private Hub proxy is not configured');
    return {
        fetchAssetById: async (assetId) => {
            const body = await proxy.fetchAsset({ assetId, expectedHubMode: 'private' });
            return selectPrivateReuseAsset(body, assetId);
        },
    };
}
function configuredHubMode(env) {
    const value = String(env['EVOMAP_HUB_MODE'] ?? 'public').trim().toLowerCase();
    if (value === 'public' || value === 'private')
        return value;
    throw new Error('EVOMAP_HUB_MODE must be public or private');
}
function selectPrivateReuseAsset(body, requestedId) {
    const root = recordValue(body);
    const payload = recordValue(root['payload']);
    const candidates = Array.isArray(root['assets'])
        ? root['assets']
        : Array.isArray(payload['assets'])
            ? payload['assets']
            : [];
    const matches = [];
    for (const candidate of candidates) {
        const record = optionalRecord(candidate);
        if (!record || !privateDeliveryMatchesRequestedId(record, requestedId))
            continue;
        const asset = record;
        const delivery = unwrapHubAssetContent(asset);
        const cleaned = stripHubDeliveryMetadataForIntegrity(delivery.content);
        let canonical;
        try {
            canonical = wire.canonicalize(cleaned);
        }
        catch {
            throw integrityError(delivery.synthesized);
        }
        matches.push({ asset, canonical, synthesized: delivery.synthesized });
    }
    if (matches.length === 0)
        return null;
    if (matches.some((match) => match.canonical !== matches[0].canonical)) {
        throw integrityError(matches.some((match) => match.synthesized));
    }
    return matches.find((match) => match.synthesized)?.asset ?? matches[0].asset;
}
function privateDeliveryMatchesRequestedId(record, requestedId) {
    const payload = optionalRecord(record['payload']);
    if (requestedId.startsWith('sha256:')) {
        return stringField(record, 'asset_id') === requestedId
            || (payload !== undefined && stringField(payload, 'asset_id') === requestedId);
    }
    return stringField(record, 'id') === requestedId
        || stringField(record, 'local_id') === requestedId
        || (payload !== undefined && stringField(payload, 'id') === requestedId);
}
/** Flags this CLI understands. parseReuseArgs walks argv and rejects anything outside this set with reason
 *  `unsupported` so a typoed flag never silently falls through to a Hub round-trip — review blocker on V1 #283
 *  (the previous tightening lived only in cliContracts.ts; dispatch.ts routes `reuse` here, so this is the path
 *  end-users actually hit). Message text MUST stay byte-equal to cliContracts.ts::parseReuseArgs for v1↔v2 parity. */
const KNOWN_REUSE_FLAGS = new Set(['--id', '--mode', '--run', '--json']);
export function parseReuseArgs(argv) {
    // Walk argv explicitly so unknown long flags fail closed instead of being ignored. We still let `--id`/`--mode`/
    // `--run` use either `--flag value` or `--flag=value`, and we still accept a single bare positional as the id
    // (the legacy ergonomics covered by parseReuseArgs's own contract test + recipe.ts callers).
    let jsonOut = false;
    let positional;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === undefined)
            continue;
        if (token === '--json') {
            jsonOut = true;
            continue;
        }
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            const flag = eq >= 0 ? token.slice(0, eq) : token;
            if (!KNOWN_REUSE_FLAGS.has(flag))
                return { ok: false, status: 'unsupported', error: 'unsupported reuse argument' };
            if (eq < 0 && VALUE_FLAGS.has(flag)) {
                // Value flag in space form consumes the next token; skip it so it doesn't get re-checked as a flag/positional.
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith('--'))
                    i += 1;
            }
            continue;
        }
        // Reject single-dash short options (e.g. `-x`) before the bare-positional branch: they bypass the
        // `--`-prefixed check above and would otherwise be silently accepted as an asset id, violating the
        // fail-closed contract. Legal asset ids (`sha256:…`, `gene_distilled_…`, logical ids) never start with `-`.
        if (token.startsWith('-'))
            return { ok: false, status: 'unsupported', error: 'unsupported reuse argument' };
        // First (and only) bare positional is the asset id; further positionals are unsupported.
        if (positional !== undefined)
            return { ok: false, status: 'unsupported', error: 'unsupported reuse argument' };
        positional = token;
    }
    if (!jsonOut)
        return { ok: false, status: 'unsupported', error: 'reuse requires --json' };
    // Reject a stray bare positional supplied alongside --id/--id=: silently preferring the flag would let a
    // typo'd/extra arg — or a conflicting second id — pass fail-OPEN, contradicting the fail-closed contract.
    const idFromFlag = flagValue(argv, '--id');
    if (idFromFlag !== null && positional !== undefined) {
        return { ok: false, status: 'unsupported', error: 'unsupported reuse argument' };
    }
    const id = idFromFlag ?? positional;
    if (!id)
        return { ok: false, status: 'missing_id', error: 'reuse requires --id <asset_id>' };
    if (id.length > MAX_ID_LENGTH)
        return { ok: false, status: 'missing_id', error: `asset id must be <= ${MAX_ID_LENGTH} characters` };
    const modeRaw = flagValue(argv, '--mode');
    if (modeRaw !== null && modeRaw !== 'direct' && modeRaw !== 'reference')
        return { ok: false, status: 'invalid_arg', error: '--mode must be direct|reference' };
    const runId = flagValue(argv, '--run');
    return { ok: true, value: { id, mode: modeRaw === 'direct' ? 'direct' : 'reference', ...(runId ? { runId } : {}) } };
}
// Integrity rejection is a first-class outcome, not an internal fault: the hub demonstrably rewrites
// delivered payloads (injected `validation`, wholesale `payload_backfill_reason` synthesis — #570), so the
// desktop adapter needs a typed reason to tell "this asset cannot be verified" apart from "the engine broke".
// Messages are fixed strings by construction (hard rule 2: nothing dynamic can reach a stream).
class ReuseIntegrityError extends Error {
}
const INTEGRITY_MISMATCH_MESSAGE = 'hub-delivered content does not match the asset content fingerprint';
const INTEGRITY_BACKFILLED_MESSAGE = 'hub delivered a synthesized payload for this asset; the original published content is unavailable for verification';
const INTEGRITY_LOGICAL_ID_MESSAGE = 'hub-delivered asset does not match the requested logical id';
const INTEGRITY_INCOMPLETE_MESSAGE = 'hub-delivered content is missing fields that cannot be repaired without the original publisher';
const INTEGRITY_REVOKED_MESSAGE = 'hub-delivered asset has been revoked';
function integrityError(synthesized) {
    return new ReuseIntegrityError(synthesized ? INTEGRITY_BACKFILLED_MESSAGE : INTEGRITY_MISMATCH_MESSAGE);
}
async function ingestHubAsset(store, deps, asset, requestedId) {
    const delivery = unwrapHubAssetContent(asset);
    // Use the same content projection as the public adapter and sync. Delivery metadata is classified first, then
    // removed from every hash and from the stored bytes; Capsule confidence remains canonical content.
    const projection = stripHubDeliveryMetadataForIntegrity(delivery.content);
    const synthesized = delivery.synthesized;
    const type = stringField(projection, 'type');
    const contentAssetId = stringField(projection, 'asset_id');
    if ((type !== 'Gene' && type !== 'Capsule') || !contentAssetId || !isContentAssetId(contentAssetId)) {
        throw integrityError(synthesized);
    }
    // The hub delivers a LOSSY projection of the published record (dropped `schema_version`/`id`, emptied
    // `constraints`, extra non-schema keys — measured across promoted genes on 2026-08-14), so a schema verdict
    // here is a verdict on the DELIVERY, not on the asset. Repair it into a storable record instead of throwing
    // the asset away; the identity guards below stay untouched, and the result is still quarantined as unverified.
    const repair = repairHubProjection(projection, contentAssetId);
    if (!repair.ok)
        throw new ReuseIntegrityError(repair.message);
    const cleaned = repair.record;
    try {
        assetstore.assertCapsuleGeneBinding(cleaned);
    }
    catch (error) {
        if (error instanceof assetstore.CapsuleGeneBindingError)
            throw integrityError(synthesized);
        throw error;
    }
    const actualAssetId = wire.computeAssetId(cleaned);
    if (!actualAssetId || !isContentAssetId(actualAssetId)) {
        // Malformed beyond classification — no computable hash or no declared id — stays a hard reject.
        throw integrityError(synthesized);
    }
    // Identity guards stay STRICT: a hub that returned a DIFFERENT asset than requested (a self-consistent asset
    // B under a request for A, or a different logical id) is a delivery fault, not the hub's known content-rewrite
    // of the RIGHT asset — reject it so a reuse never silently pulls the wrong gene.
    if (requestedId.startsWith('sha256:')) {
        if (!isContentAssetId(requestedId))
            throw integrityError(synthesized);
        if (contentAssetId !== requestedId)
            throw integrityError(synthesized);
    }
    else if (stringField(cleaned, 'id') !== requestedId) {
        throw new ReuseIntegrityError(INTEGRITY_LOGICAL_ID_MESSAGE);
    }
    const provenance = new assetstore.ProvenanceStore(storeBaseDir(store, deps));
    // Identity is confirmed; now content integrity. When the (marker-free) payload hashes to its declared id it
    // lands verified (still sidecar-marked untrusted per #30). When it does NOT, the hub rewrote the delivered
    // bytes of the right asset (#570) — DOWNGRADE instead of reject: freeze it under the network id and mark it
    // unverified so the save actually happens and the loop (which already reuses hub content without
    // re-verifying) can use it, while trust-first selection keeps it out of the reasoning pool until promotion.
    if (actualAssetId === contentAssetId) {
        const stored = await assetstore.ingestUntrustedConditional(store, provenance, cleaned);
        if (stored.status === 'logical_collision')
            throw new Error('local asset id conflict');
        return { record: { ...cleaned, asset_id: stored.asset_id }, verified: true, repaired: false };
    }
    const reason = synthesized ? 'unverified_hub_synthesized' : 'unverified_hub_rewrite';
    const stored = await assetstore.ingestUnverifiedConditional(store, provenance, cleaned, reason);
    if (stored.status === 'logical_collision')
        throw new Error('local asset id conflict');
    return { record: { ...cleaned, asset_id: stored.asset_id }, verified: false, repaired: repair.repaired };
}
/**
 * Make a hub delivery storable without letting it drift off the network identity it was fetched under.
 * `repairAssetRecord` re-derives `asset_id` from the repaired content by design; here the DECLARED network id
 * must survive instead, because the quarantine write freezes the repaired body under that id.
 */
function repairHubProjection(projection, declaredAssetId) {
    const report = assetrepair.repairAssetRecord(projection);
    if (report.status === 'already_valid')
        return { ok: true, record: projection, repaired: false };
    if (report.status === 'unrepairable') {
        return { ok: false, message: `${INTEGRITY_INCOMPLETE_MESSAGE}: ${blockerSummary(report.blockers)}` };
    }
    const repairedContent = report.changes.some((change) => change.path !== 'asset_id');
    return {
        ok: true,
        record: { ...report.asset, asset_id: declaredAssetId },
        repaired: repairedContent,
    };
}
// Hard rule 2 of this command: nothing dynamic reaches a stream unfiltered. Field paths come from the schema
// gate, but an `additionalProperties` path is named by hub-controlled content — so only plain field-path shapes
// pass, and only a handful of them.
const SAFE_FIELD_PATH = /^[A-Za-z0-9_.[\]]{1,40}$/;
function blockerSummary(blockers) {
    const fields = [...new Set(blockers.map((blocker) => blocker.path))]
        .filter((path) => SAFE_FIELD_PATH.test(path))
        .slice(0, 5);
    return fields.length > 0 ? `unrepairable fields: ${fields.join(', ')}` : 'the delivered record could not be classified';
}
async function fetchReuseDelivery(hub, assetId) {
    const options = { allowUnverifiedExactIdentity: true };
    if (hub.fetchAssetDeliveryById)
        return hub.fetchAssetDeliveryById(assetId, options);
    const asset = await hub.fetchAssetById(assetId, options);
    return asset ? { status: 'delivered', asset, verified: true } : { status: 'absent' };
}
// A delivered-but-refused asset is NOT a missing asset. Reporting both as `not_found` sent operators looking for
// an asset the hub was serving the whole time; each rejection now names what the hub actually did.
function rejectedDeliveryOutcome(reason) {
    const messages = {
        identity_mismatch: 'hub delivered an asset whose identity does not match the requested id',
        revoked: INTEGRITY_REVOKED_MESSAGE,
        ambiguous: 'hub delivered conflicting copies of the requested asset',
        unverified_not_allowed: INTEGRITY_MISMATCH_MESSAGE,
    };
    return { ok: false, status: 'integrity_failed', message: messages[reason] };
}
async function resolveLocalReuseAsset(store, id) {
    // A logical id does not identify an asset type. Gene and Capsule ids may overlap, so only the Hub can resolve
    // which remote asset the caller requested; treating either local type as a hit can silently reuse the wrong one.
    return isContentAssetId(id) ? store.get(id) : null;
}
function unwrapHubAssetContent(asset) {
    const row = asset;
    const payload = optionalRecord(row['payload']);
    // Revocation is a delivery decision, not canonical content. Reject it before wrapper unwrapping or metadata
    // stripping can erase the marker and accidentally turn a revoked listing/fetch race into an ingestible asset.
    if (hasRevokedDeliveryMarker(row) || (payload !== undefined && hasRevokedDeliveryMarker(payload))) {
        throw new ReuseIntegrityError(INTEGRITY_REVOKED_MESSAGE);
    }
    const outerType = stringField(row, 'type');
    const innerType = payload ? stringField(payload, 'type') : undefined;
    const synthesized = stringField(row, 'payload_backfill_reason') !== undefined
        || (payload !== undefined && stringField(payload, 'payload_backfill_reason') !== undefined);
    // A typed row is already a raw GEP record. Do not reinterpret a canonical payload field as a delivery wrapper.
    if (outerType !== undefined || !payload || innerType === undefined) {
        const transportType = stringField(row, 'asset_type');
        const transportLogicalId = stringField(row, 'local_id');
        if ((transportType !== undefined && transportType !== outerType)
            || (transportLogicalId !== undefined && transportLogicalId !== stringField(row, 'id'))) {
            throw integrityError(synthesized);
        }
        return { content: asset, synthesized };
    }
    const outerAssetId = stringField(row, 'asset_id');
    const innerAssetId = stringField(payload, 'asset_id');
    const outerAssetType = stringField(row, 'asset_type');
    const innerLogicalId = stringField(payload, 'id');
    if (!outerAssetId
        || !innerAssetId
        || outerAssetId !== innerAssetId
        || (outerAssetType !== undefined && outerAssetType !== innerType)
        || (stringField(row, 'id') !== undefined && stringField(row, 'id') !== innerLogicalId)
        || (stringField(row, 'local_id') !== undefined && stringField(row, 'local_id') !== innerLogicalId)) {
        throw integrityError(synthesized);
    }
    return { content: payload, synthesized };
}
function hasRevokedDeliveryMarker(record) {
    return ['status', 'trust_state'].some((key) => {
        const value = record[key];
        return typeof value === 'string' && value.trim().toLowerCase() === 'revoked';
    });
}
function storeBaseDir(store, deps) {
    return store instanceof assetstore.LocalJsonlProvider
        ? store.baseDir
        : deps.assetsDir ?? events.assetsDir(deps.env ?? process.env);
}
function localReuseDisposition(asset, store, deps) {
    const record = new assetstore.ProvenanceStore(storeBaseDir(store, deps)).get(asset.asset_id);
    // An explicit revoke dominates content-hash validity and every prior trust state. Do not let a canonical body
    // bypass the operator decision, and do not fall through to Hub refetch: this local id is intentionally blocked.
    if (record?.decision === 'revoked')
        return 'revoked';
    if (wire.verifyAssetId(asset))
        return 'reusable';
    if (record?.trusted === true || record?.decision === 'promoted')
        return 'reusable';
    const supportedReason = (record?.source === 'hub'
        && (record.reason === 'unverified_hub_rewrite' || record.reason === 'unverified_hub_synthesized')) || (record?.source === 'migrated' && record.reason === 'unverified_gepx_import');
    const isActiveWaiver = supportedReason
        && record.trusted === false
        && record.decision === undefined
        && record.decidedBy === undefined
        && record.promotedBy === undefined
        && record.frozenContentId === wire.computeAssetId(asset);
    return isActiveWaiver ? 'reusable' : 'refetch';
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function isContentAssetId(value) {
    return /^sha256:[0-9a-f]{64}$/.test(value);
}
function logReuse(deps, opts, asset, source) {
    // AssetCallLog.append is best-effort (never throws) — a logging failure must not break the reuse write.
    const callLog = deps.callLog ?? new hubNs.AssetCallLog(events.assetCallLogPath(deps.env ?? process.env));
    let indexedTokenCost;
    try {
        indexedTokenCost = callLog.assetCostIndex?.()[asset.asset_id];
    }
    catch { /* fall back to the estimator */ }
    const savings = hubNs.reuseSavingsForAsset(asset, opts.mode, indexedTokenCost);
    try {
        callLog.append({
            action: opts.mode === 'reference' ? 'asset_reference' : 'asset_reuse',
            asset_id: asset.asset_id,
            asset_type: asset.type,
            mode: opts.mode,
            tokens_saved: savings.tokens_saved,
            tokens_saved_basis: savings.tokens_saved_basis,
            ...(opts.runId ? { run_id: opts.runId } : {}),
            extra: { source },
        });
    }
    catch { /* an injected logger must preserve the production logger's non-fatal contract */ }
}
async function establishReuseTrust(hub) {
    if (typeof hub.hello !== 'function')
        return;
    try {
        await hub.hello({ rotate: false, evolverVersion: getCliVersion(), preserveCredentials: true });
    }
    catch { /* fetch decides the outcome */ }
}
const ANTI_ABUSE_BLOCK_MESSAGE = 'hub anti-abuse temporarily blocked asset fetch for this node; keep the local Evolver proxy running so the node builds trust, then retry';
function antiAbuseOutcome() {
    return { ok: false, status: 'rate_limited', message: ANTI_ABUSE_BLOCK_MESSAGE };
}
function isAntiAbuseFetchBlock(status, code) {
    return status === 403 && code !== undefined && /antibody|bulk_fetch|anti[-_]?abuse/i.test(code);
}
function hubErrorField(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const err = body['error'];
    return typeof err === 'string' ? err : undefined;
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function optionalRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function mapError(e) {
    if (e instanceof ReuseIntegrityError) {
        return { ok: false, status: 'integrity_failed', message: e.message };
    }
    if (e instanceof AuthError) {
        // hubFetch raises AuthError for BOTH 401 and 403, so the hub's anti-abuse 403
        // (`bulk_fetch_blocked: IP antibody active`) used to be misreported as "log in" — it is an
        // abuse-control block on a perfectly healthy credential, not an auth failure (#555).
        if (isAntiAbuseFetchBlock(e.status, e.errorCode))
            return antiAbuseOutcome();
        return { ok: false, status: 'unauthorized', message: 'hub authentication failed; run `evolver login` or set EVOMAP_NODE_SECRET' };
    }
    if (e instanceof HubUnreachableError)
        return { ok: false, status: 'network', message: 'hub is unreachable' };
    if (e instanceof HubClientError) {
        if (e.status === 429)
            return { ok: false, status: 'rate_limited', message: 'hub rate limited the request; retry later' };
        if (isAntiAbuseFetchBlock(e.status, hubErrorField(e.body)))
            return antiAbuseOutcome();
        if (e.status === 401 || e.status === 403)
            return { ok: false, status: 'unauthorized', message: 'hub authentication failed; run `evolver login` or set EVOMAP_NODE_SECRET' };
        if (e.status === 404)
            return { ok: false, status: 'not_found', message: 'asset not found on the hub' };
        if (e.status >= 500)
            return { ok: false, status: 'network', message: 'hub is temporarily unavailable' };
        return { ok: false, status: 'internal_error', message: 'hub rejected the reuse request' };
    }
    // createRecipeHubFromEnv/connectHub can throw plain configuration errors. Keep Hub URL issues apart from auth:
    // a bad URL is a configuration gap, NOT an auth failure — conflating them would tell the operator/desktop adapter
    // to "log in" when the real fix is to correct the Hub URL.
    const msg = e instanceof Error ? e.message : String(e);
    if (/failed to load EVOLVER_ENV_FILE/i.test(msg)) {
        return { ok: false, status: 'unavailable', message: 'failed to load EVOLVER_ENV_FILE' };
    }
    if (/EVOMAP_HUB_MODE must be public or private/i.test(msg)) {
        return { ok: false, status: 'unavailable', message: 'EVOMAP_HUB_MODE must be public or private' };
    }
    if (/private Hub proxy is not configured/i.test(msg)) {
        return { ok: false, status: 'unavailable', message: 'private Hub proxy is not configured' };
    }
    if (/Hub URL|EVOMAP_HUB_URL|A2A_HUB_URL/i.test(msg)) {
        return { ok: false, status: 'unavailable', message: 'hub URL configuration is invalid' };
    }
    if (/Hub credentials|node identity|evolver login|EVOMAP_NODE_SECRET/i.test(msg)) {
        return { ok: false, status: 'unauthorized', message: 'hub authentication failed; run `evolver login` or set EVOMAP_NODE_SECRET' };
    }
    if (/\b(?:hub|http)\s*5\d\d\b/i.test(msg) || /\b(network|fetch failed|ECONN[A-Z_]*|ENOTFOUND|ETIMEDOUT)\b/i.test(msg)) {
        return { ok: false, status: 'network', message: 'hub is unreachable' };
    }
    if (msg === 'local asset id conflict') {
        return { ok: false, status: 'internal_error', message: 'local asset id conflict' };
    }
    return { ok: false, status: 'internal_error', message: 'reuse operation failed' };
}
function emit(outcome, ctx) {
    if (ctx.jsonOut) {
        // stdout ONLY, exactly one object — the desktop adapter json.Unmarshals the whole stdout stream.
        const envelope = { ok: outcome.ok, contract: REUSE_CONTRACT, status: outcome.status, reason: outcome.reason ?? outcome.status, message: outcome.message };
        ctx.stdout(JSON.stringify(envelope));
    }
    else if (outcome.ok) {
        ctx.stdout(`reuse: ${outcome.message}`);
    }
    else {
        ctx.stderr(`reuse failed (${outcome.status}): ${outcome.message}`);
    }
    return outcome.ok ? 0 : 1;
}
function flagValue(args, flag) {
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token === undefined)
            continue;
        if (token === flag) {
            const next = args[i + 1];
            return next && !next.startsWith('--') ? next : null;
        }
        if (token.startsWith(`${flag}=`))
            return token.slice(flag.length + 1);
    }
    return null;
}