import type { AssetStoreProvider, AssetRecord } from './provider.js';
import { ReviewLedger, type ReviewRecord } from './reviewLedger.js';
import { ProvenanceStore } from './provenance.js';
/**
 * The ReviewLedger CO-LOCATED with a store — its quarantine/approve records live in the SAME dir as the genes.
 * A read site that defaults the ledger independently (e.g. always `assetsDir()`) would, when handed an injected
 * store at a different dir, consult the WRONG ledger and let a draft quarantined beside that store leak.
 * `LocalJsonlProvider.baseDir` is public exactly so callers can co-locate sidecars; any other provider falls back
 * to the live assets dir.
 */
export declare function reviewLedgerForStore(store: AssetStoreProvider): ReviewLedger;
/** The ProvenanceStore CO-LOCATED with a store, symmetric to reviewLedgerForStore. */
export declare function provenanceStoreForStore(store: AssetStoreProvider): ProvenanceStore;
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
export declare function pendingReviewRecords(review: ReviewLedger, excludeAssetIds?: ReadonlySet<string>): ReviewRecord[];
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
export declare function pendingGeneReviewRecords(store: AssetStoreProvider, review: ReviewLedger): Promise<ReviewRecord[]>;
export declare function listApprovedGenes(store: AssetStoreProvider, review: ReviewLedger, maxGenes: number, provenance?: ProvenanceStore): Promise<AssetRecord[]>;