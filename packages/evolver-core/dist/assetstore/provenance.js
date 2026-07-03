// Provenance trust ledger (#30): genes/capsules fetched from the hub are untrusted — a poisoned asset that
// reaches the selection pool could be reused and spread (experience poisoning). Provenance is a SIDECAR keyed
// by asset_id, NOT a field on the asset: asset_id = sha256(canonicalize(asset)), and "how we got it" metadata
// must not enter the content hash (#30.2), or it would break content-addressing. Trust-first by construction:
// selection defaults to trusted-only; an untrusted asset is promoted to trusted only by an explicit, logged act.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { normalizeForPut } from './provider.js';
/**
 * Append-only JSONL sidecar (last-write-wins) at <baseDir>/provenance.jsonl. Default for an asset with NO
 * record = trusted: the only local writers (cycleEngine self-produce, v1 migration) are trusted and never
 * write here; the sole untrusted source — hub ingestion — ALWAYS marks via {@link ingestUntrusted}/mark.
 */
export class ProvenanceStore {
    now;
    path;
    index = new Map();
    loaded = false;
    constructor(baseDir, now = Date.now) {
        this.now = now;
        this.path = join(baseDir, 'provenance.jsonl');
    }
    load() {
        if (this.loaded)
            return;
        if (existsSync(this.path)) {
            for (const line of readFileSync(this.path, 'utf8').split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const r = JSON.parse(line);
                    if (r.assetId)
                        this.index.set(r.assetId, r);
                }
                catch { /* skip corrupt line */ }
            }
        }
        this.loaded = true;
    }
    /** Record provenance for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec) {
        this.load();
        const full = { ...rec, at: rec.at ?? new Date(this.now()).toISOString() };
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${JSON.stringify(full)}\n`);
        this.index.set(full.assetId, full);
        return full;
    }
    rollbackLast(rec) {
        const line = `${JSON.stringify(rec)}\n`;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        try {
            if (!existsSync(this.path))
                return;
            const stat = statSync(this.path);
            if (!stat.isFile() || stat.size < lineBytes)
                return;
            const offset = stat.size - lineBytes;
            const buf = Buffer.alloc(lineBytes);
            const fd = openSync(this.path, 'r');
            try {
                readSync(fd, buf, 0, lineBytes, offset);
            }
            finally {
                closeSync(fd);
            }
            if (buf.toString('utf8') !== line)
                return;
            truncateSync(this.path, offset);
            this.index.clear();
            this.loaded = false;
        }
        catch {
            this.index.clear();
            this.loaded = false;
        }
    }
    get(assetId) {
        this.load();
        return this.index.get(assetId) ?? null;
    }
    /** No record → trusted (local default); a record → its trusted flag. */
    isTrusted(assetId) {
        this.load();
        const r = this.index.get(assetId);
        return r ? r.trusted : true;
    }
    /** Explicit, audited untrusted→trusted promotion. Appends a new trusted record carrying who/why. */
    promote(assetId, by, reason) {
        const cur = this.get(assetId);
        return this.mark({ assetId, source: cur?.source ?? 'hub', trusted: true, promotedBy: by, reason });
    }
}
/**
 * The sanctioned hub→local-pool landing: store the asset (store.put recomputes/normalizes the asset_id, so a
 * remote-supplied asset_id is never trusted) and mark it untrusted in the sidecar. This is the ONLY path that
 * should bring hub-fetched assets into the local pool — trust-first from the first byte (#30.1).
 */
export async function ingestUntrusted(store, prov, record, source = 'hub') {
    const normalized = normalizeForPut(record);
    const mark = prov.mark({ assetId: normalized.record.asset_id, source, trusted: false });
    try {
        return await store.put(record);
    }
    catch (err) {
        prov.rollbackLast(mark);
        throw err;
    }
}