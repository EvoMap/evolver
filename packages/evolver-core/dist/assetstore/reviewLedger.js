// Review-state gate: `ingest --distill` mints UNPROVEN gene drafts from real sessions. Their CONTENT quality is
// unvetted (auto-extracted transcript excerpts), so — like a hub-ingested asset under provenance (#30) — a draft
// must not influence a real autonomous run until a human reviews it. Review-state is a SIDECAR keyed by asset_id,
// NOT a field on the asset: asset_id = sha256(canonicalize(asset)), and "has a human vetted this" metadata must
// not enter the content hash, or it would break content-addressing. Symmetric to provenance, but a DIFFERENT
// axis: provenance = trustworthy origin (anti-poisoning); review-state = vetted draft quality. The embed gate
// (#45 requireTrustedGene) only injects a gene's strategy when it is BOTH trusted-origin AND review-approved.
//
// Default (no record) = approved/eligible: the only writer of quarantine records is `--distill`; cycle-self-
// produced and v1-migrated genes are never quarantined, so the explore→prove loop is untouched for them.
import { join, dirname } from 'node:path';
import { appendUtf8Durable, assertAssetStoreDirectory, ensureAssetStoreDirectory, readUtf8Regular, regularFileFingerprint, withAssetStoreLock, } from './assetStoreStorage.js';
import { assertTrustSidecarHealthy, parseReviewRecord, parseSidecarJsonl, } from './assetSidecarRecords.js';
function immutableRecord(record) {
    return Object.freeze({ ...record });
}
/**
 * Append-only JSONL sidecar at <baseDir>/review.jsonl. Default for an asset with NO record = approved (eligible):
 * only auto-distilled drafts are quarantined here; everything else is eligible by default.
 *
 * Resolution is precedence-based, NOT pure last-write-wins: a HUMAN decision (approved/rejected) always beats an
 * auto `quarantined` record regardless of append order; later beats earlier only WITHIN the same class. This is
 * the race guard — `ingest --distill` (quarantine) and `evolver review --approve` (human) run as separate
 * processes, so a quarantine line appended AFTER an approval must not silently withhold the approved gene.
 */
export class ReviewLedger {
    now;
    path;
    lockPath;
    index = new Map();
    fileState = null;
    constructor(baseDir, now = Date.now) {
        this.now = now;
        ensureAssetStoreDirectory(baseDir);
        this.path = join(baseDir, 'review.jsonl');
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    static isHuman(s) { return s === 'approved' || s === 'rejected'; }
    /** Which record wins for an asset_id: a human decision beats a quarantine; otherwise the later one wins. */
    static keep(existing, r) {
        if (!existing)
            return r;
        if (ReviewLedger.isHuman(r.state))
            return r; // human decision always wins (and later human beats earlier)
        return ReviewLedger.isHuman(existing.state) ? existing : r; // a quarantine replaces only a prior quarantine
    }
    rebuildIndex(state) {
        const next = new Map();
        const raw = state === 'missing' ? null : readUtf8Regular(this.path);
        if (raw !== null) {
            const parsed = parseSidecarJsonl(raw, parseReviewRecord);
            assertTrustSidecarHealthy('review', parsed);
            for (const record of parsed.records) {
                const frozen = immutableRecord(record);
                next.set(record.assetId, ReviewLedger.keep(next.get(record.assetId), frozen));
            }
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
        appendUtf8Durable(this.path, `${JSON.stringify(full)}\n`);
        const frozen = immutableRecord(full);
        this.index.set(full.assetId, ReviewLedger.keep(this.index.get(full.assetId), frozen));
        this.fileState = regularFileFingerprint(this.path);
        return this.index.get(full.assetId);
    }
    /** Record a review-state for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec) {
        const full = { ...rec, at: rec.at ?? new Date(this.now()).toISOString() };
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            this.appendUnderLock(full);
            return immutableRecord(full);
        });
    }
    /** Quarantine an auto-distilled draft: its strategy must not enter a real run until reviewed. */
    quarantine(assetId, reason = 'auto-distilled — review before use') {
        return this.mark({ assetId, state: 'quarantined', reason });
    }
    /**
     * Quarantine ONLY if the asset has no record yet — the atomic, reload-aware form `ingest --distill` uses so a
     * re-distill never re-quarantines a gene a human already approved/rejected. The check + append happen here as
     * one operation (reloads first to see any external decision), closing the caller-side get→quarantine gap; and
     * because `keep()` lets a human decision win regardless of order, a quarantine that still races in behind an
     * approval is inert. Returns the surviving record (the existing decision, or the new quarantine).
     */
    quarantineIfAbsent(assetId, reason = 'auto-distilled — review before use') {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const existing = this.index.get(assetId);
            if (existing)
                return existing;
            return this.appendUnderLock({
                assetId,
                state: 'quarantined',
                reason,
                at: new Date(this.now()).toISOString(),
            });
        });
    }
    /** Explicit, audited approval (who/why) — flips a draft to eligible. */
    approve(assetId, by, reason) {
        return this.mark({ assetId, state: 'approved', by, reason });
    }
    /** Explicit, audited rejection (who/why) — a reviewed terminal state that stays out of runs. */
    reject(assetId, by, reason) {
        return this.mark({ assetId, state: 'rejected', by, reason });
    }
    get(assetId) {
        return this.withFreshRead((index) => index.get(assetId) ?? null);
    }
    /**
     * Every recorded review decision (resolved, reload-aware). The authoritative source of which assets are
     * quarantined/approved/rejected — a queue/UI must read pending state from HERE, not by scanning a truncated
     * asset list, so a draft awaiting approval is never missed behind a store-list cutoff.
     */
    records() {
        return [...this.snapshot().values()];
    }
    /** One linearizable review snapshot for bounded batch readers. */
    snapshot() {
        return this.withFreshRead((index) => new Map(index));
    }
    /** No record → approved (default eligible); a record → approved only when its state is 'approved'. */
    isApproved(assetId) {
        return this.withFreshRead((index) => {
            const r = index.get(assetId);
            return r ? r.state === 'approved' : true;
        });
    }
    /**
     * True only when a human approval record exists. Safety-sensitive consumers such as AntiGene warning
     * injection must fail closed when review state is absent; unlike cycle/migrate-authored Genes, an unreviewed
     * negative-memory asset must never inherit the ledger's backward-compatible "no record = eligible" default.
     */
    isExplicitlyApproved(assetId) {
        return this.withFreshRead((index) => index.get(assetId)?.state === 'approved');
    }
}