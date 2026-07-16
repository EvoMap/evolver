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
import { appendFileSync, existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
    index = new Map();
    sig = ''; // `${mtimeMs}:${size}` of review.jsonl at the last index build; '' = never loaded / file absent
    constructor(baseDir, now = Date.now) {
        this.now = now;
        this.path = join(baseDir, 'review.jsonl');
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
    // Reload-aware (not load-once): the resident `autoexec` daemon holds ONE ReviewLedger, yet an operator runs
    // `evolver review --approve` in a SEPARATE process. Re-read review.jsonl whenever its mtime+size changed, so a
    // live approval lifts a quarantined gene without restarting the daemon. The file is small and queried at most
    // once per cycle, so a statSync per query is cheap. (mtime alone can collide within one ms → pair it with size.)
    load() {
        if (!existsSync(this.path)) {
            this.index.clear();
            this.sig = '';
            return;
        }
        const st = statSync(this.path);
        const sig = `${st.mtimeMs}:${st.size}`;
        if (sig === this.sig)
            return; // unchanged since last read → cached index is current
        this.index.clear();
        for (const line of readFileSync(this.path, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                const r = JSON.parse(line);
                if (r.assetId)
                    this.index.set(r.assetId, ReviewLedger.keep(this.index.get(r.assetId), r));
            }
            catch { /* skip corrupt line */ }
        }
        this.sig = sig;
    }
    /** Record a review-state for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec) {
        this.load();
        const full = { ...rec, at: rec.at ?? new Date(this.now()).toISOString() };
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${JSON.stringify(full)}\n`);
        this.index.set(full.assetId, ReviewLedger.keep(this.index.get(full.assetId), full));
        const st = statSync(this.path); // single stat: two separate calls could straddle a concurrent same-ms append
        this.sig = `${st.mtimeMs}:${st.size}`; // our own write is already indexed; don't force a re-read
        return full;
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
        this.load();
        const existing = this.index.get(assetId);
        return existing ?? this.quarantine(assetId, reason);
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
        this.load();
        return this.index.get(assetId) ?? null;
    }
    /**
     * Every recorded review decision (resolved, reload-aware). The authoritative source of which assets are
     * quarantined/approved/rejected — a queue/UI must read pending state from HERE, not by scanning a truncated
     * asset list, so a draft awaiting approval is never missed behind a store-list cutoff.
     */
    records() {
        this.load();
        return [...this.index.values()];
    }
    /** No record → approved (default eligible); a record → approved only when its state is 'approved'. */
    isApproved(assetId) {
        this.load();
        const r = this.index.get(assetId);
        return r ? r.state === 'approved' : true;
    }
    /**
     * True only when a human approval record exists. Safety-sensitive consumers such as AntiGene warning
     * injection must fail closed when review state is absent; unlike cycle/migrate-authored Genes, an unreviewed
     * negative-memory asset must never inherit the ledger's backward-compatible "no record = eligible" default.
     */
    isExplicitlyApproved(assetId) {
        this.load();
        return this.index.get(assetId)?.state === 'approved';
    }
}