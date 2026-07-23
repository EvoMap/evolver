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
import { assetstore, events, hub as hubNs, wire } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubUnreachableError, connectPublicHub, isHubDryRunEnabled } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
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
// Keep this list limited to Hub-only fields. `confidence` is canonical Capsule content and must
// survive integrity verification even though delivery rows also use a field with that name.
const HUB_METADATA_KEYS = new Set([
    'credit_cost',
    'gdi_score',
    'success_rate',
    'reuse_count',
    'ranking_score',
    'source_node_id',
    'fetched_at',
    'receipt',
    'hub_receipt',
    'already_purchased',
    '_semantic_similarity',
    'semantic_similarity',
    '_search_score',
    'search_score',
    '_match_score',
    'match_score',
    '_retrieval_rank',
    'retrieval_rank',
    'original_asset_id',
]);
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
        loadEnvFileFromEnv(env);
        const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
        // 1) Already in the local recall library → reuse is idempotent: log + ok, no hub round-trip.
        const local = await resolveLocalReuseAsset(store, opts.id);
        if (local) {
            logReuse(deps, opts, local, 'local');
            return emit({ ok: true, status: 'ok', message: 'asset already in local recall library' }, ctx);
        }
        // 2) Dry-run: describe the intended pull, touch nothing.
        if (isHubDryRunEnabled(env)) {
            return emit({ ok: true, status: 'dry_run', message: `would fetch ${opts.id} and write it to the local recall library` }, ctx);
        }
        // 3) Pull the global asset by id, write it into the local recall library (put dedups → idempotent on repeat).
        const hub = deps.hub ?? createRecipeHubFromEnv(env, deps.connectHub ?? connectPublicHub);
        // One-shot CLIs never heartbeat, so the hub may hold no env fingerprint for this node and its anti-abuse
        // layer then 403s /a2a/fetch (`bulk_fetch_blocked: IP antibody`, #555). A fingerprinted hello
        // (rotate:false + preserveCredentials:true) neither requests nor applies credential mutation while establishing
        // trust. Best-effort by design:
        // a hello failure must not block the fetch — the fetch's own error path classifies precisely.
        await establishReuseTrust(hub);
        const asset = await hub.fetchAssetById(opts.id);
        if (!asset)
            return emit({ ok: false, status: 'not_found', message: `asset ${opts.id} not found on the hub` }, ctx);
        const cleaned = await ingestHubAsset(store, deps, asset, opts.id);
        logReuse(deps, opts, cleaned, 'hub');
        return emit({ ok: true, status: 'ok', message: 'reused into local recall library' }, ctx);
    }
    catch (e) {
        return emit(mapError(e), ctx);
    }
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
                return { ok: false, status: 'unsupported', error: `unsupported reuse argument: ${flag}` };
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
            return { ok: false, status: 'unsupported', error: `unsupported reuse argument: ${token}` };
        // First (and only) bare positional is the asset id; further positionals are unsupported.
        if (positional !== undefined)
            return { ok: false, status: 'unsupported', error: `unsupported reuse argument: ${token}` };
        positional = token;
    }
    if (!jsonOut)
        return { ok: false, status: 'unsupported', error: 'reuse requires --json' };
    // Reject a stray bare positional supplied alongside --id/--id=: silently preferring the flag would let a
    // typo'd/extra arg — or a conflicting second id — pass fail-OPEN, contradicting the fail-closed contract.
    const idFromFlag = flagValue(argv, '--id');
    if (idFromFlag !== null && positional !== undefined) {
        return { ok: false, status: 'unsupported', error: `unsupported reuse argument: ${positional}` };
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
async function ingestHubAsset(store, deps, asset, requestedId) {
    const cleaned = stripHubMetadata(unwrapHubAssetContent(asset));
    const actualAssetId = wire.computeAssetId(cleaned);
    const contentAssetId = stringField(cleaned, 'asset_id');
    if (!actualAssetId || !contentAssetId || actualAssetId !== contentAssetId) {
        throw new Error('asset integrity verification failed');
    }
    if (isContentAssetId(requestedId) && actualAssetId !== requestedId) {
        throw new Error('asset integrity verification failed');
    }
    if (!isContentAssetId(requestedId) && stringField(cleaned, 'id') !== requestedId) {
        throw new Error('asset integrity verification failed');
    }
    await assertNoLocalReuseIdConflict(cleaned, store);
    const provenance = new assetstore.ProvenanceStore(storeBaseDir(store, deps));
    const stored = await assetstore.ingestUntrusted(store, provenance, cleaned, 'hub');
    return { ...cleaned, asset_id: stored.asset_id };
}
async function resolveLocalReuseAsset(store, id) {
    const direct = await store.get(id);
    if (direct)
        return direct;
    for (const kind of ['Gene', 'Capsule']) {
        const rows = await store.list(kind, 10_000);
        const match = rows.find((row) => stringField(row, 'id') === id || String(row.asset_id) === id);
        if (match)
            return match;
    }
    return null;
}
async function assertNoLocalReuseIdConflict(asset, store) {
    if (asset.type !== 'Gene' && asset.type !== 'Capsule')
        return;
    const id = stringField(asset, 'id');
    if (!id)
        return;
    const rows = await store.list(asset.type, 10_000);
    const local = rows.find((row) => stringField(row, 'id') === id);
    if (!local)
        return;
    const incomingAssetId = wire.computeAssetId(asset);
    const localAssetId = wire.computeAssetId(local);
    if (incomingAssetId !== localAssetId)
        throw new Error('local asset id conflict');
}
function unwrapHubAssetContent(asset) {
    const payload = asset.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && stringField(payload, 'asset_id')) {
        return payload;
    }
    return asset;
}
function stripHubMetadata(asset) {
    const out = {};
    for (const [key, value] of Object.entries(asset))
        if (!HUB_METADATA_KEYS.has(key))
            out[key] = value;
    return out;
}
function storeBaseDir(store, deps) {
    return store instanceof assetstore.LocalJsonlProvider ? store.baseDir : deps.assetsDir ?? events.assetsDir();
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function isContentAssetId(value) {
    return value.startsWith('sha256:');
}
function logReuse(deps, opts, asset, source) {
    // AssetCallLog.append is best-effort (never throws) — a logging failure must not break the reuse write.
    const callLog = deps.callLog ?? new hubNs.AssetCallLog(events.assetCallLogPath());
    callLog.append({
        action: 'asset_reuse',
        asset_id: asset.asset_id,
        asset_type: asset.type,
        mode: opts.mode,
        ...(opts.runId ? { run_id: opts.runId } : {}),
        extra: { source },
    });
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
function mapError(e) {
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
    if (/Hub URL|EVOMAP_HUB_URL|A2A_HUB_URL/i.test(msg)) {
        return { ok: false, status: 'unavailable', message: redact(msg) };
    }
    if (/Hub credentials|node identity|evolver login|EVOMAP_NODE_SECRET/i.test(msg)) {
        return { ok: false, status: 'unauthorized', message: redact(msg) };
    }
    if (/\b(?:hub|http)\s*5\d\d\b/i.test(msg) || /\b(network|fetch failed|ECONN[A-Z_]*|ENOTFOUND|ETIMEDOUT)\b/i.test(msg)) {
        return { ok: false, status: 'network', message: 'hub is unreachable' };
    }
    return { ok: false, status: 'internal_error', message: redact(msg) };
}
function emit(outcome, ctx) {
    if (ctx.jsonOut) {
        // stdout ONLY, exactly one object — the desktop adapter json.Unmarshals the whole stdout stream.
        const envelope = { ok: outcome.ok, contract: REUSE_CONTRACT, status: outcome.status, reason: outcome.status, message: outcome.message };
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
/** Defensive redaction so a stray credential in an error string never reaches stdout/stderr. */
function redact(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/\b([A-Z][A-Z0-9_]*(?:_SECRET|_TOKEN))\b\s*[:=]\s*["']?[^"',\s;}]+/g, '$1=[redacted]')
        .replace(/\b(authorization|node_secret|nodeSecret|access_token|refresh_token|token|secret)\b\s*[:=]\s*["']?[^"',\s;}]+/gi, '$1=[redacted]')
        .replace(/\bsk-[A-Za-z0-9-]{16,}/g, 'sk-[redacted]')
        .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[redacted]');
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