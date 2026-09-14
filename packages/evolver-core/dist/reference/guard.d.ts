/** Logical identifiers are meaningful only inside their owning home/connection. */
export interface ReferenceScope {
    hasId(id: string): boolean;
}
/** Carries scope through promises without a mutable process-wide current store. */
export declare function withReferenceScope<T>(scope: ReferenceScope | undefined, fn: () => T): T;
/** Connection-local fence for non-persisted remote results. Never evict a known ID into eligibility. */
export declare class ReferenceSessionScope implements ReferenceScope {
    private readonly ids;
    remember(ids: readonly string[]): void;
    hasId(id: string): boolean;
}
/** Out-of-band object provenance: no asset fields, JSON or content hashes are changed. */
export declare function brandReferenceObject<T extends object>(value: T): T;
/** Explicit evidence modes never enter procedural paths. Legacy source_type is unrelated. */
export declare function hasEvidenceMode(value: unknown): boolean;
export declare function isKnownReferenceId(id: unknown, scope?: ReferenceScope | undefined): boolean;
export declare function isExecutionEligible(value: unknown, scope?: ReferenceScope | undefined): boolean;
export declare function assertExecutionEligible(value: unknown, scope?: ReferenceScope | undefined): void;