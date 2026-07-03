// Append-only asset-call log (ported from v1 gep/assetCallLog.js). Records every hub-asset interaction across
// evolution runs — search hits/misses, reuse/reference, publish, and review outcomes — as one JSONL line each.
// This is the audit trail behind "which fetched assets actually got reused, and did the reuse pay off"; the
// reuse-reward / quality-feedback loops read it. Best-effort by construction: a logging failure NEVER blocks
// or fails an evolution. The log path is injected so it's testable without a real home dir.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
                    entries.push(JSON.parse(line));
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
}