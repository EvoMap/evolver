// Provenance trust ledger (#30): genes/capsules fetched from the hub are untrusted — a poisoned asset that
// reaches the selection pool could be reused and spread (experience poisoning). Provenance is a SIDECAR keyed
// by asset_id, NOT a field on the asset: asset_id = sha256(canonicalize(asset)), and "how we got it" metadata
// must not enter the content hash (#30.2), or it would break content-addressing. Trust-first by construction:
// selection defaults to trusted-only; an untrusted asset is promoted to trusted only by an explicit, logged act.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { normalizeForPut } from './provider.js';
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function fileFingerprint(path) {
    try {
        const stat = statSync(path, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return 'missing';
        throw error;
    }
}
/**
 * Append-only JSONL sidecar (last-write-wins) at <baseDir>/provenance.jsonl. Default for an asset with NO
 * record = trusted: the only local writers (cycleEngine self-produce, v1 migration) are trusted and never
 * write here; the sole untrusted source — hub ingestion — ALWAYS marks via {@link ingestUntrusted}/mark.
 */
export class ProvenanceStore {
    now;
    path;
    lockPath;
    index = new Map();
    fileState = null;
    constructor(baseDir, now = Date.now) {
        this.now = now;
        this.path = join(baseDir, 'provenance.jsonl');
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    rebuildIndex(state) {
        const next = new Map();
        if (state !== 'missing') {
            for (const line of readFileSync(this.path, 'utf8').split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const r = JSON.parse(line);
                    if (r.assetId)
                        next.set(r.assetId, r);
                }
                catch { /* skip corrupt line */ }
            }
        }
        this.index.clear();
        for (const [assetId, record] of next)
            this.index.set(assetId, record);
        this.fileState = state;
    }
    refreshUnderLock() {
        const state = fileFingerprint(this.path);
        if (state !== this.fileState)
            this.rebuildIndex(state);
    }
    withFreshRead(read) {
        mkdirSync(dirname(this.path), { recursive: true });
        acquireLock(this.lockPath);
        try {
            this.refreshUnderLock();
            return read(this.index);
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    /** Record provenance for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec) {
        const full = { ...rec, at: rec.at ?? new Date(this.now()).toISOString() };
        mkdirSync(dirname(this.path), { recursive: true });
        acquireLock(this.lockPath);
        try {
            this.refreshUnderLock();
            appendFileSync(this.path, `${JSON.stringify(full)}\n`);
            this.index.set(full.assetId, full);
            this.fileState = fileFingerprint(this.path);
        }
        finally {
            releaseLock(this.lockPath);
        }
        return full;
    }
    rollbackLast(rec) {
        const line = `${JSON.stringify(rec)}\n`;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        let locked = false;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            acquireLock(this.lockPath);
            locked = true;
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
            if (buf.toString('utf8') !== line) {
                this.refreshUnderLock();
                return;
            }
            truncateSync(this.path, offset);
            this.rebuildIndex(fileFingerprint(this.path));
        }
        catch {
            this.index.clear();
            this.fileState = null;
        }
        finally {
            if (locked) {
                try {
                    releaseLock(this.lockPath);
                }
                catch {
                    // Rollback is best-effort and must not mask the store failure that triggered it.
                    this.index.clear();
                    this.fileState = null;
                }
            }
        }
    }
    get(assetId) {
        return this.withFreshRead((index) => index.get(assetId) ?? null);
    }
    /** No record → trusted (local default); a record → its trusted flag. */
    isTrusted(assetId) {
        return this.withFreshRead((index) => index.get(assetId)?.trusted ?? true);
    }
    /** One linearizable trust snapshot for bounded batch readers. */
    snapshot() {
        return this.withFreshRead((index) => new Map(index));
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
    const result = await store.put(record);
    // A thrown write has an ambiguous outcome: the asset may have reached disk before the acknowledgement was
    // lost. Keep the untrusted marker in that case so a persisted Hub asset can never fall through the default
    // no-record => trusted policy. Only an explicit no-write result is safe to roll back.
    if (!result.stored)
        prov.rollbackLast(mark);
    return result;
}