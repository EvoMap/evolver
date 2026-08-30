// K_auto EvidenceProjection — coordinate-level partial revocation over the five-coordinate key.
//
// WHY THIS EXISTS. The paper's headline abstraction is that an experience asset's validity is a projection
// over five coordinates — (asset version, claim, scope, runtime, verifier) — and that revocation is PARTIAL:
// distrusting one verifier profile quarantines every projection whose verifier coordinate names it, while
// leaving projections that differ on that coordinate (a sibling verifier, or a different runtime/scope)
// untouched. `algo/kautoValidator.ts` decides five-coordinate MEMBERSHIP (is each coordinate machine-decidable),
// but nothing consumed that verdict as a revocable projection: assembly collapsed it to a boolean `kautoMember`
// used only as a soft +λ selection preference (`algo/geneSelection.ts`), and the only real exclusion path
// (`algo/bans.ts`) keys on gene id × signal overlap, not on coordinates. This module realizes the missing
// consumer: an append-only revocation event names a (coordinate, value) pair, and a pure reducer projects the
// current revoked set from the authoritative root-event history so a selection guard can drop exactly the
// records whose projection touches a revoked coordinate value — coordinate-locally, recomputably, reversibly.
//
// DEPLOYMENT BOUNDARY. This is the T1 (specified) projection-revocation mechanism, exercised by a controlled
// experiment and an optional, default-OFF selection guard (`candidateAssembly` `opts.kautoProjection`). It does
// not change the deployed T2 path (signal-scoped gene-level `bannedGenesFromFailures` + soft λ preference), which
// stays byte-for-byte unchanged when the guard is absent.
/** The five coordinates of the K_auto projection key. Order is fixed for stable key encoding. */
export const PROJECTION_COORDINATES = ['version', 'claim', 'scope', 'runtime', 'verifier'];
/** The append-only event type a revocation is recorded under on the authoritative root-event stream. */
export const PROJECTION_REVOKED_EVENT_TYPE = 'governance.projection.revoked';
/** A reinstatement withdraws a prior revocation of the SAME (coordinate, value) pair (reversibility). */
export const PROJECTION_REINSTATED_EVENT_TYPE = 'governance.projection.reinstated';
const isCoordinate = (v) => typeof v === 'string' && PROJECTION_COORDINATES.includes(v);
/** Canonical revoked-set key. A revocation is identified by its (coordinate, value) pair, never by asset id. */
export function revocationKey(coordinate, value) {
    return `${coordinate}:${value}`;
}
function readRevocationPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const p = payload;
    if (!isCoordinate(p['coordinate']))
        return null;
    const value = typeof p['value'] === 'string' ? p['value'].trim() : '';
    if (!value)
        return null;
    const out = { coordinate: p['coordinate'], value };
    if (typeof p['reason'] === 'string')
        out.reason = p['reason'];
    return out;
}
/**
 * Reduce the authoritative root-event history to the CURRENT set of revoked (coordinate, value) pairs. Pure and
 * order-preserving: a revocation adds its key; a matching reinstatement removes it; later events win. Recomputing
 * this from the same events yields a byte-identical set (replay invariant), because the root-event stream — not a
 * mutable table — is the single source of truth (mirrors ops/evolutionGraphProjection.ts).
 */
export function projectRevocations(events) {
    const revoked = new Set();
    for (const evt of events) {
        if (evt.type === PROJECTION_REVOKED_EVENT_TYPE) {
            const p = readRevocationPayload(evt.payload);
            if (p)
                revoked.add(revocationKey(p.coordinate, p.value));
        }
        else if (evt.type === PROJECTION_REINSTATED_EVENT_TYPE) {
            const p = readRevocationPayload(evt.payload);
            if (p)
                revoked.delete(revocationKey(p.coordinate, p.value));
        }
    }
    return revoked;
}
/**
 * Whether a record's current projection touches any revoked coordinate value. Only records whose five coordinates
 * are all machine-decidable (`verdict.inKauto`) HAVE a projection under T1, so an undecidable record is never
 * governed by projection revocation here (it routes through the deployed advisory/exclusion paths instead) — and
 * this function returns false for it. For a decidable record, revocation is coordinate-LOCAL: it is revoked iff
 * some coordinate's resolved value equals a distrusted (coordinate, value) pair; a sibling that differs on that
 * coordinate is not.
 */
export function isProjectionRevoked(verdict, revoked) {
    if (!verdict.inKauto || revoked.size === 0)
        return false;
    for (const coordinate of PROJECTION_COORDINATES) {
        const resolved = verdict.coordinates[coordinate].resolved;
        if (resolved !== undefined && revoked.has(revocationKey(coordinate, resolved)))
            return true;
    }
    return false;
}
/** The specific revoked coordinate(s) a record's projection matched — for auditing WHY a projection was dropped. */
export function revokedCoordinatesFor(verdict, revoked) {
    if (!verdict.inKauto || revoked.size === 0)
        return [];
    const hits = [];
    for (const coordinate of PROJECTION_COORDINATES) {
        const resolved = verdict.coordinates[coordinate].resolved;
        if (resolved !== undefined && revoked.has(revocationKey(coordinate, resolved)))
            hits.push(coordinate);
    }
    return hits;
}