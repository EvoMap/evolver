// Reuse-before-solve ORCHESTRATION + BILLING + CACHE (#110) — the adapter half of the cost lever.
// Ported from v1 hubSearch.js (the two-phase flow + the two-layer cache). The PURE decision lives in core
// (evolver-core/src/hub/reuseDecision.ts) — this file owns everything core must NOT know about: the paid
// fetch, the economic receipt read-through, and the cache that turns repeat lookups into ZERO hub calls.
//
// Two-phase flow (the #69 lesson: search != fetch — search is free metadata, fetch is the paid content pull):
//   Phase 1 (free):  cap.search(query)            → candidate metadata only
//   Phase 2 (decide): core scoreSearchResults + decideReuse → AT MOST ONE winner
//   Phase 3 (paid):  cap.fetch(winner)            → full payload for the single winner (and only then)
//
// Two-layer cache (ported from v1):
//   - search cache: signal-fingerprint → phase-1 metadata (short TTL). Repeat signal set → ZERO hub calls.
//   - payload cache: assetId → phase-3 payload (content-addressed, long/permanent, bounded LRU). A cached
//     payload → ZERO fetch. Both clocks are injected so TTL/eviction is deterministic and testable.
import { hub } from '@evomap/evolver-core';
const { scoreSearchResults, decideReuse, DEFAULT_MIN_REUSE_SCORE, } = hub;
const GENE_WIRE_KEYS = new Set([
    'type',
    'schema_version',
    'id',
    'category',
    'signals_match',
    'preconditions',
    'strategy',
    'constraints',
    'validation',
    'summary',
    'epigenetic_marks',
    'learning_history',
    'anti_patterns',
    'routing_hint',
    'tool_policy',
    'asset_id',
]);
// ── Cache config (ported from v1 hubSearch.js) ───────────────────────────────
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // metadata is hot but staleable — short TTL
export const SEARCH_CACHE_MAX = 200;
export const PAYLOAD_CACHE_MAX = 100;
export const DEFAULT_REUSE_MODE = 'reference';
/** Reads EVOLVER_MIN_REUSE_SCORE here (env is an ADAPTER concern — core never reads it). */
export function getMinReuseScore(env = process.env) {
    const n = Number(env['EVOLVER_MIN_REUSE_SCORE']);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_REUSE_SCORE;
}
/** Reads EVOLVER_REUSE_MODE here (adapter concern). */
export function getReuseMode(env = process.env) {
    return String(env['EVOLVER_REUSE_MODE'] ?? DEFAULT_REUSE_MODE).toLowerCase() === 'direct' ? 'direct' : 'reference';
}
/** Stable signal fingerprint (ported from v1 _cacheKey: sort + join). */
export function signalFingerprint(signals) {
    return [...signals].map((s) => String(s).trim()).filter(Boolean).sort().join('|');
}
/**
 * The two-layer reuse cache. Bounded + TTL'd, per-process. A search-cache hit means phase 1 makes ZERO hub
 * calls; a payload-cache hit means phase 3 makes ZERO hub calls. The clock is injected for deterministic tests.
 */
export class ReuseCache {
    now;
    searchTtlMs;
    searchMax;
    payloadMax;
    search = new Map();
    payload = new Map();
    constructor(now = () => Date.now(), searchTtlMs = SEARCH_CACHE_TTL_MS, searchMax = SEARCH_CACHE_MAX, payloadMax = PAYLOAD_CACHE_MAX) {
        this.now = now;
        this.searchTtlMs = searchTtlMs;
        this.searchMax = searchMax;
        this.payloadMax = payloadMax;
    }
    getSearch(key) {
        const e = this.search.get(key);
        if (!e)
            return null;
        if (this.now() - e.ts > this.searchTtlMs) {
            this.search.delete(key);
            return null;
        }
        return e.value;
    }
    setSearch(key, value) {
        if (this.search.size >= this.searchMax) {
            const oldest = this.search.keys().next().value;
            if (oldest !== undefined)
                this.search.delete(oldest);
        }
        this.search.set(key, { ts: this.now(), value });
    }
    getPayload(assetId) {
        const asset = this.payload.get(assetId) ?? null;
        if (!asset)
            return null;
        if (assetMatchesId(asset, assetId))
            return asset;
        this.payload.delete(assetId);
        return null;
    }
    setPayload(assetId, payload) {
        if (!assetMatchesId(payload, assetId))
            return;
        if (this.payload.size >= this.payloadMax) {
            const oldest = this.payload.keys().next().value;
            if (oldest !== undefined)
                this.payload.delete(oldest);
        }
        this.payload.set(assetId, payload);
    }
    clear() { this.search.clear(); this.payload.clear(); }
}
// ── metadata mapping (hub wire → core HubMetadata, NO price) ──────────────────
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}
function strArr(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined;
}
function ts(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : undefined;
    }
    return undefined;
}
function stripHubPayloadMetadata(rec) {
    const out = {};
    for (const [key, value] of Object.entries(rec)) {
        if (GENE_WIRE_KEYS.has(key))
            out[key] = value;
    }
    return out;
}
/**
 * Map a hub search row (AssetRecord with arbitrary quality fields) → the core's price-free HubMetadata.
 * Accepts both camelCase and the hub's snake_case (gdi_score / success_rate / reuse_count / ...). Drops any
 * price/credit field by simply not reading it — the core HubMetadata has no slot for cost.
 */
export function toHubMetadata(rec) {
    const r = rec;
    const assetId = String(r['asset_id'] ?? r['assetId'] ?? '');
    const updatedAt = ts(r['updated_at'] ?? r['updatedAt'] ?? r['created_at'] ?? r['createdAt']);
    return {
        assetId,
        ...(strArr(r['signals_match'] ?? r['signalsMatch']) ? { signalsMatch: strArr(r['signals_match'] ?? r['signalsMatch']) } : {}),
        ...(typeof r['category'] === 'string' ? { category: r['category'] } : {}),
        ...(typeof r['summary'] === 'string' ? { summary: r['summary'] } : {}),
        ...(typeof r['status'] === 'string' ? { status: r['status'] } : {}),
        ...(num(r['confidence']) !== undefined ? { confidence: num(r['confidence']) } : {}),
        ...(num(r['success_streak'] ?? r['successStreak']) !== undefined ? { successStreak: num(r['success_streak'] ?? r['successStreak']) } : {}),
        ...(num(r['reputation_score'] ?? r['reputationScore']) !== undefined ? { reputationScore: num(r['reputation_score'] ?? r['reputationScore']) } : {}),
        ...(num(r['gdi_score'] ?? r['gdiScore']) !== undefined ? { gdiScore: num(r['gdi_score'] ?? r['gdiScore']) } : {}),
        ...(num(r['success_rate'] ?? r['successRate']) !== undefined ? { successRate: num(r['success_rate'] ?? r['successRate']) } : {}),
        ...(num(r['reuse_count'] ?? r['reuseCount']) !== undefined ? { reuseCount: num(r['reuse_count'] ?? r['reuseCount']) } : {}),
        ...(num(r['similarity'] ?? r['semanticSimilarity']) !== undefined ? { semanticSimilarity: num(r['similarity'] ?? r['semanticSimilarity']) } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
}
/** Map a fetched hub asset (full payload) → a selection candidate so it competes in candidateAssembly. */
export function toGeneCandidate(rec) {
    const r = rec;
    const assetId = String(r['asset_id'] ?? r['assetId'] ?? '');
    const geneId = typeof r['id'] === 'string' ? r['id'] : assetId;
    const signalsMatch = strArr(r['signals_match'] ?? r['signalsMatch']) ?? [];
    const reuseCount = num(r['reuse_count'] ?? r['reuseCount']) ?? 0;
    return {
        geneId,
        assetId,
        signalsMatch,
        // A freshly-fetched hub gene has no LOCAL learning history yet; selection scores it on signal-match +
        // reuse popularity. The local learning view stays empty (it earns history once it's actually applied).
        view: { geneId, total: 0, success: 0, failed: 0, successRate: 0, avgScore: 0, recentCapsuleIds: [] },
        reuseCount,
        ...(typeof r['category'] === 'string' ? { category: r['category'] } : {}),
        ...(typeof r['summary'] === 'string' ? { summary: r['summary'] } : {}),
        hubAsset: stripHubPayloadMetadata(rec),
    };
}
/**
 * The reuse-before-solve flow. Returns the single winner (already fetched) as a selection candidate, or a
 * solve-fresh verdict. Never throws on a hub error — reuse is an optimization, not a hard dependency:
 * a failed search/fetch degrades to solve-fresh.
 *
 * @param cap   the HubCapability (free search + paid fetch).
 * @param cache the two-layer cache (caller owns it across cycles so it actually warms).
 * @param signals the local problem signals.
 */
export async function reuseBeforeSolve(cap, cache, signals, opts = {}) {
    const mode = opts.mode ?? getReuseMode();
    const threshold = opts.threshold ?? getMinReuseScore();
    const runId = opts.runId ?? null;
    const log = opts.log;
    const signalList = signals.map((s) => String(s).trim()).filter(Boolean);
    if (signalList.length === 0) {
        return { action: 'solve-fresh', mode, zeroHubCalls: true, reason: 'no_signals' };
    }
    // ── Phase 1: free search (signal fingerprint cache → ZERO hub calls on hit) ──
    const key = signalFingerprint(signalList);
    let metadata = cache.getSearch(key);
    const searchCached = metadata !== null;
    if (metadata === null) {
        let rows = [];
        try {
            rows = await cap.search({ signalsAny: signalList, ...(opts.searchLimit ? { limit: opts.searchLimit } : {}) });
        }
        catch (e) {
            log?.append({ run_id: runId, action: 'hub_search_miss', signals: signalList, reason: 'search_error', error: errMsg(e) });
            return { action: 'solve-fresh', mode, zeroHubCalls: false, reason: 'search_error' };
        }
        metadata = rows.map(toHubMetadata).filter((m) => m.assetId.length > 0);
        cache.setSearch(key, metadata);
    }
    if (metadata.length === 0) {
        log?.append({ run_id: runId, action: 'hub_search_miss', signals: signalList, reason: 'no_results', via: searchCached ? 'search_cached' : 'search' });
        return { action: 'solve-fresh', mode, zeroHubCalls: searchCached, reason: 'no_results' };
    }
    // ── Phase 2: PURE decision (core — no price) ──
    const ranked = scoreSearchResults(signalList, metadata, opts.now !== undefined ? { now: opts.now } : {});
    const decision = decideReuse(ranked, { threshold });
    if (decision.action === 'solve-fresh' || !decision.candidate) {
        log?.append({ run_id: runId, action: 'hub_search_miss', signals: signalList, reason: 'below_threshold', candidates: metadata.length, threshold });
        return { action: 'solve-fresh', mode, zeroHubCalls: searchCached, reason: 'below_threshold' };
    }
    // ── Phase 3: paid fetch for the ONE winner (payload cache → ZERO hub calls on hit) ──
    const winner = decision.candidate;
    const winnerId = winner.assetId;
    let asset = cache.getPayload(winnerId);
    let payloadCached = asset !== null;
    let creditCost;
    if (asset === null) {
        try {
            if (isAssetByIdFetcher(cap)) {
                asset = await cap.fetchAssetById(winnerId);
                creditCost = asset?.['credit_cost'];
            }
            else {
                const results = await cap.fetch({ signalsAny: signalList, limit: metadata.length });
                // The paid fetch returns full payloads; select the winner by id (content-addressed match).
                asset = results.find((a) => String(a['asset_id'] ?? '') === winnerId)
                    ?? null;
                // Economic receipt read-through (read-only): surface credit_cost if the hub attached one, never gate.
                const carrier = results.credit_cost
                    ?? asset?.['credit_cost'];
                creditCost = carrier;
            }
        }
        catch (e) {
            log?.append({ run_id: runId, action: 'hub_search_miss', signals: signalList, reason: 'fetch_error', error: errMsg(e) });
            return { action: 'solve-fresh', mode, zeroHubCalls: false, reason: 'fetch_error' };
        }
        if (assetMatchesId(asset, winnerId))
            cache.setPayload(winnerId, asset);
        else
            asset = null;
        payloadCached = false;
    }
    if (!asset) {
        return { action: 'solve-fresh', mode, zeroHubCalls: searchCached, reason: 'fetch_empty' };
    }
    const zeroHubCalls = searchCached && payloadCached;
    log?.append({
        run_id: runId, action: 'hub_search_hit', asset_id: winnerId, score: winner.score, mode,
        signals: signalList, via: zeroHubCalls ? 'cache' : (searchCached ? 'search_cached' : 'search_then_fetch'),
    });
    // Value-ledger emission (#112): a reuse HIT lands a replayable record so the ledger can derive a
    // source=reuse entry anchored on the real assetId + cycleId. fetchTokens is the actual fetch cost — a
    // payload/cache pull rather than a fresh LLM solve, so ≈0 here. Never lets an emission error break reuse.
    if (opts.onReuseHit) {
        try {
            opts.onReuseHit({ assetId: winnerId, cycleId: opts.cycleId ?? '', signalFingerprint: key, fetchTokens: 0 });
        }
        catch { /* emission must never break the reuse path */ }
    }
    return {
        action: 'fetch',
        candidate: toGeneCandidate(asset),
        asset,
        mode,
        score: winner.score,
        receipt: { fromCache: payloadCached, ...(creditCost !== undefined ? { creditCost } : {}) },
        zeroHubCalls,
    };
}
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
function isAssetByIdFetcher(value) {
    return typeof value.fetchAssetById === 'function';
}
export function assetMatchesId(asset, assetId) {
    return Boolean(asset && asset.asset_id === assetId);
}