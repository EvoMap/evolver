import type { AssetRecord } from './provider.js';
import type { ProvenanceRecord } from './provenance.js';
import type { ReviewRecord } from './reviewLedger.js';
import { type ReferenceScope } from '../reference/guard.js';
import type { GeneScanSessionV1 } from './geneScanV1.js';
/** Cooperative CPU + asynchronous filesystem budget. No locks, recovery, mkdir or writes.
 * An in-flight OS stat/open/read cannot be preempted by JS. Abort detaches the caller,
 * closes a late-opened descriptor, and prevents any subsequent read/parse/audit work.
 * Each read is <=64 KiB; each JSON.parse is <=256 KiB; scanning yields every 16 KiB.
 */
export interface GeneSnapshotQuery {
    signal?: AbortSignal;
    deadlineAt?: number;
    maxRecords?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
}
export interface GeneReadSnapshot {
    genes: AssetRecord[];
    provenance: ReadonlyMap<string, ProvenanceRecord>;
    review: ReadonlyMap<string, ReviewRecord>;
    referenceScope: ReferenceScope;
    /** Complete deny IDs captured with this snapshot. Required for bounded Union
     * composition: an opaque hasId closure cannot be frozen or enumerated safely. */
    referenceIds?: readonly string[];
}
/** One product invocation may reuse its descriptor-owning process, never its
 * corpus or handles. Different roots keep independent workers; the same root
 * may borrow its process only after confirmed descriptor closes. Each query
 * opens and verifies a fresh reader. Root slots
 * stay admitted between queries and until the process's actual exit; a timed
 * out query poisons this invocation rather than silently starting a new worker. */
export declare function withSnapshotReadInvocation<T>(run: () => Promise<T>): Promise<T>;
export declare function withSnapshotDeadline<T>(query: GeneSnapshotQuery, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
export declare function readLocalSnapshot(baseDir: string, query: GeneSnapshotQuery, capsules: boolean): Promise<GeneReadSnapshot & {
    capsules: AssetRecord[];
    scanned: number;
}>;
/** Validate the complete identity authority BEFORE any filtering or result limits.
 * Content equality alone misses out-of-band reference brands; eligibility alone
 * misses replacement methods under an approved ID. Either conflict makes the
 * source unknown. Never compare the declared ID to the computed digest here:
 * explicitly promoted frozen legacy Genes retain their original network IDs.
 */
export declare function checkedSnapshotAssets(records: readonly AssetRecord[], referenceScope: ReferenceScope, query: GeneSnapshotQuery): Promise<ReadonlyArray<{
    asset: AssetRecord;
    executionEligible: boolean;
}>>;
/** Exported production Gene-only read: never touches Capsules/events, even on a cold pool.
 * Full source scan precedes selection so malformed authority/sidecars cannot become local-default approval.
 */
export declare function readLocalGeneSnapshot(baseDir: string, query?: GeneSnapshotQuery): Promise<GeneReadSnapshot>;
/** Capture admission needs every frozen address, including non-execution-eligible
 * records. Use the same reader and aggregate budgets, not an unbounded provider
 * reload or another independent snapshot which could miss a cross-kind writer. */
export declare function readLocalExperienceSnapshot(baseDir: string, query: GeneSnapshotQuery): Promise<GeneReadSnapshot & {
    identities: AssetRecord[];
}>;
/** A real, single-pass Local/Foreign scan. The reader and root admission remain
 * owned while a page is paused; the next page resumes the same inode/authority
 * view rather than reopening a path or replaying a scan. */
export declare function beginLocalGeneScanV1(baseDir: string, query?: GeneSnapshotQuery): GeneScanSessionV1;