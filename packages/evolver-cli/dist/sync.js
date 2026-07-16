import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assetstore, events, hub as hubNs, wire } from '@evomap/evolver-core';
import { AuthError, connectPublicHub, HubClientError, HubUnreachableError, isHubDryRunEnabled, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { createRecipeHubFromEnv } from './recipe.js';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const GROUP = 'sync';
const USAGE = [
    'usage: evolver sync [--write] [--force] [--scope all|purchased|published] [--type Gene|Capsule] [--status draft|promoted|all] [--limit N] [--json]',
    '       evolver sync --export <file.gepx> [--type Gene|Capsule] [--limit N] [--json]',
    '       evolver sync --import <file.gepx> [--write] [--force] [--type Gene|Capsule] [--limit N] [--json]',
    '       evolver sync --json',
].join('\n');
const VALUE_FLAGS = new Set(['--scope', '--type', '--status', '--limit', '--export', '--import']);
const GEPX_TYPE = 'evomap.gepx';
const GEPX_VERSION = 1;
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
    'asset_type',
    'local_id',
    'payload',
    'source',
    'status',
]);
const MISSING_ASSET_ID = '[missing]';
export async function runSyncCommand(argv, deps = {}) {
    const out = deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); });
    const err = deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); });
    if (argv.includes('--help') || argv.includes('-h')) {
        if (argv.includes('--json'))
            out(JSON.stringify({ ok: true, group: GROUP, mode: 'help', usage: USAGE }));
        else
            out(USAGE);
        return 0;
    }
    const parsed = parseSyncArgs(argv);
    if (!parsed.ok)
        return emitFailure(parsed.reason, parsed.message, parsed.jsonOut, out, err);
    try {
        const result = parsed.value.exportPath
            ? await executeSyncExport(parsed.value, deps)
            : parsed.value.importPath
                ? parsed.value.write
                    ? await executeGepxImportWrite(parsed.value, deps)
                    : await buildGepxImportPreview(parsed.value, deps)
                : parsed.value.write
                    ? await executeSyncWrite(parsed.value, deps)
                    : await buildSyncPreview(parsed.value, deps);
        if (parsed.value.jsonOut)
            out(JSON.stringify(result));
        else if (result.mode === 'preview')
            emitTextPreview(result, out);
        else if (result.mode === 'export')
            emitTextExport(result, out);
        else if (result.mode === 'import_preview')
            emitTextImportPreview(result, out);
        else if (result.mode === 'import')
            emitTextImport(result, out);
        else
            emitTextWrite(result, out);
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
    let jsonOut = argv.includes('--json');
    let write = false;
    let force = false;
    let exportPath;
    let importPath;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token)
            continue;
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
    if (exportPath && importPath) {
        return { ok: false, reason: 'invalid_arg', message: '--export and --import cannot be used together', jsonOut };
    }
    if (exportPath && write) {
        return { ok: false, reason: 'invalid_arg', message: '--export does not use --write', jsonOut };
    }
    return { ok: true, value: { scope, ...(type ? { type } : {}), status, limit, jsonOut, write, force, ...(exportPath ? { exportPath } : {}), ...(importPath ? { importPath } : {}) } };
}
async function buildSyncPreview(opts, deps) {
    const env = deps.env ?? process.env;
    loadEnvFileFromEnv(env);
    if (isHubDryRunEnabled(env))
        return emptyPreview(opts.scope);
    const hub = deps.hub ?? createDefaultHub(deps);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const local = await localIndex(store);
    const { purchased, published } = await listRemoteRows(hub, opts);
    const counts = {
        remotePurchased: purchased.length,
        remotePublished: published.length,
        uniqueRemote: 0,
        alreadyLocal: 0,
        idCollision: 0,
        unsupported: 0,
        integrityError: 0,
        wouldImport: 0,
        forcedImport: 0,
    };
    const unique = new Map();
    const missingAssetId = [];
    for (const row of purchased)
        addUnique(unique, missingAssetId, row, 'purchased');
    for (const row of published)
        addUnique(unique, missingAssetId, row, 'published');
    counts.uniqueRemote = unique.size + missingAssetId.length;
    const candidates = [];
    for (const { row, source } of [...unique.values(), ...missingAssetId]) {
        const candidate = classifyRemote(row, source, local);
        candidates.push(candidate);
        if (candidate.action === 'already_local')
            counts.alreadyLocal += 1;
        else if (candidate.action === 'id_collision')
            counts.idCollision += 1;
        else if (candidate.action === 'would_import')
            counts.wouldImport += 1;
        else if (candidate.action === 'force_import')
            counts.forcedImport += 1;
        else if (candidate.action === 'unsupported_type')
            counts.unsupported += 1;
        else
            counts.integrityError += 1;
    }
    return { ok: true, group: GROUP, mode: 'preview', scope: opts.scope, counts, candidates };
}
async function executeSyncWrite(opts, deps) {
    const env = deps.env ?? process.env;
    loadEnvFileFromEnv(env);
    if (isHubDryRunEnabled(env))
        return emptyWrite(opts.scope, 'dry_run');
    const hub = deps.hub ?? createDefaultHub(deps);
    if (!hasFetchAssetById(hub))
        throw new Error('sync write requires fetchAssetById support');
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const preview = await buildSyncPreview(opts, { ...deps, env, hub, store });
    if (preview.counts.integrityError > 0) {
        throw new SyncAbortError('integrity_error', 'remote asset integrity verification failed before import');
    }
    const local = await localIndex(store);
    const finalCandidates = preview.candidates.map((candidate) => ({ ...candidate }));
    const prepared = [];
    const pendingLogical = new Map(local.logical);
    for (const candidate of finalCandidates) {
        if (candidate.action !== 'would_import' && !(opts.force && candidate.action === 'id_collision'))
            continue;
        const fetched = await hub.fetchAssetById(candidate.assetId);
        if (!fetched)
            throw new SyncAbortError('not_found', 'Hub asset disappeared before import');
        const preparedAsset = prepareFetchedAsset(candidate, fetched, local.byAssetId, pendingLogical, opts.force);
        if ('blocked' in preparedAsset) {
            updateFinalCandidate(finalCandidates, candidate, preparedAsset.blocked);
            continue;
        }
        const logicalId = stringField(preparedAsset.asset, 'id');
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
                source: candidate.source,
                ...(candidate.status ? { status: candidate.status } : {}),
                ...(logicalId ? { logicalId } : {}),
                action: 'would_import',
            };
        updateFinalCandidate(finalCandidates, candidate, finalCandidate);
        prepared.push({
            candidate: finalCandidate,
            asset: preparedAsset.asset,
            ...(preparedAsset.forced ? { forced: true, collisionWithAssetId: preparedAsset.collisionWithAssetId } : {}),
        });
        if (logicalId)
            pendingLogical.set(`${preparedAsset.asset.type}:${logicalId}`, preparedAsset.asset.asset_id);
    }
    const baseDir = storeBaseDir(store, deps);
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(baseDir, deps.now);
    const syncLedger = deps.syncLedger ?? new assetstore.AssetSyncLedger(baseDir, deps.now);
    const written = [];
    for (const item of prepared) {
        const stored = await assetstore.ingestUntrusted(store, provenance, item.asset, 'hub');
        const assetId = stored.asset_id;
        if (!stored.stored) {
            updateFinalCandidate(finalCandidates, item.candidate, { ...item.candidate, assetId, action: 'already_local' });
            continue;
        }
        syncLedger.append({
            assetId,
            type: item.asset.type,
            source: 'hub',
            scope: item.candidate.source === 'published' ? 'published' : 'purchased',
            remoteAssetId: item.candidate.assetId,
            ...(item.candidate.logicalId ? { logicalId: item.candidate.logicalId } : {}),
            ...(item.candidate.status ? { status: item.candidate.status } : {}),
            ...(item.forced ? { forced: true } : {}),
            ...(item.collisionWithAssetId ? { collisionWithAssetId: item.collisionWithAssetId } : {}),
        });
        written.push({
            assetId,
            type: item.asset.type,
            source: item.candidate.source,
            stored: stored.stored,
            trusted: false,
            ...(item.candidate.logicalId ? { logicalId: item.candidate.logicalId } : {}),
            ...(item.candidate.status ? { status: item.candidate.status } : {}),
            ...(item.forced ? { forced: true } : {}),
            ...(item.collisionWithAssetId ? { collisionWithAssetId: item.collisionWithAssetId } : {}),
        });
    }
    const counts = countsFromCandidates(preview.counts, finalCandidates);
    const blocked = finalCandidates.filter(isBlockedCandidate);
    return {
        ok: true,
        group: GROUP,
        mode: 'write',
        scope: opts.scope,
        counts,
        candidates: finalCandidates,
        written,
        blocked,
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
        provenance: provenanceRecords,
        sync: syncRecords,
    };
    try {
        mkdirSync(dirname(opts.exportPath), { recursive: true });
        writeFileSync(opts.exportPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
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
            ...(stringField(asset, 'id') ? { logicalId: stringField(asset, 'id') } : {}),
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
    assertGepxPackageIntegrity(pkg);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const local = await localIndex(store);
    const finalCandidates = classifyGepxAssets(pkg, opts, local);
    const assetsById = gepxImportAssetsById(pkg);
    const syncById = new Map((pkg.sync ?? []).map((record) => [record.assetId, record]));
    const prepared = [];
    const pendingLogical = new Map(local.logical);
    for (const candidate of finalCandidates) {
        if (candidate.action !== 'would_import' && !(opts.force && candidate.action === 'id_collision'))
            continue;
        const asset = assetsById.get(candidate.assetId);
        if (!asset)
            throw new SyncAbortError('integrity_error', '.gepx package asset is missing');
        const preparedAsset = preparePackagedAsset(candidate, asset, local.byAssetId, pendingLogical, opts.force);
        if ('blocked' in preparedAsset) {
            updateFinalCandidate(finalCandidates, candidate, preparedAsset.blocked);
            continue;
        }
        const logicalId = stringField(preparedAsset.asset, 'id');
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
            ...(preparedAsset.forced ? { forced: true, collisionWithAssetId: preparedAsset.collisionWithAssetId } : {}),
        });
        if (logicalId)
            pendingLogical.set(`${preparedAsset.asset.type}:${logicalId}`, preparedAsset.asset.asset_id);
    }
    const baseDir = storeBaseDir(store, deps);
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(baseDir, deps.now);
    const syncLedger = deps.syncLedger ?? new assetstore.AssetSyncLedger(baseDir, deps.now);
    const written = [];
    for (const item of prepared) {
        const stored = await assetstore.ingestUntrusted(store, provenance, item.asset, 'migrated');
        const assetId = stored.asset_id;
        if (!stored.stored) {
            updateFinalCandidate(finalCandidates, item.candidate, { ...item.candidate, assetId, action: 'already_local' });
            continue;
        }
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
            ...(item.candidate.logicalId ? { logicalId: item.candidate.logicalId } : {}),
            ...(item.candidate.status ? { status: item.candidate.status } : {}),
            ...(item.forced ? { forced: true } : {}),
            ...(item.collisionWithAssetId ? { collisionWithAssetId: item.collisionWithAssetId } : {}),
        });
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
            idCollision: 0,
            unsupported: 0,
            integrityError: 0,
            wouldImport: 0,
            forcedImport: 0,
        },
        candidates: [],
    };
}
function emptyCounts(uniqueRemote = 0) {
    return {
        remotePurchased: 0,
        remotePublished: 0,
        uniqueRemote,
        alreadyLocal: 0,
        idCollision: 0,
        unsupported: 0,
        integrityError: 0,
        wouldImport: 0,
        forcedImport: 0,
    };
}
function emptyWrite(scope, mode = 'write') {
    return {
        ...emptyPreview(scope),
        mode,
        written: [],
        blocked: [],
    };
}
function createDefaultHub(deps) {
    const hub = createRecipeHubFromEnv(deps.env ?? process.env, deps.connectHub ?? connectPublicHub);
    return hub;
}
async function listRemoteRows(hub, opts) {
    const purchased = opts.scope === 'all' || opts.scope === 'purchased'
        ? await listAll(hub, { scope: 'purchased', ...(opts.type ? { type: opts.type } : {}), limit: opts.limit })
        : [];
    const remaining = Math.max(0, opts.limit - purchased.length);
    const publishedLimit = opts.scope === 'all' ? remaining : opts.limit;
    const published = (opts.scope === 'all' || opts.scope === 'published') && publishedLimit > 0
        ? await listAll(hub, {
            scope: 'published',
            ...(opts.type ? { type: opts.type } : {}),
            status: opts.status,
            limit: publishedLimit,
        })
        : [];
    return { purchased, published };
}
async function listAll(hub, opts) {
    const rows = [];
    let cursor = opts.cursor;
    const seenCursors = new Set();
    while (rows.length < opts.limit) {
        const remaining = opts.limit - rows.length;
        const result = await hub.listAccountAssets({ ...opts, limit: remaining, ...(cursor ? { cursor } : {}) });
        const pageRows = result.assets;
        rows.push(...pageRows);
        if (!result.hasMore || !result.nextCursor)
            break;
        if (pageRows.length === 0 || result.nextCursor === cursor || seenCursors.has(result.nextCursor))
            break;
        if (cursor)
            seenCursors.add(cursor);
        cursor = result.nextCursor;
    }
    return rows.slice(0, opts.limit);
}
function addUnique(target, missingAssetId, row, source) {
    const assetId = stringField(row, 'asset_id');
    if (!assetId) {
        missingAssetId.push({ row, source });
        return;
    }
    if (target.has(assetId))
        return;
    target.set(assetId, { row, source });
}
async function localIndex(store) {
    const byAssetId = new Set();
    const logical = new Map();
    for (const kind of ['Gene', 'Capsule']) {
        for (const row of await store.list(kind, Number.MAX_SAFE_INTEGER)) {
            byAssetId.add(row.asset_id);
            const logicalId = stringField(row, 'id');
            if (logicalId)
                logical.set(`${kind}:${logicalId}`, row.asset_id);
        }
    }
    return { byAssetId, logical };
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
function classifyRemote(row, source, local) {
    const assetId = stringField(row, 'asset_id') ?? MISSING_ASSET_ID;
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
    if (type !== 'Gene' && type !== 'Capsule')
        return { ...base, action: 'unsupported_type' };
    if (assetId === MISSING_ASSET_ID)
        return { ...base, action: 'integrity_error' };
    if (remotePayloadIntegrityInvalid(row, type, assetId))
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
function classifyGepxAssets(pkg, opts, local) {
    return uniqueGepxAssets(pkg)
        .filter((entry) => !opts.type || entry.type === opts.type)
        .slice(0, opts.limit)
        .map((entry) => classifyGepxAsset(entry, local));
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
    for (const asset of pkg.assets) {
        const normalized = normalizeGepxAsset(asset);
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
            assets.set(entry.assetId, entry.asset);
    }
    return assets;
}
function assertGepxPackageIntegrity(pkg) {
    for (const asset of pkg.assets) {
        const normalized = normalizeGepxAsset(asset);
        if (normalized.type && normalized.integrityError) {
            throw new SyncAbortError('integrity_error', '.gepx package integrity verification failed before import');
        }
    }
}
function normalizeGepxAsset(asset) {
    const cleaned = stripHubMetadata(asset);
    const assetId = stringField(cleaned, 'asset_id') ?? stringField(asset, 'asset_id') ?? MISSING_ASSET_ID;
    const type = cleaned.type === 'Gene' || cleaned.type === 'Capsule' ? cleaned.type : undefined;
    const logicalId = stringField(cleaned, 'id');
    let integrityError = false;
    if (type) {
        const claimed = stringField(cleaned, 'asset_id');
        const fullAsset = looksLikeFullAsset(cleaned, type);
        const computed = fullAsset ? wire.computeAssetId(cleaned) : undefined;
        integrityError = assetId === MISSING_ASSET_ID || !claimed || !fullAsset || !computed || claimed !== assetId || computed !== claimed;
    }
    return {
        original: asset,
        asset: cleaned,
        assetId,
        ...(type ? { type } : {}),
        ...(logicalId ? { logicalId } : {}),
        integrityError,
    };
}
function countsFromCandidates(base, candidates) {
    const counts = {
        remotePurchased: base.remotePurchased,
        remotePublished: base.remotePublished,
        uniqueRemote: candidates.length,
        alreadyLocal: 0,
        idCollision: 0,
        unsupported: 0,
        integrityError: 0,
        wouldImport: 0,
        forcedImport: 0,
    };
    for (const candidate of candidates) {
        if (candidate.action === 'already_local')
            counts.alreadyLocal += 1;
        else if (candidate.action === 'id_collision')
            counts.idCollision += 1;
        else if (candidate.action === 'would_import')
            counts.wouldImport += 1;
        else if (candidate.action === 'force_import')
            counts.forcedImport += 1;
        else if (candidate.action === 'unsupported_type')
            counts.unsupported += 1;
        else
            counts.integrityError += 1;
    }
    return counts;
}
function updateFinalCandidate(candidates, original, replacement) {
    const index = candidates.findIndex((candidate) => candidate.assetId === original.assetId && candidate.source === original.source);
    if (index >= 0)
        candidates[index] = replacement;
}
function isBlockedCandidate(candidate) {
    return candidate.action !== 'would_import' && candidate.action !== 'force_import' && candidate.action !== 'already_local';
}
function remotePayloadIntegrityInvalid(row, type, assetId) {
    const payload = asRecord(row.payload);
    const source = payload ?? row;
    if (!looksLikeFullAsset(source, type))
        return false;
    const candidate = stripHubMetadata({ ...source, type, asset_id: stringField(source, 'asset_id') ?? assetId });
    return Boolean(candidate.asset_id && wire.computeAssetId(candidate) !== candidate.asset_id);
}
function prepareFetchedAsset(candidate, fetched, localAssetIds, logical, force) {
    const type = fetched.type === 'Gene' || fetched.type === 'Capsule' ? fetched.type : undefined;
    if (!type)
        return { blocked: { ...candidate, type: fetched.type ?? candidate.type, action: 'unsupported_type' } };
    if (type !== candidate.type)
        throw new SyncAbortError('integrity_error', 'Hub asset type changed before import');
    const cleaned = stripHubMetadata(fetched);
    const claimed = stringField(cleaned, 'asset_id');
    const computed = wire.computeAssetId(cleaned);
    if (!claimed || !computed || claimed !== computed || claimed !== candidate.assetId) {
        throw new SyncAbortError('integrity_error', 'Hub asset integrity verification failed before import');
    }
    if (!looksLikeFullAsset(cleaned, type)) {
        throw new SyncAbortError('integrity_error', 'Hub asset payload is incomplete');
    }
    if (localAssetIds.has(cleaned.asset_id))
        return { blocked: { ...candidate, action: 'already_local' } };
    const logicalId = stringField(cleaned, 'id');
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
function preparePackagedAsset(candidate, asset, localAssetIds, logical, force) {
    const cleaned = stripHubMetadata(asset);
    const type = cleaned.type === 'Gene' || cleaned.type === 'Capsule' ? cleaned.type : undefined;
    if (!type)
        return { blocked: { ...candidate, type: cleaned.type ?? candidate.type, action: 'unsupported_type' } };
    if (type !== candidate.type)
        return { blocked: { ...candidate, type, action: 'unsupported_type' } };
    const claimed = stringField(cleaned, 'asset_id');
    const computed = wire.computeAssetId(cleaned);
    if (!claimed || !computed || claimed !== computed || claimed !== candidate.assetId || !looksLikeFullAsset(cleaned, type)) {
        throw new SyncAbortError('integrity_error', '.gepx package integrity verification failed before import');
    }
    if (localAssetIds.has(cleaned.asset_id))
        return { blocked: { ...candidate, action: 'already_local' } };
    const logicalId = stringField(cleaned, 'id');
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
function stripHubMetadata(asset) {
    const out = {};
    for (const [key, value] of Object.entries(asset))
        if (!HUB_METADATA_KEYS.has(key))
            out[key] = value;
    return out;
}
function readGepxPackage(path) {
    if (!path)
        throw new SyncAbortError('invalid_arg', '--import requires a file');
    if (!existsSync(path))
        throw new SyncAbortError('gepx_read_failed', 'could not read .gepx file');
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    const obj = asRecord(parsed);
    if (!obj || obj['type'] !== GEPX_TYPE || obj['version'] !== GEPX_VERSION || !Array.isArray(obj['assets'])) {
        throw new SyncAbortError('invalid_gepx', 'invalid .gepx package');
    }
    const assets = obj['assets']
        .map((asset) => asRecord(asset))
        .filter((asset) => Boolean(asset))
        .map((asset) => asset);
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
        provenance,
        sync,
    };
}
function parseGepxProvenanceRecord(value) {
    if (!value)
        return null;
    const assetId = stringField(value, 'assetId');
    const source = stringField(value, 'source');
    const at = stringField(value, 'at');
    if (!assetId || !at || (source !== 'local' && source !== 'migrated' && source !== 'hub'))
        return null;
    return {
        assetId,
        source,
        trusted: value['trusted'] === true,
        at,
        ...(stringField(value, 'promotedBy') ? { promotedBy: stringField(value, 'promotedBy') } : {}),
        ...(stringField(value, 'reason') ? { reason: stringField(value, 'reason') } : {}),
    };
}
function parseGepxSyncRecord(value) {
    if (!value)
        return null;
    const assetId = stringField(value, 'assetId');
    const type = stringField(value, 'type');
    const source = stringField(value, 'source');
    const scope = stringField(value, 'scope');
    const syncedAt = stringField(value, 'syncedAt');
    const remoteAssetId = stringField(value, 'remoteAssetId');
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
        ...(stringField(value, 'logicalId') ? { logicalId: stringField(value, 'logicalId') } : {}),
        ...(stringField(value, 'status') ? { status: stringField(value, 'status') } : {}),
        ...(value['forced'] === true ? { forced: true } : {}),
        ...(stringField(value, 'collisionWithAssetId') ? { collisionWithAssetId: stringField(value, 'collisionWithAssetId') } : {}),
    };
}
function remoteType(row) {
    const payload = asRecord(row.payload);
    const raw = stringField(row, 'type') ?? stringField(row, 'asset_type') ?? (payload ? stringField(payload, 'type') : undefined);
    return raw === 'Gene' || raw === 'Capsule' ? raw : undefined;
}
function remoteLogicalId(row) {
    const payload = asRecord(row.payload);
    return stringField(row, 'id') ?? stringField(row, 'local_id') ?? (payload ? stringField(payload, 'id') : undefined);
}
function emitTextPreview(preview, out) {
    const c = preview.counts;
    out(`sync preview: scope=${preview.scope} purchased=${c.remotePurchased} published=${c.remotePublished} unique=${c.uniqueRemote}`);
    out(`  would_import=${c.wouldImport} forced_import=${c.forcedImport} already_local=${c.alreadyLocal} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    for (const candidate of preview.candidates.slice(0, 10)) {
        out(`  ${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
    }
}
function emitTextWrite(result, out) {
    const c = result.counts;
    out(`sync ${result.mode}: scope=${result.scope} purchased=${c.remotePurchased} published=${c.remotePublished} unique=${c.uniqueRemote}`);
    out(`  written=${result.written.length} blocked=${result.blocked.length} would_import=${c.wouldImport} forced_import=${c.forcedImport} already_local=${c.alreadyLocal} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    for (const asset of result.written.slice(0, 10)) {
        out(`  imported: ${asset.type} ${asset.assetId}${asset.logicalId ? ` (${asset.logicalId})` : ''}`);
    }
    for (const candidate of result.blocked.slice(0, 10)) {
        out(`  blocked/${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
    }
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
    out(`  would_import=${c.wouldImport} forced_import=${c.forcedImport} already_local=${c.alreadyLocal} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    for (const candidate of result.candidates.slice(0, 10)) {
        out(`  ${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
    }
}
function emitTextImport(result, out) {
    const c = result.counts;
    out(`sync import: written=${result.written.length} blocked=${result.blocked.length} unique=${c.uniqueRemote}`);
    out(`  would_import=${c.wouldImport} forced_import=${c.forcedImport} already_local=${c.alreadyLocal} id_collision=${c.idCollision} unsupported=${c.unsupported} integrity_error=${c.integrityError}`);
    for (const asset of result.written.slice(0, 10)) {
        out(`  imported: ${asset.type} ${asset.assetId}${asset.logicalId ? ` (${asset.logicalId})` : ''}`);
    }
    for (const candidate of result.blocked.slice(0, 10)) {
        out(`  blocked/${candidate.action}: ${candidate.type} ${candidate.assetId}${candidate.logicalId ? ` (${candidate.logicalId})` : ''}`);
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
function emitFailure(reason, message, jsonOut, out, err) {
    const payload = { ok: false, group: GROUP, reason, message: redact(message) };
    if (jsonOut)
        out(JSON.stringify(payload));
    else
        err(`sync failed (${reason}): ${payload.message}`);
    return 1;
}
function mapSyncError(error) {
    if (error instanceof SyncAbortError)
        return { reason: error.reason, message: error.message };
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
    return { reason: 'internal_error', message: redact(message) };
}
function hasFetchAssetById(hub) {
    return typeof hub.fetchAssetById === 'function';
}
function storeBaseDir(store, deps) {
    return store instanceof assetstore.LocalJsonlProvider ? store.baseDir : deps.assetsDir ?? events.assetsDir();
}
function redact(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/\b([A-Z][A-Z0-9_]*(?:_SECRET|_TOKEN))\b\s*[:=]\s*["']?[^"',\s;}]+/g, '$1=[redacted]')
        .replace(/\b(authorization|node_secret|nodeSecret|access_token|refresh_token|token|secret)\b\s*[:=]\s*["']?[^"',\s;}]+/gi, '$1=[redacted]');
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stringField(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}