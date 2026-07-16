export type ReviewState = 'quarantined' | 'approved' | 'rejected';
export interface ReviewRecord {
    assetId: string;
    state: ReviewState;
    at: string;
    by?: string;
    reason?: string;
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
export declare class ReviewLedger {
    private readonly now;
    private readonly path;
    private readonly index;
    private sig;
    constructor(baseDir: string, now?: () => number);
    private static isHuman;
    /** Which record wins for an asset_id: a human decision beats a quarantine; otherwise the later one wins. */
    private static keep;
    private load;
    /** Record a review-state for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec: Omit<ReviewRecord, 'at'> & {
        at?: string;
    }): ReviewRecord;
    /** Quarantine an auto-distilled draft: its strategy must not enter a real run until reviewed. */
    quarantine(assetId: string, reason?: string): ReviewRecord;
    /**
     * Quarantine ONLY if the asset has no record yet — the atomic, reload-aware form `ingest --distill` uses so a
     * re-distill never re-quarantines a gene a human already approved/rejected. The check + append happen here as
     * one operation (reloads first to see any external decision), closing the caller-side get→quarantine gap; and
     * because `keep()` lets a human decision win regardless of order, a quarantine that still races in behind an
     * approval is inert. Returns the surviving record (the existing decision, or the new quarantine).
     */
    quarantineIfAbsent(assetId: string, reason?: string): ReviewRecord;
    /** Explicit, audited approval (who/why) — flips a draft to eligible. */
    approve(assetId: string, by: string, reason: string): ReviewRecord;
    /** Explicit, audited rejection (who/why) — a reviewed terminal state that stays out of runs. */
    reject(assetId: string, by: string, reason: string): ReviewRecord;
    get(assetId: string): ReviewRecord | null;
    /**
     * Every recorded review decision (resolved, reload-aware). The authoritative source of which assets are
     * quarantined/approved/rejected — a queue/UI must read pending state from HERE, not by scanning a truncated
     * asset list, so a draft awaiting approval is never missed behind a store-list cutoff.
     */
    records(): ReviewRecord[];
    /** No record → approved (default eligible); a record → approved only when its state is 'approved'. */
    isApproved(assetId: string): boolean;
    /**
     * True only when a human approval record exists. Safety-sensitive consumers such as AntiGene warning
     * injection must fail closed when review state is absent; unlike cycle/migrate-authored Genes, an unreviewed
     * negative-memory asset must never inherit the ledger's backward-compatible "no record = eligible" default.
     */
    isExplicitlyApproved(assetId: string): boolean;
}