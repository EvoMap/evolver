import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect, format } from 'node:util';
import { assetrepair, assetstore, events, hub, wire, algo, verify } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubFetch, HubUnreachableError, connectPublicHub, gepEnvelope, globalFetchLike, resolveHubUrl, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv, proxyClientFromEnv } from '@evomap/evolver-mcp';
import { resolveAtpSenderId } from './atp.js';
import { storeRepairedAsset } from './repairedAssetStore.js';
import { resolveExplicitNodeCredentials, resolveIdentityHome } from './identityHome.js';
const REUSE_CONTRACT = 'reuse.v1';
const PUBLISH_CONTRACT = 'publish.v1';
const REVERSIBILITY = 'irreversible';
const OAUTH_AUTH_REQUIRED_MESSAGE = "Hub authentication required; run 'evolver login' and retry";
const LEGACY_AUTH_REQUIRED_MESSAGE = 'Hub node authentication failed; verify the configured node credentials and retry';
const PRIVATE_AUTH_REQUIRED_MESSAGE = 'Private Hub authentication failed; verify proxy enrollment, credentials, and hub mode';
const BUNDLE_REQUIRED_MESSAGE = 'publish requires Gene + Capsule bundle; pass --gene <id|path> --capsule <id|path>';
const MAX_ASSETS = 50;
const PUBLISH_USAGE = [
    'usage: evolver publish --asset <gene_id_or_path> --asset <capsule_id_or_path> --json [--dry-run] [--repair] [--no-recipe]',
    '       evolver publish --gene <id_or_path> --capsule <id_or_path> --json [--dry-run] [--no-recipe]',
    '       evolver publish --gene <id_or_path> --auto-pair --json [--dry-run] [--no-recipe]',
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
    'gene_unproven',
    'insufficient_credits',
    'unsafe_validation_command',
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
    if (!parsed.ok || !parsed.assetId) {
        return writeJson(out, reuseFailure(parsed.reason ?? 'missing_id', parsed.message ?? 'reuse requires --id <asset_id>'), 1, deps);
    }
    let runtimeDeps;
    try {
        runtimeDeps = { ...deps, env: loadContractEnv(deps) };
    }
    catch (err) {
        const failure = classifyError(err, 'reuse');
        return writeJson(out, reuseFailure(failure.reason, failure.message), 1, deps);
    }
    const write = (value, code) => writeJson(out, value, code, runtimeDeps);
    const assetId = parsed.assetId;
    return withMachineJsonConsole(Boolean(parsed.jsonOut), runtimeDeps, async () => {
        try {
            const fetcher = runtimeDeps.fetchAssetById
                ?? runtimeDeps.transport?.fetchAssetById
                ?? createDefaultTransport(runtimeDeps).fetchAssetById;
            const asset = await fetcher(assetId);
            if (!asset)
                return write(reuseFailure('not_found', 'asset not found'), 1);
            const cleaned = stripHubMetadata(asset);
            const computedAssetId = wire.computeAssetId(cleaned);
            const identityMatches = assetId.startsWith('sha256:')
                ? computedAssetId === assetId
                : stringField(cleaned, 'id') === assetId && computedAssetId === cleaned.asset_id;
            if (!identityMatches) {
                return write(reuseFailure('internal_error', 'asset integrity verification failed'), 1);
            }
            const store = runtimeDeps.assetStore ?? new assetstore.LocalJsonlProvider(contractAssetsDir(runtimeDeps));
            await assertNoLocalReuseIdConflict(cleaned, store);
            const provenance = new assetstore.ProvenanceStore(storeBaseDir(store, runtimeDeps));
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
    if (!parsed.ok || !parsed.assetRefs) {
        return writeJson(out, publishFailure(parsed.reason ?? 'bundle_required', parsed.message ?? publishReasonMessage('bundle_required'), { retryable: false }), 1, deps);
    }
    const assetRefs = parsed.assetRefs;
    let runtimeDeps;
    try {
        const inheritedEnv = deps.env ?? process.env;
        const runtimeEnv = loadContractEnv(deps);
        runtimeDeps = { ...deps, env: preserveInheritedSecrets(runtimeEnv, inheritedEnv) };
    }
    catch (err) {
        const failure = classifyError(err, 'publish', deps.env ?? process.env);
        return writeJson(out, publishFailure(failure.reason, failure.message, {
            retryable: failure.retryable,
            mode: parsed.dryRun ? 'dry_run' : 'publish',
        }), 1, deps);
    }
    const write = (value, code) => writeJson(out, value, code, runtimeDeps);
    return withMachineJsonConsole(Boolean(parsed.jsonOut), runtimeDeps, async () => {
        try {
            const effectiveRefs = parsed.autoPair
                ? await autoPairPublishRefs(assetRefs, parsed.geneRef, runtimeDeps)
                : assetRefs;
            const bundle = await buildPublishBundle(effectiveRefs, runtimeDeps);
            if (!bundle.ok) {
                return write(publishFailure(bundle.reason, bundle.message, { retryable: false, gates: bundle.gates }), 1);
            }
            if (bundle.blockReasons.length > 0) {
                if (parsed.dryRun)
                    return write(dryRunEnvelope(bundle), 0);
                const reason = bundle.blockReasons[0] ?? 'internal_error';
                const detailMessage = bundle.blockMessages?.[reason];
                return write(publishFailure(reason, detailMessage ?? publishReasonMessage(reason), {
                    retryable: false,
                    mode: 'publish',
                    gates: bundle.gates,
                    assets: bundle.assets,
                }), 1);
            }
            const transport = deps.transport ?? createDefaultTransport(runtimeDeps, {
                composeRecipe: parsed.noRecipe !== true,
            });
            const validate = deps.validate ?? transport.validate;
            // A field-level refusal is a defect in the RECORD, not a verdict on the work in it. Read the Hub's own
            // `details[]`, mend what is mechanically derivable, and (only when asked) try once more — otherwise the
            // envelope still carries the plan, so the operator can see the asset is salvageable instead of losing it.
            const validationAttempt = await callHubWithRepair(validate, bundle.sanitized, parsed.repair === true);
            const validation = validationAttempt.result;
            let effectiveAssets = validationAttempt.assets;
            const validationCredits = extractCredits(validation.body);
            const validationUnavailable = transport.validationCapabilityOptional === true
                && isValidationCapabilityUnavailable(validation.body);
            if (!validation.ok && !(validationUnavailable && !parsed.dryRun)) {
                if (validationUnavailable) {
                    return write(publishFailure('unsupported', publishReasonMessage('unsupported'), {
                        retryable: false,
                        mode: 'dry_run',
                        gates: bundle.gates,
                        assets: bundle.assets,
                        detail: 'Private Hub validation is not configured',
                    }), 1);
                }
                const reason = publishReasonFromResponse(validation.status, validation.body);
                const detail = hubDetailFromBody(validation.body);
                if (parsed.dryRun && reason === 'quality_gate_failed') {
                    bundle.gates.quality = 'fail';
                    if (!bundle.blockReasons.includes('quality_gate_failed'))
                        bundle.blockReasons.push('quality_gate_failed');
                    return write(dryRunEnvelope(bundle, validationCredits, detail, validationAttempt), 0);
                }
                return write(publishFailure(reason, publishReasonMessage(reason, runtimeDeps.env), {
                    retryable: publishRetryable(reason),
                    mode: parsed.dryRun ? 'dry_run' : 'publish',
                    gates: parsed.dryRun ? bundle.gates : { ...bundle.gates, quality: 'fail' },
                    assets: bundle.assets,
                    ...(detail ? { detail } : {}),
                    ...(validationCredits ? { credits: validationCredits } : {}),
                    ...repairEnvelopeField(validationAttempt),
                }), 1);
            }
            if (parsed.dryRun)
                return write(dryRunEnvelope(bundle, validationCredits, undefined, validationAttempt), 0);
            const publish = deps.publish ?? transport.publish;
            const publishAttempt = await callHubWithRepair(publish, effectiveAssets, parsed.repair === true);
            const published = publishAttempt.result;
            effectiveAssets = publishAttempt.assets;
            const repairApplied = mergeRepairAttempts(validationAttempt, publishAttempt);
            const publishCredits = extractCredits(published.body);
            if (!published.ok) {
                const reason = publishReasonFromResponse(published.status, published.body);
                const detail = hubDetailFromBody(published.body);
                return write(publishFailure(reason, publishReasonMessage(reason, runtimeDeps.env), {
                    retryable: publishRetryable(reason),
                    mode: 'publish',
                    gates: bundle.gates,
                    assets: bundle.assets,
                    ...(detail ? { detail } : {}),
                    ...(publishCredits ? { credits: publishCredits } : {}),
                    ...repairEnvelopeField(repairApplied),
                }), 1);
            }
            // The repaired records are what the network now holds. Persist them so the local library and the Hub do
            // not silently diverge; a storage failure is reported, never fatal — the publish already happened.
            const repairPersisted = repairApplied?.applied === true
                ? await persistRepairedBundle(effectiveAssets, bundle.sanitized, runtimeDeps)
                : undefined;
            const payload = payloadRecord(published.body);
            const decision = stringField(payload, 'decision');
            const hubReason = stringField(payload, 'reason');
            const safetyCandidate = decision === 'quarantine' && hubReason === 'safety_candidate';
            if (decision === 'quarantine' && !safetyCandidate) {
                const detail = hubDetailFromBody(published.body);
                return write(publishFailure('quality_gate_failed', publishReasonMessage('quality_gate_failed'), {
                    retryable: false,
                    mode: 'publish',
                    gates: { ...bundle.gates, quality: 'fail' },
                    assets: bundle.assets,
                    ...(detail ? { detail } : {}),
                    ...(publishCredits ? { credits: publishCredits } : {}),
                }), 1);
            }
            const status = safetyCandidate ? 'queued' : normalizePublishStatus(published.body);
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
            const publishedBundle = { ...bundle, sanitized: [...effectiveAssets] };
            appendPublishedCapsuleCall(publishedBundle, deps, { status, receiptId, bundleId });
            const recipeId = parsed.noRecipe || deps.publish
                ? undefined
                : await composePublishedRecipe(transport, effectiveAssets);
            return write({
                ok: true,
                contract: PUBLISH_CONTRACT,
                mode: 'publish',
                status,
                reversibility: REVERSIBILITY,
                ...(receiptId ? { receipt_id: receiptId } : {}),
                ...(bundleId ? { bundle_id: bundleId } : {}),
                ...(recipeId ? { recipe_id: recipeId } : {}),
                ...(safetyCandidate ? { hub_reason: hubReason } : {}),
                // What the Hub actually holds — after a repair that is the mended record, not the one first submitted.
                assets: repairApplied?.applied === true ? summarizePublishAssets(effectiveAssets) : bundle.assets,
                ...(publishCredits ? { credits: publishCredits } : {}),
                ...repairEnvelopeField(repairApplied, repairPersisted),
            }, 0);
        }
        catch (err) {
            const failure = classifyError(err, 'publish', runtimeDeps.env ?? process.env);
            return write(publishFailure(failure.reason, failure.message, {
                retryable: failure.retryable,
                mode: parsed.dryRun ? 'dry_run' : 'publish',
            }), 1);
        }
    });
}
async function callHubWithRepair(call, assets, allowRepair) {
    const first = await call(assets);
    if (first.ok)
        return { result: first, assets, applied: false, entries: [] };
    const plan = planBundleRepair(assets, first.body);
    // Retry only when the WHOLE bundle is mended. One unrepairable asset means the Hub will refuse the bundle
    // again for the same reason, and a second refusal costs the operator another paid round-trip for nothing.
    const repairable = plan.entries.some((entry) => entry.repair_status === 'repaired')
        && plan.entries.every((entry) => entry.repair_status !== 'unrepairable');
    if (!repairable || !allowRepair)
        return { result: first, assets, applied: false, entries: plan.entries };
    // Exactly one retry: a Hub that refuses the mended record too is telling us the defect is not mechanical,
    // and a repair loop against a paid endpoint is how you burn credits without converging.
    const retried = await call(plan.assets);
    return { result: retried, assets: plan.assets, applied: true, entries: plan.entries };
}
function planBundleRepair(assets, rejectionBody) {
    const hubIssues = assetrepair.hubRejectionIssues(rejectionBody, {
        assetTypes: assets.map((asset) => (typeof asset.type === 'string' ? asset.type : undefined)),
    });
    const bundleIssues = hubIssues.byAssetIndex.get(-1) ?? [];
    const repaired = [];
    const entries = [];
    for (const [index, asset] of assets.entries()) {
        const issues = [...(hubIssues.byAssetIndex.get(index) ?? []), ...bundleIssues];
        const report = assetrepair.repairAssetRecord(asset, { hubIssues: issues });
        repaired.push(report.asset ?? asset);
        entries.push({
            ...(asset.asset_id ? { asset_id: asset.asset_id } : {}),
            ...(report.asset && report.asset.asset_id !== asset.asset_id ? { repaired_asset_id: report.asset.asset_id } : {}),
            repair_status: report.status,
            changes: report.changes.map((change) => `${change.path}: ${change.action}`),
            blockers: report.blockers.map(repairBlockerText),
        });
    }
    return { assets: repaired, entries };
}
function repairBlockerText(blocker) {
    return `${blocker.path || '(record)'}: ${stripControlChars(blocker.message).replace(/\s+/g, ' ').trim()}`.slice(0, HUB_DETAIL_MAX_CHARS);
}
/** Report the LATER attempt's plan: it is the one describing the bundle that was actually refused last. */
function mergeRepairAttempts(validation, publish) {
    if (publish.applied || publish.entries.length > 0) {
        return { ...publish, applied: publish.applied || validation.applied };
    }
    return validation.entries.length > 0 || validation.applied ? validation : undefined;
}
function repairEnvelopeField(attempt, persisted) {
    if (!attempt || (attempt.entries.length === 0 && !attempt.applied))
        return {};
    return {
        repair: {
            applied: attempt.applied,
            ...(persisted !== undefined ? { persisted } : {}),
            ...(attempt.applied ? {} : { hint: 're-run with --repair to publish the mended record' }),
            assets: attempt.entries,
        },
    };
}
async function persistRepairedBundle(published, submitted, deps) {
    const env = deps.env ?? process.env;
    const store = deps.assetStore ?? new assetstore.LocalJsonlProvider(contractAssetsDir(deps));
    // Only the records repair actually changed are new locally; the untouched ones are already stored.
    const changed = published.filter((asset, index) => asset.asset_id !== submitted[index]?.asset_id);
    try {
        const stored = await Promise.all(changed.map((asset) => storeRepairedAsset(asset, store, env)));
        return stored.every(Boolean);
    }
    catch {
        return false;
    }
}
function appendPublishedCapsuleCall(bundle, deps, receipt) {
    const capsuleIndex = bundle.sanitized.findIndex((asset) => asset.type === 'Capsule');
    if (capsuleIndex < 0)
        return;
    const publishedCapsule = bundle.sanitized[capsuleIndex];
    const originalCapsule = bundle.original[capsuleIndex];
    if (!publishedCapsule)
        return;
    const tokensSpent = hub.assetDerivationTokenCost(originalCapsule);
    const trigger = Array.isArray(publishedCapsule['trigger'])
        ? publishedCapsule['trigger'].filter((value) => typeof value === 'string')
        : undefined;
    try {
        const callLog = deps.callLog ?? new hub.AssetCallLog(events.assetCallLogPath(deps.env ?? process.env));
        callLog.append({
            action: 'asset_publish',
            asset_id: publishedCapsule.asset_id,
            asset_type: 'Capsule',
            ...(trigger ? { signals: trigger } : {}),
            ...(tokensSpent !== undefined ? { tokens_spent: tokensSpent } : {}),
            extra: {
                status: receipt.status,
                ...(receipt.receiptId ? { receipt_id: receipt.receiptId } : {}),
                ...(receipt.bundleId ? { bundle_id: receipt.bundleId } : {}),
            },
        });
    }
    catch { /* a local audit failure must never change an accepted Hub publish */ }
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
    let geneRef;
    let geneCount = 0;
    let capsuleRef;
    let hasUntypedAsset = false;
    let autoPair = false;
    let dryRun = false;
    let repair = false;
    let noRecipe = false;
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
        if (token === '--auto-pair') {
            autoPair = true;
            continue;
        }
        if (token === '--repair') {
            repair = true;
            continue;
        }
        if (token === '--no-recipe') {
            noRecipe = true;
            continue;
        }
        const equalFlag = [...ASSET_FLAGS].find((flag) => token.startsWith(`${flag}=`));
        if (equalFlag) {
            const value = token.slice(equalFlag.length + 1).trim();
            if (!value)
                return { ok: false, reason: 'bundle_required', message: `${equalFlag} requires a value` };
            assetRefs.push(value);
            if (equalFlag === '--gene') {
                geneRef = value;
                geneCount++;
            }
            if (equalFlag === '--capsule')
                capsuleRef = value;
            if (equalFlag === '--asset')
                hasUntypedAsset = true;
            continue;
        }
        if (ASSET_FLAGS.has(token)) {
            const next = args[i + 1];
            if (!next || next.startsWith('--'))
                return { ok: false, reason: 'bundle_required', message: `${token} requires a value` };
            const value = next.trim();
            if (!value)
                return { ok: false, reason: 'bundle_required', message: `${token} requires a value` };
            assetRefs.push(value);
            if (token === '--gene') {
                geneRef = value;
                geneCount++;
            }
            if (token === '--capsule')
                capsuleRef = value;
            if (token === '--asset')
                hasUntypedAsset = true;
            i++;
            continue;
        }
        if (!token.startsWith('--'))
            return { ok: false, reason: 'unsupported', message: 'unsupported publish argument; did you mean --asset <id|path>?' };
        if (token === '--home' || token.startsWith('--home=') || token === '--evomap-home' || token.startsWith('--evomap-home=')) {
            return { ok: false, reason: 'unsupported', message: 'publish does not accept home flags; set EVOLVER_HOME or EVOMAP_HOME before running evolver publish' };
        }
        return { ok: false, reason: 'unsupported', message: "unsupported publish flag; run 'evolver publish --help'" };
    }
    if (!jsonOut)
        return { ok: false, reason: 'unsupported', message: 'publish requires --json' };
    if (autoPair && (geneCount !== 1 || !geneRef || capsuleRef || hasUntypedAsset)) {
        return { ok: false, reason: 'bundle_required', message: '--auto-pair requires exactly one explicit --gene and no --asset or --capsule' };
    }
    const refs = assetRefs;
    if (refs.length === 0)
        return { ok: false, reason: 'bundle_required', message: 'publish requires --asset <id|path>' };
    if (refs.length > MAX_ASSETS)
        return { ok: false, reason: 'bundle_required', message: `publish supports at most ${MAX_ASSETS} assets` };
    return {
        ok: true,
        assetRefs: refs,
        ...(geneRef ? { geneRef } : {}),
        ...(autoPair ? { autoPair: true } : {}),
        dryRun,
        repair,
        ...(noRecipe ? { noRecipe: true } : {}),
        jsonOut,
    };
}
export async function buildPublishBundle(refs, deps = {}) {
    let original;
    try {
        original = await Promise.all(refs.map((ref) => loadAssetRef(ref, deps)));
    }
    catch (err) {
        // Report what actually went wrong. Overwriting every failure with "asset
        // schema is invalid" hid the common case — a ref that resolved to nothing —
        // behind a claim about a schema that was never read, leaving a user who
        // could not publish with no way to tell a missing asset from a bad one.
        const reason = err instanceof ContractError ? err.reason : 'internal_error';
        const message = err instanceof ContractError ? err.safeMessage : publishReasonMessage(reason);
        return {
            ok: false,
            reason,
            message,
            gates: reason === 'schema_invalid' ? { schema: 'fail' } : {},
        };
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
    // Local quality gate: a gene may only publish once it has TRULY succeeded at
    // least once. Minting sets `confidence` from self-report / text completeness,
    // which never proves the gene worked; without this check an unproven gene
    // leaks to the Hub and comes back as an opaque `quality_gate_failed` after a
    // round-trip. Assessing the gene's outcome evidence here fails fast, locally,
    // with a precise reason. Read-only: aggregates the local capsule history.
    const geneEvidence = await assessPublishGeneEvidence(original, deps);
    const geneProven = geneEvidence?.eligible ?? true;
    // Local quality gate: validation command safety check.
    // Only applies to Gene assets. Checks that all validation commands are safe
    // (e.g., no `node -e`, no shell metacharacters).
    const validationCommandResult = checkValidationCommands(original);
    const gates = {
        redaction: 'pass',
        leak: leak.blocked ? 'fail' : 'pass',
        schema: 'pass',
        bundle: 'pass',
        quality: geneProven ? 'pass' : 'fail',
        validation_command: validationCommandResult.allowed ? 'pass' : 'fail',
    };
    const blockReasons = [];
    const blockMessages = {};
    if (leak.blocked)
        blockReasons.push('leak_detected');
    if (!geneProven)
        blockReasons.push('gene_unproven');
    if (!validationCommandResult.allowed) {
        blockReasons.push('unsafe_validation_command');
        if (validationCommandResult.message) {
            blockMessages['unsafe_validation_command'] = validationCommandResult.message;
        }
    }
    return {
        ok: true,
        original,
        sanitized,
        blockReasons,
        blockMessages,
        gates,
        assets: summarizePublishAssets(sanitized),
    };
}
// Assess whether the bundle's Gene has proven success in the local capsule
// history. Fail-open (returns null) when there is no gene id or the store read
// throws — the pre-check only ADDS a local gate; the Hub still gates, so an
// infra hiccup must not block an otherwise-valid publish.
async function assessPublishGeneEvidence(original, deps) {
    const gene = original.find((asset) => asset.type === 'Gene');
    if (!gene)
        return null;
    const businessId = stringField(gene, 'id');
    const assetId = typeof gene.asset_id === 'string' ? gene.asset_id : undefined;
    const geneId = businessId ?? assetId;
    if (!geneId)
        return null;
    try {
        const store = deps.assetStore ?? new assetstore.LocalJsonlProvider(contractAssetsDir(deps));
        const primary = await algo.assessGenePublishEvidence(store, geneId);
        // Capsules key their `gene` link by the gene's business id in production;
        // some stores (and legacy fixtures) key it by asset_id. Mixed histories can
        // contain failures under the business id and a success under asset_id, so
        // both aliases must contribute to the gate rather than only falling back
        // when the primary alias has no rows at all.
        if (assetId && assetId !== geneId) {
            const byAssetId = await algo.assessGenePublishEvidence(store, assetId);
            const combined = {
                success: primary.success + byAssetId.success,
                failed: primary.failed + byAssetId.failed,
                inert: primary.inert + byAssetId.inert,
                total: primary.total + byAssetId.total,
            };
            const eligible = algo.isGenePublishEligible(combined);
            return {
                geneId,
                ...combined,
                eligible,
                reason: eligible ? 'eligible' : 'no_proven_success',
            };
        }
        return primary;
    }
    catch {
        return null;
    }
}
/**
 * 检查 Gene 资产中的验证命令是否安全。
 * 只检查 Gene 类型的资产，不影响 Capsule 或 EvolutionEvent。
 * 如果 Gene 有 validation 数组，会检查每条命令是否符合安全策略。
 * 不安全的命令（如 `node -e`、包含 shell 元字符等）会阻止发布。
 */
function checkValidationCommands(original) {
    const gene = original.find((asset) => asset.type === 'Gene');
    if (!gene)
        return { allowed: true, unsafeCommands: [] };
    const validation = gene['validation'];
    if (!Array.isArray(validation) || validation.length === 0) {
        return { allowed: true, unsafeCommands: [] };
    }
    const unsafeCommands = [];
    for (const cmd of validation) {
        if (typeof cmd !== 'string')
            continue;
        if (!verify.isValidationCommandAllowed(cmd)) {
            unsafeCommands.push(cmd);
        }
    }
    if (unsafeCommands.length === 0) {
        return { allowed: true, unsafeCommands: [] };
    }
    // 构建诊断信息（不暴露原始命令文本，避免泄露安全策略细节）
    const reasons = new Set();
    for (const cmd of unsafeCommands) {
        if (/`|\$\(/.test(cmd)) {
            reasons.add('command_substitution');
            continue;
        }
        const stripped = cmd.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
        if (verify.SHELL_METACHARS.test(stripped)) {
            reasons.add('shell_metacharacters');
            continue;
        }
        const tokens = cmd.split(/\s+/);
        const executable = tokens[0] ?? '';
        const args = tokens.slice(1);
        const badFlag = verify.isNodeExecutable(executable) ? verify.nodeFlagViolation(executable, args) : null;
        if (badFlag) {
            reasons.add('blocked_node_flag');
            continue;
        }
        if (!cmd.trim().startsWith('node ')) {
            reasons.add('non_node_command');
        }
        else {
            reasons.add('unsafe_pattern');
        }
    }
    return {
        allowed: false,
        unsafeCommands,
        message: `validation command rejected: ${[...reasons].join(', ')}`,
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
/** Resolve `<asset_id|logical_id|path>` the way publish does. Shared so `asset-repair` speaks the same refs. */
export async function loadAssetRef(ref, deps) {
    if (looksLikeFile(ref)) {
        try {
            return normalizeAsset(JSON.parse(readFileSync(resolve(ref), 'utf8')));
        }
        catch (err) {
            if (err instanceof ContractError)
                throw err;
            if (err instanceof SyntaxError)
                throw new ContractError('schema_invalid', 'asset schema is invalid');
            throw err;
        }
    }
    const store = deps.assetStore;
    if (store) {
        const fromStore = await findAssetInStore(ref, store);
        // `not_found`, not `schema_invalid`: nothing was located, so no schema was
        // ever read. `reuse` already reports this ref-resolution failure that way.
        if (!fromStore)
            throw new ContractError('not_found', 'asset not found');
        return normalizeAsset(fromStore);
    }
    const assetsDir = contractAssetsDir(deps);
    const readOnly = loadLocalAssetsReadOnly(assetsDir, ref);
    const byAssetId = readOnly.filter((asset) => asset.asset_id === ref);
    if (byAssetId.length > 1)
        throw new ContractError('not_found', 'asset reference is ambiguous');
    let found = byAssetId[0];
    if (!found) {
        const exactLogical = readOnly.filter((asset) => stringField(asset, 'id') === ref);
        if (exactLogical.length > 1)
            throw new ContractError('not_found', 'asset reference is ambiguous');
        found = exactLogical[0];
    }
    if (!found) {
        const fallback = prefixedLogicalRef(ref);
        if (fallback) {
            const matches = readOnly.filter((asset) => asset.type === fallback.kind && stringField(asset, 'id') === fallback.id);
            if (matches.length > 1)
                throw new ContractError('not_found', 'asset reference is ambiguous');
            found = matches[0];
        }
    }
    if (!found)
        throw new ContractError('not_found', 'asset not found');
    return normalizeAsset(found);
}
function prefixedLogicalRef(ref) {
    const match = /^(gene|capsule):(.+)$/.exec(ref);
    if (!match?.[2])
        return null;
    return { kind: match[1] === 'gene' ? 'Gene' : 'Capsule', id: match[2] };
}
async function findLogicalAsset(store, id, kind) {
    if (store.findByLogicalId) {
        const matches = await store.findByLogicalId(id, 2, kind);
        if (matches.length > 1)
            throw new ContractError('not_found', 'asset reference is ambiguous');
        return matches[0] ?? null;
    }
    const scanLimit = 10_000;
    const rows = await store.list(kind, scanLimit + 1);
    if (rows.length > scanLimit)
        throw new ContractError('not_found', 'asset lookup is truncated; use an exact asset_id');
    const matches = rows.filter((asset) => stringField(asset, 'id') === id);
    if (matches.length > 1)
        throw new ContractError('not_found', 'asset reference is ambiguous');
    return matches[0] ?? null;
}
async function findAssetInStore(ref, store) {
    const byAssetId = await store.get(ref);
    if (byAssetId)
        return byAssetId;
    const exact = await findLogicalAsset(store, ref);
    if (exact)
        return exact;
    const fallback = prefixedLogicalRef(ref);
    return fallback ? findLogicalAsset(store, fallback.id, fallback.kind) : null;
}
async function autoPairPublishRefs(refs, geneRef, deps) {
    const store = deps.assetStore ?? new assetstore.LocalJsonlProvider(contractAssetsDir(deps));
    if (!(store instanceof assetstore.LocalJsonlProvider)) {
        throw new ContractError('bundle_required', '--auto-pair requires a local asset store; pass --capsule <id|path> explicitly');
    }
    const gene = await loadAssetRef(geneRef, { ...deps, assetStore: store });
    if (gene.type !== 'Gene')
        throw new ContractError('bundle_required', '--auto-pair requires a Gene reference');
    const geneIds = new Set([gene.asset_id, stringField(gene, 'id')].filter((id) => Boolean(id)));
    const trust = new assetstore.ProvenanceStore(store.baseDir).snapshot();
    const candidates = store.listAll('Capsule').filter((candidate) => {
        if (!geneIds.has(String(candidate['gene'] ?? '')))
            return false;
        const outcome = asRecord(candidate['outcome']);
        if (outcome?.['status'] !== 'success')
            return false;
        if (trust.get(candidate.asset_id)?.trusted === false)
            return false;
        if (!wire.validateWireDeep(candidate).ok)
            return false;
        return wire.verifyAssetId(candidate);
    });
    if (candidates.length === 0) {
        throw new ContractError('bundle_required', 'no eligible successful Capsule found; pass --capsule <id|path> explicitly');
    }
    if (candidates.length > 1) {
        throw new ContractError('bundle_required', 'multiple eligible Capsules found; pass --capsule <id|path> explicitly');
    }
    return [...refs, candidates[0].asset_id];
}
function loadLocalAssetsReadOnly(baseDir, targetRef) {
    return [
        ...loadLocalGenesReadOnly(baseDir, targetRef),
        ...readJsonLines(`${baseDir}/capsules.jsonl`, 'Capsule', targetRef),
        ...readJsonLines(`${baseDir}/events.jsonl`, 'EvolutionEvent', targetRef),
    ];
}
function loadLocalGenesReadOnly(baseDir, targetRef) {
    const byId = new Map();
    for (const gene of [
        ...readGenesEnvelopeReadOnly(`${baseDir}/genes.json`),
        ...readJsonLines(`${baseDir}/genes.jsonl`, 'Gene', targetRef),
    ]) {
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
    catch (err) {
        if (err instanceof ContractError)
            throw err;
        if (err instanceof SyntaxError)
            throw new ContractError('schema_invalid', 'asset schema is invalid');
        throw err;
    }
}
function readJsonLines(filePath, type, targetRef) {
    if (!existsSync(filePath))
        return [];
    try {
        return readFileSync(filePath, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((asset) => {
            if (!isRecord(asset))
                return false;
            if (asset['type'] === type)
                return true;
            if (stringField(asset, 'asset_id') === targetRef || stringField(asset, 'id') === targetRef) {
                throw new ContractError('schema_invalid', 'asset schema is invalid');
            }
            return false;
        })
            .map(normalizeAsset);
    }
    catch (err) {
        if (err instanceof ContractError)
            throw err;
        if (err instanceof SyntaxError)
            throw new ContractError('schema_invalid', 'asset schema is invalid');
        throw err;
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
        return { ok: false, message: BUNDLE_REQUIRED_MESSAGE };
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
    return store instanceof assetstore.LocalJsonlProvider ? store.baseDir : contractAssetsDir(deps);
}
function contractAssetsDir(deps) {
    return deps.assetsDir ?? events.assetsDir(deps.env ?? process.env);
}
function dryRunEnvelope(bundle, credits, blockDetail, repairAttempt) {
    const suppressPayload = bundle.blockReasons.includes('leak_detected');
    // Collect detailed messages for block reasons
    const blockDetails = [];
    if (blockDetail)
        blockDetails.push(blockDetail);
    for (const reason of bundle.blockReasons) {
        const detailMessage = bundle.blockMessages?.[reason];
        if (detailMessage && !blockDetails.includes(detailMessage)) {
            blockDetails.push(detailMessage);
        }
    }
    return {
        ok: true,
        contract: PUBLISH_CONTRACT,
        mode: 'dry_run',
        reversibility: REVERSIBILITY,
        blocked: bundle.blockReasons.length > 0,
        block_reasons: bundle.blockReasons,
        ...(blockDetails.length > 0 ? { block_details: blockDetails } : {}),
        assets: bundle.assets,
        ...(suppressPayload ? {} : { payload: { assets: bundle.sanitized } }),
        gates: bundle.gates,
        ...(credits ? { credits } : {}),
        ...repairEnvelopeField(repairAttempt),
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
        ...(opts.repair ? { repair: opts.repair } : {}),
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
async function composePublishedRecipe(transport, assets) {
    if (!transport.composeRecipe)
        return undefined;
    try {
        const composed = await transport.composeRecipe({
            compose_recipe: true,
            assets: [...assets],
        });
        return composed.ok && composed.recipeId ? composed.recipeId : undefined;
    }
    catch {
        return undefined;
    }
}
function createDefaultTransport(deps, opts = {}) {
    const env = loadContractEnv(deps);
    const hubMode = configuredHubMode(env);
    if (hubMode === 'private') {
        return createPrivateTransport(env, deps.resolveProxyClient ?? resolveDefaultPrivateProxy, opts.composeRecipe !== false);
    }
    const hubUrl = resolveHubUrl(env);
    const evomapDir = resolveIdentityHome(env);
    const explicitCredentials = resolveExplicitNodeCredentials(env);
    const { nodeSecret } = explicitCredentials;
    const sender = nodeSecret
        ? explicitCredentials.senderId ?? resolveAtpSenderId(env)
        : resolveAtpSenderId(env);
    const senderId = () => sender;
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
        ...(opts.composeRecipe === false ? {} : {
            composeRecipe: (payload) => hub.composeRecipeAfterAssetPublish(connected.hub, payload),
        }),
    };
}
function loadContractEnv(deps) {
    const env = { ...(deps.env ?? process.env) };
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error)
        throw new Error('failed to load EVOLVER_ENV_FILE');
    return env;
}
function preserveInheritedSecrets(runtimeEnv, inheritedEnv) {
    const env = { ...runtimeEnv };
    let index = 0;
    for (const [key, value] of Object.entries(inheritedEnv)) {
        if (!value || value === runtimeEnv[key] || !/SECRET|TOKEN|API[_-]?KEY|PASSWORD|AUTH|CREDENTIAL/i.test(key))
            continue;
        env[`EVOLVER_INHERITED_SECRET_${index++}`] = value;
    }
    return env;
}
function configuredHubMode(env) {
    const value = String(env['EVOMAP_HUB_MODE'] ?? 'public').trim().toLowerCase();
    if (value === 'public' || value === 'private')
        return value;
    throw new Error('EVOMAP_HUB_MODE must be public or private');
}
function resolveDefaultPrivateProxy(env) {
    return proxyClientFromEnv(env);
}
function createPrivateTransport(env, resolveProxy, composeRecipe = true) {
    const proxy = resolveProxy(env);
    if (!proxy)
        throw new Error('private Hub proxy credentials are not configured');
    const privateModeReady = assertPrivateProxyMode(proxy);
    return {
        validationCapabilityOptional: true,
        fetchAssetById: async (assetId) => {
            try {
                await privateModeReady;
                const body = await proxy.fetchAsset({ assetId, expectedHubMode: 'private' });
                return privateProxyAssets(body).find((asset) => (asset.asset_id === assetId || stringField(asset, 'id') === assetId)) ?? null;
            }
            catch (err) {
                if (err instanceof ContractError)
                    throw err;
                const message = err instanceof Error ? err.message : String(err);
                if (message === 'proxy_hub_mode_mismatch' || isAuthLikeError(err)) {
                    throw new ContractError('auth_required', 'private Hub proxy authentication required');
                }
                throw new ContractError('network_error', 'Hub unreachable');
            }
        },
        validate: async (bundle) => {
            try {
                await privateModeReady;
                const body = await proxy.validateAssetBundle({ assets: [...bundle], expected_hub_mode: 'private' });
                return { ok: hasExplicitValidatePass(body), status: 200, body };
            }
            catch (err) {
                if (err instanceof ContractError)
                    throw err;
                return privateProxyFailure(err);
            }
        },
        publish: async (bundle) => {
            try {
                await privateModeReady;
                const body = normalizePrivatePublishBody(await proxy.submitAssetBundle({
                    assets: [...bundle],
                    expected_hub_mode: 'private',
                    ...(composeRecipe ? {} : { compose_recipe: false }),
                }));
                return { ok: !privatePublishExplicitFailure(body) && normalizePublishStatus(body) !== undefined, status: 200, body };
            }
            catch (err) {
                if (err instanceof ContractError)
                    throw err;
                return privateProxyFailure(err);
            }
        },
    };
}
async function assertPrivateProxyMode(proxy) {
    const status = asRecord(await proxy.status()) ?? {};
    if (status['hub_mode'] !== 'private') {
        throw new ContractError('auth_required', 'private Hub proxy mode mismatch');
    }
}
function isValidationCapabilityUnavailable(body) {
    const root = asRecord(body) ?? {};
    const payload = asRecord(root['payload']) ?? {};
    return (root['reason'] ?? payload['reason']) === 'validate_not_configured';
}
function privateProxyAssets(body) {
    const root = asRecord(body) ?? {};
    const payload = asRecord(root['payload']) ?? {};
    const rows = Array.isArray(root['assets']) ? root['assets'] : Array.isArray(payload['assets']) ? payload['assets'] : [];
    return rows.filter((asset) => Boolean(asset && typeof asset === 'object' && !Array.isArray(asset)));
}
function normalizePrivatePublishBody(body) {
    const root = asRecord(body);
    if (!root)
        return body;
    const payload = asRecord(root['payload']);
    if (payload) {
        return { ...root, payload: normalizePrivatePublishLayer(payload) };
    }
    return normalizePrivatePublishLayer(root);
}
function normalizePrivatePublishLayer(body) {
    const receiptId = stringField(body, 'receipt_id') ?? stringField(body, 'receiptId');
    return {
        ...body,
        ...(stringField(body, 'status') === 'pending' ? { status: 'queued' } : {}),
        ...(receiptId ? { receipt_id: receiptId } : {}),
    };
}
function privatePublishExplicitFailure(body) {
    const root = asRecord(body) ?? {};
    const payload = asRecord(root['payload']) ?? {};
    return root['ok'] === false || root['stored'] === false || payload['ok'] === false || payload['stored'] === false;
}
function privateProxyFailure(err) {
    return { ok: false, status: isAuthLikeError(err) ? 401 : 0 };
}
function isAuthLikeError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /oauth|login|credential|auth|401|403|node_secret/i.test(message);
}
function classifyError(err, command, env = {}) {
    if (err instanceof ContractError)
        return { reason: err.reason, message: err.safeMessage, retryable: err.reason === 'network_error' };
    if (err instanceof AuthError)
        return {
            reason: 'auth_required',
            message: command === 'publish' ? publishAuthRequiredMessage(env) : 'Hub authentication required',
            retryable: false,
        };
    if (err instanceof HubUnreachableError)
        return { reason: 'network_error', message: 'Hub unreachable', retryable: true };
    if (err instanceof HubClientError) {
        const reason = stableContractReasonFromBody(err.body) ?? (command === 'reuse' ? reuseReasonFromStatus(err.status) : publishReasonFromStatus(err.status));
        return { reason, message: command === 'publish' ? publishReasonMessage(reason, env) : reuseReasonMessage(reason), retryable: publishRetryable(reason) };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/oauth|login|credential|auth|401|403|node_secret/i.test(message))
        return {
            reason: 'auth_required',
            message: command === 'publish' ? publishAuthRequiredMessage(env) : 'Hub authentication required',
            retryable: false,
        };
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
function publishAuthRequiredMessage(env) {
    const rawMode = env['EVOMAP_HUB_MODE']?.trim().toLowerCase();
    if (rawMode && rawMode !== 'public' && rawMode !== 'private') {
        return 'Hub authentication failed; verify EVOMAP_HUB_MODE and the configured credentials';
    }
    if (rawMode === 'private')
        return PRIVATE_AUTH_REQUIRED_MESSAGE;
    return resolveExplicitNodeCredentials(env).nodeSecret
        ? LEGACY_AUTH_REQUIRED_MESSAGE
        : OAUTH_AUTH_REQUIRED_MESSAGE;
}
function publishReasonMessage(reason, env = {}) {
    const map = {
        missing_id: 'missing asset id',
        cli_unavailable: 'evolver CLI unavailable',
        auth_required: publishAuthRequiredMessage(env),
        not_found: 'asset not found',
        network_error: 'Hub unreachable',
        unsupported: 'publish unsupported',
        internal_error: 'evolver publish failed',
        redaction_unavailable: 'redaction unavailable',
        leak_detected: 'leak detected after redaction',
        schema_invalid: 'asset schema is invalid',
        bundle_required: BUNDLE_REQUIRED_MESSAGE,
        quality_gate_failed: 'Hub quality gate failed',
        gene_unproven: 'gene has no proven success yet — run it to a successful outcome before publishing',
        insufficient_credits: 'insufficient credits',
        unsafe_validation_command: 'validation command contains unsafe patterns (e.g., node -e, shell metacharacters) blocked by sandbox security policy',
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
    if (status === 'candidate')
        return 'queued';
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