import { LocalJsonlProvider } from './localJsonl.js';
import { ReviewLedger } from './reviewLedger.js';
import { ProvenanceStore } from './provenance.js';
import { assetsDir } from '../events/paths.js';
// Scan window before review filtering — the local gene pool is bounded; mirrors makeTrustedGeneResolver's
// `list('Gene', 1000)`. Scanning wider than maxGenes then filtering means a quarantined draft sitting in the
// top-N can never crowd an approved gene out of the result (filter-then-bound, not bound-then-filter).
const GENE_SCAN_LIMIT = 1000;
/**
 * The ReviewLedger CO-LOCATED with a store — its quarantine/approve records live in the SAME dir as the genes.
 * A read site that defaults the ledger independently (e.g. always `assetsDir()`) would, when handed an injected
 * store at a different dir, consult the WRONG ledger and let a draft quarantined beside that store leak.
 * `LocalJsonlProvider.baseDir` is public exactly so callers can co-locate sidecars; any other provider falls back
 * to the live assets dir.
 */
export function reviewLedgerForStore(store) {
    const baseDir = store instanceof LocalJsonlProvider ? store.baseDir : assetsDir();
    return new ReviewLedger(baseDir);
}
/** The ProvenanceStore CO-LOCATED with a store, symmetric to reviewLedgerForStore. */
export function provenanceStoreForStore(store) {
    const baseDir = store instanceof LocalJsonlProvider ? store.baseDir : assetsDir();
    return new ProvenanceStore(baseDir);
}
/**
 * Read up to `maxGenes` trusted-origin and REVIEW-APPROVED genes from the store, preserving store order.
 * Default-eligible: a gene with NO review record passes (local / cycle / migrated genes); only an explicitly
 * quarantined or rejected draft is withheld. A gene with NO provenance record is trusted; hub-ingested genes are
 * withheld until promotion. This mirrors candidateAssembly's trust-first + review-first filters.
 */
/**
 * Authoritative pending-review queue: quarantined ledger records, oldest first.
 * Callers that display a human queue MUST start here instead of `store.list`, or a
 * draft sitting past the newest-N cutoff is invisible even though it is still blocked.
 */
export function pendingReviewRecords(review, excludeAssetIds = new Set()) {
    return review.records()
        .filter((record) => record.state === 'quarantined' && !excludeAssetIds.has(record.assetId))
        .sort((a, b) => a.at.localeCompare(b.at));
}
/**
 * Pending Gene queue with the asset store as the type/existence authority.
 *
 * ReviewLedger is intentionally generic because the same sidecar also records
 * AntiGene decisions. A quarantined row can also outlive its asset after a
 * repair or a truncated migration. Human Gene queues must therefore resolve
 * every row through the provider instead of treating the ledger alone as a
 * complete inventory. The lookups are deliberately sequential so a malformed
 * or unexpectedly large ledger cannot fan out an unbounded request burst to a
 * remote provider.
 */
export async function pendingGeneReviewRecords(store, review) {
    const pending = pendingReviewRecords(review);
    // LocalJsonlProvider 可直接使用内存索引精确回答，避免 sidecar 变大后逐行等待查询。
    if (store instanceof LocalJsonlProvider) {
        const geneIds = new Set(store.listAll('Gene').map((asset) => asset.asset_id));
        return pending.filter((record) => geneIds.has(record.assetId));
    }
    const genes = [];
    for (const record of pending) {
        const asset = await store.get(record.assetId);
        if (asset?.type === 'Gene')
            genes.push(record);
    }
    return genes;
}
export async function listApprovedGenes(store, review, maxGenes, provenance = provenanceStoreForStore(store)) {
    const all = await store.list('Gene', GENE_SCAN_LIMIT);
    const trust = provenance.snapshot();
    const reviewed = review.snapshot();
    const approved = [];
    for (const g of all) {
        if (trust.get(String(g.asset_id))?.trusted === false)
            continue; // hub-untrusted → withhold until promoted
        const reviewRecord = reviewed.get(String(g.asset_id));
        if (reviewRecord !== undefined && reviewRecord.state !== 'approved')
            continue; // quarantined/rejected draft → withhold
        approved.push(g);
        if (approved.length >= maxGenes)
            break;
    }
    return approved;
}