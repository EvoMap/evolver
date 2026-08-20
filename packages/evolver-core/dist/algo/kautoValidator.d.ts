import type { AssetRecord } from '../assetstore/provider.js';
/** Why a coordinate could not be decided. `null` means it was decided. */
export type UndecidableReason = string | null;
export interface CoordinateVerdict {
    decidable: boolean;
    /** The resolved value when decidable, for auditing what the predicate actually accepted. */
    resolved?: string;
    reason: UndecidableReason;
}
export interface KautoVerdict {
    inKauto: boolean;
    coordinates: {
        version: CoordinateVerdict;
        claim: CoordinateVerdict;
        scope: CoordinateVerdict;
        runtime: CoordinateVerdict;
        verifier: CoordinateVerdict;
    };
    /** Coordinate names that failed, most useful for aggregate reporting. */
    blockedBy: string[];
}
export declare function decideVersion(rec: Readonly<Record<string, unknown>>): CoordinateVerdict;
export declare const CLAIM_PREDICATES: readonly ["source_of_truth", "requires_service", "requires_tool", "forbids_action", "output_contract", "ordering_constraint", "environment_precondition"];
export declare function decideClaim(rec: Readonly<Record<string, unknown>>): CoordinateVerdict;
export declare function decideScope(rec: Readonly<Record<string, unknown>>): CoordinateVerdict;
export interface RuntimeRegistry {
    has(id: string): boolean;
}
export declare function decideRuntime(rec: Readonly<Record<string, unknown>>, registry?: RuntimeRegistry): CoordinateVerdict;
export declare function decideVerifier(rec: Readonly<Record<string, unknown>>): CoordinateVerdict;
/**
 * Decide K_auto membership for one record. All five coordinates must be decidable; we evaluate every
 * coordinate rather than short-circuiting, so aggregate reporting can attribute the shortfall.
 */
export declare function decideKauto(record: Readonly<Record<string, unknown>> | AssetRecord, opts?: {
    runtimeRegistry?: RuntimeRegistry;
}): KautoVerdict;
/**
 * The PRESENCE proxy the original production query implemented, kept so the two can be reported side by
 * side and the gap between them quantified rather than asserted.
 */
export declare function decideKautoPresenceProxy(record: Readonly<Record<string, unknown>> | AssetRecord): boolean;
export interface KautoStructuralVerdict {
    /** True when the record STRUCTURALLY carries all five dedicated coordinates in canonical shape (regardless of
     * whether their CONTENT clears the strict decidability bar). */
    structurallyComplete: boolean;
    coordinates: {
        version: boolean;
        claim: boolean;
        scope: boolean;
        runtime: boolean;
        verifier: boolean;
    };
    /** Dedicated-coordinate names the writer did not emit in canonical shape. */
    missing: string[];
}
/**
 * The SECOND track of the dual-track report (user decision: 双轨并报). Where {@link decideKauto} answers "is each
 * coordinate machine-DECIDABLE" (strict, closed-vocabulary bar), this answers the strictly weaker, writer-side
 * question "did the producer EMIT the dedicated coordinate field at all, in its canonical minimal shape". The two
 * are reported side by side so the paper can separate two failure modes that a single number conflates:
 *   - the dedicated field is ABSENT (writer never emitted it) — the 0%-adoption problem this batch attacks; vs
 *   - the dedicated field is PRESENT but its content is not yet strict (e.g. a scope signal that is not namespaced,
 *     a claim predicate outside the closed vocabulary) — a content-quality gap, not an adoption gap.
 * Structural presence NEVER implies decidability; it is deliberately permissive so the adoption-vs-quality gap is
 * visible rather than hidden inside the single strict figure.
 */
export declare function decideKautoStructural(record: Readonly<Record<string, unknown>> | AssetRecord): KautoStructuralVerdict;