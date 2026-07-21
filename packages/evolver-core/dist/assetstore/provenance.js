// Provenance trust ledger (#30): genes/capsules fetched from the hub are untrusted — a poisoned asset that
// reaches the selection pool could be reused and spread (experience poisoning). Provenance is a SIDECAR keyed
// by asset_id, NOT a field on the asset: asset_id = sha256(canonicalize(asset)), and "how we got it" metadata
// must not enter the content hash (#30.2), or it would break content-addressing. Trust-first by construction:
// selection defaults to trusted-only; an untrusted asset is promoted to trusted only by an explicit, logged act.
import { join, dirname } from 'node:path';
import { normalizeForPut } from './provider.js';
import { appendUtf8Durable, assertAssetStoreDirectory, ensureAssetStoreDirectory, readUtf8Regular, regularFileFingerprint, truncateUtf8SuffixDurable, withAssetStoreLock, } from './assetStoreStorage.js';
import { assertTrustSidecarHealthy, parseProvenanceRecord, parseSidecarJsonl, } from './assetSidecarRecords.js';
function immutableRecord(record) {
    return Object.freeze({ ...record });
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
        ensureAssetStoreDirectory(baseDir);
        this.path = join(baseDir, 'provenance.jsonl');
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    rebuildIndex(state) {
        const next = new Map();
        const raw = state === 'missing' ? null : readUtf8Regular(this.path);
        if (raw !== null) {
            const parsed = parseSidecarJsonl(raw, parseProvenanceRecord);
            assertTrustSidecarHealthy('provenance', parsed);
            for (const record of parsed.records)
                next.set(record.assetId, immutableRecord(record));
        }
        this.index.clear();
        for (const [assetId, record] of next)
            this.index.set(assetId, record);
        this.fileState = state;
    }
    refreshUnderLock() {
        const state = regularFileFingerprint(this.path);
        if (state !== this.fileState)
            this.rebuildIndex(state);
    }
    withFreshRead(read) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return read(this.index);
        });
    }
    appendUnderLock(full) {
        const stored = immutableRecord(full);
        appendUtf8Durable(this.path, `${JSON.stringify(stored)}\n`);
        this.index.set(stored.assetId, stored);
        this.fileState = regularFileFingerprint(this.path);
        return stored;
    }
    /** Record provenance for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec) {
        const full = { ...rec, at: rec.at ?? new Date(this.now()).toISOString() };
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return this.appendUnderLock(full);
        });
    }
    rollbackLast(rec) {
        const line = `${JSON.stringify(rec)}\n`;
        try {
            assertAssetStoreDirectory(dirname(this.path));
            withAssetStoreLock(this.lockPath, () => {
                if (!truncateUtf8SuffixDurable(this.path, line)) {
                    this.refreshUnderLock();
                    return;
                }
                this.rebuildIndex(regularFileFingerprint(this.path));
            });
        }
        catch {
            this.index.clear();
            this.fileState = null;
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
    /** Compare and append one trust decision under the same cross-process lock. */
    changeTrust(assetId, trusted, by, reason) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const current = this.index.get(assetId) ?? null;
            if (current?.trusted === trusted)
                return { changed: false, record: current };
            const full = {
                assetId,
                source: current?.source ?? 'local',
                trusted,
                at: new Date(this.now()).toISOString(),
                decision: trusted ? 'promoted' : 'revoked',
                decidedBy: by,
                ...(trusted ? { promotedBy: by } : {}),
                reason,
            };
            return { changed: true, record: this.appendUnderLock(full) };
        });
    }
    /** Explicit, audited untrusted→trusted promotion. Appends a new trusted record carrying who/why. */
    promote(assetId, by, reason) {
        return this.changeTrust(assetId, true, by, reason).record;
    }
    /** Explicit, audited trusted-to-untrusted revocation. A record-less asset is local by default. */
    revoke(assetId, by, reason) {
        return this.changeTrust(assetId, false, by, reason).record;
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