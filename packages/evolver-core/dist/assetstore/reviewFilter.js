import { LocalJsonlProvider } from './localJsonl.js';
import { ReviewLedger } from './reviewLedger.js';
import { ProvenanceStore } from './provenance.js';
import { assetsDir } from '../events/paths.js';
import { withContextRead } from './contextRead.js';
import { assessSourceEligibility } from './sourceQualification.js';
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
export async function listApprovedGenes(store, review, maxGenes, provenance = provenanceStoreForStore(store), options = {}) {
    // Capture the caller's read boundary before dispatch; legacy calls without a
    // boundary retain their existing concurrency and numeric-limit semantics.
    options = { ...options };
    checkSelectionActive(options);
    validateGeneLimit(maxGenes);
    const all = options.signal !== undefined || options.deadlineAt !== undefined
        ? await listBeforeSelectionBoundary(store, options)
        : await store.list('Gene', GENE_SCAN_LIMIT);
    checkSelectionActive(options);
    const trust = provenance.snapshot();
    checkSelectionActive(options);
    const reviewed = review.snapshot();
    checkSelectionActive(options);
    return approvedGeneRecords({ genes: all, provenance: trust, review: reviewed }, maxGenes, options);
}
/** Stop waiting without relinquishing an unfinished legacy provider operation.
 * A legacy list cannot be forcibly cancelled; withContextRead keeps its slot
 * until the actual read settles, including a late rejection after this race. */
async function listBeforeSelectionBoundary(store, options) {
    const { signal, deadlineAt } = options;
    let timer;
    let onAbort;
    try {
        return await Promise.race([
            Promise.resolve().then(() => {
                checkSelectionActive(options);
                return withContextRead(store, () => store.list('Gene', GENE_SCAN_LIMIT));
            }),
            new Promise((_, reject) => {
                onAbort = () => reject(new Error('source_selection_aborted'));
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted)
                    onAbort();
                if (deadlineAt !== undefined) {
                    const checkDeadline = () => {
                        const remaining = deadlineAt - Date.now();
                        if (remaining <= 0)
                            onAbort();
                        else
                            timer = setTimeout(checkDeadline, Math.min(remaining, 0x7fffffff));
                    };
                    checkDeadline();
                }
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (onAbort)
            signal?.removeEventListener('abort', onAbort);
    }
}
function checkSelectionActive(options) {
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) {
        throw new Error('invalid_source_selection_deadline');
    }
    if (options.signal?.aborted || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) {
        throw new Error('source_selection_aborted');
    }
}
function validateGeneLimit(maxGenes) {
    // Preserve the existing legacy fractional limit (the first integer count >=
    // the limit), while zero cannot admit a record and non-finite limits are invalid.
    if (!Number.isFinite(maxGenes) || maxGenes < 0)
        throw new Error('invalid_gene_limit');
}
/** Same trust/review/source gate for the asynchronous read-only snapshot path. */
export function approvedGenesFromSnapshot(snapshot, maxGenes, options = {}, scanLimit = GENE_SCAN_LIMIT) {
    checkSelectionActive(options);
    validateGeneLimit(maxGenes);
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 0 || scanLimit > 100_000)
        throw new Error('invalid_gene_scan_limit');
    if (maxGenes === 0) {
        if (options.benchmark)
            options.onQualification?.([]);
        return [];
    }
    return approvedGeneRecords({ ...snapshot, genes: snapshot.genes.slice(0, scanLimit) }, maxGenes, options);
}
function approvedGeneRecords(snapshot, maxGenes, options) {
    const all = snapshot.genes;
    const trust = snapshot.provenance;
    const reviewed = snapshot.review;
    const approved = [];
    const receipts = [];
    for (const g of all) {
        checkSelectionActive(options);
        if (trust.get(String(g.asset_id))?.trusted === false)
            continue; // hub-untrusted → withhold until promoted
        const reviewRecord = reviewed.get(String(g.asset_id));
        if (reviewRecord !== undefined && reviewRecord.state !== 'approved')
            continue; // quarantined/rejected draft → withhold
        if (options.benchmark) {
            const decision = assessSourceEligibility(g, trust.get(g.asset_id), options.benchmark);
            if (!decision.allowed)
                continue;
            receipts.push({ ...decision, assetId: g.asset_id, benchmarkId: options.benchmark.benchmarkId });
        }
        approved.push(g);
        if (approved.length >= maxGenes)
            break;
    }
    checkSelectionActive(options);
    if (options.benchmark)
        options.onQualification?.(receipts);
    return approved;
}