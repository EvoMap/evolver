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
export async function listApprovedGenes(store, review, maxGenes, provenance = provenanceStoreForStore(store)) {
    const all = await store.list('Gene', GENE_SCAN_LIMIT);
    const approved = [];
    for (const g of all) {
        if (!provenance.isTrusted(String(g.asset_id)))
            continue; // hub-untrusted → withhold until promoted
        if (!review.isApproved(String(g.asset_id)))
            continue; // quarantined/rejected draft → withhold
        approved.push(g);
        if (approved.length >= maxGenes)
            break;
    }
    return approved;
}