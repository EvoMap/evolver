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
import { createHash } from 'node:crypto';
import { hub, algo, signals as signalNs, wire } from '@evomap/evolver-core';
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
    'generation_meta',
    'asset_id',
]);
const HUB_DELIVERY_METADATA_KEYS = new Set([
    'status',
    'success_streak',
    'reputation_score',
    'gdi_score',
    'gdi_score_mean',
    'success_rate',
    'reuse_count',
    'ranking_score',
    'credit_cost',
    'source_node_id',
    'fetched_at',
    'receipt',
    'hub_receipt',
    'already_purchased',
    '_semantic_similarity',
    'semantic_similarity',
    'similarity',
    'semanticSimilarity',
    '_search_score',
    'search_score',
    'payload_backfill_reason',
    'asset_type',
    'bundle_id',
    'callable',
    'payload_ready',
    'bundle_capsule',
    'bundle_events',
]);
// ── Cache config (ported from v1 hubSearch.js) ───────────────────────────────
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // metadata is hot but staleable — short TTL
export const SEARCH_CACHE_MAX = 200;
export const PAYLOAD_CACHE_MAX = 100;
export const SEMANTIC_SEARCH_LIMIT = 10;
export const SEMANTIC_QUERY_MAX_TERMS = 12;
export const SEMANTIC_QUERY_MAX_CHARS = 512;
// Namespace filtering removes obviously private signal classes. The term allowlist below is still mandatory:
// even a public namespace can contain an arbitrary user-controlled value that must not enter a logged GET URL.
const PUBLIC_SEMANTIC_NAMESPACES = new Set(['area', 'cap', 'capability_gap', 'risk']);
const PUBLIC_SEMANTIC_TERMS = new Set([
    '401', '403', '404', '409', '429', '500', '502', '503', '504',
    'auth', 'cache', 'capability_gap', 'code_review', 'concurrency', 'database', 'debugging', 'go',
    'javascript', 'latency', 'memory', 'network', 'performance', 'python',
    'rate_limit', 'reliability', 'retry', 'rust', 'security', 'testing', 'timeout',
    'typescript',
]);
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
/** V1-compatible kill-switch. Semantic recall is on unless explicitly disabled. */
export function isSemanticSearchEnabled(env = process.env) {
    const value = String(env['HUBSEARCH_SEMANTIC'] ?? '').trim().toLowerCase();
    return value !== '0' && value !== 'false';
}
/**
 * Derive a bounded public semantic query from structured signal tags. Error signatures, paths, prose, and other
 * unstructured values are excluded so the vector-search leg cannot become a side channel for local diagnostics.
 */
export function buildSemanticQuery(signals) {
    const terms = [];
    const seen = new Set();
    for (const raw of signals) {
        const signal = String(raw).trim();
        const lower = signal.toLowerCase();
        if (!signal || lower.startsWith('errsig:') || lower.startsWith('errsig_norm:') || lower.startsWith('recurring_errsig'))
            continue;
        const colon = signal.indexOf(':');
        if (colon > 0 && !PUBLIC_SEMANTIC_NAMESPACES.has(lower.slice(0, colon)))
            continue;
        const candidate = (colon > 0 && colon < 30 ? signal.slice(colon + 1) : signal).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate)
            // Signals are user-controlled. Only a fixed public taxonomy may enter the GET query because URLs are
            // commonly retained by Hub and reverse-proxy access logs. Unknown terms remain in the structured POST leg.
            || !PUBLIC_SEMANTIC_TERMS.has(candidate)
            || seen.has(candidate))
            continue;
        const nextLength = terms.length === 0 ? candidate.length : terms.join(' ').length + 1 + candidate.length;
        if (nextLength > SEMANTIC_QUERY_MAX_CHARS)
            break;
        seen.add(candidate);
        terms.push(candidate);
        if (terms.length >= SEMANTIC_QUERY_MAX_TERMS)
            break;
    }
    return terms.join(' ');
}
/** Stable signal fingerprint (ported from v1 _cacheKey: sort + join). */
export function signalFingerprint(signals) {
    return [...signals].map((s) => String(s).trim()).filter(Boolean).sort().join('|');
}
export const TASK_DOMAIN_SIGNAL_PREFIX = signalNs.TASK_DOMAIN_SIGNAL_PREFIX;
/**
 * evolver domain slug → hub domain taxonomy (evomap-hub domainDetectionService VALID_DOMAINS).
 * Only mapped slugs may ride the wire: the hub validates against its own taxonomy and silently
 * ignores unknown values (fail-open), so an unmapped slug would just waste the fence. Slugs the
 * hub has no counterpart for (pdf/mail/calendar) intentionally map to nothing.
 */
const HUB_DOMAIN_BY_SLUG = {
    coding: 'software_engineering',
    sql: 'software_engineering',
    pptx: 'content_creation',
    docx: 'content_creation',
    xlsx: 'data_analysis',
    marketing: 'marketing',
};
/**
 * Resolve the hub-side domain fence from this turn's signals. Exactly one domain is used and only
 * when the turn is unambiguous: with two or more distinct task_domain:* signals the turn spans
 * domains, and scoping recall to either one would hide the other's assets — so we return null and
 * fall back to unscoped recall (today's behaviour).
 */
export function hubDomainFromSignals(signals) {
    const resolution = signalNs.resolveTaskDomainSignals(signals);
    return resolution.status === 'resolved'
        ? HUB_DOMAIN_BY_SLUG[resolution.slug] ?? null
        : null;
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
        this.search.delete(key);
        this.search.set(key, e);
        return e.value;
    }
    setSearch(key, value) {
        const exists = this.search.delete(key);
        if (!exists && this.search.size >= this.searchMax) {
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
        if (assetMatchesId(asset, assetId)) {
            this.payload.delete(assetId);
            this.payload.set(assetId, asset);
            return asset;
        }
        this.payload.delete(assetId);
        return null;
    }
    setPayload(assetId, payload) {
        if (!assetMatchesId(payload, assetId))
            return;
        const exists = this.payload.delete(assetId);
        if (!exists && this.payload.size >= this.payloadMax) {
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
function stripHubDeliveryMetadataForIntegrity(rec) {
    const out = { ...rec };
    for (const key of HUB_DELIVERY_METADATA_KEYS)
        delete out[key];
    // Hub ranking confidence is metadata for Genes, while Capsule.confidence is canonical content.
    if (out['type'] === 'Gene')
        delete out['confidence'];
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
        ...(num(r['similarity'] ?? r['semantic_similarity'] ?? r['_semantic_similarity'] ?? r['semanticSimilarity']) !== undefined
            ? { semanticSimilarity: num(r['similarity'] ?? r['semantic_similarity'] ?? r['_semantic_similarity'] ?? r['semanticSimilarity']) }
            : {}),
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
    const generationSource = algo.geneGenerationSource(r, geneId);
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
        ...(generationSource ? { generationSource } : {}),
        hubAsset: stripHubPayloadMetadata(rec),
    };
}
/**
 * Run the complete free-search phase shared by reuse and economic miss probes. This function never performs the
 * paid fetch. Only complete dual-leg results enter the cache, so a partial outage cannot become a verified miss.
 */
export async function searchHubMetadata(cap, cache, signals, opts = {}) {
    const signalList = signals.map((signal) => String(signal).trim()).filter(Boolean);
    const fingerprint = signalFingerprint(signalList);
    if (signalList.length === 0) {
        return { signals: signalList, fingerprint, metadata: [], searchCached: false, complete: true };
    }
    const env = opts.env ?? process.env;
    const semanticQuery = isSemanticSearchEnabled(env) ? buildSemanticQuery(signalList) : '';
    const semanticActive = semanticQuery.length >= 3;
    const semanticQueryDigest = semanticActive
        ? createHash('sha256').update(semanticQuery).digest('hex')
        : undefined;
    // Domain fence: derived from the turn's own task_domain:* signals (never from prose), mapped to
    // the hub taxonomy. Scopes the structured signal leg only — the semantic leg already carries its
    // own allowlisted free-text and stays domain-agnostic as the discovery fallback.
    const hubDomain = hubDomainFromSignals(signals);
    const signalSearchLimit = opts.searchLimit ? opts.searchLimit : undefined;
    const limitKey = signalSearchLimit === undefined ? 'all' : String(signalSearchLimit);
    const domainKey = hubDomain === null ? '' : `:domain:${hubDomain}`;
    const key = semanticQueryDigest
        ? `semantic:${fingerprint}:${semanticQueryDigest}:limit:${limitKey}${domainKey}`
        : `signals:${fingerprint}:limit:${limitKey}${domainKey}`;
    const cached = cache.getSearch(key);
    if (cached !== null) {
        return { signals: signalList, fingerprint, metadata: cached, searchCached: true, complete: true };
    }
    // Enter a promise boundary before invoking an injected provider: interface implementations can still throw
    // synchronously even though their declared return type is Promise, and reuse must remain best-effort.
    const signalSearch = Promise.resolve().then(() => cap.search({
        signalsAny: signalList,
        ...(hubDomain !== null ? { domain: hubDomain } : {}),
        ...(signalSearchLimit ? { limit: signalSearchLimit } : {}),
    }));
    const semanticSearch = semanticActive
        ? Promise.resolve().then(() => cap.search({ text: semanticQuery, kind: 'Gene', limit: SEMANTIC_SEARCH_LIMIT }))
        : Promise.resolve([]);
    const [signalResult, semanticResult] = await Promise.allSettled([signalSearch, semanticSearch]);
    const signalRows = signalResult.status === 'fulfilled' ? signalResult.value : [];
    const semanticRows = semanticResult.status === 'fulfilled' ? semanticResult.value : [];
    const failedSearch = signalResult.status === 'rejected'
        ? signalResult
        : semanticResult.status === 'rejected'
            ? semanticResult
            : undefined;
    const metadata = mergeSearchRows(signalRows, semanticRows)
        .map(toHubMetadata)
        .filter((candidate) => candidate.assetId.length > 0);
    if (!failedSearch)
        cache.setSearch(key, metadata);
    return {
        signals: signalList,
        fingerprint,
        metadata,
        searchCached: false,
        complete: failedSearch === undefined,
        ...(failedSearch ? { error: failedSearch.reason } : {}),
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
    const env = opts.env ?? process.env;
    const mode = opts.mode ?? getReuseMode(env);
    const threshold = opts.threshold ?? getMinReuseScore(env);
    const runId = opts.runId ?? null;
    const log = opts.log;
    const searchResult = await searchHubMetadata(cap, cache, signals, {
        env,
        ...(opts.searchLimit ? { searchLimit: opts.searchLimit } : {}),
    });
    const { signals: signalList, fingerprint, metadata, searchCached, complete: searchComplete, error: searchFailure, } = searchResult;
    if (signalList.length === 0) {
        return { action: 'solve-fresh', mode, zeroHubCalls: true, reason: 'no_signals' };
    }
    // ── Phase 1: free search (signal fingerprint cache → ZERO hub calls on hit) ──
    const searchIncomplete = !searchComplete;
    if (searchIncomplete && metadata.length === 0) {
        log?.append({
            run_id: runId,
            action: 'hub_search_miss',
            signals: signalList,
            reason: 'search_error',
            error: errMsg(searchFailure),
        });
        return { action: 'solve-fresh', mode, zeroHubCalls: false, reason: 'search_error' };
    }
    if (metadata.length === 0) {
        const reason = searchIncomplete ? 'search_error' : 'no_results';
        log?.append({
            run_id: runId,
            action: 'hub_search_miss',
            signals: signalList,
            reason,
            via: searchCached ? 'search_cached' : 'search',
            ...(searchIncomplete ? { error: errMsg(searchFailure) } : {}),
        });
        return { action: 'solve-fresh', mode, zeroHubCalls: searchCached, reason };
    }
    // ── Phase 2: PURE decision (core — no price) ──
    const ranked = scoreSearchResults(signalList, metadata, opts.now !== undefined ? { now: opts.now } : {});
    const decision = decideReuse(ranked, { threshold });
    if (decision.action === 'solve-fresh' || !decision.candidate) {
        const reason = searchIncomplete ? 'search_error' : 'below_threshold';
        log?.append({
            run_id: runId,
            action: 'hub_search_miss',
            signals: signalList,
            reason,
            candidates: metadata.length,
            threshold,
            ...(searchIncomplete ? { error: errMsg(searchFailure) } : {}),
        });
        return { action: 'solve-fresh', mode, zeroHubCalls: searchCached, reason };
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
                asset = normalizeMatchedAssetId(await cap.fetchAssetById(winnerId), winnerId);
                creditCost = asset?.['credit_cost'];
            }
            else {
                const results = await cap.fetch({ signalsAny: signalList, limit: metadata.length });
                // The paid fetch returns full payloads; select the winner by id (content-addressed match).
                const fetched = results.find((candidate) => assetMatchesId(candidate, winnerId));
                asset = normalizeMatchedAssetId(fetched, winnerId);
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
        return { action: 'solve-fresh', mode, zeroHubCalls: false, reason: 'fetch_empty' };
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
            opts.onReuseHit({ assetId: winnerId, cycleId: opts.cycleId ?? '', signalFingerprint: fingerprint, fetchTokens: 0 });
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
function mergeSearchRows(signalRows, semanticRows) {
    const merged = [];
    const indexById = new Map();
    for (const row of signalRows) {
        const record = row;
        const assetId = String(record['asset_id'] ?? record['assetId'] ?? '');
        if (!assetId || indexById.has(assetId))
            continue;
        indexById.set(assetId, merged.length);
        merged.push(row);
    }
    for (const row of semanticRows) {
        const record = row;
        const assetId = String(record['asset_id'] ?? record['assetId'] ?? '');
        if (!assetId)
            continue;
        const existingIndex = indexById.get(assetId);
        if (existingIndex === undefined) {
            indexById.set(assetId, merged.length);
            merged.push(row);
            continue;
        }
        const similarity = num(record['similarity'] ?? record['semantic_similarity'] ?? record['_semantic_similarity'] ?? record['semanticSimilarity']);
        if (similarity !== undefined) {
            merged[existingIndex] = { ...merged[existingIndex], similarity };
        }
    }
    return merged;
}
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
function isAssetByIdFetcher(value) {
    return typeof value.fetchAssetById === 'function';
}
function normalizeMatchedAssetId(asset, assetId) {
    if (!assetMatchesId(asset, assetId))
        return null;
    const record = asset;
    if (typeof record['asset_id'] === 'string')
        return asset;
    const normalized = { ...record, asset_id: assetId };
    if (record['assetId'] === assetId)
        delete normalized['assetId'];
    if (record['id'] === assetId)
        delete normalized['id'];
    return normalized;
}
export function assetMatchesId(asset, assetId) {
    if (!asset)
        return false;
    const record = asset;
    const canonicalAssetId = typeof record['asset_id'] === 'string' ? record['asset_id'] : undefined;
    if (canonicalAssetId !== undefined && canonicalAssetId !== assetId)
        return false;
    const hasCamelAlias = typeof record['assetId'] === 'string';
    if (canonicalAssetId === undefined && hasCamelAlias && record['assetId'] !== assetId)
        return false;
    if (canonicalAssetId === undefined && !hasCamelAlias && record['id'] !== assetId)
        return false;
    const content = { ...record };
    if (record['assetId'] === assetId)
        delete content['assetId'];
    if (record['id'] === assetId)
        delete content['id'];
    try {
        if (assetId.startsWith('sha256:') && !/^sha256:[0-9a-f]{64}$/.test(assetId))
            return false;
        const contentMatches = wire.computeAssetId(stripHubDeliveryMetadataForIntegrity(content)) === assetId;
        return assetId.startsWith('sha256:') ? contentMatches : canonicalAssetId !== undefined || contentMatches;
    }
    catch {
        return false;
    }
}