/** Bucket the failure falls into. unclassified = default-open (treat as a real evolver bug worth filing).
 *  Bucket string matches V1 byte-for-byte so wire / UI
 *  consumers can branch on the same value regardless of producer. */
export type CycleFailureClass = 'host_no_transcript' | 'host_provider_error' | 'local_gene_no_blast' | 'unclassified';
/** Shape of a recent cycle event the classifier reads. Loose so callers can pass partial DTOs. */
export interface ClassifyRecentEvent {
    gene?: string;
    outcome?: {
        status?: string;
    };
    blast_radius?: {
        files?: number;
        lines?: number;
    };
    blastRadius?: {
        files?: number;
        lines?: number;
    };
    meta?: {
        empty_cycle?: boolean;
    };
}
export interface ClassifyCycleFailureInput {
    /** Cycle signals — used to detect ban_gene:<id> and locality (gene_distilled_/sha256:/gene_auto_). */
    signals?: readonly string[];
    /** Current failed gene in V2's hard-ban/filtering path. */
    geneId?: string;
    /** Current failed capsule blast radius when available. */
    blastRadius?: {
        files?: number;
        lines?: number;
    };
    /** Recent cycle events (failed cycles only matter — blast_radius / meta.empty_cycle are checked). */
    recentEvents?: readonly ClassifyRecentEvent[];
    /** Optional session transcript. Empty / sentinel / provider-error text drives host_* buckets. */
    sessionLog?: string;
}
export interface CycleFailureClassification {
    /** The bucket. */
    failureClass: CycleFailureClass;
    /** Short human reason (≤ ~100 chars). Empty for 'unclassified'. */
    reason: string;
}
/**
 * Triage a cycle failure into a root-cause bucket. Default-open: if no rule fires, returns 'unclassified',
 * which means "treat this as a real evolver bug" (so unclassified faults are never hidden).
 *
 * Pure — does not read filesystem, env, or events store.
 */
export declare function classifyCycleFailure(opts: ClassifyCycleFailureInput | null | undefined): CycleFailureClassification;
/** Buckets we are confident are host-side; everything else is default-open (filed / surfaced). */
export declare const HOST_SUPPRESS_CLASSES: ReadonlySet<CycleFailureClass>;