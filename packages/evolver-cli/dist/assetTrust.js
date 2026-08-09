import { assetstore, events, hub } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const GROUP = 'asset-trust';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_REASON_INPUT = 1_000;
const MAX_REASON = 240;
const ASSET_ID_RE = /^sha256:[a-f0-9]{64}$/;
const ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,79}$/;
const USAGE = [
    'Usage:',
    '  evolver asset-trust list [--limit N] [--json]',
    '  evolver asset-trust show <asset_id> [--json]',
    '  evolver asset-trust promote <asset_id> --reason <text> [--json]',
    '  evolver asset-trust revoke <asset_id> --reason <text> [--json]',
    '',
].join('\n');
function parseArgs(argv) {
    const action = argv[0];
    if (action !== 'list' && action !== 'show' && action !== 'promote' && action !== 'revoke')
        return 'invalid_action';
    let assetId;
    let reason;
    let limit = DEFAULT_LIMIT;
    let json = false;
    let index = 1;
    if (action !== 'list') {
        assetId = argv[index];
        index += 1;
        if (!assetId || !ASSET_ID_RE.test(assetId))
            return 'invalid_asset_id';
    }
    while (index < argv.length) {
        const arg = argv[index];
        if (arg === '--json') {
            json = true;
            index += 1;
            continue;
        }
        if (arg === '--reason' && (action === 'promote' || action === 'revoke')) {
            const value = argv[index + 1];
            if (!value || value.startsWith('--'))
                return 'reason_required';
            reason = value;
            index += 2;
            continue;
        }
        if (arg === '--limit' && action === 'list') {
            const value = argv[index + 1];
            if (!value || !/^\d+$/.test(value))
                return 'invalid_limit';
            limit = Math.min(MAX_LIMIT, Math.max(1, Number(value)));
            index += 2;
            continue;
        }
        return 'unknown_argument';
    }
    if ((action === 'promote' || action === 'revoke') && !reason)
        return 'reason_required';
    return { action, ...(assetId ? { assetId } : {}), ...(reason ? { reason } : {}), limit, json };
}
function safeActorId(env) {
    const raw = env['EVOLVER_ACTOR_ID'] ?? env['USER'] ?? env['LOGNAME'] ?? env['USERNAME'] ?? 'cli';
    const trimmed = raw.trim();
    return ACTOR_ID_RE.test(trimmed) && hub.redactString(trimmed) === trimmed ? trimmed : 'cli';
}
function safeReason(raw, env) {
    if (raw.length > MAX_REASON_INPUT)
        return null;
    const redacted = hub.redactString(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
    if (!redacted || hub.fullLeakCheck(redacted, env).found)
        return null;
    return redacted;
}
function safeOutputText(value, env, max = MAX_REASON) {
    if (!value)
        return undefined;
    const redacted = hub.redactString(value).replace(/\s+/g, ' ').trim().slice(0, max);
    return redacted && !hub.fullLeakCheck(redacted, env).found ? redacted : '[redacted]';
}
function safeActorOutput(value) {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    return ACTOR_ID_RE.test(trimmed) && hub.redactString(trimmed) === trimmed ? trimmed : '[redacted]';
}
function viewFor(asset, record, env) {
    const logicalId = typeof asset['id'] === 'string' && asset['id'].trim() ? asset['id'].trim() : undefined;
    const decidedBy = safeActorOutput(record?.decidedBy ?? record?.promotedBy);
    const reason = safeOutputText(record?.reason, env);
    return {
        assetId: asset.asset_id,
        type: asset.type,
        ...(logicalId ? { logicalId: safeOutputText(logicalId, env, 120) } : {}),
        source: record?.source ?? 'local_default',
        trusted: record?.trusted ?? true,
        ...(record?.at ? { at: record.at } : {}),
        ...(record?.decision ? { decision: record.decision } : {}),
        ...(decidedBy ? { decidedBy } : {}),
        ...(reason ? { reason } : {}),
    };
}
function storeBaseDir(store, deps) {
    if (deps.assetsDir)
        return deps.assetsDir;
    return store instanceof assetstore.LocalJsonlProvider ? store.baseDir : events.assetsDir();
}
function writeJson(write, value) {
    write(`${JSON.stringify(value)}\n`);
}
function parseFailure(reason, json, stdout, stderr) {
    if (json)
        writeJson(stdout, { ok: false, group: GROUP, reason });
    else
        stderr(`[asset-trust] ${reason}\n${USAGE}`);
    return 2;
}
function renderView(view) {
    return `${view.type} ${view.assetId} source=${view.source} trusted=${view.trusted}${view.logicalId ? ` id=${view.logicalId}` : ''}`;
}
async function recordTrustEvent(ingestor, action, view, reason, actorId) {
    try {
        await ingestor.ingest({
            type: action === 'promote' ? 'actor.human.trust.promote' : 'actor.human.trust.revoke',
            payload: { assetId: view.assetId, assetType: view.type, source: view.source, reason },
            human: { title: `${action} ${view.type} ${view.assetId.slice(0, 19)}`, severity: 'notice' },
            actor: { kind: 'human', id: actorId },
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function runAssetTrustCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    if (argv.includes('--help') || argv.includes('-h')) {
        stdout(USAGE);
        return 0;
    }
    const json = argv.includes('--json');
    const parsed = parseArgs(argv);
    if (typeof parsed === 'string')
        return parseFailure(parsed, json, stdout, stderr);
    const env = deps.env ?? process.env;
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error)
        return parseFailure('env_file_unavailable', parsed.json, stdout, stderr);
    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(storeBaseDir(store, deps));
    if (parsed.action === 'list') {
        const snapshot = provenance.snapshot();
        const allAssets = (await store.list(undefined, Number.MAX_SAFE_INTEGER))
            .map((asset) => viewFor(asset, snapshot.get(asset.asset_id) ?? null, env))
            .sort((left, right) => Number(left.trusted) - Number(right.trusted)
            || left.assetId.localeCompare(right.assetId));
        const assets = allAssets.slice(0, parsed.limit);
        const counts = {
            total: allAssets.length,
            trusted: allAssets.filter((asset) => asset.trusted).length,
            untrusted: allAssets.filter((asset) => !asset.trusted).length,
            returned: assets.length,
        };
        const truncated = assets.length < allAssets.length;
        const result = { ok: true, group: GROUP, mode: 'list', counts, truncated, assets };
        if (parsed.json)
            writeJson(stdout, result);
        else {
            stdout(`asset trust: total=${counts.total} trusted=${counts.trusted} untrusted=${counts.untrusted} returned=${counts.returned} truncated=${truncated}\n`);
            for (const asset of assets)
                stdout(`${renderView(asset)}\n`);
        }
        return 0;
    }
    const asset = await store.get(parsed.assetId);
    if (!asset) {
        if (parsed.json)
            writeJson(stdout, { ok: false, group: GROUP, reason: 'asset_not_found' });
        else
            stderr('[asset-trust] asset_not_found\n');
        return 1;
    }
    if (parsed.action === 'show') {
        const result = { ok: true, group: GROUP, mode: 'show', asset: viewFor(asset, provenance.get(asset.asset_id), env) };
        if (parsed.json)
            writeJson(stdout, result);
        else
            stdout(`${renderView(result.asset)}\n`);
        return 0;
    }
    const reason = safeReason(parsed.reason, env);
    if (!reason)
        return parseFailure('unsafe_reason', parsed.json, stdout, stderr);
    const actorId = safeActorId(env);
    const desiredTrust = parsed.action === 'promote';
    let change;
    try {
        change = provenance.changeTrust(asset.asset_id, desiredTrust, actorId, reason);
    }
    catch (error) {
        if (error instanceof assetstore.ProvenanceWritePendingError) {
            if (parsed.json)
                writeJson(stdout, { ok: false, group: GROUP, reason: 'asset_write_pending' });
            else
                stderr('[asset-trust] asset_write_pending\n');
            return 1;
        }
        throw error;
    }
    const view = viewFor(asset, change.record, env);
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
    const auditEventRecorded = change.changed
        ? await recordTrustEvent(ingestor, parsed.action, view, reason, actorId)
        : false;
    if (change.changed && !auditEventRecorded)
        stderr('[asset-trust] trust decision saved; root event unavailable\n');
    const result = {
        ok: true,
        group: GROUP,
        mode: parsed.action,
        changed: change.changed,
        auditEventRecorded,
        asset: view,
    };
    if (parsed.json)
        writeJson(stdout, result);
    else
        stdout(`${change.changed ? 'updated' : 'unchanged'} ${renderView(view)}\n`);
    return 0;
}