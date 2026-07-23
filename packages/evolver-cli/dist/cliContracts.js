import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect, format } from 'node:util';
import { assetstore, events, hub, wire } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubFetch, HubUnreachableError, connectPublicHub, gepEnvelope, globalFetchLike, resolveHubUrl, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { resolveAtpHome, resolveAtpSenderId } from './atp.js';
const REUSE_CONTRACT = 'reuse.v1';
const PUBLISH_CONTRACT = 'publish.v1';
const REVERSIBILITY = 'irreversible';
const MAX_ASSETS = 50;
const PUBLISH_USAGE = [
    'usage: evolver publish --asset <gene_id_or_path> --asset <capsule_id_or_path> --json [--dry-run]',
    '       evolver publish --gene <id_or_path> --capsule <id_or_path> --json [--dry-run]',
].join('\n');
const ASSET_FLAGS = new Set(['--asset', '--gene', '--capsule', '--event']);
const STABLE_CONTRACT_REASONS = new Set([
    'missing_id',
    'cli_unavailable',
    'auth_required',
    'not_found',
    'network_error',
    'unsupported',
    'internal_error',
    'redaction_unavailable',
    'leak_detected',
    'schema_invalid',
    'bundle_required',
    'quality_gate_failed',
    'insufficient_credits',
]);
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
let machineJsonStdoutBypass;
class ContractError extends Error {
    reason;
    safeMessage;
    constructor(reason, safeMessage) {
        super(safeMessage);
        this.reason = reason;
        this.safeMessage = safeMessage;
        this.name = 'ContractError';
    }
}
export async function runReuseCommand(args, deps = {}) {
    const out = deps.out ?? process.stdout;
    const parsed = parseReuseArgs(args);
    const write = (value, code) => writeJson(out, value, code, deps);
    if (!parsed.ok || !parsed.assetId)
        return write(reuseFailure(parsed.reason ?? 'missing_id', parsed.message ?? 'reuse requires --id <asset_id>'), 1);
    const assetId = parsed.assetId;
    return withMachineJsonConsole(Boolean(parsed.jsonOut), deps, async () => {
        try {
            const fetcher = deps.fetchAssetById ?? deps.transport?.fetchAssetById ?? createDefaultTransport(deps).fetchAssetById;
            const asset = await fetcher(assetId);
            if (!asset)
                return write(reuseFailure('not_found', 'asset not found'), 1);
            const cleaned = stripHubMetadata(asset);
            if (wire.computeAssetId(cleaned) !== assetId) {
                return write(reuseFailure('internal_error', 'asset integrity verification failed'), 1);
            }
            const store = deps.assetStore ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
            await assertNoLocalReuseIdConflict(cleaned, store);
            const provenance = new assetstore.ProvenanceStore(storeBaseDir(store, deps));
            const stored = await assetstore.ingestUntrusted(store, provenance, cleaned, 'hub');
            return write({
                ok: true,
                contract: REUSE_CONTRACT,
                status: 'ok',
                asset_id: stored.asset_id,
                action: 'reused',
            }, 0);
        }
        catch (err) {
            const failure = classifyError(err, 'reuse');
            return write(reuseFailure(failure.reason, failure.message), 1);
        }
    });
}
export async function runPublishCommand(args, deps = {}) {
    const out = deps.out ?? process.stdout;
    if (args.includes('--help') || args.includes('-h')) {
        if (args.includes('--json')) {
            return writeJson(out, {
                ok: true,
                contract: PUBLISH_CONTRACT,
                mode: 'help',
                usage: PUBLISH_USAGE,
            }, 0, deps);
        }
        out.write(`${PUBLISH_USAGE}\n`);
        return 0;
    }
    const parsed = parsePublishArgs(args);
    const write = (value, code) => writeJson(out, value, code, deps);
    if (!parsed.ok || !parsed.assetRefs) {
        return write(publishFailure(parsed.reason ?? 'bundle_required', parsed.message ?? publishReasonMessage('bundle_required'), { retryable: false }), 1);
    }
    const assetRefs = parsed.assetRefs;
    return withMachineJsonConsole(Boolean(parsed.jsonOut), deps, async () => {
        try {
            const bundle = await buildPublishBundle(assetRefs, deps);
            if (!bundle.ok) {
                return write(publishFailure(bundle.reason, bundle.message, { retryable: false, gates: bundle.gates }), 1);
            }
            if (bundle.blockReasons.length > 0) {
                if (parsed.dryRun)
                    return write(dryRunEnvelope(bundle), 0);
                const reason = bundle.blockReasons[0] ?? 'internal_error';
                return write(publishFailure(reason, publishReasonMessage(reason), {
                    retryable: false,
                    mode: 'publish',
                    gates: bundle.gates,
                    assets: bundle.assets,
                }), 1);
            }
            const transport = deps.transport ?? createDefaultTransport(deps);
            const validate = deps.validate ?? transport.validate;
            const validation = await validate(bundle.sanitized);
            const validationCredits = extractCredits(validation.body);
            if (!validation.ok) {
                const reason = publishReasonFromResponse(validation.status, validation.body);
                const detail = hubDetailFromBody(validation.body);
                if (parsed.dryRun && reason === 'quality_gate_failed') {
                    bundle.gates.quality = 'fail';
                    if (!bundle.blockReasons.includes('quality_gate_failed'))
                        bundle.blockReasons.push('quality_gate_failed');
                    return write(dryRunEnvelope(bundle, validationCredits, detail), 0);
                }
                return write(publishFailure(reason, publishReasonMessage(reason), {
                    retryable: publishRetryable(reason),
                    mode: parsed.dryRun ? 'dry_run' : 'publish',
                    gates: parsed.dryRun ? bundle.gates : { ...bundle.gates, quality: 'fail' },
                    assets: bundle.assets,
                    ...(detail ? { detail } : {}),
                    ...(validationCredits ? { credits: validationCredits } : {}),
                }), 1);
            }
            if (parsed.dryRun)
                return write(dryRunEnvelope(bundle, validationCredits), 0);
            const publish = deps.publish ?? transport.publish;
            const published = await publish(bundle.sanitized);
            const publishCredits = extractCredits(published.body);
            if (!published.ok) {
                const reason = publishReasonFromResponse(published.status, published.body);
                const detail = hubDetailFromBody(published.body);
                return write(publishFailure(reason, publishReasonMessage(reason), {
                    retryable: publishRetryable(reason),
                    mode: 'publish',
                    gates: bundle.gates,
                    assets: bundle.assets,
                    ...(detail ? { detail } : {}),
                    ...(publishCredits ? { credits: publishCredits } : {}),
                }), 1);
            }
            const payload = payloadRecord(published.body);
            if (stringField(payload, 'decision') === 'quarantine') {
                return write(publishFailure('quality_gate_failed', publishReasonMessage('quality_gate_failed'), {
                    retryable: false,
                    mode: 'publish',
                    gates: { ...bundle.gates, quality: 'fail' },
                    assets: bundle.assets,
                    ...(publishCredits ? { credits: publishCredits } : {}),
                }), 1);
            }
            const status = normalizePublishStatus(published.body);
            if (!status) {
                return write(publishFailure('internal_error', 'Hub publish response missing lifecycle status', {
                    retryable: false,
                    mode: 'publish',
                    gates: bundle.gates,
                    assets: bundle.assets,
                    ...(publishCredits ? { credits: publishCredits } : {}),
                }), 1);
            }
            const receiptId = stringField(payload, 'receipt_id');
            const bundleId = stringField(payload, 'bundle_id');
            return write({
                ok: true,
                contract: PUBLISH_CONTRACT,
                mode: 'publish',
                status,
                reversibility: REVERSIBILITY,
                ...(receiptId ? { receipt_id: receiptId } : {}),
                ...(bundleId ? { bundle_id: bundleId } : {}),
                assets: bundle.assets,
                ...(publishCredits ? { credits: publishCredits } : {}),
            }, 0);
        }
        catch (err) {
            const failure = classifyError(err, 'publish');
            return write(publishFailure(failure.reason, failure.message, {
                retryable: failure.retryable,
                mode: parsed.dryRun ? 'dry_run' : 'publish',
            }), 1);
        }
    });
}
export function parseReuseArgs(args) {
    let id;
    let jsonOut = false;
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (!token)
            continue;
        if (token === '--json') {
            jsonOut = true;
            continue;
        }
        if (token === '--id') {
            const next = args[i + 1];
            if (!next || next.startsWith('--'))
                return { ok: false, reason: 'missing_id', message: 'reuse requires --id <asset_id>' };
            id = next.trim();
            i++;
            continue;
        }
        if (token.startsWith('--id=')) {
            id = token.slice('--id='.length).trim();
            continue;
        }
        return { ok: false, reason: 'unsupported', message: 'unsupported reuse argument' };
    }
    if (!jsonOut)
        return { ok: false, reason: 'unsupported', message: 'reuse requires --json' };
    if (!id)
        return { ok: false, reason: 'missing_id', message: 'reuse requires --id <asset_id>' };
    if (id.length > 200)
        return { ok: false, reason: 'missing_id', message: 'asset id must be <= 200 characters' };
    return { ok: true, assetId: id, jsonOut };
}
export function parsePublishArgs(args) {
    const assetRefs = [];
    let dryRun = false;
    let jsonOut = false;
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (!token)
            continue;
        if (token === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (token === '--json') {
            jsonOut = true;
            continue;
        }
        const equalFlag = [...ASSET_FLAGS].find((flag) => token.startsWith(`${flag}=`));
        if (equalFlag) {
            const value = token.slice(equalFlag.length + 1).trim();
            if (!value)
                return { ok: false, reason: 'bundle_required', message: `${equalFlag} requires a value` };
            assetRefs.push(value);
            continue;
        }
        if (ASSET_FLAGS.has(token)) {
            const next = args[i + 1];
            if (!next || next.startsWith('--'))
                return { ok: false, reason: 'bundle_required', message: `${token} requires a value` };
            assetRefs.push(next.trim());
            i++;
            continue;
        }
        if (!token.startsWith('--'))
            return { ok: false, reason: 'unsupported', message: 'unsupported publish argument' };
        return { ok: false, reason: 'unsupported', message: 'unsupported publish flag' };
    }
    if (!jsonOut)
        return { ok: false, reason: 'unsupported', message: 'publish requires --json' };
    const refs = assetRefs.filter(Boolean);
    if (refs.length === 0)
        return { ok: false, reason: 'bundle_required', message: 'publish requires --asset <id|path>' };
    if (refs.length > MAX_ASSETS)
        return { ok: false, reason: 'bundle_required', message: `publish supports at most ${MAX_ASSETS} assets` };
    return { ok: true, assetRefs: refs, dryRun, jsonOut };
}
export async function buildPublishBundle(refs, deps = {}) {
    let original;
    try {
        original = await Promise.all(refs.map((ref) => loadAssetRef(ref, deps)));
    }
    catch (err) {
        const reason = err instanceof ContractError ? err.reason : 'schema_invalid';
        return { ok: false, reason, message: reason === 'bundle_required' ? publishReasonMessage(reason) : 'asset schema is invalid', gates: { schema: 'fail' } };
    }
    const bundleCheck = checkBundle(original);
    if (!bundleCheck.ok)
        return { ok: false, reason: 'bundle_required', message: bundleCheck.message, gates: { schema: 'pass', bundle: 'fail' } };
    let sanitized;
    try {
        sanitized = sanitizePublishBundle(original);
    }
    catch {
        return { ok: false, reason: 'redaction_unavailable', message: 'redaction unavailable', gates: { redaction: 'unavailable' } };
    }
    const finalBundleCheck = checkBundle(sanitized);
    if (!finalBundleCheck.ok) {
        return { ok: false, reason: 'bundle_required', message: finalBundleCheck.message, gates: { redaction: 'pass', schema: 'pass', bundle: 'fail' } };
    }
    const leak = finalPayloadLeakCheck(sanitized, deps.env ?? process.env);
    const gates = {
        redaction: 'pass',
        leak: leak.blocked ? 'fail' : 'pass',
        schema: 'pass',
        bundle: 'pass',
        quality: 'pass',
    };
    return {
        ok: true,
        original,
        sanitized,
        blockReasons: leak.blocked ? ['leak_detected'] : [],
        gates,
        assets: summarizePublishAssets(sanitized),
    };
}
function sanitizePublishBundle(original) {
    const sanitized = original.map((asset) => hub.sanitizeAsset(stripPublishMetadata(asset)));
    const finalGeneIdByOriginalRef = new Map();
    for (let i = 0; i < original.length; i++) {
        const source = original[i];
        const finalAsset = sanitized[i];
        if (source?.type !== 'Gene' || finalAsset?.type !== 'Gene')
            continue;
        for (const ref of [source.asset_id, stringField(source, 'id')]) {
            if (ref)
                finalGeneIdByOriginalRef.set(ref, finalAsset.asset_id);
        }
    }
    return sanitized.map((asset, index) => {
        if (asset.type !== 'Capsule')
            return asset;
        const originalGeneRef = stringField(original[index], 'gene');
        const sanitizedGeneRef = stringField(asset, 'gene');
        const finalGeneId = (originalGeneRef ? finalGeneIdByOriginalRef.get(originalGeneRef) : undefined)
            ?? (sanitizedGeneRef ? finalGeneIdByOriginalRef.get(sanitizedGeneRef) : undefined);
        if (!finalGeneId || sanitizedGeneRef === finalGeneId)
            return asset;
        return withRecomputedAssetId({ ...asset, gene: finalGeneId });
    });
}
function withRecomputedAssetId(asset) {
    const assetId = wire.computeAssetId(asset);
    return { ...asset, asset_id: assetId ?? asset.asset_id };
}
async function loadAssetRef(ref, deps) {
    if (looksLikeFile(ref))
        return normalizeAsset(JSON.parse(readFileSync(resolve(ref), 'utf8')));
    const store = deps.assetStore;
    if (store) {
        const fromStore = await findAssetInStore(ref, store);
        if (!fromStore)
            throw new ContractError('schema_invalid', 'asset not found');
        return normalizeAsset(fromStore);
    }
    const readOnly = loadLocalAssetsReadOnly(deps.assetsDir ?? events.assetsDir());
    const found = readOnly.find((asset) => asset.asset_id === ref || stringField(asset, 'id') === ref);
    if (!found)
        throw new ContractError('schema_invalid', 'asset not found');
    return normalizeAsset(found);
}
async function findAssetInStore(ref, store) {
    const byAssetId = await store.get(ref);
    if (byAssetId)
        return byAssetId;
    for (const kind of ['Gene', 'Capsule', 'EvolutionEvent']) {
        const rows = await store.list(kind, 10_000);
        const found = rows.find((asset) => stringField(asset, 'id') === ref);
        if (found)
            return found;
    }
    return null;
}
function loadLocalAssetsReadOnly(baseDir) {
    return [
        ...loadLocalGenesReadOnly(baseDir),
        ...readJsonLines(`${baseDir}/capsules.jsonl`, 'Capsule'),
        ...readJsonLines(`${baseDir}/events.jsonl`, 'EvolutionEvent'),
    ];
}
function loadLocalGenesReadOnly(baseDir) {
    const byId = new Map();
    for (const gene of [...readGenesEnvelopeReadOnly(`${baseDir}/genes.json`), ...readJsonLines(`${baseDir}/genes.jsonl`, 'Gene')]) {
        const id = stringField(gene, 'id') ?? gene.asset_id;
        if (id && !byId.has(id))
            byId.set(id, gene);
    }
    return [...byId.values()];
}
function readGenesEnvelopeReadOnly(filePath) {
    if (!existsSync(filePath))
        return [];
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        const envelopeGenes = isRecord(parsed) && Array.isArray(parsed['genes']) ? parsed['genes'] : [];
        return envelopeGenes.filter(isRecord).map((gene) => normalizeAsset({ ...gene, type: 'Gene' }));
    }
    catch {
        throw new ContractError('schema_invalid', 'asset schema is invalid');
    }
}
function readJsonLines(filePath, type) {
    if (!existsSync(filePath))
        return [];
    try {
        return readFileSync(filePath, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter(isRecord)
            .filter((asset) => asset['type'] === type)
            .map(normalizeAsset);
    }
    catch {
        throw new ContractError('schema_invalid', 'asset schema is invalid');
    }
}
function normalizeAsset(value) {
    if (!isRecord(value))
        throw new ContractError('schema_invalid', 'asset is not an object');
    const type = canonicalAssetType(value['type']);
    if (!type)
        throw new ContractError('schema_invalid', 'asset type must be Gene, Capsule, or EvolutionEvent');
    return { ...value, type, asset_id: stringField(value, 'asset_id') ?? 'IGNORED' };
}
function checkBundle(bundle) {
    const genes = bundle.filter((asset) => asset.type === 'Gene');
    const capsules = bundle.filter((asset) => asset.type === 'Capsule');
    const eventsFound = bundle.filter((asset) => asset.type === 'EvolutionEvent');
    if (genes.length > 1 || capsules.length > 1 || eventsFound.length > 1) {
        return { ok: false, message: 'publish supports one Gene + one Capsule + optional one EvolutionEvent bundle' };
    }
    if (genes.length === 0 || capsules.length === 0)
        return { ok: false, message: 'publish requires Gene + Capsule bundle' };
    const gene = genes[0];
    const capsule = capsules[0];
    const geneIds = new Set([gene.asset_id, stringField(gene, 'id')].filter((id) => Boolean(id)));
    if (!geneIds.has(String(capsule['gene'] ?? '')))
        return { ok: false, message: 'gene must publish with its capsule' };
    return { ok: true };
}
function finalPayloadLeakCheck(bundle, env) {
    const result = hub.fullLeakCheck(JSON.stringify(bundle), env);
    const hardLeaks = result.leaks.filter((leak) => leak.type !== 'local_path');
    return { blocked: hardLeaks.length > 0 };
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
        throw new ContractError('internal_error', 'local asset id conflict');
}
function stripHubMetadata(asset) {
    const out = {};
    for (const [key, value] of Object.entries(asset))
        if (!HUB_METADATA_KEYS.has(key))
            out[key] = value;
    return out;
}
function stripPublishMetadata(asset) {
    return stripHubMetadata(asset);
}
function storeBaseDir(store, deps) {
    return store instanceof assetstore.LocalJsonlProvider ? store.baseDir : deps.assetsDir ?? events.assetsDir();
}
function dryRunEnvelope(bundle, credits, blockDetail) {
    const suppressPayload = bundle.blockReasons.includes('leak_detected');
    return {
        ok: true,
        contract: PUBLISH_CONTRACT,
        mode: 'dry_run',
        reversibility: REVERSIBILITY,
        blocked: bundle.blockReasons.length > 0,
        block_reasons: bundle.blockReasons,
        ...(blockDetail ? { block_details: [blockDetail] } : {}),
        assets: bundle.assets,
        ...(suppressPayload ? {} : { payload: { assets: bundle.sanitized } }),
        gates: bundle.gates,
        ...(credits ? { credits } : {}),
    };
}
function publishFailure(reason, message, opts) {
    return {
        ok: false,
        contract: PUBLISH_CONTRACT,
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.gates ? { gates: opts.gates } : {}),
        ...(opts.assets ? { assets: opts.assets } : {}),
        ...(opts.detail ? { detail: opts.detail } : {}),
        ...(opts.credits ? { credits: opts.credits } : {}),
        reason,
        retryable: opts.retryable,
        message,
    };
}
function reuseFailure(reason, message) {
    return { ok: false, contract: REUSE_CONTRACT, reason, message };
}
function writeJson(out, value, code, deps) {
    const chunk = `${JSON.stringify(sanitizeForContract(value, deps))}\n`;
    if (out === process.stdout && machineJsonStdoutBypass)
        machineJsonStdoutBypass(chunk);
    else
        out.write(chunk);
    return code;
}
async function withMachineJsonConsole(enabled, deps, fn) {
    if (!enabled)
        return fn();
    const original = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
        stdoutWrite: process.stdout.write,
        stderrWrite: process.stderr.write,
    };
    const redirected = (...args) => {
        try {
            original.stderrWrite.call(process.stderr, `${sanitizeText(format(...args), deps)}\n`);
        }
        catch { /* ignore logging failures */ }
    };
    const stderrWrite = (chunk, encoding, callback) => {
        const text = Buffer.isBuffer(chunk)
            ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
            : String(chunk);
        const clean = sanitizeText(text, deps);
        const cb = typeof encoding === 'function' ? encoding : callback;
        const ok = original.stderrWrite.call(process.stderr, clean);
        cb?.();
        return ok;
    };
    const stdoutWrite = (chunk, encoding, callback) => {
        const text = Buffer.isBuffer(chunk)
            ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
            : String(chunk);
        const clean = sanitizeText(text, deps);
        const cb = typeof encoding === 'function' ? encoding : callback;
        const ok = original.stderrWrite.call(process.stderr, clean);
        cb?.();
        return ok;
    };
    const previousBypass = machineJsonStdoutBypass;
    machineJsonStdoutBypass = (chunk) => original.stdoutWrite.call(process.stdout, chunk);
    console.log = redirected;
    console.info = redirected;
    console.warn = redirected;
    console.error = redirected;
    console.debug = redirected;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    try {
        return await fn();
    }
    finally {
        console.log = original.log;
        console.info = original.info;
        console.warn = original.warn;
        console.error = original.error;
        console.debug = original.debug;
        process.stdout.write = original.stdoutWrite;
        process.stderr.write = original.stderrWrite;
        machineJsonStdoutBypass = previousBypass;
    }
}
function createDefaultTransport(deps) {
    const env = deps.env ?? process.env;
    loadEnvFileFromEnv(env);
    const hubUrl = resolveHubUrl(env);
    const evomapDir = resolveAtpHome(env);
    const sender = resolveAtpSenderId(env);
    const senderId = () => sender ?? env['A2A_NODE_ID']?.trim();
    const nodeSecret = env['EVOMAP_NODE_SECRET']?.trim() || env['A2A_NODE_SECRET']?.trim();
    const connected = nodeSecret
        ? connectPublicHub({ hubUrl, authMode: 'legacy', evomapDir, nodeSecret, senderId })
        : connectPublicHub({ hubUrl, authMode: 'oauth', evomapDir, senderId });
    const http = new HubFetch({ baseUrl: hubUrl, auth: connected.auth, fetchFn: globalFetchLike, senderId });
    const call = async (path, messageType, bundle) => {
        try {
            const body = await http.call('POST', path, gepEnvelope(messageType, { assets: [...bundle] }));
            if (messageType === 'validate') {
                const valid = hasExplicitValidatePass(body);
                return { ok: valid, status: 200, body };
            }
            return { ok: true, status: 200, body };
        }
        catch (err) {
            if (err instanceof AuthError)
                return { ok: false, status: err.status };
            if (isAuthLikeError(err))
                return { ok: false, status: 401 };
            if (err instanceof HubClientError)
                return { ok: false, status: err.status, body: err.body };
            return { ok: false, status: 0 };
        }
    };
    return {
        fetchAssetById: (assetId) => connected.hub.fetchAssetById(assetId),
        validate: (bundle) => call('/a2a/validate', 'validate', bundle),
        publish: (bundle) => call('/a2a/publish', 'publish', bundle),
    };
}
function isAuthLikeError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /oauth|login|credential|auth|401|403|node_secret/i.test(message);
}
function classifyError(err, command) {
    if (err instanceof ContractError)
        return { reason: err.reason, message: err.safeMessage, retryable: err.reason === 'network_error' };
    if (err instanceof AuthError)
        return { reason: 'auth_required', message: 'Hub authentication required', retryable: false };
    if (err instanceof HubUnreachableError)
        return { reason: 'network_error', message: 'Hub unreachable', retryable: true };
    if (err instanceof HubClientError) {
        const reason = stableContractReasonFromBody(err.body) ?? (command === 'reuse' ? reuseReasonFromStatus(err.status) : publishReasonFromStatus(err.status));
        return { reason, message: command === 'publish' ? publishReasonMessage(reason) : reuseReasonMessage(reason), retryable: publishRetryable(reason) };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/oauth|login|credential|auth|401|403|node_secret/i.test(message))
        return { reason: 'auth_required', message: 'Hub authentication required', retryable: false };
    if (/network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|hub 5\d\d/i.test(message))
        return { reason: 'network_error', message: 'Hub unreachable', retryable: true };
    return { reason: 'internal_error', message: `evolver ${command} failed`, retryable: false };
}
function reuseReasonFromStatus(status) {
    if (status === 401 || status === 403)
        return 'auth_required';
    if (status === 404)
        return 'not_found';
    if (status === 429 || status >= 500 || status === 0)
        return 'network_error';
    return 'internal_error';
}
function publishReasonFromStatus(status) {
    if (status === 401 || status === 403)
        return 'auth_required';
    if (status === 402)
        return 'insufficient_credits';
    if (status === 429 || status >= 500 || status === 0)
        return 'network_error';
    return 'quality_gate_failed';
}
function publishReasonFromResponse(status, body) {
    return stableContractReasonFromBody(body) ?? publishReasonFromStatus(status);
}
function publishRetryable(reason) {
    return reason === 'network_error';
}
function publishReasonMessage(reason) {
    const map = {
        missing_id: 'missing asset id',
        cli_unavailable: 'evolver CLI unavailable',
        auth_required: 'Hub authentication required',
        not_found: 'asset not found',
        network_error: 'Hub unreachable',
        unsupported: 'publish unsupported',
        internal_error: 'evolver publish failed',
        redaction_unavailable: 'redaction unavailable',
        leak_detected: 'leak detected after redaction',
        schema_invalid: 'asset schema is invalid',
        bundle_required: 'publish requires a complete asset bundle',
        quality_gate_failed: 'Hub quality gate failed',
        insufficient_credits: 'insufficient credits',
    };
    return map[reason] ?? map.internal_error;
}
function reuseReasonMessage(reason) {
    if (reason === 'not_found')
        return 'asset not found';
    if (reason === 'auth_required')
        return 'Hub authentication required';
    if (reason === 'network_error')
        return 'Hub unreachable';
    return 'evolver reuse failed';
}
function summarizePublishAssets(assets) {
    return assets.map((asset) => {
        const type = canonicalAssetType(asset.type);
        return {
            ...(asset.asset_id ? { asset_id: asset.asset_id } : {}),
            ...(type ? { type } : {}),
        };
    });
}
function extractCredits(body) {
    const payload = payloadRecord(body);
    const credits = asRecord(payload['credits']) ?? asRecord(payload['credit_cost']) ?? asRecord(payload['economic']) ?? payload;
    return creditsFromPayload(credits);
}
function creditsFromPayload(payload) {
    const required = numberField(payload, 'required');
    const available = numberField(payload, 'available');
    const estimated = numberField(payload, 'estimated') ?? numberField(payload, 'estimate');
    const charged = numberField(payload, 'charged');
    const balanceKind = safeTokenField(stringField(payload, 'balance_kind') ?? stringField(payload, 'balanceKind'));
    const out = {};
    if (required !== undefined)
        out['required'] = required;
    if (available !== undefined)
        out['available'] = available;
    if (estimated !== undefined)
        out['estimated'] = estimated;
    if (charged !== undefined)
        out['charged'] = charged;
    if (balanceKind)
        out['balance_kind'] = balanceKind;
    return Object.keys(out).length > 0 ? out : undefined;
}
export function hasExplicitValidatePass(body) {
    const payload = payloadRecord(body);
    const hasExplicitPass = payload['valid'] === true || payload['ok'] === true;
    const hasExplicitFail = payload['valid'] === false || payload['ok'] === false;
    return hasExplicitPass && !hasExplicitFail;
}
function normalizePublishStatus(body) {
    const payload = payloadRecord(body);
    const status = stringField(payload, 'status');
    if (status === 'queued' || status === 'accepted' || status === 'published')
        return status;
    if (status)
        return undefined;
    const decision = stringField(payload, 'decision');
    if (decision === 'accept')
        return 'accepted';
    if (decision === 'accepted')
        return 'accepted';
    if ((decision === 'reject' || decision === 'rejected') && stringField(payload, 'reason') === 'already_published')
        return 'published';
    return undefined;
}
function payloadRecord(body) {
    const root = asRecord(body) ?? {};
    return asRecord(root['payload']) ?? root;
}
// The Hub answers a rejected publish with the SPECIFIC rule that failed
// ("gene_validation_required: ..."), which our stable ContractReason enum
// necessarily flattens to `quality_gate_failed`. Keeping only the flattened code
// leaves every caller — the desktop wizard above all — with a red gate and no
// way to act on it, so the detail rides along in a separate additive field.
// Capped and control-character-stripped: it is Hub-authored text that ends up in
// a machine-readable envelope on stdout.
const HUB_DETAIL_MAX_CHARS = 300;
function stripControlChars(value) {
    let out = '';
    for (const ch of value) {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? ' ' : ch;
    }
    return out;
}
function hubDetailFromBody(body) {
    const root = asRecord(body) ?? {};
    const payload = payloadRecord(body);
    // Take the first candidate that ISN'T already a stable contract token: those
    // are what `reason` carries, so emitting one here would repeat the flattened
    // code this field exists to supplement. The Hub is free to put the token in
    // `reason` and the rule text in `error` (or the reverse), so order alone
    // cannot pick the informative one.
    const raw = [
        stringField(root, 'error'),
        stringField(root, 'reason'),
        stringField(payload, 'error'),
        stringField(payload, 'reason'),
    ].find((candidate) => candidate && !isStableContractReason(candidate.trim()));
    if (!raw)
        return undefined;
    const detail = stripControlChars(raw).replace(/\s+/g, ' ').trim();
    if (!detail)
        return undefined;
    return detail.length > HUB_DETAIL_MAX_CHARS ? `${detail.slice(0, HUB_DETAIL_MAX_CHARS)}…` : detail;
}
function stableContractReasonFromBody(body) {
    const payload = payloadRecord(body);
    const reason = stringField(payload, 'reason') ?? stringField(payload, 'error');
    return isStableContractReason(reason) ? reason : undefined;
}
function isStableContractReason(value) {
    return Boolean(value && STABLE_CONTRACT_REASONS.has(value));
}
function sanitizeForContract(value, deps) {
    return redactKnownSecrets(hub.redactDeep(value), deps);
}
function sanitizeText(value, deps) {
    return String(redactKnownSecrets(hub.redactString(value), deps));
}
function redactKnownSecrets(value, deps, known = knownLocalSecrets(deps)) {
    if (typeof value === 'string')
        return redactKnownSecretsInString(value, known);
    if (!value || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map((item) => redactKnownSecrets(item, deps, known));
    const out = {};
    for (const [key, item] of Object.entries(value))
        out[key] = redactKnownSecrets(item, deps, known);
    return out;
}
function redactKnownSecretsInString(value, known) {
    let result = value;
    for (const secret of known)
        result = result.split(secret).join('[REDACTED]');
    return result;
}
function knownLocalSecrets(deps) {
    const env = deps.env ?? process.env;
    const secrets = new Set();
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && value.length >= 8 && /SECRET|TOKEN|API[_-]?KEY|PASSWORD|AUTH|CREDENTIAL/i.test(key)) {
            secrets.add(value);
        }
    }
    return [...secrets].sort((a, b) => b.length - a.length);
}
function canonicalAssetType(value) {
    if (value === 'Gene' || value === 'gene')
        return 'Gene';
    if (value === 'Capsule' || value === 'capsule')
        return 'Capsule';
    if (value === 'EvolutionEvent' || value === 'event' || value === 'Evolutionevent')
        return 'EvolutionEvent';
    return undefined;
}
function looksLikeFile(value) {
    try {
        return existsSync(value) && statSync(value).isFile();
    }
    catch {
        return false;
    }
}
function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function asRecord(value) {
    return isRecord(value) ? value : undefined;
}
function stringField(value, key) {
    const record = asRecord(value);
    const raw = record?.[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
function numberField(value, key) {
    const raw = asRecord(value)?.[key];
    const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN);
    return Number.isFinite(n) ? n : undefined;
}
function safeTokenField(value) {
    if (!value)
        return undefined;
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}
export function _inspectCliContractsForTest(value) {
    return inspect(value, { depth: 4, colors: false });
}