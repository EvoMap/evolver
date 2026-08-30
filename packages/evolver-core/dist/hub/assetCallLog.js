// Append-only asset-call log (ported from v1 gep/assetCallLog.js). Records every hub-asset interaction across
// evolution runs — search hits/misses, reuse/reference, publish, and review outcomes — as one JSONL line each.
// This is the audit trail behind "which fetched assets actually got reused, and did the reuse pay off"; the
// reuse-reward / quality-feedback loops read it. Best-effort by construction: a logging failure NEVER blocks
// or fails an evolution. The log path is injected so it's testable without a real home dir.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { REUSE_ESTIMATOR, reuseEstimate } from '../ops/savingsCore.js';
function objectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function positiveNumber(value, coerceLegacy = false) {
    const number = typeof value === 'number' ? value : coerceLegacy ? Number(value) : Number.NaN;
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
function nestedAssetRecord(asset) {
    const direct = objectRecord(asset);
    return { ...(direct ? { direct } : {}), ...(objectRecord(direct?.['payload']) ? { payload: objectRecord(direct?.['payload']) } : {}) };
}
/** Measured derivation cost carried by an asset (or by a Hub wrapper's payload). */
export function assetDerivationTokenCost(asset) {
    const records = nestedAssetRecord(asset);
    for (const record of [records.direct, records.payload]) {
        const derivation = objectRecord(record?.['derivation_tokens']);
        const total = positiveNumber(derivation?.['total_tokens']);
        if (total !== undefined)
            return total;
    }
    return undefined;
}
function assetBlastRadiusLines(asset) {
    const records = nestedAssetRecord(asset);
    for (const record of [records.direct, records.payload]) {
        const blast = objectRecord(record?.['blast_radius']);
        const lines = positiveNumber(blast?.['lines']);
        if (lines !== undefined)
            return lines;
    }
    return undefined;
}
/**
 * Attribute savings without inventing a measured value: asset telemetry wins, then this node's publish-cost
 * index, then the savings-core blast/default estimator. Reference reuse applies the same fractional discount
 * to measured and estimated costs.
 */
export function reuseSavingsForAsset(asset, mode, indexedTokenCost) {
    const measured = assetDerivationTokenCost(asset);
    const indexed = measured === undefined ? positiveNumber(indexedTokenCost) : undefined;
    const cost = measured ?? indexed;
    if (cost !== undefined) {
        return {
            tokens_saved: Math.round(mode === 'reference' ? cost * REUSE_ESTIMATOR.reference_saving_fraction : cost),
            tokens_saved_basis: measured !== undefined ? 'measured' : 'cost_index',
        };
    }
    const estimated = reuseEstimate(assetBlastRadiusLines(asset), mode);
    return { tokens_saved: estimated.tokens_saved, tokens_saved_basis: estimated.basis };
}
function isAssetCallRecord(value) {
    const record = objectRecord(value);
    return record !== undefined
        && typeof record['timestamp'] === 'string'
        && typeof record['action'] === 'string'
        && record['action'].length > 0;
}
export class AssetCallLog {
    path;
    now;
    constructor(path, now = () => new Date()) {
        this.path = path;
        this.now = now;
    }
    /** Append one record (timestamped). Never throws — logging must not break evolution. */
    append(entry) {
        if (!entry || typeof entry !== 'object')
            return;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            const record = { timestamp: this.now().toISOString(), ...entry };
            appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
        }
        catch { /* non-fatal */ }
    }
    /** Read records with optional filters. Corrupt lines are skipped. */
    read(opts = {}) {
        if (!existsSync(this.path))
            return [];
        let entries = [];
        try {
            for (const line of readFileSync(this.path, 'utf8').split('\n')) {
                if (!line)
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    if (isAssetCallRecord(parsed))
                        entries.push(parsed);
                }
                catch { /* skip corrupt */ }
            }
        }
        catch {
            return [];
        }
        if (opts.since) {
            const sinceTs = new Date(opts.since).getTime();
            if (Number.isFinite(sinceTs))
                entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceTs);
        }
        if (opts.run_id)
            entries = entries.filter((e) => e.run_id === opts.run_id);
        if (opts.action)
            entries = entries.filter((e) => e.action === opts.action);
        if (opts.last && Number.isFinite(opts.last) && opts.last > 0)
            entries = entries.slice(-opts.last);
        return entries;
    }
    /** Totals + per-action counts (for CLI / observability). */
    summarize(opts = {}) {
        const entries = this.read(opts);
        const byAction = {};
        const assets = new Set();
        const runs = new Set();
        for (const e of entries) {
            byAction[e.action] = (byAction[e.action] ?? 0) + 1;
            if (e.asset_id)
                assets.add(e.asset_id);
            if (e.run_id)
                runs.add(e.run_id);
        }
        return { total_entries: entries.length, unique_assets: assets.size, unique_runs: runs.size, by_action: byAction, entries };
    }
    /** Local-only attribution rollup over reuse/reference audit rows. */
    reuseAttributionSummary(opts = {}) {
        const entries = this.read(opts).filter((entry) => entry.action === 'asset_reuse' || entry.action === 'asset_reference');
        const byAsset = new Map();
        let totalTokensSaved = 0;
        let totalReuse = 0;
        let totalReference = 0;
        for (const entry of entries) {
            const id = nonEmptyString(entry.asset_id) ?? '(unknown)';
            let aggregate = byAsset.get(id);
            if (!aggregate) {
                aggregate = {
                    asset_id: id,
                    source_node_id: nonEmptyString(entry.source_node_id) ?? null,
                    chain_id: nonEmptyString(entry.chain_id) ?? null,
                    reuse: 0,
                    reference: 0,
                    tokens_saved: 0,
                };
                byAsset.set(id, aggregate);
            }
            if (entry.action === 'asset_reuse') {
                aggregate.reuse += 1;
                totalReuse += 1;
            }
            else {
                aggregate.reference += 1;
                totalReference += 1;
            }
            const tokensSaved = positiveNumber(entry['tokens_saved'], true);
            if (tokensSaved !== undefined) {
                aggregate.tokens_saved += tokensSaved;
                totalTokensSaved += tokensSaved;
            }
            aggregate.source_node_id ??= nonEmptyString(entry.source_node_id) ?? null;
            aggregate.chain_id ??= nonEmptyString(entry.chain_id) ?? null;
        }
        const byAssetRows = [...byAsset.values()].sort((left, right) => (right.reuse + right.reference) - (left.reuse + left.reference));
        return {
            total_reuse: totalReuse,
            total_reference: totalReference,
            total_tokens_saved: totalTokensSaved,
            by_asset: byAssetRows,
        };
    }
    /** Later valid publish rows win; malformed/non-positive costs never erase a prior measurement. */
    assetCostIndex(opts = {}) {
        const costs = new Map();
        for (const entry of this.read(opts)) {
            if (entry.action !== 'asset_publish')
                continue;
            const assetId = nonEmptyString(entry.asset_id);
            const tokensSpent = positiveNumber(entry['tokens_spent'], true);
            if (assetId && tokensSpent !== undefined)
                costs.set(assetId, tokensSpent);
        }
        return Object.fromEntries(costs);
    }
}