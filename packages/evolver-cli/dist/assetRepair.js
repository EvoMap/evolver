// `evolver asset-repair --asset <id|path> [--rejection <file|->] [--apply] --json`
//
// An asset the network refuses is not automatically a bad asset: the Hub rejects field-by-field (missing
// `asset_id`, a key its envelope does not allow), and its own deliveries come back stripped of fields the GEP
// schema requires. Before this command the only options were "publish failed, good luck" and "asset discarded",
// so distilled work was lost to defects that are mechanically fixable.
//
// This command reads the refusal — the local schema gate, plus the Hub's own `details[]` when the operator
// feeds the rejection body back in — and reports exactly what it can fix and what it cannot. `--apply` writes
// the repaired record into the local recall library under its recomputed content id; the original is left
// untouched, so a repair is additive and the operator can still publish either one.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assetrepair, assetstore, events } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { loadAssetRef } from './cliContracts.js';
import { storeRepairedAsset } from './repairedAssetStore.js';
const CONTRACT = 'asset_repair.v1';
const ASSET_REPAIR_USAGE = [
    'usage: evolver asset-repair --asset <id|path> [--asset <id|path>] --json [--rejection <file|->] [--apply]',
].join('\n');
export async function runAssetRepairCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); });
    const stderr = deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); });
    if (argv.includes('--help') || argv.includes('-h')) {
        stdout(ASSET_REPAIR_USAGE);
        return 0;
    }
    const parsed = parseAssetRepairArgs(argv);
    if (!parsed.ok)
        return emit({ status: 'invalid_arg', message: parsed.error, assets: [] }, parsed.value?.jsonOut ?? argv.includes('--json'), stdout, stderr);
    const { refs, rejectionPath, apply, jsonOut } = parsed.value;
    const env = deps.env ?? process.env;
    loadEnvFileFromEnv(env);
    const loaded = await Promise.all(refs.map(async (ref) => {
        try {
            return { ref, record: await loadAssetRef(ref, { ...deps, env }) };
        }
        catch {
            // Ref resolution is the only failure mode here, and its message is caller-controlled text — report the
            // ref we were given, never the underlying error string.
            return { ref, record: undefined };
        }
    }));
    let hubIssuesByIndex;
    try {
        hubIssuesByIndex = rejectionPath === undefined
            ? new Map()
            : assetrepair.hubRejectionIssues(JSON.parse(readRejectionBody(rejectionPath, deps)), {
                assetTypes: loaded.map((entry) => (typeof entry.record?.type === 'string' ? entry.record.type : undefined)),
            }).byAssetIndex;
    }
    catch {
        return emit({ status: 'invalid_arg', message: 'rejection body is not readable JSON', assets: [] }, jsonOut, stdout, stderr);
    }
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir(env));
    const outcomes = [];
    for (const [index, entry] of loaded.entries()) {
        if (!entry.record) {
            outcomes.push({ ref: entry.ref, repair_status: 'not_found', changes: [], blockers: [] });
            continue;
        }
        outcomes.push(await repairOne(entry.ref, entry.record, index, { deps, env, store, apply, hubIssuesByIndex }));
    }
    const status = outcomes.some((outcome) => outcome.repair_status === 'not_found')
        ? 'not_found'
        : outcomes.some((outcome) => outcome.repair_status === 'unrepairable')
            ? 'unrepairable'
            : 'ok';
    return emit({ status, message: summaryMessage(status, apply), assets: outcomes }, jsonOut, stdout, stderr);
}
async function repairOne(ref, original, index, ctx) {
    const hubIssues = [...(ctx.hubIssuesByIndex.get(index) ?? []), ...(ctx.hubIssuesByIndex.get(-1) ?? [])];
    const report = assetrepair.repairAssetRecord(original, { hubIssues });
    const base = {
        ref,
        repair_status: report.status,
        ...(original.asset_id ? { asset_id: original.asset_id } : {}),
        changes: report.changes,
        blockers: report.blockers,
    };
    if (report.status !== 'repaired' || !report.asset)
        return base;
    const repairedAssetId = report.asset.asset_id;
    if (!ctx.apply)
        return { ...base, repaired_asset_id: repairedAssetId, stored: false };
    const stored = await storeRepairedAsset(report.asset, ctx.store, ctx.env);
    return { ...base, repaired_asset_id: repairedAssetId, stored };
}
export function parseAssetRepairArgs(argv) {
    const refs = [];
    let rejectionPath;
    let apply = false;
    let jsonOut = false;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === undefined)
            continue;
        if (token === '--json') {
            jsonOut = true;
            continue;
        }
        if (token === '--apply') {
            apply = true;
            continue;
        }
        const valued = valueOf(token, argv, i);
        if (valued?.flag === '--asset') {
            refs.push(valued.value);
            i += valued.consumed;
            continue;
        }
        if (valued?.flag === '--rejection') {
            rejectionPath = valued.value;
            i += valued.consumed;
            continue;
        }
        if (token === '--asset' || token === '--rejection')
            return { ok: false, error: `${token} requires a value` };
        return { ok: false, error: 'unsupported asset-repair argument' };
    }
    if (!jsonOut)
        return { ok: false, error: 'asset-repair requires --json' };
    if (refs.length === 0)
        return { ok: false, error: 'asset-repair requires --asset <id|path>', value: { refs, apply, jsonOut } };
    return { ok: true, value: { refs, ...(rejectionPath !== undefined ? { rejectionPath } : {}), apply, jsonOut } };
}
function valueOf(token, argv, index) {
    for (const flag of ['--asset', '--rejection']) {
        if (token.startsWith(`${flag}=`)) {
            const value = token.slice(flag.length + 1).trim();
            return value ? { flag, value, consumed: 0 } : undefined;
        }
        if (token === flag) {
            const next = argv[index + 1]?.trim();
            return next && !next.startsWith('--') ? { flag, value: next, consumed: 1 } : undefined;
        }
    }
    return undefined;
}
function readRejectionBody(path, deps) {
    if (deps.readRejection)
        return deps.readRejection(path);
    return readFileSync(path === '-' ? 0 : resolve(path), 'utf8');
}
function summaryMessage(status, apply) {
    if (status === 'not_found')
        return 'one or more asset references could not be resolved';
    if (status === 'unrepairable')
        return 'one or more assets need fields that cannot be derived; see blockers';
    return apply ? 'repaired assets written to the local recall library' : 'repair plan only; re-run with --apply to write it';
}
function emit(result, jsonOut, stdout, stderr) {
    const ok = result.status === 'ok';
    if (jsonOut) {
        stdout(JSON.stringify({ ok, contract: CONTRACT, status: result.status, message: result.message, assets: result.assets }));
        return ok ? 0 : 1;
    }
    for (const asset of result.assets) {
        const detail = asset.repair_status === 'repaired'
            ? `${asset.changes.length} change(s)${asset.repaired_asset_id ? ` → ${asset.repaired_asset_id}` : ''}`
            : asset.repair_status === 'unrepairable'
                ? `blocked on ${asset.blockers.map((blocker) => blocker.path).join(', ')}`
                : asset.repair_status;
        stdout(`asset-repair ${asset.ref}: ${detail}`);
    }
    if (ok)
        stdout(`asset-repair: ${result.message}`);
    else
        stderr(`asset-repair failed (${result.status}): ${result.message}`);
    return ok ? 0 : 1;
}