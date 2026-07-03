// Preferred-gene confidence edges (positive cross-cycle learning, ported from v1 src/gep/memoryGraph.js,
// adapted to v2's derive-from-events model). The negative side (ban / epigenetic penalty) is already ported;
// this is the missing POSITIVE half: a gene that keeps succeeding under a given signal fingerprint should be
// nudged UP in ranking for that fingerprint — without ever resurrecting a gene that a hard gate excluded.
//
// Sidecar principle (same as epigenetics.ts): edges are DERIVED from the append-only root_events log at
// selection time. We never mutate an asset, never add an asset field, never persist a separate store — so
// asset_id stays stable and the edges can be replayed byte-for-byte from the events alone.
//
// Edge key: (signalFingerprint, geneId). Edge value: { successCount, failCount, inertCount, lastAt, confidence },
// where confidence is a Laplace-smoothed, half-life-decayed expected success rate in [0, 1] (port of v1
// edgeExpectedSuccess). The fingerprint is a stable, deterministic digest of the signal set (port of v1
// computeSignalKey): sorted, de-duplicated, normalized — so the same signals always map to the same edge.
//
// This file also carries the negative #195 half of the same scoring data: an `inert` (zero-work) outcome
// builds no confidence (tallied apart as inertCount), and `inertBannedGeneIds` bans a gene stuck producing only
// inert cycles on a signal — so a sole-matching do-nothing gene can no longer dominate `--loop` selection.
//
// Purity: no Date.now(), no Math.random(). Time enters only through event timestamps and an injected `now`.
import { createHash } from 'node:crypto';
/** Default half-life for confidence decay (days). Aligned with v1 edgeExpectedSuccess half_life_days=30. */
export const CONFIDENCE_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Composite map key for an edge: `<fingerprint>::<geneId>`. The fingerprint is fixed-length hex (no `:`), so
 * `::` is an unambiguous separator. Exported so callers/tests look edges up the same way they are stored,
 * instead of hand-building the key string.
 */
export function confidenceEdgeKey(signalFingerprint, geneId) {
    return `${signalFingerprint}::${geneId}`;
}
/**
 * Stable signal fingerprint (port of v1 computeSignalKey): normalize → de-duplicate → sort → digest.
 * Deterministic and order-independent, so the same signal SET always yields the same fingerprint.
 * An empty set maps to a fixed sentinel digest so "no signals" is still a well-defined edge key.
 */
export function signalFingerprint(signals) {
    const norm = (Array.isArray(signals) ? signals : [])
        .map((s) => String(s ?? '').trim())
        .filter((s) => s.length > 0);
    const uniqSorted = Array.from(new Set(norm)).sort();
    const canonical = uniqSorted.length > 0 ? uniqSorted.join('|') : '(none)';
    // Short, collision-resistant, deterministic. 16 hex chars (64 bits) is ample for an edge key.
    return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}
/**
 * Laplace-smoothed expected success rate (port of v1 edgeExpectedSuccess, smoothing only — decay is separate).
 * p = (success + 1) / (success + fail + 2). With zero evidence this is 0.5 (a neutral prior), not 0 or 1.
 */
function laplaceSuccessRate(success, fail) {
    const total = success + fail;
    return (success + 1) / (total + 2);
}
/**
 * Half-life decay weight in (0,1] (port of v1 decayWeight): 0.5^(ageDays / halfLife).
 * Age is measured from the edge's lastAt to `now`. Future/zero/negative age → no decay (weight 1).
 */
export function decayWeight(lastAt, now, halfLifeDays = CONFIDENCE_HALF_LIFE_DAYS) {
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0)
        return 1;
    if (!Number.isFinite(lastAt) || !Number.isFinite(now))
        return 1;
    const ageDays = (now - lastAt) / MS_PER_DAY;
    if (!Number.isFinite(ageDays) || ageDays <= 0)
        return 1;
    return Math.pow(0.5, ageDays / halfLifeDays);
}
/**
 * Derive confidence edges from a flat list of per-(fingerprint, gene) outcome observations.
 * Pure and deterministic: the same observations (in any order — we track the max `at` for lastAt) always
 * produce the same edges. This is the replay primitive — feed it the observations re-extracted from
 * root_events and you get byte-identical edges back.
 */
export function deriveConfidenceEdges(observations) {
    const map = new Map();
    for (const o of observations) {
        if (!o || !o.geneId || !o.signalFingerprint)
            continue;
        if (o.status !== 'success' && o.status !== 'failed' && o.status !== 'inert')
            continue;
        const k = confidenceEdgeKey(o.signalFingerprint, o.geneId);
        const cur = map.get(k) ?? {
            signalFingerprint: o.signalFingerprint,
            geneId: o.geneId,
            successCount: 0,
            failCount: 0,
            inertCount: 0,
            lastAt: 0,
            baseConfidence: 0,
        };
        // #195: inert (zero-work) outcomes are tallied apart — they must NOT raise success/fail counts, so they
        // build no positive confidence. They still advance lastAt (the gene WAS exercised; freshness is real).
        if (o.status === 'success')
            cur.successCount += 1;
        else if (o.status === 'failed')
            cur.failCount += 1;
        else
            cur.inertCount += 1;
        const at = Number.isFinite(o.at) ? o.at : 0;
        if (at > cur.lastAt)
            cur.lastAt = at;
        map.set(k, cur);
    }
    // Finalize baseConfidence once counts are known. Inert outcomes are excluded from the smoothing inputs, so an
    // all-inert edge has success=0/fail=0 → the neutral 0.5 prior (no climb toward 1.0). Order-independent: the
    // result is a pure function of the observation SET (counts + max `at`), never their sequence.
    for (const edge of map.values()) {
        edge.baseConfidence = laplaceSuccessRate(edge.successCount, edge.failCount);
    }
    return map;
}
/**
 * Query the confidence of `geneId` under `signalFingerprint` at time `now`, in [0,1].
 * = baseConfidence (Laplace-smoothed success rate) × half-life decay weight.
 * Returns 0 when there is no edge (no history) so a never-tried gene gets no positive nudge —
 * absence of evidence is not evidence of success — and 0 for a purely-inert edge (only zero-work cycles),
 * so a do-nothing gene gets the same zero nudge as a never-tried one (#195).
 */
export function confidenceFor(edges, signalFingerprint, geneId, now, halfLifeDays = CONFIDENCE_HALF_LIFE_DAYS) {
    const edge = edges.get(confidenceEdgeKey(signalFingerprint, geneId));
    if (!edge)
        return 0;
    // #195: a purely-inert edge (only zero-work cycles — no real success or failure) carries no positive evidence,
    // so it must give the SAME zero nudge as a never-tried gene, not the neutral-prior 0.5 (which would leak a
    // +CONFIDENCE_WEIGHT×0.5 boost and let a do-nothing gene out-rank an equal-health fresh candidate before the
    // inert ban trips). Mirrors v1's hasPositiveEvidence (success>0) gate. A fail-only edge keeps its small Laplace
    // nudge unchanged — that is pre-existing v2 behavior, out of #195's scope.
    if (edge.successCount === 0 && edge.failCount === 0)
        return 0;
    const w = decayWeight(edge.lastAt, now, halfLifeDays);
    const c = edge.baseConfidence * w;
    return c < 0 ? 0 : c > 1 ? 1 : c;
}
/**
 * Consecutive inert (zero-work) outcomes on a (fingerprint, gene) edge after which a gene with NO real success
 * on that signal is banned, so `--loop` selection explores instead of re-running a do-nothing gene (#195).
 * Port of v1 `GENE_INERT_BAN_STREAK` (env `EVOLVER_GENE_INERT_BAN_STREAK`, default 8); kept an inline const to
 * match v2's algo-tunable convention (BAN_THRESHOLD / MIN_ENV_ATTEMPTS), not env-driven.
 */
export const GENE_INERT_BAN_STREAK = 8;
/**
 * Observation window (in raw events) over which the inert ban is derived — deliberately MUCH wider than the
 * small recency window used for confidence SCORING. A banned gene runs as `ad-hoc` and accrues no new
 * observation for itself, so its trailing inert run must be recomputed from a history wide enough that
 * intervening innovate/ad-hoc cycles cannot evict it — and cannot evict an earlier real success that exempts
 * the gene (`successCount > 0`). With a small window the run/exemption age out purely from unrelated cycles, so
 * the ban flaps: the do-nothing gene resurfaces and the productive gene gets falsely banned (#195 regression).
 * ~14000 events ≈ 2000 cycles, mirroring v1's multi-hundred-cycle memory-graph read horizon: far past any
 * realistic flap window, yet still bounded (a long-idle gene's stale success eventually ages out, matching v1).
 * `EventStore.tail()` reads the entire log regardless of window size, so a larger window costs no extra I/O.
 */
export const INERT_BAN_OBSERVATION_WINDOW = 14_000;
/**
 * Trailing consecutive-inert run per (fingerprint, gene), keyed by `confidenceEdgeKey`. Unlike
 * `deriveConfidenceEdges` (a pure function of the observation SET), this is deliberately order-DEPENDENT: it
 * counts inert outcomes from the most recent backward and ANY real success/failure resets the run to 0 — so a
 * gene that ever does real work is never punished for older idle cycles. Input MUST be chronological
 * (oldest→newest, i.e. the order `ingestor.tail` yields); the trailing run is the value left after the final
 * observation per edge.
 */
export function trailingInertByEdge(observations) {
    const run = new Map();
    for (const o of observations) {
        if (!o || !o.geneId || !o.signalFingerprint)
            continue;
        const k = confidenceEdgeKey(o.signalFingerprint, o.geneId);
        if (o.status === 'inert')
            run.set(k, (run.get(k) ?? 0) + 1);
        else if (o.status === 'success' || o.status === 'failed')
            run.set(k, 0); // any real outcome breaks the run
    }
    return run;
}
/**
 * Gene ids to ban for the CURRENT signal fingerprint because they are stuck producing inert (zero-work)
 * cycles (#195). A gene is banned iff, on this fingerprint's edge, its trailing inert run ≥ `streak` AND it has
 * ZERO real success on this signal (double guard: the consecutive run is reset by any real outcome, and a gene
 * that ever truly succeeded here keeps successCount > 0). Banning a sole-matching inert gene lets selection
 * fall through to mutation (selected:null → fresh gene), restoring diversity — the failure-streak ban never
 * fires on these because nothing "fails". Per-signal, mirroring v1's per-signal-key ban: a gene idle on THIS
 * signal can still be tried on others.
 */
export function inertBannedGeneIds(edges, observations, fingerprint, streak = GENE_INERT_BAN_STREAK) {
    const trailing = trailingInertByEdge(observations);
    const banned = new Set();
    for (const edge of edges.values()) {
        if (edge.signalFingerprint !== fingerprint)
            continue;
        if (edge.successCount > 0)
            continue; // ever did real work here → never banned for idle cycles
        const k = confidenceEdgeKey(fingerprint, edge.geneId);
        if ((trailing.get(k) ?? 0) >= streak)
            banned.add(edge.geneId);
    }
    return banned;
}