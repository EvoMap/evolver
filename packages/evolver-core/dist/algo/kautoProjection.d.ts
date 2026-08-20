import type { KautoVerdict } from './kautoValidator.js';
/** The five coordinates of the K_auto projection key. Order is fixed for stable key encoding. */
export declare const PROJECTION_COORDINATES: readonly ["version", "claim", "scope", "runtime", "verifier"];
export type ProjectionCoordinate = (typeof PROJECTION_COORDINATES)[number];
/** The append-only event type a revocation is recorded under on the authoritative root-event stream. */
export declare const PROJECTION_REVOKED_EVENT_TYPE = "governance.projection.revoked";
/** A reinstatement withdraws a prior revocation of the SAME (coordinate, value) pair (reversibility). */
export declare const PROJECTION_REINSTATED_EVENT_TYPE = "governance.projection.reinstated";
export interface ProjectionRevocationPayload {
    /** Which coordinate axis the distrust applies to. */
    coordinate: ProjectionCoordinate;
    /** The resolved coordinate value being distrusted (e.g. a verifier profile id or a runtime name). */
    value: string;
    /** Auditable reason; recorded, never interpreted. */
    reason?: string;
}
/** Minimal shape of a root event this reducer reads. Compatible with events/eventSchema RootEvent. */
export interface ProjectionSourceEvent {
    type: string;
    payload?: unknown;
}
/** Canonical revoked-set key. A revocation is identified by its (coordinate, value) pair, never by asset id. */
export declare function revocationKey(coordinate: ProjectionCoordinate, value: string): string;
/**
 * Reduce the authoritative root-event history to the CURRENT set of revoked (coordinate, value) pairs. Pure and
 * order-preserving: a revocation adds its key; a matching reinstatement removes it; later events win. Recomputing
 * this from the same events yields a byte-identical set (replay invariant), because the root-event stream — not a
 * mutable table — is the single source of truth (mirrors ops/evolutionGraphProjection.ts).
 */
export declare function projectRevocations(events: readonly ProjectionSourceEvent[]): Set<string>;
/**
 * Whether a record's current projection touches any revoked coordinate value. Only records whose five coordinates
 * are all machine-decidable (`verdict.inKauto`) HAVE a projection under T1, so an undecidable record is never
 * governed by projection revocation here (it routes through the deployed advisory/exclusion paths instead) — and
 * this function returns false for it. For a decidable record, revocation is coordinate-LOCAL: it is revoked iff
 * some coordinate's resolved value equals a distrusted (coordinate, value) pair; a sibling that differs on that
 * coordinate is not.
 */
export declare function isProjectionRevoked(verdict: KautoVerdict, revoked: ReadonlySet<string>): boolean;
/** The specific revoked coordinate(s) a record's projection matched — for auditing WHY a projection was dropped. */
export declare function revokedCoordinatesFor(verdict: KautoVerdict, revoked: ReadonlySet<string>): ProjectionCoordinate[];