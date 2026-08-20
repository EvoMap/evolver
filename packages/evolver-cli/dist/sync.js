import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assetstore, events, hub as hubNs, wire } from '@evomap/evolver-core';
import { AuthError, connectPublicHub, HubClientError, HubUnreachableError, isHubDryRunEnabled, MalformedAccountAssetPageError, resolveHubUrl, stripHubDeliveryMetadataForIntegrity, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { createRecipeHubFromEnv, resolveRecipeHubResumeIdentityFingerprint } from './recipe.js';
import { getCliVersion } from './version.js';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_CURSOR_LENGTH = 4096;
const MAX_CONSECUTIVE_EMPTY_PAGES = 10;
const MAX_CONSECUTIVE_PAGES_WITHOUT_UNIQUE_PROGRESS = 10;
const MAX_RAW_PAGES = 20_000;
const MAX_RAW_ROWS = 100_000;
const MAX_GEPX_BYTES = 64 * 1024 * 1024;
const MAX_GEPX_ASSETS = 10_000;
const MAX_GEPX_SIDECAR_RECORDS = MAX_GEPX_ASSETS;
const GROUP = 'sync';
const USAGE = [
    'usage: evolver sync [--write] [--force] [--resume] [--scope all|purchased|published] [--type Gene|Capsule] [--status draft|promoted|all] [--limit N] [--page-size N] [--purchased-cursor CURSOR] [--published-cursor CURSOR] [--json]',
    '       evolver sync --export <file.gepx> [--type Gene|Capsule] [--limit N] [--json]',
    '       evolver sync --import <file.gepx> [--write] [--force] [--type Gene|Capsule] [--limit N] [--json]',
    '       evolver sync --json',
].join('\n');
const VALUE_FLAGS = new Set(['--scope', '--type', '--status', '--limit', '--page-size', '--purchased-cursor', '--published-cursor', '--export', '--import']);
const GEPX_TYPE = 'evomap.gepx';
const GEPX_VERSION = 1;
const MISSING_ASSET_ID = '[missing]';
const UNVERIFIED_HUB_WRITE_PENDING_REASON = 'unverified_hub_write_pending';
export async function runSyncCommand(argv, deps = {}) {
    const out = deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); });
    const err = deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); });
    const textOut = (line) => { out(formatTerminalText(line)); };
    const parsed = parseSyncArgs(argv);
    if (!parsed.ok)
        return emitFailure(parsed.reason, parsed.message, parsed.jsonOut, out, err);
    if ('help' in parsed) {
        if (parsed.jsonOut)
            out(stringifyJsonOutput({ ok: true, group: GROUP, mode: 'help', usage: USAGE }));
        else
            out(USAGE);
        return 0;
    }
    try {
        const env = deps.env ?? process.env;
        loadSyncEnv(env);
        const runtimeDeps = {
            ...deps,
            env,
            assetsDir: deps.assetsDir ?? join(events.evomapHome(env), 'assets'),
        };
        const result = parsed.value.exportPath
            ? await executeSyncExport(parsed.value, runtimeDeps)
            : parsed.value.importPath
                ? parsed.value.write
                    ? await executeGepxImportWrite(parsed.value, runtimeDeps)
                    : await buildGepxImportPreview(parsed.value, runtimeDeps)
                : parsed.value.write
                    ? await executeSyncWrite(parsed.value, runtimeDeps)
                    : await executeSyncPreview(parsed.value, runtimeDeps);
        if (parsed.value.jsonOut)
            out(stringifyJsonOutput(result));
        else if (result.mode === 'preview')
            emitTextPreview(result, textOut);
        else if (result.mode === 'export')
            emitTextExport(result, textOut);
        else if (result.mode === 'import_preview')
            emitTextImportPreview(result, textOut);
        else if (result.mode === 'import')
            emitTextImport(result, textOut);
        else
            emitTextWrite(result, textOut);
        if ('failures' in result && result.failures.length > 0)
            return 1;
        if (result.mode === 'import' && result.blocked.length > 0)
            return 1;
        if (result.mode === 'write' && !result.reconciliation.consistent)
            return 1;
        return 0;
    }
    catch (error) {
        const mapped = mapSyncError(error);
        return emitFailure(mapped.reason, mapped.message, parsed.value.jsonOut, out, err);
    }
}
function parseSyncArgs(argv) {
    let scope = 'all';
    let type;
    let status = 'all';
    let limit = DEFAULT_LIMIT;
    let pageSize = DEFAULT_PAGE_SIZE;
    let purchasedCursor;
    let publishedCursor;
    let jsonOut = argv.includes('--json');
    let write = false;
    let force = false;
    let resume = false;
    let exportPath;
    let importPath;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token)
            continue;
        if (token === '--help' || token === '-h')
            return { ok: true, help: true, jsonOut };
        if (token === '--json') {
            jsonOut = true;
            continue;
        }
        if (token === '--write') {
            write = true;
            continue;
        }
        if (token === '--force') {
            force = true;
            continue;
        }
        if (token === '--resume') {
            resume = true;
            continue;
        }
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            const flag = eq >= 0 ? token.slice(0, eq) : token;
            if (!VALUE_FLAGS.has(flag)) {
                return { ok: false, reason: 'invalid_arg', message: `unsupported sync argument: ${flag}`, jsonOut };
            }
            const value = eq >= 0 ? token.slice(eq + 1) : argv[i + 1];
            if (!value || value.startsWith('--'))
                return { ok: false, reason: 'invalid_arg', message: `${flag} requires a value`, jsonOut };
            if (eq < 0)
                i += 1;
            if (flag === '--scope') {
                if (value !== 'all' && value !== 'purchased' && value !== 'published') {
                    return { ok: false, reason: 'invalid_arg', message: '--scope must be all|purchased|published', jsonOut };
                }
                scope = value;
            }
            else if (flag === '--type') {
                if (value !== 'Gene' && value !== 'Capsule')
                    return { ok: false, reason: 'invalid_arg', message: '--type must be Gene|Capsule', jsonOut };
                type = value;
            }
            else if (flag === '--status') {
                if (value !== 'draft' && value !== 'promoted' && value !== 'all') {
                    return { ok: false, reason: 'invalid_arg', message: '--status must be draft|promoted|all', jsonOut };
                }
                status = value;
            }
            else if (flag === '--limit') {
                const parsedLimit = Number(value);
                if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0)
                    return { ok: false, reason: 'invalid_arg', message: '--limit must be a positive integer', jsonOut };
                limit = Math.min(parsedLimit, MAX_LIMIT);
            }
            else if (flag === '--page-size') {
                const parsedPageSize = Number(value);
                if (!Number.isSafeInteger(parsedPageSize) || parsedPageSize <= 0)
                    return { ok: false, reason: 'invalid_arg', message: '--page-size must be a positive integer', jsonOut };
                pageSize = Math.min(parsedPageSize, MAX_PAGE_SIZE);
            }
            else if (flag === '--purchased-cursor' || flag === '--published-cursor') {
                if (!isValidOpaqueCursor(value)) {
                    return { ok: false, reason: 'invalid_arg', message: `${flag} must be a non-empty cursor of at most ${MAX_CURSOR_LENGTH} characters`, jsonOut };
                }
                if (flag === '--purchased-cursor')
                    purchasedCursor = value;
                else
                    publishedCursor = value;
            }
            else if (flag === '--export') {
                exportPath = value;
            }
            else if (flag === '--import') {
                importPath = value;
            }
            continue;
        }
        return { ok: false, reason: 'invalid_arg', message: `unsupported sync argument: ${token}`, jsonOut };
    }
    if (force && !write) {
        return { ok: false, reason: 'force_requires_write', message: '--force requires --write', jsonOut };
    }
    if (resume && !write) {
        return { ok: false, reason: 'resume_requires_write', message: '--resume requires --write', jsonOut };
    }
    if (exportPath && importPath) {
        return { ok: false, reason: 'invalid_arg', message: '--export and --import cannot be used together', jsonOut };
    }
    if (exportPath && write) {
        return { ok: false, reason: 'invalid_arg', message: '--export does not use --write', jsonOut };
    }
    if (purchasedCursor && scope === 'published') {
        return { ok: false, reason: 'invalid_arg', message: '--purchased-cursor requires --scope all|purchased', jsonOut };
    }
    if (publishedCursor && scope === 'purchased') {
        return { ok: false, reason: 'invalid_arg', message: '--published-cursor requires --scope all|published', jsonOut };
    }
    if ((purchasedCursor || publishedCursor) && (exportPath || importPath)) {
        return { ok: false, reason: 'invalid_arg', message: 'Hub cursors cannot be used with --export or --import', jsonOut };
    }
    return { ok: true, value: { scope, ...(type ? { type } : {}), status, limit, pageSize, ...(purchasedCursor ? { purchasedCursor } : {}), ...(publishedCursor ? { publishedCursor } : {}), jsonOut, write, force, resume, ...(exportPath ? { exportPath } : {}), ...(importPath ? { importPath } : {}) } };
}
async function buildSyncPreview(opts, deps, listing = {
    skipPurchased: false,
    skipPublished: false,
}) {
    const env = deps.env ?? process.env;
    validatePrivateHubUrl(env);
    if (isHubDryRunEnabled(env))
        return emptyPreview(opts.scope);
    const hub = deps.hub ?? await createDefaultHub(deps, env);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const local = await localIndex(store);
    const { purchased, published, failures, inventoryComplete, nextCursors } = await listRemoteRows(hub, opts, listing);
    const provenanceSnapshot = previewProvenanceSnapshot(store, deps);
    const counts = {
        remotePurchased: purchased.length,
        remotePublished: published.length,
        uniqueRemote: 0,
        alreadyLocal: 0,
        tombstone: 0,
        idCollision: 0,
        unsupported: 0,
        integrityError: 0,
        wouldImport: 0,
        unverifiedWouldImport: 0,
        forcedImport: 0,
        skippedLimit: 0,
        fetchFailed: 0,
        writeFailed: 0,
    };
    const unique = new Map();
    const conflictingDuplicateAssetIds = new Set();
    const missingAssetId = [];
    for (const row of purchased)
        addUnique(unique, missingAssetId, conflictingDuplicateAssetIds, row, 'purchased');
    for (const row of published)
        addUnique(unique, missingAssetId, conflictingDuplicateAssetIds, row, 'published');
    counts.uniqueRemote = unique.size + missingAssetId.length;
    const candidates = [];
    const pendingLogical = new Map(local.logical);
    for (const { row, source } of [...unique.values(), ...missingAssetId]) {
        const assetId = rawStringField(row, 'asset_id');
        const candidate = assetId && conflictingDuplicateAssetIds.has(assetId)
            ? classifyConflictingRemoteDuplicate(row, source)
            : classifyRemote(row, source, { ...local, logical: pendingLogical }, provenanceSnapshot);
        candidates.push(candidate);
        if (candidate.action === 'already_local')
            counts.alreadyLocal += 1;
        else if (candidate.action === 'tombstone')
            counts.tombstone += 1;
        else if (candidate.action === 'id_collision')
            counts.idCollision += 1;
        else if (candidate.action === 'would_import') {
            counts.wouldImport += 1;
            if (candidate.verification === 'unverified')
                counts.unverifiedWouldImport += 1;
            if (candidate.logicalId && (candidate.type === 'Gene' || candidate.type === 'Capsule')) {
                pendingLogical.set(`${candidate.type}:${candidate.logicalId}`, candidate.assetId);
            }
        }
        else if (candidate.action === 'force_import')
            counts.forcedImport += 1;
        else if (candidate.action === 'unsupported_type')
            counts.unsupported += 1;
        else
            counts.integrityError += 1;
    }
    return {
        ok: true,
        group: GROUP,
        mode: 'preview',
        scope: opts.scope,
        counts,
        candidates,
        failures,
        nextCursors,
        reconciliation: reconcile(candidates, failures, 0, false, inventoryComplete, 0),
    };
}
async function executeSyncPreview(opts, deps) {
    const env = deps.env ?? process.env;
    validatePrivateHubUrl(env);
    if (isHubDryRunEnabled(env))
        return emptyPreview(opts.scope);
    const hub = deps.hub ?? await createDefaultHub(deps, env);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    if (!opts.purchasedCursor && !opts.publishedCursor) {
        return buildSyncPreview(opts, { ...deps, env, hub, store });
    }
    const baseDir = storeBaseDir(store, deps);
    const syncLedger = deps.syncLedger ?? new assetstore.AssetSyncLedger(baseDir, deps.now);
    const inventoryKey = syncInventoryKey(opts, env, deps);
    const inventoryScan = prepareInventoryScan(syncLedger, inventoryKey, opts);
    return buildSyncPreview(opts, { ...deps, env, hub, store }, inventoryScan);
}
async function executeSyncWrite(opts, deps) {
    const env = deps.env ?? process.env;
    validatePrivateHubUrl(env);
    if (isHubDryRunEnabled(env))
        return emptyWrite(opts.scope, 'dry_run');
    const hub = deps.hub ?? await createDefaultHub(deps, env);
    if (!hasFetchAssetById(hub))
        throw new Error('sync write requires fetchAssetById support');
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const baseDir = storeBaseDir(store, deps);
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(baseDir, deps.now);
    const syncLedger = deps.syncLedger ?? new assetstore.AssetSyncLedger(baseDir, deps.now);
    const runKey = syncRunKey(opts, env, deps);
    const inventoryKey = syncInventoryKey(opts, env, deps);
    const inventoryScan = prepareInventoryScan(syncLedger, inventoryKey, opts);
    const preview = await buildSyncPreview(opts, { ...deps, env, hub, store, provenance }, inventoryScan);
    const local = await localIndex(store);
    const provenanceSnapshot = provenance.snapshot();
    const pendingUnverifiedRecoveryIds = await reactivatePendingUnverifiedCandidates(preview.candidates, store, provenanceSnapshot);
    const thinFrozenRevalidationIds = reactivateThinFrozenCandidates(preview.candidates, local, provenanceSnapshot);
    const checkpointEnabled = !preview.failures.some((failure) => failure.stage === 'list');
    const previousRun = opts.resume && checkpointEnabled ? syncLedger.latestIncompleteRun(runKey) : null;
    const runId = previousRun?.runId ?? randomUUID();
    const appendRunCheckpoint = (record) => {
        if (checkpointEnabled)
            syncLedger.appendRun(record);
    };
    const resumeSelection = previousRun
        ? resumePlannedCandidates(preview.candidates, previousRun, preview.reconciliation.inventoryComplete)
        : { candidates: preview.candidates.map((candidate) => ({ ...candidate })), remoteMissingAssetIds: [], newRemoteMissingAssetIds: [] };
    const finalCandidates = resumeSelection.candidates;
    const currentPlan = actionableCandidatePlanIds(finalCandidates, opts.force);
    const runPlan = previousRun?.plan ? mergeCandidatePlan(previousRun.plan, currentPlan) : currentPlan;
    const hasActionable = currentPlan.length > 0;
    if (previousRun?.plan) {
        if (runPlan.length > previousRun.plan.length) {
            appendRunCheckpoint({ runId, runKey, state: 'started', plan: runPlan });
        }
    }
    if (hasActionable && !previousRun) {
        appendRunCheckpoint({
            runId,
            runKey,
            state: 'started',
            plan: runPlan,
        });
    }
    for (const assetId of resumeSelection.newRemoteMissingAssetIds) {
        appendRunCheckpoint({
            runId,
            runKey,
            state: 'progress',
            remoteAssetId: assetId,
            outcome: 'remote_missing',
        });
    }
    const failures = [...preview.failures];
    const resumed = previousRun
        ? await reconcileResumeCandidates({
            candidates: finalCandidates,
            previousRun,
            store,
            provenanceSnapshot,
            syncLedger,
            appendRunCheckpoint,
            runId,
            runKey,
            inventoryKey,
            failures,
        })
        : 0;
    await verifyAlreadyLocalCandidates(finalCandidates, store, provenanceSnapshot, failures);
    const prepared = [];
    const pendingLogical = new Map(local.logical);
    for (const candidate of finalCandidates) {
        if (candidate.action !== 'would_import' && !(opts.force && candidate.action === 'id_collision'))
            continue;
        const checkpoint = previousRun?.processed.get(candidate.assetId);
        if (checkpoint
            && checkpoint.outcome !== 'failed'
            && local.byAssetId.has(candidate.assetId)
            && !pendingUnverifiedRecoveryIds.has(candidate.assetId)
            && !thinFrozenRevalidationIds.has(candidate.assetId))
            continue;
        let preparedAsset;
        try {
            const fetched = await hub.fetchAssetById(candidate.assetId, { allowUnverifiedExactIdentity: true });
            if (!fetched)
                throw new SyncAbortError('not_found', 'Hub asset disappeared before import');
            preparedAsset = prepareFetchedAsset(candidate, fetched, local.byAssetId, pendingLogical, opts.force, pendingUnverifiedRecoveryIds.has(candidate.assetId)
                || thinFrozenRevalidationIds.has(candidate.assetId));
        }
        catch (error) {
            const mapped = mapSyncError(error);
            failures.push({ stage: 'fetch', assetId: candidate.assetId, reason: mapped.reason });
            appendRunCheckpoint({ runId, runKey, state: 'progress', remoteAssetId: candidate.assetId, outcome: 'failed', reason: mapped.reason });
            updateFinalCandidate(finalCandidates, candidate, mapped.reason === 'integrity_error'
                ? { ...candidate, action: 'integrity_error' }
                : mapped.reason === 'remote_revoked'
                    ? { ...candidate, action: 'tombstone', failureReason: mapped.reason }
                    : { ...candidate, action: 'fetch_failed', failureReason: mapped.reason });
            continue;
        }
        if ('blocked' in preparedAsset) {
            updateFinalCandidate(finalCandidates, candidate, preparedAsset.blocked);
            continue;
        }
        if (thinFrozenRevalidationIds.has(candidate.assetId)) {
            try {
                const persistedProvenance = provenance.get(candidate.assetId);
                const stored = await readBackStoredAsset(store, candidate.assetId, preparedAsset.asset, false, persistedProvenance, preparedAsset.asset.type);
                if (!preparedAsset.frozenUnverified
                    || !preparedAsset.verificationReason
                    || !preparedAsset.frozenContentId
                    || !isActiveFrozenWaiver(persistedProvenance, candidate.assetId, preparedAsset.frozenContentId)
                    || !assetstore.frozenAssetRecordsEqual(stored, preparedAsset.asset)) {
                    throw new SyncAbortError('integrity_error', 'Fetched Hub body differs from frozen local content');
                }
                updateFinalCandidate(finalCandidates, candidate, {
                    ...candidate,
                    action: 'already_local',
                    verification: 'unverified',
                    verificationReason: preparedAsset.verificationReason,
                });
                appendRunCheckpoint({
                    runId,
                    runKey,
                    state: 'progress',
                    remoteAssetId: candidate.assetId,
                    outcome: 'already_local',
                });
            }
            catch (error) {
                const mapped = mapSyncError(error);
                failures.push({ stage: 'fetch', assetId: candidate.assetId, reason: mapped.reason });
                appendRunCheckpoint({
                    runId,
                    runKey,
                    state: 'progress',
                    remoteAssetId: candidate.assetId,
                    outcome: 'failed',
                    reason: mapped.reason,
                });
                updateFinalCandidate(finalCandidates, candidate, mapped.reason === 'integrity_error'
                    ? { ...candidate, action: 'integrity_error', failureReason: mapped.reason }
                    : { ...candidate, action: 'fetch_failed', failureReason: mapped.reason });
            }
            continue;
        }
        const logicalId = rawStringField(preparedAsset.asset, 'id');
        const finalCandidateBase = {
            assetId: candidate.assetId,
            type: candidate.type,
            source: candidate.source,
            ...(candidate.status ? { status: candidate.status } : {}),
            ...(logicalId ? { logicalId } : {}),
            ...(preparedAsset.frozenUnverified && preparedAsset.verificationReason
                ? { verification: 'unverified', verificationReason: preparedAsset.verificationReason }
                : {}),
        };
        const finalCandidate = preparedAsset.forced
            ? {
                ...finalCandidateBase,
                action: 'force_import',
                collisionWithAssetId: preparedAsset.collisionWithAssetId,
            }
            : { ...finalCandidateBase, action: 'would_import' };
        updateFinalCandidate(finalCandidates, candidate, finalCandidate);
        prepared.push({
            candidate: finalCandidate,
            asset: preparedAsset.asset,
            ...(preparedAsset.frozenUnverified ? { frozenUnverified: true } : {}),
            ...(preparedAsset.verificationReason ? { verificationReason: preparedAsset.verificationReason } : {}),
            ...(preparedAsset.frozenContentId ? { frozenContentId: preparedAsset.frozenContentId } : {}),
            ...(preparedAsset.forced ? { forced: true, collisionWithAssetId: preparedAsset.collisionWithAssetId } : {}),
        });
        if (logicalId)
            pendingLogical.set(`${preparedAsset.asset.type}:${logicalId}`, preparedAsset.asset.asset_id);
    }
    const written = [];
    for (const item of prepared) {
        try {
            const stored = item.frozenUnverified && item.verificationReason
                ? await assetstore.ingestUnverifiedConditional(store, provenance, item.asset, item.verificationReason, { allowLogicalCollision: opts.force }, 'hub')
                : await assetstore.ingestUntrustedConditional(store, provenance, item.asset, { allowLogicalCollision: opts.force }, 'hub');
            const assetId = stored.asset_id;
            if (stored.status === 'logical_collision') {
                updateFinalCandidate(finalCandidates, item.candidate, {
                    ...item.candidate,
                    assetId,
                    action: 'id_collision',
                    collisionWithAssetId: stored.collisionWithAssetId,
                });
                continue;
            }
            const persistedProvenance = provenance.get(assetId);
            await readBackStoredAsset(store, assetId, item.asset, false, persistedProvenance, item.asset.type);
            if (stored.status === 'already_exists') {
                updateFinalCandidate(finalCandidates, item.candidate, { ...item.candidate, assetId, action: 'already_local' });
                if (item.frozenUnverified && !syncLedger.getForRunKey(runKey, assetId)) {
                    appendSyncRecord(syncLedger, item.candidate, item.asset, runKey, inventoryKey, {
                        ...(item.forced ? { forced: true } : {}),
                        ...(item.collisionWithAssetId ? { collisionWithAssetId: item.collisionWithAssetId } : {}),
                    });
                }
                appendRunCheckpoint({
                    runId,
                    runKey,
                    state: 'progress',
                    remoteAssetId: item.candidate.assetId,
                    outcome: item.frozenUnverified ? 'imported' : 'already_local',
                });
                continue;
            }
            const collisionWithAssetId = stored.collisionWithAssetId ?? item.collisionWithAssetId;
            const forced = item.forced === true || collisionWithAssetId !== undefined;
            const writtenCandidate = forced
                ? { ...item.candidate, action: 'force_import', collisionWithAssetId }
                : item.candidate;
            updateFinalCandidate(finalCandidates, item.candidate, writtenCandidate);
            appendSyncRecord(syncLedger, writtenCandidate, item.asset, runKey, inventoryKey, {
                ...(forced ? { forced: true } : {}),
                ...(collisionWithAssetId ? { collisionWithAssetId } : {}),
            });
            appendRunCheckpoint({ runId, runKey, state: 'progress', remoteAssetId: item.candidate.assetId, outcome: 'imported' });
            written.push({
                assetId,
                type: item.asset.type,
                source: writtenCandidate.source,
                stored: true,
                trusted: false,
                verification: item.frozenUnverified ? 'unverified' : 'verified',
                ...(item.verificationReason ? { verificationReason: item.verificationReason } : {}),
                ...(item.frozenContentId ? { frozenContentId: item.frozenContentId } : {}),
                ...(writtenCandidate.logicalId ? { logicalId: writtenCandidate.logicalId } : {}),
                ...(writtenCandidate.status ? { status: writtenCandidate.status } : {}),
                ...(forced ? { forced: true } : {}),
                ...(collisionWithAssetId ? { collisionWithAssetId } : {}),
            });
        }
        catch (error) {
            const mapped = mapSyncError(error);
            failures.push({ stage: 'write', assetId: item.candidate.assetId, reason: mapped.reason });
            appendRunCheckpoint({ runId, runKey, state: 'progress', remoteAssetId: item.candidate.assetId, outcome: 'failed', reason: mapped.reason });
            updateFinalCandidate(finalCandidates, item.candidate, mapped.reason === 'integrity_error'
                ? { ...item.candidate, action: 'integrity_error', failureReason: mapped.reason }
                : { ...item.candidate, action: 'write_failed', failureReason: mapped.reason });
        }
    }
    const retryableInventoryFailure = failures.some(isRetryableAssetFailure);
    let inventoryComplete = preview.reconciliation.inventoryComplete;
    if (retryableInventoryFailure)
        inventoryComplete = false;
    let remoteAssetIds = new Set(finalCandidates.flatMap((candidate) => (candidate.assetId === MISSING_ASSET_ID ? [] : [candidate.assetId])));
    let missingRemote = inventoryComplete
        ? countMissingRemote(syncLedger, inventoryKey, runKey, local.byAssetId, remoteAssetIds)
        : 0;
    let reconciliation;
    let inventoryCheckpointFailed = false;
    if (inventoryScan.trackable
        && inventoryScan.index === 0
        && !inventoryScan.retry
        && inventoryComplete
        && !failures.some((failure) => failure.stage === 'list')) {
        try {
            syncLedger.clearInventoryScan(inventoryKey);
        }
        catch {
            failures.push({ stage: 'list', reason: 'inventory_scan_checkpoint_failed' });
            inventoryComplete = false;
            missingRemote = 0;
            inventoryCheckpointFailed = true;
        }
    }
    const shouldCheckpointInventory = inventoryScan.trackable
        && !inventoryCheckpointFailed
        && !failures.some((failure) => failure.stage === 'list')
        && (!inventoryComplete || inventoryScan.index > 0 || inventoryScan.retry);
    if (shouldCheckpointInventory) {
        const segment = inventorySegmentOutcome(finalCandidates, failures, written);
        const inventoryBatch = {
            scanId: inventoryScan.scanId,
            inventoryKey,
            scope: opts.scope,
            index: inventoryScan.index,
            inputCursorFingerprints: inventoryScan.inputCursorFingerprints,
            nextCursorFingerprints: retryableInventoryFailure
                ? inventoryScan.inputCursorFingerprints
                : fingerprintCursors(preview.nextCursors),
            items: segment.items,
            anonymousBlocked: segment.anonymousBlocked,
            ...(retryableInventoryFailure ? { cursorHeld: true } : {}),
        };
        const appended = inventoryScan.retry
            ? syncLedger.replaceInventoryRetryBatch(inventoryBatch)
            : syncLedger.appendInventoryBatch(inventoryBatch);
        const snapshot = appended ? syncLedger.latestInventoryScan(inventoryKey) : undefined;
        if (!snapshot || snapshot.scanId !== inventoryScan.scanId) {
            failures.push({ stage: 'list', reason: 'inventory_scan_checkpoint_failed' });
            inventoryComplete = false;
            missingRemote = 0;
            inventoryCheckpointFailed = true;
        }
        else if (snapshot.complete) {
            inventoryComplete = true;
            remoteAssetIds = new Set(snapshot.outcomes.keys());
            missingRemote = countMissingRemote(syncLedger, inventoryKey, runKey, local.byAssetId, remoteAssetIds);
            reconciliation = reconcileInventorySnapshot(snapshot, missingRemote);
        }
    }
    reconciliation ??= reconcile(finalCandidates, failures, written.length, true, inventoryComplete, missingRemote);
    const counts = countsFromCandidates(preview.counts, finalCandidates);
    const blocked = finalCandidates.filter(isBlockedCandidate);
    const failedAssetIds = new Set(failures.flatMap((failure) => failure.assetId ? [failure.assetId] : []));
    const finalCandidatesByAssetId = new Map(finalCandidates.map((candidate) => [candidate.assetId, candidate]));
    const writtenAssetIds = new Set(written.map((asset) => asset.assetId));
    const remoteMissingAssetIds = new Set(resumeSelection.remoteMissingAssetIds);
    const actionComplete = runPlan.every((assetId) => {
        if (remoteMissingAssetIds.has(assetId))
            return true;
        if (failedAssetIds.has(assetId))
            return false;
        if (local.byAssetId.has(assetId) || writtenAssetIds.has(assetId))
            return true;
        const candidate = finalCandidatesByAssetId.get(assetId);
        return candidate?.action === 'already_local' || (candidate !== undefined && isBlockedCandidate(candidate));
    });
    if ((hasActionable || previousRun) && actionComplete && !inventoryCheckpointFailed) {
        appendRunCheckpoint({ runId, runKey, state: 'completed' });
    }
    return {
        ok: true,
        group: GROUP,
        mode: 'write',
        scope: opts.scope,
        counts,
        candidates: finalCandidates,
        written,
        blocked,
        failures,
        nextCursors: preview.nextCursors,
        resumed,
        reconciliation,
    };
}
async function executeSyncExport(opts, deps) {
    if (!opts.exportPath)
        throw new SyncAbortError('invalid_arg', '--export requires a file');
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const baseDir = storeBaseDir(store, deps);
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(baseDir, deps.now);
    const syncLedger = deps.syncLedger ?? new assetstore.AssetSyncLedger(baseDir, deps.now);
    const provenanceSnapshot = provenance.snapshot();
    const assets = await listLocalExportAssets(store, opts);
    const provenanceRecords = assets
        .map((asset) => provenanceSnapshot.get(asset.asset_id) ?? null)
        .filter((record) => Boolean(record));
    const syncRecords = assets
        .map((asset) => syncLedger.get(asset.asset_id))
        .filter((record) => Boolean(record));
    const pkg = {
        type: GEPX_TYPE,
        version: GEPX_VERSION,
        exportedAt: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
        assets,
        malformedAssets: [],
        provenance: provenanceRecords,
        sync: syncRecords,
    };
    let serialized;
    try {
        serialized = `${JSON.stringify(pkg, null, 2)}\n`;
    }
    catch {
        throw new SyncAbortError('export_failed', 'could not serialize .gepx package');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_GEPX_BYTES) {
        throw new SyncAbortError('gepx_too_large', '.gepx package exceeds the 64 MiB limit');
    }
    try {
        mkdirSync(dirname(opts.exportPath), { recursive: true });
        writeFileSync(opts.exportPath, serialized, 'utf8');
    }
    catch {
        throw new SyncAbortError('export_failed', 'could not write .gepx file');
    }
    return {
        ok: true,
        group: GROUP,
        mode: 'export',
        counts: {
            exported: assets.length,
            provenance: provenanceRecords.length,
            sync: syncRecords.length,
        },
        assets: assets.map((asset) => ({
            assetId: asset.asset_id,
            type: asset.type,
            ...(rawStringField(asset, 'id') ? { logicalId: rawStringField(asset, 'id') } : {}),
            trusted: provenanceSnapshot.get(asset.asset_id)?.trusted ?? true,
            synced: Boolean(syncLedger.get(asset.asset_id)),
        })),
    };
}
async function buildGepxImportPreview(opts, deps) {
    const pkg = readGepxPackage(opts.importPath);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const local = await localIndex(store);
    const candidates = classifyGepxAssets(pkg, opts, local);
    return { ok: true, group: GROUP, mode: 'import_preview', counts: countsFromCandidates(emptyCounts(candidates.length), candidates), candidates };
}
async function executeGepxImportWrite(opts, deps) {
    const pkg = readGepxPackage(opts.importPath);
    assertNoConflictingGepxDuplicates(pkg);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const local = await localIndex(store);
    const finalCandidates = classifyGepxAssets(pkg, opts, local);
    const failures = finalCandidates
        .filter((candidate) => candidate.action === 'integrity_error')
        .map((candidate) => ({
        stage: 'write',
        ...(candidate.assetId.startsWith(MISSING_ASSET_ID) ? {} : { assetId: candidate.assetId }),
        reason: candidate.failureReason ?? 'integrity_error',
    }));
    const assetsById = gepxImportAssetsById(pkg);
    const syncById = new Map((pkg.sync ?? []).map((record) => [record.assetId, record]));
    const prepared = [];
    const pendingLogical = new Map(local.logical);
    for (const candidate of finalCandidates) {
        if (candidate.action !== 'would_import' && !(opts.force && candidate.action === 'id_collision'))
            continue;
        const entry = assetsById.get(candidate.assetId);
        if (!entry)
            throw new SyncAbortError('integrity_error', '.gepx package asset is missing');
        const preparedAsset = preparePackagedAsset(candidate, entry.asset, local.byAssetId, pendingLogical, opts.force, entry.frozenUnverified);
        if ('blocked' in preparedAsset) {
            updateFinalCandidate(finalCandidates, candidate, preparedAsset.blocked);
            continue;
        }
        const logicalId = rawStringField(preparedAsset.asset, 'id');
        const finalCandidate = preparedAsset.forced
            ? {
                ...candidate,
                ...(logicalId ? { logicalId } : {}),
                action: 'force_import',
                collisionWithAssetId: preparedAsset.collisionWithAssetId,
            }
            : {
                assetId: candidate.assetId,
                type: candidate.type,
                source: 'gepx',
                ...(candidate.status ? { status: candidate.status } : {}),
                ...(logicalId ? { logicalId } : {}),
                action: 'would_import',
            };
        updateFinalCandidate(finalCandidates, candidate, finalCandidate);
        prepared.push({
            candidate: finalCandidate,
            asset: preparedAsset.asset,
            ...(entry.frozenUnverified ? { frozenUnverified: true } : {}),
            ...(preparedAsset.forced ? { forced: true, collisionWithAssetId: preparedAsset.collisionWithAssetId } : {}),
        });
        if (logicalId)
            pendingLogical.set(`${preparedAsset.asset.type}:${logicalId}`, preparedAsset.asset.asset_id);
    }
    const baseDir = storeBaseDir(store, deps);
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(baseDir, deps.now);
    const syncLedger = deps.syncLedger ?? new assetstore.AssetSyncLedger(baseDir, deps.now);
    await verifyAlreadyLocalGepxCandidates(finalCandidates, assetsById, store, provenance.snapshot(), failures);
    const written = [];
    for (const item of prepared) {
        try {
            const stored = item.frozenUnverified
                ? await assetstore.ingestUnverifiedConditional(store, provenance, item.asset, 'unverified_gepx_import', { allowLogicalCollision: opts.force }, 'migrated')
                : await assetstore.ingestUntrustedConditional(store, provenance, item.asset, { allowLogicalCollision: opts.force }, 'migrated');
            const assetId = stored.asset_id;
            if (stored.status === 'logical_collision') {
                updateFinalCandidate(finalCandidates, item.candidate, {
                    ...item.candidate,
                    assetId,
                    action: 'id_collision',
                    collisionWithAssetId: stored.collisionWithAssetId,
                });
                continue;
            }
            await readBackStoredAsset(store, assetId, item.asset, item.frozenUnverified === true);
            if (stored.status === 'already_exists') {
                updateFinalCandidate(finalCandidates, item.candidate, { ...item.candidate, assetId, action: 'already_local' });
                continue;
            }
            const collisionWithAssetId = stored.collisionWithAssetId ?? item.collisionWithAssetId;
            const forced = item.forced === true || collisionWithAssetId !== undefined;
            const writtenCandidate = forced
                ? { ...item.candidate, action: 'force_import', collisionWithAssetId }
                : item.candidate;
            updateFinalCandidate(finalCandidates, item.candidate, writtenCandidate);
            const syncRecord = syncById.get(assetId);
            if (syncRecord)
                syncLedger.append({
                    assetId,
                    type: item.asset.type,
                    source: 'hub',
                    scope: syncRecord.scope,
                    remoteAssetId: syncRecord.remoteAssetId,
                    ...(syncRecord.logicalId ? { logicalId: syncRecord.logicalId } : {}),
                    ...(syncRecord.status ? { status: syncRecord.status } : {}),
                    ...(syncRecord.syncedAt ? { syncedAt: syncRecord.syncedAt } : {}),
                    ...(syncRecord.forced ? { forced: true } : {}),
                    ...(syncRecord.collisionWithAssetId ? { collisionWithAssetId: syncRecord.collisionWithAssetId } : {}),
                });
            written.push({
                assetId,
                type: item.asset.type,
                source: 'gepx',
                stored: stored.stored,
                trusted: false,
                ...(writtenCandidate.logicalId ? { logicalId: writtenCandidate.logicalId } : {}),
                ...(writtenCandidate.status ? { status: writtenCandidate.status } : {}),
                ...(forced ? { forced: true } : {}),
                ...(collisionWithAssetId ? { collisionWithAssetId } : {}),
            });
        }
        catch (error) {
            const mapped = mapSyncError(error);
            failures.push({ stage: 'write', assetId: item.candidate.assetId, reason: mapped.reason });
            updateFinalCandidate(finalCandidates, item.candidate, {
                ...item.candidate,
                action: 'write_failed',
                failureReason: mapped.reason,
            });
        }
    }
    const counts = countsFromCandidates(emptyCounts(finalCandidates.length), finalCandidates);
    return {
        ok: true,
        group: GROUP,
        mode: 'import',
        counts,
        candidates: finalCandidates,
        written,
        blocked: finalCandidates.filter(isBlockedCandidate),
        failures,
    };
}
function emptyPreview(scope) {
    return {
        ok: true,
        group: GROUP,
        mode: 'preview',
        scope,
        counts: {
            remotePurchased: 0,
            remotePublished: 0,
            uniqueRemote: 0,
            alreadyLocal: 0,
            tombstone: 0,
            idCollision: 0,
            unsupported: 0,
            integrityError: 0,
            wouldImport: 0,
            unverifiedWouldImport: 0,
            forcedImport: 0,
            skippedLimit: 0,
            fetchFailed: 0,
            writeFailed: 0,
        },
        candidates: [],
        failures: [],
        nextCursors: { purchased: null, published: null },
        reconciliation: {
            remoteUnique: 0,
            accounted: 0,
            imported: 0,
            alreadyLocal: 0,
            blocked: 0,
            failed: 0,
            pending: 0,
            inventoryComplete: true,
            missingRemote: 0,
            consistent: false,
        },
    };
}
function emptyCounts(uniqueRemote = 0) {
    return {
        remotePurchased: 0,
        remotePublished: 0,
        uniqueRemote,
        alreadyLocal: 0,
        tombstone: 0,
        idCollision: 0,
        unsupported: 0,
        integrityError: 0,
        wouldImport: 0,
        unverifiedWouldImport: 0,
        forcedImport: 0,
        skippedLimit: 0,
        fetchFailed: 0,
        writeFailed: 0,
    };
}
function emptyWrite(scope, mode = 'write') {
    return {
        ...emptyPreview(scope),
        mode,
        written: [],
        blocked: [],
        resumed: 0,
    };
}
async function createDefaultHub(deps, env) {
    if (isPrivateHubMode(env)) {
        try {
            const hubUrl = requirePrivateHubUrl(env);
            if (deps.connectPrivateHub)
                return await deps.connectPrivateHub(env);
            const { connectPrivateProxyHub } = await import('@evomap/evolver-proxy');
            const runtime = await connectPrivateProxyHub({
                hubUrl,
                senderId: () => env['EVOMAP_NODE_ID'] ?? env['A2A_NODE_ID'],
                env,
                ...(deps.now ? { now: deps.now } : {}),
            });
            return await preparePrivateSyncHub(runtime);
        }
        catch {
            // Adapter diagnostics may contain local paths or credentials; never expose them through the CLI.
            throw new SyncAbortError('private_adapter_unavailable', 'private Hub adapter is unavailable');
        }
    }
    const hub = createRecipeHubFromEnv(env, deps.connectHub ?? connectPublicHub);
    if (!isSyncAccountAssetHub(hub))
        throw new Error('Hub adapter does not support account asset sync');
    return hub;
}
export async function preparePrivateSyncHub(runtime) {
    const hello = await runtime.hello({ rotate: false, evolverVersion: getCliVersion() });
    if (!hello.ok)
        throw new Error('private Hub enrollment failed');
    if (!isSyncAccountAssetHub(runtime.hub))
        throw new Error('private Hub adapter does not support account asset sync');
    return runtime.hub;
}
async function listRemoteRows(hub, opts, listing) {
    const failures = [];
    const purchasedBudget = { uniqueAssetIds: new Set(), rawPages: 0, rawRows: 0 };
    const publishedBudget = { uniqueAssetIds: new Set(), rawPages: 0, rawRows: 0 };
    const purchasedResult = (opts.scope === 'all' || opts.scope === 'purchased') && !listing.skipPurchased
        ? await listAll(hub, {
            scope: 'purchased',
            ...(opts.type ? { type: opts.type } : {}),
            limit: opts.limit,
            ...(opts.purchasedCursor ? { cursor: opts.purchasedCursor } : {}),
        }, opts.pageSize, failures, purchasedBudget)
        : { rows: [], complete: true, nextCursor: undefined };
    const shouldListPublished = (opts.scope === 'all' || opts.scope === 'published') && !listing.skipPublished;
    const publishedResult = shouldListPublished
        ? await listAll(hub, {
            scope: 'published',
            ...(opts.type ? { type: opts.type } : {}),
            status: opts.status,
            limit: opts.limit,
            ...(opts.publishedCursor ? { cursor: opts.publishedCursor } : {}),
        }, opts.pageSize, failures, publishedBudget)
        : { rows: [], complete: true, nextCursor: undefined };
    const startsAtInventoryBeginning = !opts.purchasedCursor && !opts.publishedCursor;
    return {
        purchased: purchasedResult.rows,
        published: publishedResult.rows,
        failures,
        inventoryComplete: startsAtInventoryBeginning && purchasedResult.complete && publishedResult.complete && failures.length === 0,
        nextCursors: {
            purchased: purchasedResult.nextCursor ?? null,
            published: publishedResult.nextCursor ?? null,
        },
    };
}
async function listAll(hub, opts, pageSize, failures, budget) {
    const rows = [];
    let cursor = opts.cursor;
    const seenCursors = new Set();
    let consecutiveEmptyPages = 0;
    let consecutivePagesWithoutUniqueProgress = 0;
    while (budget.uniqueAssetIds.size < opts.limit) {
        if (budget.rawPages >= MAX_RAW_PAGES) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'raw_page_limit' });
            break;
        }
        if (budget.rawRows >= MAX_RAW_ROWS) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'raw_row_limit' });
            break;
        }
        const remaining = opts.limit - budget.uniqueAssetIds.size;
        const requestedPageLimit = Math.min(remaining, pageSize);
        let rawResult;
        try {
            rawResult = await hub.listAccountAssets({ ...opts, limit: requestedPageLimit, ...(cursor ? { cursor } : {}) });
            budget.rawPages += 1;
        }
        catch (error) {
            failures.push({ stage: 'list', scope: opts.scope, reason: mapSyncError(error).reason });
            break;
        }
        const result = asRecord(rawResult);
        if (!result || !Array.isArray(result['assets']) || typeof result['hasMore'] !== 'boolean') {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'malformed_page' });
            break;
        }
        const hasMore = result['hasMore'];
        const nextCursor = result['nextCursor'];
        const pageRows = result['assets'];
        if (pageRows.length > requestedPageLimit) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'oversized_page' });
            break;
        }
        const availableRawRows = MAX_RAW_ROWS - budget.rawRows;
        const boundedPageRows = pageRows.slice(0, availableRawRows);
        budget.rawRows += boundedPageRows.length;
        const uniqueBefore = budget.uniqueAssetIds.size;
        let consumedPageRows = 0;
        // The page is bounded by the remaining unique budget, so consuming it fully cannot exceed the limit.
        for (const raw of boundedPageRows) {
            consumedPageRows += 1;
            const row = asRecord(raw);
            if (!row) {
                failures.push({ stage: 'list', scope: opts.scope, reason: 'invalid_remote_asset' });
                continue;
            }
            rows.push(row);
            const assetId = rawStringField(row, 'asset_id');
            if (assetId)
                budget.uniqueAssetIds.add(assetId);
        }
        const uniqueProgress = budget.uniqueAssetIds.size - uniqueBefore;
        if ((!hasMore && nextCursor !== undefined) || (hasMore && (typeof nextCursor !== 'string' || !nextCursor.trim()))) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'invalid_remote_pagination' });
            break;
        }
        if (hasMore && typeof nextCursor === 'string' && !isValidOpaqueCursor(nextCursor)) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'malformed_cursor' });
            break;
        }
        if (!hasMore) {
            return { rows, complete: consumedPageRows === pageRows.length, nextCursor: undefined };
        }
        if (typeof nextCursor !== 'string' || !nextCursor.trim()) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'invalid_remote_pagination' });
            break;
        }
        if (boundedPageRows.length < pageRows.length || budget.rawRows >= MAX_RAW_ROWS) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'raw_row_limit' });
            break;
        }
        consecutiveEmptyPages = pageRows.length === 0 ? consecutiveEmptyPages + 1 : 0;
        if (consecutiveEmptyPages > MAX_CONSECUTIVE_EMPTY_PAGES) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'empty_page_limit' });
            break;
        }
        consecutivePagesWithoutUniqueProgress = uniqueProgress === 0 ? consecutivePagesWithoutUniqueProgress + 1 : 0;
        if (consecutivePagesWithoutUniqueProgress > MAX_CONSECUTIVE_PAGES_WITHOUT_UNIQUE_PROGRESS) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'no_unique_progress_limit' });
            break;
        }
        if (nextCursor === cursor || seenCursors.has(nextCursor)) {
            failures.push({ stage: 'list', scope: opts.scope, reason: 'invalid_remote_pagination' });
            break;
        }
        if (budget.uniqueAssetIds.size >= opts.limit)
            return { rows, complete: false, nextCursor };
        if (cursor)
            seenCursors.add(cursor);
        cursor = nextCursor;
    }
    return { rows, complete: false, nextCursor: cursor };
}
function isValidOpaqueCursor(cursor) {
    if (cursor.length > MAX_CURSOR_LENGTH || !cursor.trim())
        return false;
    for (const character of cursor) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f))
            return false;
    }
    return true;
}
function addUnique(target, missingAssetId, conflictingDuplicateAssetIds, row, source) {
    const assetId = rawStringField(row, 'asset_id');
    if (!assetId) {
        missingAssetId.push({ row, source });
        return;
    }
    const existing = target.get(assetId);
    if (!existing) {
        target.set(assetId, { row, source });
        return;
    }
    const merged = mergeDuplicateRemoteRows(existing.row, row, assetId);
    if (!merged)
        conflictingDuplicateAssetIds.add(assetId);
    else
        target.set(assetId, {
            row: merged,
            source: existing.source === 'purchased' || source === 'purchased' ? 'purchased' : existing.source,
        });
}
function classifyConflictingRemoteDuplicate(row, source) {
    return {
        assetId: rawStringField(row, 'asset_id') ?? MISSING_ASSET_ID,
        type: 'unknown',
        source,
        action: 'integrity_error',
        failureReason: 'conflicting_remote_duplicate',
    };
}
function mergeDuplicateRemoteRows(left, right, assetId) {
    const leftIdentity = remoteDuplicateIdentity(left, assetId);
    const rightIdentity = remoteDuplicateIdentity(right, assetId);
    if (leftIdentity.invalid || rightIdentity.invalid)
        return null;
    if (leftIdentity.declaredType
        && rightIdentity.declaredType
        && leftIdentity.declaredType !== rightIdentity.declaredType)
        return null;
    if (leftIdentity.logicalId && rightIdentity.logicalId && leftIdentity.logicalId !== rightIdentity.logicalId)
        return null;
    if (leftIdentity.tombstone !== rightIdentity.tombstone)
        return null;
    if (leftIdentity.canonicalBody && rightIdentity.canonicalBody && leftIdentity.canonicalBody !== rightIdentity.canonicalBody) {
        return null;
    }
    if (leftIdentity.canonicalBody && !rightIdentity.canonicalBody)
        return left;
    if (rightIdentity.canonicalBody && !leftIdentity.canonicalBody)
        return right;
    if (leftIdentity.synthesized !== rightIdentity.synthesized)
        return leftIdentity.synthesized ? left : right;
    return stableRemoteRowKey(left) <= stableRemoteRowKey(right) ? left : right;
}
function remoteDuplicateIdentity(row, assetId) {
    const type = remoteType(row);
    const declaredType = remoteDeclaredType(row);
    const logicalId = remoteLogicalId(row);
    const delivery = unwrapLiveHubDelivery(row, assetId);
    let canonicalBody;
    let invalid = delivery.invalid;
    if (!invalid && type && declaresFullAssetPayload(delivery.content, type)) {
        const cleaned = stripHubDeliveryMetadataForIntegrity(delivery.content);
        if (!looksLikeFullAsset(cleaned, type) || !wire.validateWireDeep(cleaned).ok) {
            invalid = true;
        }
        else {
            try {
                canonicalBody = wire.canonicalize(cleaned);
            }
            catch {
                invalid = true;
            }
        }
    }
    return {
        ...(declaredType ? { declaredType } : {}),
        ...(logicalId ? { logicalId } : {}),
        tombstone: isRemoteTombstoneDelivery(row),
        ...(canonicalBody ? { canonicalBody } : {}),
        synthesized: Boolean(stringField(delivery.content, 'payload_backfill_reason')
            ?? stringField(row, 'payload_backfill_reason')),
        invalid,
    };
}
function stableRemoteRowKey(row) {
    try {
        return wire.canonicalize(row);
    }
    catch {
        return JSON.stringify(row) ?? '';
    }
}
async function localIndex(store) {
    const byAssetId = new Set();
    const logical = new Map();
    const recordsByAssetId = new Map();
    for (const kind of ['Gene', 'Capsule']) {
        for (const row of await store.list(kind, Number.MAX_SAFE_INTEGER)) {
            byAssetId.add(row.asset_id);
            recordsByAssetId.set(row.asset_id, row);
            const logicalId = rawStringField(row, 'id');
            if (logicalId)
                logical.set(`${kind}:${logicalId}`, row.asset_id);
        }
    }
    return { byAssetId, logical, recordsByAssetId };
}
async function listLocalExportAssets(store, opts) {
    const kinds = opts.type ? [opts.type] : ['Gene', 'Capsule'];
    const assets = [];
    for (const kind of kinds) {
        const remaining = opts.limit - assets.length;
        if (remaining <= 0)
            break;
        assets.push(...await store.list(kind, remaining));
    }
    return assets.slice(0, opts.limit);
}
function classifyRemote(row, source, local, provenanceSnapshot) {
    const assetId = rawStringField(row, 'asset_id') ?? MISSING_ASSET_ID;
    const type = remoteType(row);
    const logicalId = remoteLogicalId(row);
    const status = stringField(row, 'status');
    const base = {
        assetId,
        type: type ?? 'unknown',
        ...(logicalId ? { logicalId } : {}),
        source,
        ...(status ? { status } : {}),
    };
    if (assetId === MISSING_ASSET_ID)
        return { ...base, action: 'integrity_error' };
    if (!isContentAssetId(assetId))
        return { ...base, action: 'integrity_error' };
    if (unwrapLiveHubDelivery(row, assetId).invalid)
        return { ...base, action: 'integrity_error' };
    if (isRemoteTombstoneDelivery(row))
        return { ...base, action: 'tombstone' };
    if (type !== 'Gene' && type !== 'Capsule')
        return { ...base, action: 'unsupported_type' };
    const payloadVerification = inspectRemotePayload(row, type, assetId);
    if (payloadVerification === 'invalid')
        return { ...base, action: 'integrity_error' };
    const isUnverified = payloadVerification === 'unverified_hub_rewrite'
        || payloadVerification === 'unverified_hub_synthesized';
    const verifiedBase = isUnverified
        ? { ...base, verification: 'unverified', verificationReason: payloadVerification }
        : base;
    if (local.byAssetId.has(assetId)) {
        if (payloadVerification === 'unavailable') {
            const stored = local.recordsByAssetId.get(assetId);
            const localComputed = stored ? wire.computeAssetId(stored) : null;
            if (!stored
                || stored.asset_id !== assetId
                || stored.type !== type
                || !localComputed) {
                return {
                    ...base,
                    action: 'integrity_error',
                    failureReason: 'local_content_integrity_mismatch',
                };
            }
            if (localComputed !== assetId) {
                if (!isActiveFrozenWaiver(provenanceSnapshot.get(assetId), assetId, localComputed, true)) {
                    return {
                        ...base,
                        action: 'integrity_error',
                        failureReason: 'local_frozen_waiver_mismatch',
                    };
                }
                return {
                    ...base,
                    action: 'already_local',
                    verification: 'unverified',
                };
            }
        }
        if (payloadVerification !== 'unavailable'
            && !inlineContentMatchesLocal(row, type, assetId, local.recordsByAssetId.get(assetId), provenanceSnapshot.get(assetId))) {
            return {
                ...base,
                action: 'integrity_error',
                failureReason: 'frozen_remote_content_changed',
            };
        }
        return { ...verifiedBase, action: 'already_local' };
    }
    if (logicalId) {
        const localAssetId = local.logical.get(`${type}:${logicalId}`);
        if (localAssetId && localAssetId !== assetId)
            return { ...verifiedBase, action: 'id_collision', collisionWithAssetId: localAssetId };
    }
    return { ...verifiedBase, action: 'would_import' };
}
function classifyGepxAssets(pkg, opts, local) {
    const classified = uniqueGepxAssets(pkg)
        .filter((entry) => !opts.type || entry.type === opts.type)
        .map((entry) => classifyGepxAsset(entry, local));
    let remaining = opts.limit;
    const candidates = classified.map((candidate) => {
        if (candidate.action === 'integrity_error')
            return candidate;
        if (remaining > 0) {
            remaining -= 1;
            return candidate;
        }
        return { ...candidate, action: 'skipped_limit', failureReason: 'limit_reached' };
    });
    const malformed = pkg.malformedAssets.map((entry) => ({
        assetId: entry.assetId ?? `${MISSING_ASSET_ID}-${entry.index}`,
        type: 'unknown',
        source: 'gepx',
        action: 'integrity_error',
        failureReason: 'invalid_package_asset',
    }));
    return [...candidates, ...malformed];
}
function classifyGepxAsset(entry, local) {
    const { assetId, type, logicalId } = entry;
    const base = {
        assetId,
        type: type ?? String(entry.original.type ?? 'unknown'),
        ...(logicalId ? { logicalId } : {}),
        source: 'gepx',
    };
    if (type !== 'Gene' && type !== 'Capsule')
        return { ...base, action: 'unsupported_type' };
    if (entry.integrityError)
        return { ...base, action: 'integrity_error' };
    if (local.byAssetId.has(assetId))
        return { ...base, action: 'already_local' };
    if (logicalId) {
        const localAssetId = local.logical.get(`${type}:${logicalId}`);
        if (localAssetId && localAssetId !== assetId)
            return { ...base, action: 'id_collision', collisionWithAssetId: localAssetId };
    }
    return { ...base, action: 'would_import' };
}
function uniqueGepxAssets(pkg) {
    const unique = new Map();
    const missing = [];
    const provenanceByAssetId = indexUniqueGepxProvenance(pkg);
    for (const asset of pkg.assets) {
        const normalized = normalizeGepxAsset(asset, provenanceByAssetId.get(asset.asset_id) ?? undefined);
        if (normalized.assetId === MISSING_ASSET_ID) {
            missing.push(normalized);
            continue;
        }
        if (!unique.has(normalized.assetId))
            unique.set(normalized.assetId, normalized);
    }
    return [...unique.values(), ...missing];
}
function gepxImportAssetsById(pkg) {
    const assets = new Map();
    for (const entry of uniqueGepxAssets(pkg)) {
        if (entry.type && !entry.integrityError && !assets.has(entry.assetId))
            assets.set(entry.assetId, entry);
    }
    return assets;
}
function indexUniqueGepxProvenance(pkg) {
    const indexed = new Map();
    for (const record of pkg.provenance ?? []) {
        indexed.set(record.assetId, indexed.has(record.assetId) ? null : record);
    }
    return indexed;
}
function normalizeGepxAsset(asset, provenance) {
    const cleaned = { ...asset };
    const assetId = rawStringField(cleaned, 'asset_id') ?? MISSING_ASSET_ID;
    const type = cleaned.type === 'Gene' || cleaned.type === 'Capsule' ? cleaned.type : undefined;
    const logicalId = rawStringField(cleaned, 'id');
    let integrityError = false;
    let frozenUnverified = false;
    if (type) {
        const claimed = rawStringField(cleaned, 'asset_id');
        const fullAsset = looksLikeFullAsset(cleaned, type);
        const computed = fullAsset ? wire.computeAssetId(cleaned) : undefined;
        const supportedFrozenProvenance = provenance
            && ((provenance.source === 'hub'
                && (provenance.reason === 'unverified_hub_rewrite' || provenance.reason === 'unverified_hub_synthesized'))
                || (provenance.source === 'migrated' && provenance.reason === 'unverified_gepx_import'));
        frozenUnverified = Boolean(claimed
            && computed
            && claimed === assetId
            && computed !== claimed
            && provenance?.assetId === assetId
            && supportedFrozenProvenance
            && provenance.trusted === false
            && provenance.decision === undefined
            && provenance.decidedBy === undefined
            && provenance.promotedBy === undefined
            && provenance.frozenContentId === computed);
        integrityError = assetId === MISSING_ASSET_ID
            || !claimed
            || !isContentAssetId(assetId)
            || !fullAsset
            || !computed
            || claimed !== assetId
            || (computed !== claimed && !frozenUnverified);
    }
    return {
        original: asset,
        asset: cleaned,
        assetId,
        ...(type ? { type } : {}),
        ...(logicalId ? { logicalId } : {}),
        integrityError,
        frozenUnverified,
    };
}
function countsFromCandidates(base, candidates) {
    const counts = {
        remotePurchased: base.remotePurchased,
        remotePublished: base.remotePublished,
        uniqueRemote: candidates.length,
        alreadyLocal: 0,
        tombstone: 0,
        idCollision: 0,
        unsupported: 0,
        integrityError: 0,
        wouldImport: 0,
        unverifiedWouldImport: 0,
        forcedImport: 0,
        skippedLimit: 0,
        fetchFailed: 0,
        writeFailed: 0,
    };
    for (const candidate of candidates) {
        if (candidate.action === 'already_local')
            counts.alreadyLocal += 1;
        else if (candidate.action === 'tombstone')
            counts.tombstone += 1;
        else if (candidate.action === 'id_collision')
            counts.idCollision += 1;
        else if (candidate.action === 'would_import')
            counts.wouldImport += 1;
        else if (candidate.action === 'force_import')
            counts.forcedImport += 1;
        else if (candidate.action === 'skipped_limit')
            counts.skippedLimit += 1;
        else if (candidate.action === 'fetch_failed')
            counts.fetchFailed += 1;
        else if (candidate.action === 'write_failed')
            counts.writeFailed += 1;
        else if (candidate.action === 'unsupported_type')
            counts.unsupported += 1;
        else if (candidate.action === 'integrity_error')
            counts.integrityError += 1;
        if (candidate.action === 'would_import' && candidate.verification === 'unverified') {
            counts.unverifiedWouldImport += 1;
        }
    }
    return counts;
}
function updateFinalCandidate(candidates, original, replacement) {
    const index = candidates.findIndex((candidate) => candidate.assetId === original.assetId && candidate.source === original.source);
    if (index >= 0)
        candidates[index] = replacement;
}
function isBlockedCandidate(candidate) {
    return candidate.action !== 'would_import'
        && candidate.action !== 'force_import'
        && candidate.action !== 'already_local'
        && candidate.action !== 'skipped_limit';
}
function inspectRemotePayload(row, type, assetId) {
    const delivery = unwrapLiveHubDelivery(row, assetId);
    if (delivery.invalid)
        return 'invalid';
    const source = delivery.content;
    if (!looksLikeFullAsset(source, type)) {
        return declaresFullAssetPayload(source, type) ? 'invalid' : 'unavailable';
    }
    const candidate = stripHubDeliveryMetadataForIntegrity(source);
    if (!wire.validateWireDeep(candidate).ok)
        return 'invalid';
    const claimed = rawStringField(candidate, 'asset_id');
    if (!claimed || !isContentAssetId(claimed) || claimed !== assetId)
        return 'invalid';
    const computed = wire.computeAssetId(candidate);
    if (!computed)
        return 'invalid';
    if (computed === claimed)
        return 'verified';
    return stringField(source, 'payload_backfill_reason') ?? stringField(row, 'payload_backfill_reason')
        ? 'unverified_hub_synthesized'
        : 'unverified_hub_rewrite';
}
function inlineContentMatchesLocal(row, type, assetId, local, provenance) {
    const delivery = unwrapLiveHubDelivery(row, assetId);
    if (delivery.invalid || !local)
        return false;
    const remote = stripHubDeliveryMetadataForIntegrity(delivery.content);
    const remoteComputed = wire.computeAssetId(remote);
    const localComputed = wire.computeAssetId(local);
    if (!remoteComputed
        || !localComputed
        || local.asset_id !== assetId
        || local.type !== type
        || remoteComputed !== localComputed
        || !assetstore.frozenAssetRecordsEqual(local, remote))
        return false;
    if (remoteComputed === assetId)
        return true;
    return isActiveFrozenWaiver(provenance, assetId, remoteComputed, true);
}
function isActiveFrozenWaiver(provenance, assetId, frozenContentId, allowPending = false) {
    return Boolean(provenance?.assetId === assetId
        && provenance.trusted === false
        && provenance.frozenContentId === frozenContentId
        && provenance.decision === undefined
        && provenance.decidedBy === undefined
        && provenance.promotedBy === undefined
        && ((provenance.source === 'hub'
            && (provenance.reason === 'unverified_hub_rewrite' || provenance.reason === 'unverified_hub_synthesized'))
            || (provenance.source === 'migrated' && provenance.reason === 'unverified_gepx_import')
            || (allowPending && provenance.source === 'hub' && provenance.reason === UNVERIFIED_HUB_WRITE_PENDING_REASON)));
}
function unwrapLiveHubDelivery(row, expectedAssetId) {
    const nested = asRecord(row.payload);
    if (Object.prototype.hasOwnProperty.call(row, 'type') || !nested) {
        const directType = rawStringField(row, 'type');
        const directLogicalId = rawStringField(row, 'id');
        const aliasType = rawStringField(row, 'asset_type');
        const aliasLogicalId = rawStringField(row, 'local_id');
        return {
            content: row,
            invalid: Boolean(hasInvalidLiveIdentityField(row, ['asset_id', 'type', 'asset_type', 'id', 'local_id'])
                || (aliasType !== undefined && directType !== undefined && aliasType !== directType)
                || (aliasLogicalId !== undefined && directLogicalId !== undefined && aliasLogicalId !== directLogicalId)),
        };
    }
    const outerAssetId = rawStringField(row, 'asset_id');
    const outerType = rawStringField(row, 'asset_type');
    const outerLogicalIds = [rawStringField(row, 'id'), rawStringField(row, 'local_id')]
        .filter((value) => value !== undefined);
    const innerAssetId = rawStringField(nested, 'asset_id');
    const innerType = rawStringField(nested, 'type');
    const innerAliasType = rawStringField(nested, 'asset_type');
    const innerLogicalId = rawStringField(nested, 'id');
    const innerAliasLogicalId = rawStringField(nested, 'local_id');
    const invalid = Boolean(hasInvalidLiveIdentityField(row, ['asset_id', 'asset_type', 'id', 'local_id'])
        || hasInvalidLiveIdentityField(nested, ['asset_id', 'type', 'asset_type', 'id', 'local_id'])
        || outerAssetId === undefined
        || outerAssetId !== expectedAssetId
        || innerAssetId === undefined
        || innerAssetId !== expectedAssetId
        || innerType === undefined
        || (outerType !== undefined && innerType !== undefined && outerType !== innerType)
        || (innerAliasType !== undefined && innerAliasType !== innerType)
        || (outerLogicalIds.length > 0 && innerLogicalId === undefined)
        || (innerLogicalId !== undefined && outerLogicalIds.some((outerLogicalId) => outerLogicalId !== innerLogicalId))
        || (innerAliasLogicalId !== undefined && innerAliasLogicalId !== innerLogicalId));
    const backfillReason = stringField(row, 'payload_backfill_reason');
    return {
        content: backfillReason && stringField(nested, 'payload_backfill_reason') === undefined
            ? { ...nested, payload_backfill_reason: backfillReason }
            : nested,
        invalid,
    };
}
function prepareFetchedAsset(candidate, fetched, localAssetIds, logical, force, allowExistingFrozenFinalize = false) {
    if (isRemoteTombstoneDelivery(fetched)) {
        throw new SyncAbortError('remote_revoked', 'Hub asset was revoked before import');
    }
    const delivery = unwrapLiveHubDelivery(fetched, candidate.assetId);
    if (delivery.invalid)
        throw new SyncAbortError('integrity_error', 'Hub delivery identity changed before import');
    const delivered = delivery.content;
    const type = delivered.type === 'Gene' || delivered.type === 'Capsule' ? delivered.type : undefined;
    if (!type)
        return { blocked: { ...candidate, type: delivered.type ?? candidate.type, action: 'unsupported_type' } };
    if (type !== candidate.type)
        throw new SyncAbortError('integrity_error', 'Hub asset type changed before import');
    const cleaned = stripHubDeliveryMetadataForIntegrity(delivered);
    const claimed = rawStringField(cleaned, 'asset_id');
    if (!looksLikeFullAsset(cleaned, type)) {
        throw new SyncAbortError('integrity_error', 'Hub asset payload is incomplete');
    }
    if (!wire.validateWireDeep(cleaned).ok) {
        throw new SyncAbortError('integrity_error', 'Hub asset failed wire schema validation before import');
    }
    const computed = wire.computeAssetId(cleaned);
    if (!claimed || !computed || !isContentAssetId(claimed) || claimed !== candidate.assetId) {
        throw new SyncAbortError('integrity_error', 'Hub asset identity verification failed before import');
    }
    const logicalId = rawStringField(cleaned, 'id');
    if (candidate.logicalId && logicalId !== candidate.logicalId) {
        throw new SyncAbortError('integrity_error', 'Hub asset logical id changed before import');
    }
    const frozenUnverified = computed !== claimed;
    const verificationReason = frozenUnverified
        ? stringField(delivered, 'payload_backfill_reason')
            ? 'unverified_hub_synthesized'
            : 'unverified_hub_rewrite'
        : undefined;
    const verification = frozenUnverified
        ? { frozenUnverified: true, verificationReason, frozenContentId: computed }
        : {};
    if (localAssetIds.has(cleaned.asset_id) && !allowExistingFrozenFinalize) {
        return { blocked: { ...candidate, action: 'already_local' } };
    }
    if (logicalId) {
        const localAssetId = logical.get(`${type}:${logicalId}`);
        if (localAssetId && localAssetId !== cleaned.asset_id) {
            if (force)
                return { asset: cleaned, ...verification, forced: true, collisionWithAssetId: localAssetId };
            return { blocked: { ...candidate, logicalId, action: 'id_collision', collisionWithAssetId: localAssetId } };
        }
    }
    return { asset: cleaned, ...verification };
}
async function reactivatePendingUnverifiedCandidates(candidates, store, provenanceSnapshot) {
    const recoveryIds = new Set();
    for (const candidate of [...candidates]) {
        if (candidate.action !== 'already_local' || (candidate.type !== 'Gene' && candidate.type !== 'Capsule'))
            continue;
        const record = provenanceSnapshot.get(candidate.assetId);
        if (record?.assetId !== candidate.assetId
            || record.source !== 'hub'
            || record.trusted !== false
            || record.reason !== UNVERIFIED_HUB_WRITE_PENDING_REASON
            || !record.frozenContentId
            || record.decision !== undefined
            || record.decidedBy !== undefined
            || record.promotedBy !== undefined)
            continue;
        let stored;
        try {
            stored = await store.get(candidate.assetId);
        }
        catch {
            continue;
        }
        const computed = stored ? wire.computeAssetId(stored) : null;
        const storedLogicalId = stored ? rawStringField(stored, 'id') : undefined;
        if (!stored
            || stored.asset_id !== candidate.assetId
            || stored.type !== candidate.type
            || !looksLikeFullAsset(stored, candidate.type)
            || !wire.validateWireDeep(stored).ok
            || !computed
            || computed === candidate.assetId
            || computed !== record.frozenContentId
            || (candidate.logicalId !== undefined && storedLogicalId !== candidate.logicalId))
            continue;
        recoveryIds.add(candidate.assetId);
        updateFinalCandidate(candidates, candidate, {
            ...candidate,
            action: 'would_import',
            verification: 'unverified',
        });
    }
    return recoveryIds;
}
function reactivateThinFrozenCandidates(candidates, local, provenanceSnapshot) {
    const revalidationIds = new Set();
    for (const candidate of [...candidates]) {
        if (candidate.action !== 'already_local'
            || candidate.verification !== 'unverified'
            || candidate.verificationReason !== undefined
            || (candidate.type !== 'Gene' && candidate.type !== 'Capsule'))
            continue;
        const stored = local.recordsByAssetId.get(candidate.assetId);
        const frozenContentId = stored ? wire.computeAssetId(stored) : null;
        if (!stored
            || stored.asset_id !== candidate.assetId
            || stored.type !== candidate.type
            || !frozenContentId
            || frozenContentId === candidate.assetId
            || !isActiveFrozenWaiver(provenanceSnapshot.get(candidate.assetId), candidate.assetId, frozenContentId))
            continue;
        revalidationIds.add(candidate.assetId);
        updateFinalCandidate(candidates, candidate, {
            ...candidate,
            action: 'would_import',
            verification: 'unverified',
        });
    }
    return revalidationIds;
}
function resumePlannedCandidates(candidates, previousRun, inventoryComplete) {
    const plan = previousRun.plan;
    if (!plan) {
        throw new SyncAbortError('resume_plan_drift', 'cannot resume a run without its original candidate plan');
    }
    const byPlanId = new Map(candidates.flatMap((candidate) => candidate.assetId === MISSING_ASSET_ID
        ? []
        : [[candidate.assetId, candidate]]));
    const knownRemoteMissing = plan.filter((assetId) => (previousRun.processed.get(assetId)?.outcome === 'remote_missing'
        && !byPlanId.has(assetId)));
    const unresolvedMissing = plan.filter((assetId) => {
        const processed = previousRun.processed.get(assetId);
        return (!processed || processed.outcome === 'failed') && !byPlanId.has(assetId);
    });
    const newRemoteMissingAssetIds = inventoryComplete ? unresolvedMissing : [];
    const remoteMissingAssetIds = [...knownRemoteMissing, ...newRemoteMissingAssetIds];
    const remoteMissing = new Set(remoteMissingAssetIds);
    const plannedCandidates = plan.flatMap((assetId) => {
        const candidate = byPlanId.get(assetId);
        if (candidate)
            return [{ ...candidate }];
        return remoteMissing.has(assetId) ? [{
                assetId,
                type: 'unknown',
                source: 'reconciliation',
                action: 'tombstone',
                failureReason: 'remote_missing',
            }] : [];
    });
    const plannedIds = new Set(plan);
    const newCandidates = candidates
        .filter((candidate) => candidate.assetId === MISSING_ASSET_ID || !plannedIds.has(candidate.assetId))
        .map((candidate) => ({ ...candidate }));
    return {
        candidates: [...plannedCandidates, ...newCandidates],
        remoteMissingAssetIds,
        newRemoteMissingAssetIds,
    };
}
function actionableCandidatePlanIds(candidates, force) {
    return candidates.flatMap((candidate) => (candidate.assetId !== MISSING_ASSET_ID
        && (candidate.action === 'would_import' || (force && candidate.action === 'id_collision'))
        ? [candidate.assetId]
        : []));
}
function mergeCandidatePlan(previous, current) {
    const merged = [...previous];
    const seen = new Set(previous);
    for (const assetId of current) {
        if (seen.has(assetId))
            continue;
        seen.add(assetId);
        merged.push(assetId);
    }
    return merged;
}
function assertNoConflictingGepxDuplicates(pkg) {
    const seen = new Map();
    for (const asset of pkg.assets) {
        const assetId = rawStringField(asset, 'asset_id');
        if (!assetId)
            continue;
        const serialized = JSON.stringify(asset);
        const previous = seen.get(assetId);
        if (previous !== undefined && previous !== serialized) {
            throw new SyncAbortError('integrity_error', '.gepx package contains conflicting duplicate asset IDs');
        }
        seen.set(assetId, serialized);
    }
}
async function reconcileResumeCandidates(input) {
    let resumed = 0;
    for (const candidate of input.candidates) {
        if (candidate.action !== 'already_local')
            continue;
        const checkpoint = input.previousRun.processed.get(candidate.assetId);
        const provenanceRecord = input.provenanceSnapshot.get(candidate.assetId);
        const syncRecord = input.syncLedger.getForRunKey(input.runKey, candidate.assetId);
        const checkpointedAlreadyLocal = checkpoint?.outcome === 'already_local';
        const hubImportProvenance = provenanceRecord?.assetId === candidate.assetId
            && provenanceRecord.source === 'hub'
            && !provenanceRecord.trusted;
        const importedEvidence = Boolean(hubImportProvenance || syncRecord || (checkpoint && checkpoint.outcome !== 'already_local'));
        if (!checkpointedAlreadyLocal && !importedEvidence)
            continue;
        try {
            const storedAsset = await readBackStoredAsset(input.store, candidate.assetId, undefined, false, provenanceRecord, candidate.type);
            if (checkpointedAlreadyLocal) {
                resumed += 1;
                continue;
            }
            if (!provenanceRecord || provenanceRecord.assetId !== candidate.assetId || provenanceRecord.source !== 'hub' || provenanceRecord.trusted) {
                throw new SyncAbortError('resume_verification_failed', 'Resume provenance verification failed');
            }
            if (syncRecord && !syncRecordMatches(syncRecord, candidate, storedAsset)) {
                throw new SyncAbortError('resume_verification_failed', 'Resume sync ledger verification failed');
            }
            if (!syncRecord)
                appendSyncRecord(input.syncLedger, candidate, storedAsset, input.runKey, input.inventoryKey);
            if (checkpoint?.outcome !== 'imported') {
                input.appendRunCheckpoint({
                    runId: input.runId,
                    runKey: input.runKey,
                    state: 'progress',
                    remoteAssetId: candidate.assetId,
                    outcome: 'imported',
                });
            }
            resumed += 1;
        }
        catch (error) {
            const mapped = mapSyncError(error);
            input.failures.push({ stage: 'write', assetId: candidate.assetId, reason: mapped.reason });
            input.appendRunCheckpoint({
                runId: input.runId,
                runKey: input.runKey,
                state: 'progress',
                remoteAssetId: candidate.assetId,
                outcome: 'failed',
                reason: mapped.reason,
            });
        }
    }
    return resumed;
}
async function verifyAlreadyLocalCandidates(candidates, store, provenanceSnapshot, failures) {
    const failedAssetIds = new Set(failures.flatMap((failure) => failure.assetId ? [failure.assetId] : []));
    for (const candidate of candidates) {
        if (candidate.action !== 'already_local' || failedAssetIds.has(candidate.assetId))
            continue;
        try {
            await readBackStoredAsset(store, candidate.assetId, undefined, false, provenanceSnapshot.get(candidate.assetId), candidate.type);
        }
        catch (error) {
            const mapped = mapSyncError(error);
            failures.push({ stage: 'write', assetId: candidate.assetId, reason: mapped.reason });
            failedAssetIds.add(candidate.assetId);
        }
    }
}
async function verifyAlreadyLocalGepxCandidates(candidates, assetsById, store, provenanceSnapshot, failures) {
    for (const candidate of [...candidates]) {
        if (candidate.action !== 'already_local')
            continue;
        const entry = assetsById.get(candidate.assetId);
        if (!entry)
            throw new SyncAbortError('integrity_error', '.gepx package asset is missing');
        try {
            const stored = await readBackStoredAsset(store, candidate.assetId, entry.asset, false, provenanceSnapshot.get(candidate.assetId), candidate.type);
            if (!assetstore.frozenAssetRecordsEqual(stored, entry.asset)) {
                throw new SyncAbortError('store_read_back_failed', 'Stored asset differs from packaged asset');
            }
        }
        catch (error) {
            const mapped = mapSyncError(error);
            failures.push({ stage: 'write', assetId: candidate.assetId, reason: mapped.reason });
            updateFinalCandidate(candidates, candidate, {
                ...candidate,
                action: 'write_failed',
                failureReason: mapped.reason,
            });
        }
    }
}
async function readBackStoredAsset(store, assetId, expected, allowFrozenUnverified = false, provenance, expectedType = expected?.type) {
    let stored;
    try {
        stored = await store.get(assetId);
    }
    catch {
        throw new SyncAbortError('store_read_back_failed', 'Stored asset could not be read back');
    }
    const computed = stored ? wire.computeAssetId(stored) : null;
    const expectedComputed = expected ? wire.computeAssetId(expected) : assetId;
    const exactFrozenBody = Boolean(allowFrozenUnverified
        && stored
        && expected
        && assetstore.frozenAssetRecordsEqual(stored, expected)
        && computed === expectedComputed);
    const provenanceBoundFrozenBody = Boolean(stored
        && computed
        && isActiveFrozenWaiver(provenance, assetId, computed));
    if (!stored ||
        stored.asset_id !== assetId ||
        (!exactFrozenBody && !provenanceBoundFrozenBody && computed !== assetId) ||
        (!exactFrozenBody && !provenanceBoundFrozenBody && expectedComputed !== assetId) ||
        (expectedType !== undefined && stored.type !== expectedType)) {
        throw new SyncAbortError('store_read_back_failed', 'Stored asset failed read-back verification');
    }
    return stored;
}
function appendSyncRecord(syncLedger, candidate, asset, runKey, inventoryKey, extra = {}) {
    return syncLedger.append({
        assetId: asset.asset_id,
        type: asset.type,
        source: 'hub',
        scope: candidate.source === 'published' ? 'published' : 'purchased',
        remoteAssetId: candidate.assetId,
        runKey,
        inventoryKey,
        ...(rawStringField(asset, 'id') ? { logicalId: rawStringField(asset, 'id') } : {}),
        ...(candidate.status ? { status: candidate.status } : {}),
        ...extra,
    });
}
function syncRecordMatches(record, candidate, asset) {
    const scope = candidate.source === 'published' ? 'published' : 'purchased';
    const logicalId = rawStringField(asset, 'id');
    return record.assetId === candidate.assetId &&
        record.remoteAssetId === candidate.assetId &&
        record.type === asset.type &&
        record.source === 'hub' &&
        record.scope === scope &&
        (!logicalId || record.logicalId === logicalId);
}
function preparePackagedAsset(candidate, asset, localAssetIds, logical, force, frozenUnverified = false) {
    const cleaned = { ...asset };
    const type = cleaned.type === 'Gene' || cleaned.type === 'Capsule' ? cleaned.type : undefined;
    if (!type)
        return { blocked: { ...candidate, type: cleaned.type ?? candidate.type, action: 'unsupported_type' } };
    if (type !== candidate.type)
        return { blocked: { ...candidate, type, action: 'unsupported_type' } };
    const claimed = rawStringField(cleaned, 'asset_id');
    const computed = wire.computeAssetId(cleaned);
    if (!claimed
        || !computed
        || (claimed !== computed && !frozenUnverified)
        || claimed !== candidate.assetId
        || !isContentAssetId(claimed)
        || !looksLikeFullAsset(cleaned, type)) {
        throw new SyncAbortError('integrity_error', '.gepx package integrity verification failed before import');
    }
    if (localAssetIds.has(cleaned.asset_id))
        return { blocked: { ...candidate, action: 'already_local' } };
    const logicalId = rawStringField(cleaned, 'id');
    if (logicalId) {
        const localAssetId = logical.get(`${type}:${logicalId}`);
        if (localAssetId && localAssetId !== cleaned.asset_id) {
            if (force)
                return { asset: cleaned, forced: true, collisionWithAssetId: localAssetId };
            return { blocked: { ...candidate, logicalId, action: 'id_collision', collisionWithAssetId: localAssetId } };
        }
    }
    return { asset: cleaned };
}
function looksLikeFullAsset(value, type) {
    if (!stringField(value, 'schema_version'))
        return false;
    if (type === 'Gene') {
        return Boolean(stringField(value, 'id') &&
            stringField(value, 'category') &&
            Array.isArray(value['signals_match']) &&
            Array.isArray(value['strategy']) &&
            asRecord(value['constraints']) &&
            Array.isArray(value['validation']));
    }
    return Boolean(stringField(value, 'id') &&
        stringField(value, 'gene') &&
        stringField(value, 'summary') &&
        asRecord(value['outcome']));
}
function declaresFullAssetPayload(value, type) {
    if (Object.prototype.hasOwnProperty.call(value, 'schema_version'))
        return true;
    if (type === 'Gene') {
        return Boolean(stringField(value, 'id')
            && stringField(value, 'category')
            && Array.isArray(value['signals_match'])
            && Array.isArray(value['strategy'])
            && asRecord(value['constraints'])
            && Array.isArray(value['validation']));
    }
    return Boolean(stringField(value, 'id')
        && stringField(value, 'gene')
        && stringField(value, 'summary')
        && asRecord(value['outcome']));
}
function readGepxPackage(path) {
    if (!path)
        throw new SyncAbortError('invalid_arg', '--import requires a file');
    let parsed;
    try {
        parsed = JSON.parse(readBoundedGepxText(path));
    }
    catch (error) {
        if (error instanceof SyncAbortError)
            throw error;
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    const obj = asRecord(parsed);
    if (!obj || obj['type'] !== GEPX_TYPE || obj['version'] !== GEPX_VERSION || !Array.isArray(obj['assets'])) {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    if (obj['assets'].length > MAX_GEPX_ASSETS)
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    if ((Array.isArray(obj['provenance']) && obj['provenance'].length > MAX_GEPX_SIDECAR_RECORDS)
        || (Array.isArray(obj['sync']) && obj['sync'].length > MAX_GEPX_SIDECAR_RECORDS)) {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    const assets = [];
    const malformedAssets = [];
    obj['assets'].forEach((rawAsset, index) => {
        const asset = asRecord(rawAsset);
        const assetId = asset ? rawStringField(asset, 'asset_id') : undefined;
        if (!asset || !assetId) {
            malformedAssets.push({ index, ...(assetId ? { assetId } : {}) });
            return;
        }
        assets.push(asset);
    });
    const provenance = Array.isArray(obj['provenance'])
        ? obj['provenance'].map((record) => parseGepxProvenanceRecord(asRecord(record))).filter((record) => Boolean(record))
        : [];
    const sync = Array.isArray(obj['sync'])
        ? obj['sync'].map((record) => parseGepxSyncRecord(asRecord(record))).filter((record) => Boolean(record))
        : [];
    return {
        type: GEPX_TYPE,
        version: GEPX_VERSION,
        ...(stringField(obj, 'exportedAt') ? { exportedAt: stringField(obj, 'exportedAt') } : {}),
        assets,
        malformedAssets,
        provenance,
        sync,
    };
}
function readBoundedGepxText(path) {
    let before;
    try {
        before = lstatSync(path, { bigint: true });
    }
    catch {
        throw new SyncAbortError('gepx_read_failed', 'could not read .gepx file');
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_GEPX_BYTES)) {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch {
        throw new SyncAbortError('gepx_read_failed', 'could not read .gepx file');
    }
    let opened;
    let text;
    try {
        opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile()
            || opened.size > BigInt(MAX_GEPX_BYTES)
            || opened.dev !== before.dev
            || opened.ino !== before.ino
            || opened.size !== before.size) {
            throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
        }
        const chunks = [];
        let total = 0;
        while (total <= MAX_GEPX_BYTES) {
            const remaining = MAX_GEPX_BYTES + 1 - total;
            if (remaining <= 0)
                break;
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
            const count = readSync(descriptor, chunk, 0, chunk.length, null);
            if (count === 0)
                break;
            chunks.push(chunk.subarray(0, count));
            total += count;
        }
        if (total > MAX_GEPX_BYTES)
            throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
        const settled = fstatSync(descriptor, { bigint: true });
        if (settled.dev !== opened.dev
            || settled.ino !== opened.ino
            || settled.size !== opened.size
            || settled.mtimeNs !== opened.mtimeNs
            || settled.ctimeNs !== opened.ctimeNs) {
            throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
        }
        text = Buffer.concat(chunks, total).toString('utf8');
    }
    catch (error) {
        if (error instanceof SyncAbortError)
            throw error;
        throw new SyncAbortError('gepx_read_failed', 'could not read .gepx file');
    }
    finally {
        closeSync(descriptor);
    }
    let after;
    try {
        after = lstatSync(path, { bigint: true });
    }
    catch {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    if (!after.isFile()
        || after.isSymbolicLink()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs) {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    return text;
}
function parseGepxProvenanceRecord(value) {
    if (!value)
        return null;
    const assetId = rawStringField(value, 'assetId');
    const source = stringField(value, 'source');
    const at = stringField(value, 'at');
    const frozenContentId = rawStringField(value, 'frozenContentId');
    if (!assetId
        || !at
        || Number.isNaN(Date.parse(at))
        || typeof value['trusted'] !== 'boolean'
        || (source !== 'local' && source !== 'migrated' && source !== 'hub')
        || (frozenContentId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(frozenContentId)))
        return null;
    const rawDecision = value['decision'];
    if (rawDecision !== undefined && rawDecision !== 'promoted' && rawDecision !== 'revoked')
        return null;
    const decision = rawDecision === 'promoted' || rawDecision === 'revoked'
        ? rawDecision
        : undefined;
    return {
        assetId,
        source,
        trusted: value['trusted'],
        at,
        ...(decision ? { decision } : {}),
        ...(stringField(value, 'decidedBy') ? { decidedBy: stringField(value, 'decidedBy') } : {}),
        ...(stringField(value, 'promotedBy') ? { promotedBy: stringField(value, 'promotedBy') } : {}),
        ...(stringField(value, 'reason') ? { reason: stringField(value, 'reason') } : {}),
        ...(frozenContentId ? { frozenContentId } : {}),
    };
}
function parseGepxSyncRecord(value) {
    if (!value)
        return null;
    const assetId = rawStringField(value, 'assetId');
    const type = rawStringField(value, 'type');
    const source = rawStringField(value, 'source');
    const scope = rawStringField(value, 'scope');
    const syncedAt = stringField(value, 'syncedAt');
    const remoteAssetId = rawStringField(value, 'remoteAssetId');
    if (!assetId || (type !== 'Gene' && type !== 'Capsule') || source !== 'hub' || (scope !== 'purchased' && scope !== 'published') || !syncedAt || !remoteAssetId) {
        return null;
    }
    return {
        assetId,
        type,
        source: 'hub',
        scope,
        syncedAt,
        remoteAssetId,
        ...(rawStringField(value, 'logicalId') ? { logicalId: rawStringField(value, 'logicalId') } : {}),
        ...(stringField(value, 'status') ? { status: stringField(value, 'status') } : {}),
        ...(value['forced'] === true ? { forced: true } : {}),
        ...(rawStringField(value, 'collisionWithAssetId') ? { collisionWithAssetId: rawStringField(value, 'collisionWithAssetId') } : {}),
    };
}
function remoteType(row) {
    const raw = remoteDeclaredType(row);
    return raw === 'Gene' || raw === 'Capsule' ? raw : undefined;
}
function remoteDeclaredType(row) {
    const payload = asRecord(row.payload);
    return rawStringField(row, 'type')
        ?? rawStringField(row, 'asset_type')
        ?? (payload ? rawStringField(payload, 'type') : undefined);
}
function remoteLogicalId(row) {
    const payload = asRecord(row.payload);
    if (!Object.prototype.hasOwnProperty.call(row, 'type') && payload && rawStringField(payload, 'type') !== undefined) {
        return rawStringField(row, 'local_id') ?? rawStringField(payload, 'id');
    }
    return rawStringField(row, 'id')
        ?? rawStringField(row, 'local_id')
        ?? (payload ? rawStringField(payload, 'id') : undefined);
}
function isContentAssetId(value) {
    return /^sha256:[0-9a-f]{64}$/.test(value);
}
function isRemoteTombstone(row) {
    return stringField(row, 'status')?.toLowerCase() === 'revoked'
        || stringField(row, 'trust_state')?.toLowerCase() === 'revoked';
}
function isRemoteTombstoneDelivery(row) {
    if (isRemoteTombstone(row))
        return true;
    const nested = asRecord(row.payload);
    return nested ? isRemoteTombstone(nested) : false;
}
function emitTextPreview(preview, out) {
    const c = preview.counts;
    out(`sync preview: scope=${preview.scope} purchased=${c.remotePurchased} published=${c.remotePublished} unique=${c.uniqueRemote}`);
    out(`  would_import=${c.wouldImport} unverified_would_import=${c.unverifiedWouldImport} forced_import=${c.forcedImport} skipped_limit=${c.skippedLimit} fetch_failed=${c.fetchFailed} write_failed=${c.writeFailed} already_local=${c.alreadyLocal} tombstone=${c.tombstone} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    out(`  reconciliation: accounted=${preview.reconciliation.accounted}/${preview.reconciliation.remoteUnique} failed=${preview.reconciliation.failed} inventory_complete=${preview.reconciliation.inventoryComplete} missing_remote=${preview.reconciliation.missingRemote} consistent=${preview.reconciliation.consistent}`);
    emitTextNextCursors(preview.nextCursors, out);
    for (const candidate of preview.candidates.slice(0, 10)) {
        out(`  ${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}${formatHubVerification(candidate)}`);
    }
}
function emitTextWrite(result, out) {
    const c = result.counts;
    out(`sync ${result.mode}: scope=${result.scope} purchased=${c.remotePurchased} published=${c.remotePublished} unique=${c.uniqueRemote}`);
    out(`  written=${result.written.length} blocked=${result.blocked.length} would_import=${c.wouldImport} unverified_would_import=${c.unverifiedWouldImport} forced_import=${c.forcedImport} skipped_limit=${c.skippedLimit} fetch_failed=${c.fetchFailed} write_failed=${c.writeFailed} already_local=${c.alreadyLocal} tombstone=${c.tombstone} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    out(`  reconciliation: accounted=${result.reconciliation.accounted}/${result.reconciliation.remoteUnique} imported=${result.reconciliation.imported} resumed=${result.resumed} failed=${result.reconciliation.failed} inventory_complete=${result.reconciliation.inventoryComplete} missing_remote=${result.reconciliation.missingRemote} consistent=${result.reconciliation.consistent}`);
    emitTextNextCursors(result.nextCursors, out);
    for (const asset of result.written.slice(0, 10)) {
        out(`  imported: ${asset.type} ${asset.assetId}${asset.logicalId ? ` (${asset.logicalId})` : ''}${formatHubVerification(asset)}`);
    }
    for (const candidate of result.blocked.slice(0, 10)) {
        out(`  blocked/${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
    }
}
function formatHubVerification(value) {
    if (value.verification !== 'unverified')
        return '';
    return ` [verification=unverified${value.verificationReason ? ` reason=${value.verificationReason}` : ''}]`;
}
function emitTextNextCursors(nextCursors, out) {
    if (nextCursors.purchased)
        out(`  next_purchased_cursor=${nextCursors.purchased}`);
    if (nextCursors.published)
        out(`  next_published_cursor=${nextCursors.published}`);
}
function emitTextExport(result, out) {
    out(`sync export: exported=${result.counts.exported} provenance=${result.counts.provenance} sync=${result.counts.sync}`);
    for (const asset of result.assets.slice(0, 10)) {
        out(`  exported: ${asset.type} ${asset.assetId}${asset.logicalId ? ` (${asset.logicalId})` : ''}`);
    }
}
function emitTextImportPreview(result, out) {
    const c = result.counts;
    out(`sync import preview: unique=${c.uniqueRemote}`);
    out(`  would_import=${c.wouldImport} forced_import=${c.forcedImport} skipped_limit=${c.skippedLimit} fetch_failed=${c.fetchFailed} write_failed=${c.writeFailed} already_local=${c.alreadyLocal} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    for (const candidate of result.candidates.slice(0, 10)) {
        out(`  ${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
    }
}
function emitTextImport(result, out) {
    const c = result.counts;
    out(`sync import: written=${result.written.length} blocked=${result.blocked.length} failed=${result.failures.length} unique=${c.uniqueRemote}`);
    out(`  would_import=${c.wouldImport} forced_import=${c.forcedImport} skipped_limit=${c.skippedLimit} fetch_failed=${c.fetchFailed} write_failed=${c.writeFailed} already_local=${c.alreadyLocal} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    for (const asset of result.written.slice(0, 10)) {
        out(`  imported: ${asset.type} ${asset.assetId}${asset.logicalId ? ` (${asset.logicalId})` : ''}`);
    }
    for (const candidate of result.blocked.slice(0, 10)) {
        out(`  blocked/${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
    }
    for (const failure of result.failures.slice(0, 10)) {
        out(`  failed/${failure.reason}: ${failure.assetId ?? 'unknown'}`);
    }
}
class SyncAbortError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'SyncAbortError';
    }
}
function loadSyncEnv(env) {
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error)
        throw new SyncAbortError('env_file_unavailable', 'Configured environment file is unavailable');
}
function emitFailure(reason, message, jsonOut, out, err) {
    const payload = { ok: false, group: GROUP, reason, message: formatTerminalText(message) };
    if (jsonOut)
        out(stringifyJsonOutput(payload));
    else
        err(formatTerminalText(`sync failed (${reason}): ${message}`));
    return 1;
}
function mapSyncError(error) {
    if (error instanceof SyncAbortError)
        return { reason: error.reason, message: error.message };
    if (error instanceof MalformedAccountAssetPageError) {
        return { reason: 'malformed_page', message: 'Hub account asset page is malformed' };
    }
    if (error instanceof assetstore.FrozenAssetIdCollisionError) {
        return { reason: 'integrity_error', message: 'Frozen Hub asset conflicts with existing content or provenance' };
    }
    if (error instanceof assetstore.InvalidConditionalPutResultError) {
        return { reason: 'conditional_write_invalid', message: 'Conditional asset write returned an invalid result' };
    }
    if (error instanceof AuthError)
        return { reason: 'auth_required', message: 'Hub authentication required' };
    if (error instanceof HubClientError) {
        if (error.status === 401 || error.status === 403)
            return { reason: 'auth_required', message: 'Hub authentication required' };
        if (error.status === 429 || error.status >= 500)
            return { reason: 'network_error', message: 'Hub temporarily unavailable' };
        return { reason: 'hub_rejected', message: 'Hub rejected the sync request' };
    }
    if (error instanceof HubUnreachableError)
        return { reason: 'network_error', message: 'Hub unreachable' };
    const message = error instanceof Error ? error.message : String(error);
    if (/credential|auth|login|node_secret|token/i.test(message))
        return { reason: 'auth_required', message: redact(message) };
    if (/network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|hub 5\d\d/i.test(message))
        return { reason: 'network_error', message: 'Hub unreachable' };
    return { reason: 'internal_error', message: 'Sync operation failed' };
}
function hasFetchAssetById(hub) {
    return typeof hub.fetchAssetById === 'function';
}
function isSyncAccountAssetHub(value) {
    const candidate = value;
    return typeof candidate?.listAccountAssets === 'function' && typeof candidate.fetchAssetById === 'function';
}
function syncRunKey(opts, env, deps) {
    const material = {
        ...syncInventoryIdentity(opts, env, deps),
        limit: opts.limit,
        pageSize: opts.pageSize,
        force: opts.force,
        purchasedCursor: opts.purchasedCursor ?? '',
        publishedCursor: opts.publishedCursor ?? '',
    };
    return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
function syncInventoryKey(opts, env, deps) {
    return createHash('sha256').update(JSON.stringify(syncInventoryIdentity(opts, env, deps))).digest('hex');
}
function prepareInventoryScan(syncLedger, inventoryKey, opts) {
    const inputCursors = {
        purchased: opts.purchasedCursor ?? null,
        published: opts.publishedCursor ?? null,
    };
    const inputCursorFingerprints = fingerprintCursors(inputCursors);
    const previous = syncLedger.latestInventoryScan(inventoryKey);
    if (opts.resume
        && previous
        && !previous.complete
        && previous.retryIndex !== undefined
        && previous.scope === opts.scope
        && cursorFingerprintsMatch(previous.nextCursorFingerprints, inputCursorFingerprints)) {
        return {
            trackable: true,
            scanId: previous.scanId,
            index: previous.retryIndex,
            retry: true,
            inputCursorFingerprints,
            skipPurchased: opts.scope === 'all'
                && previous.nextCursorFingerprints.purchased === null
                && previous.nextCursorFingerprints.published !== null,
            skipPublished: opts.scope === 'all'
                && previous.nextCursorFingerprints.published === null
                && previous.nextCursorFingerprints.purchased !== null,
        };
    }
    if (inputCursors.purchased === null && inputCursors.published === null) {
        return {
            trackable: true,
            scanId: randomUUID(),
            index: 0,
            retry: false,
            inputCursorFingerprints,
            skipPurchased: false,
            skipPublished: false,
        };
    }
    if (previous
        && !previous.complete
        && previous.retryIndex === undefined
        && previous.scope === opts.scope
        && cursorFingerprintsMatch(previous.nextCursorFingerprints, inputCursorFingerprints)) {
        return {
            trackable: true,
            scanId: previous.scanId,
            index: previous.segmentCount,
            retry: false,
            inputCursorFingerprints,
            skipPurchased: opts.scope === 'all' && previous.nextCursorFingerprints.purchased === null,
            skipPublished: opts.scope === 'all' && previous.nextCursorFingerprints.published === null,
        };
    }
    return {
        trackable: false,
        scanId: randomUUID(),
        index: 0,
        retry: false,
        inputCursorFingerprints,
        skipPurchased: false,
        skipPublished: false,
    };
}
function isRetryableAssetFailure(failure) {
    return (failure.stage === 'fetch' || failure.stage === 'write')
        && (failure.reason === 'network_error' || failure.reason === 'internal_error');
}
function fingerprintCursors(cursors) {
    return {
        purchased: cursors.purchased === null ? null : createHash('sha256').update(cursors.purchased).digest('hex'),
        published: cursors.published === null ? null : createHash('sha256').update(cursors.published).digest('hex'),
    };
}
function cursorFingerprintsMatch(left, right) {
    return left.purchased === right.purchased && left.published === right.published;
}
function syncInventoryIdentity(opts, env, deps) {
    const privateMode = isPrivateHubMode(env);
    const suppliedIdentityFingerprint = suppliedResumeIdentityFingerprint(deps);
    return {
        mode: String(env['EVOMAP_HUB_MODE'] ?? 'public').trim().toLowerCase(),
        hubUrl: privateMode ? requirePrivateHubUrl(env) : resolveHubUrl(env),
        account: privateMode
            ? firstNonEmptyEnv(env, ['EVOMAP_ENTERPRISE_SUBJECT', 'EVOMAP_PRIVATE_SUBJECT', 'PHUB_ENTERPRISE_SUBJECT', 'USER']) ?? 'evolver-proxy'
            : '',
        credentialFingerprint: suppliedIdentityFingerprint
            ?? (privateMode ? syncCredentialFingerprint(env) : publicResumeIdentityFingerprint(env, deps)),
        scope: opts.scope,
        type: opts.type ?? '',
        status: opts.status,
    };
}
function reconciliationRecords(syncLedger, inventoryKey, legacyRunKey) {
    const records = new Map();
    for (const record of syncLedger.listForInventoryKey(inventoryKey))
        records.set(record.assetId, record);
    // Records written before inventoryKey existed retain same-parameter reconciliation behavior.
    for (const record of syncLedger.listForRunKey(legacyRunKey))
        records.set(record.assetId, record);
    return [...records.values()];
}
function countMissingRemote(syncLedger, inventoryKey, legacyRunKey, localAssetIds, remoteAssetIds) {
    return reconciliationRecords(syncLedger, inventoryKey, legacyRunKey)
        .filter((record) => localAssetIds.has(record.assetId) && !remoteAssetIds.has(record.remoteAssetId))
        .length;
}
function inventorySegmentOutcome(candidates, failures, written) {
    const failedAssetIds = new Set(failures.flatMap((failure) => failure.assetId ? [failure.assetId] : []));
    const writtenAssetIds = new Set(written.map((asset) => asset.assetId));
    const items = [];
    let anonymousBlocked = 0;
    for (const candidate of candidates) {
        if (candidate.assetId === MISSING_ASSET_ID) {
            anonymousBlocked += 1;
            continue;
        }
        let outcome;
        if (failedAssetIds.has(candidate.assetId))
            outcome = 'failed';
        else if (candidate.action === 'already_local')
            outcome = 'already_local';
        else if (isBlockedCandidate(candidate))
            outcome = 'blocked';
        else if (writtenAssetIds.has(candidate.assetId))
            outcome = 'imported';
        else
            outcome = 'pending';
        items.push({ remoteAssetId: candidate.assetId, outcome });
    }
    return { items, anonymousBlocked };
}
function reconcileInventorySnapshot(snapshot, missingRemote) {
    let imported = 0;
    let alreadyLocal = 0;
    let blocked = snapshot.anonymousBlocked;
    let failed = 0;
    let pending = 0;
    for (const outcome of snapshot.outcomes.values()) {
        if (outcome === 'imported')
            imported += 1;
        else if (outcome === 'already_local')
            alreadyLocal += 1;
        else if (outcome === 'blocked')
            blocked += 1;
        else if (outcome === 'failed')
            failed += 1;
        else
            pending += 1;
    }
    const remoteUnique = snapshot.outcomes.size + snapshot.anonymousBlocked;
    const accounted = imported + alreadyLocal + blocked + failed + pending;
    return {
        remoteUnique,
        accounted,
        imported,
        alreadyLocal,
        blocked,
        failed,
        pending,
        inventoryComplete: snapshot.complete,
        missingRemote,
        consistent: snapshot.complete
            && missingRemote === 0
            && blocked === 0
            && failed === 0
            && pending === 0
            && accounted === remoteUnique,
    };
}
function publicResumeIdentityFingerprint(env, deps) {
    if (!deps.hub)
        return resolveRecipeHubResumeIdentityFingerprint(env);
    return createHash('sha256').update(JSON.stringify({
        account: firstNonEmptyEnv(env, ['EVOMAP_NODE_ID', 'A2A_NODE_ID']) ?? '',
        credentialFingerprint: syncCredentialFingerprint(env),
    })).digest('hex');
}
function syncCredentialFingerprint(env) {
    const credentials = [
        ['A2A_INVITATION_TOKEN', firstNonEmptyEnv(env, ['A2A_INVITATION_TOKEN'])],
        ['enterprise', firstNonEmptyEnv(env, [
                'EVOMAP_ENTERPRISE_TOKEN',
                'EVOMAP_PRIVATE_HUB_TOKEN',
                'PHUB_ENTERPRISE_TOKEN',
                'PRIVATE_HUB_ENTERPRISE_TOKEN',
            ])],
        ['node', firstNonEmptyEnv(env, ['EVOMAP_NODE_SECRET', 'A2A_NODE_SECRET'])],
    ].filter((entry) => entry[1] !== undefined);
    if (credentials.length === 0)
        return '';
    return createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
}
function isPrivateHubMode(env) {
    return String(env['EVOMAP_HUB_MODE'] ?? 'public').trim().toLowerCase() === 'private';
}
function configuredPrivateHubUrl(env) {
    return firstNonEmptyEnv(env, ['EVOMAP_HUB_URL', 'A2A_HUB_URL', 'EVOLVER_DEFAULT_HUB_URL']);
}
function requirePrivateHubUrl(env) {
    const hubUrl = configuredPrivateHubUrl(env);
    if (!hubUrl)
        throw new SyncAbortError('private_hub_url_required', 'Private Hub URL must be configured explicitly');
    return hubUrl;
}
function validatePrivateHubUrl(env) {
    if (isPrivateHubMode(env))
        requirePrivateHubUrl(env);
}
function firstNonEmptyEnv(env, keys) {
    for (const key of keys) {
        const value = env[key]?.trim();
        if (value)
            return value;
    }
    return undefined;
}
function reconcile(candidates, failures, imported, final, inventoryComplete, missingRemote) {
    const failedAssetIds = new Set(failures.flatMap((failure) => failure.assetId ? [failure.assetId] : []));
    let alreadyLocal = 0;
    let blocked = 0;
    let actionable = 0;
    for (const candidate of candidates) {
        if (failedAssetIds.has(candidate.assetId))
            continue;
        if (candidate.action === 'already_local')
            alreadyLocal += 1;
        else if (isBlockedCandidate(candidate))
            blocked += 1;
        else
            actionable += 1;
    }
    const failed = failedAssetIds.size;
    const pending = Math.max(0, actionable - imported);
    const accounted = imported + alreadyLocal + blocked + failed + pending;
    return {
        remoteUnique: candidates.length,
        accounted,
        imported,
        alreadyLocal,
        blocked,
        failed,
        pending,
        inventoryComplete,
        missingRemote,
        consistent: final
            && inventoryComplete
            && missingRemote === 0
            && failures.length === 0
            && blocked === 0
            && pending === 0
            && accounted === candidates.length,
    };
}
function storeBaseDir(store, deps) {
    return store instanceof assetstore.LocalJsonlProvider ? store.baseDir : deps.assetsDir ?? events.assetsDir();
}
function suppliedResumeIdentityFingerprint(deps) {
    const supplied = deps.resumeIdentityFingerprint;
    return supplied === undefined ? undefined : createHash('sha256').update(supplied).digest('hex');
}
function previewProvenanceSnapshot(store, deps) {
    if (deps.provenance)
        return deps.provenance.snapshot();
    if (store instanceof assetstore.LocalJsonlProvider || deps.assetsDir) {
        return new assetstore.ProvenanceStore(storeBaseDir(store, deps), deps.now).snapshot();
    }
    return new Map();
}
function redact(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/\b([A-Z][A-Z0-9_]*(?:_SECRET|_TOKEN))\b\s*[:=]\s*["']?[^"',\s;}]+/g, '$1=[redacted]')
        .replace(/\b(authorization|node_secret|nodeSecret|access_token|refresh_token|token|secret)\b\s*[:=]\s*["']?[^"',\s;}]+/gi, '$1=[redacted]');
}
function stringifyJsonOutput(value) {
    let output = '';
    for (const character of JSON.stringify(value)) {
        const codePoint = character.codePointAt(0);
        output += codePoint !== undefined && isTerminalControlCodePoint(codePoint)
            ? `\\u${codePoint.toString(16).padStart(4, '0')}`
            : character;
    }
    return output;
}
function formatTerminalText(value) {
    const withoutAnsi = redactAnsiSequences(value);
    const withoutSecrets = redact(withoutAnsi)
        .replace(/\b[A-Za-z]:[\\/][^\s\x22'<>|\x5b\x5d]*/g, '[redacted-path]')
        .replace(/\\\\[^\s\x22'<>|\x5b\x5d]+\\[^\s\x22'<>|\x5b\x5d]*/g, '[redacted-path]')
        .replace(/(^|[\s(\x22'=])\/(?:[^/\s\x22'<>|\x5b\x5d]+\/?)+/g, '$1[redacted-path]');
    let output = '';
    for (const character of withoutSecrets) {
        const codePoint = character.codePointAt(0);
        output += codePoint !== undefined && isTerminalControlCodePoint(codePoint)
            ? `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`
            : character;
    }
    return output;
}
function redactAnsiSequences(value) {
    let output = '';
    for (let index = 0; index < value.length;) {
        const code = value.charCodeAt(index);
        const next = value.charCodeAt(index + 1);
        const csi = code === 0x9b || (code === 0x1b && next === 0x5b);
        if (csi) {
            let end = index + (code === 0x1b ? 2 : 1);
            while (end < value.length) {
                const current = value.charCodeAt(end);
                end += 1;
                if (current >= 0x40 && current <= 0x7e)
                    break;
            }
            output += ' [escaped-ansi] ';
            index = end;
            continue;
        }
        const osc = code === 0x9d || (code === 0x1b && next === 0x5d);
        if (osc) {
            let end = index + (code === 0x1b ? 2 : 1);
            while (end < value.length) {
                const current = value.charCodeAt(end);
                if (current === 0x07) {
                    end += 1;
                    break;
                }
                if (current === 0x1b && value.charCodeAt(end + 1) === 0x5c) {
                    end += 2;
                    break;
                }
                end += 1;
            }
            output += ' [escaped-ansi] ';
            index = end;
            continue;
        }
        output += value[index];
        index += 1;
    }
    return output;
}
function isTerminalControlCodePoint(codePoint) {
    return codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || codePoint === 0x061c
        || codePoint === 0x200e
        || codePoint === 0x200f
        || codePoint === 0x2028
        || codePoint === 0x2029
        || (codePoint >= 0x202a && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069);
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stringField(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
function rawStringField(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
function hasInvalidLiveIdentityField(value, keys) {
    const record = value;
    return keys.some((key) => {
        if (!Object.prototype.hasOwnProperty.call(record, key))
            return false;
        const raw = record[key];
        return typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim();
    });
}