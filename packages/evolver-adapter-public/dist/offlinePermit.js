import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { util } from '@evomap/evolver-core';
import { AuthError, globalFetchLike, HubClientError, HubFetch } from './hubFetch.js';
export const DEFAULT_MAX_OFFLINE_SOLIDIFIES = 10;
export const DEFAULT_MAX_OFFLINE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_CLOCK_DRIFT_MS = 24 * 60 * 60 * 1000;
const OFFLINE_TOKEN_FILE = '.ot';
const LAST_VERIFY_FILE = '.lv';
const LOCK_SUFFIX = '.lock';
const ERROR_DETAIL_MAX_CHARS = 200;
const DEFAULT_OFFLINE_PERMIT_LOCK = { maxTries: 5, waitMs: 1 };
/**
 * HMAC-backed local offline permit counter.
 *
 * This ports v1 PR #157's concurrency fix into v2: the full
 * load -> cap-check -> increment -> write pipeline is serialized with the
 * shared PID-liveness file lock, so daemon and CLI processes cannot both
 * consume the same local offline quota slot.
 */
export class OfflinePermitStore {
    opts;
    now;
    maxOfflineSolidifies;
    maxOfflineDurationMs;
    maxClockDriftMs;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? (() => Date.now());
        this.maxOfflineSolidifies = opts.maxOfflineSolidifies ?? DEFAULT_MAX_OFFLINE_SOLIDIFIES;
        this.maxOfflineDurationMs = opts.maxOfflineDurationMs ?? DEFAULT_MAX_OFFLINE_DURATION_MS;
        this.maxClockDriftMs = opts.maxClockDriftMs ?? DEFAULT_MAX_CLOCK_DRIFT_MS;
    }
    offlineTokenPath() {
        return join(this.opts.dir, OFFLINE_TOKEN_FILE);
    }
    lastVerifyPath() {
        return join(this.opts.dir, LAST_VERIFY_FILE);
    }
    lockPath() {
        return `${this.offlineTokenPath()}${LOCK_SUFFIX}`;
    }
    cacheOfflineToken(token) {
        try {
            const secret = this.nodeSecret();
            if (!secret)
                return false;
            mkdirSync(dirname(this.offlineTokenPath()), { recursive: true });
            const data = JSON.stringify(token);
            const hmac = hmacSha256(secret, data);
            writeFileSync(this.offlineTokenPath(), `${JSON.stringify({ data: token, hmac })}\n`, { encoding: 'utf8', mode: 0o600 });
            return true;
        }
        catch {
            return false;
        }
    }
    loadOfflineToken() {
        try {
            if (!existsSync(this.offlineTokenPath()))
                return null;
            const stored = JSON.parse(readFileSync(this.offlineTokenPath(), 'utf8'));
            if (!isStoredOfflinePermitToken(stored))
                return null;
            const secret = this.nodeSecret();
            if (!secret)
                return null;
            const expected = hmacSha256(secret, JSON.stringify(stored.data));
            if (!safeHexEqual(expected, stored.hmac))
                return null;
            return stored.data;
        }
        catch {
            return null;
        }
    }
    recordLastOnlineVerify(ts = this.now()) {
        try {
            mkdirSync(dirname(this.lastVerifyPath()), { recursive: true });
            writeFileSync(this.lastVerifyPath(), String(ts), { encoding: 'utf8', mode: 0o600 });
            return true;
        }
        catch {
            return false;
        }
    }
    getLastOnlineVerifyTs() {
        try {
            if (!existsSync(this.lastVerifyPath()))
                return 0;
            return Number.parseInt(readFileSync(this.lastVerifyPath(), 'utf8'), 10) || 0;
        }
        catch {
            return 0;
        }
    }
    consumeOfflinePermit() {
        try {
            mkdirSync(dirname(this.offlineTokenPath()), { recursive: true });
        }
        catch {
            // Let acquireLock surface the concrete filesystem error below; it is
            // converted to the structured offline_lock_failed envelope.
        }
        let locked = false;
        try {
            util.acquireLock(this.lockPath(), this.opts.lock ?? DEFAULT_OFFLINE_PERMIT_LOCK);
            locked = true;
            return this.consumeLocked();
        }
        catch (err) {
            if (isLockTimeoutError(err))
                return { ok: false, error: 'offline_permit_busy', offline: true };
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: 'offline_lock_failed', offline: true, detail: this.errorDetail(message) };
        }
        finally {
            if (locked)
                util.releaseLock(this.lockPath());
        }
    }
    consumeLocked() {
        const token = this.loadOfflineToken();
        if (!token)
            return { ok: false, error: 'no_offline_token', offline: true };
        const maxSolidifies = finiteNonNegativeNumber(token.maxOfflineSolidifies, this.maxOfflineSolidifies);
        const expiresAt = finitePositiveNumber(token.expiresAt);
        const usedCount = finiteNonNegativeNumber(token.usedCount, 0);
        const now = this.now();
        const lastOnline = this.getLastOnlineVerifyTs();
        if (lastOnline > 0 && now < lastOnline - this.maxClockDriftMs) {
            return { ok: false, error: 'clock_drift_detected', offline: true };
        }
        if (expiresAt === null || now > expiresAt) {
            return { ok: false, error: 'offline_token_expired', offline: true };
        }
        if (lastOnline > 0 && now - lastOnline > this.maxOfflineDurationMs) {
            return { ok: false, error: 'offline_duration_exceeded', offline: true };
        }
        if (usedCount >= maxSolidifies) {
            return { ok: false, error: 'offline_quota_exhausted', offline: true };
        }
        token.usedCount = usedCount + 1;
        if (!this.cacheOfflineToken(token)) {
            return { ok: false, error: 'offline_lock_failed', offline: true, detail: 'offline token write failed' };
        }
        return { ok: true, offline: true, remaining: maxSolidifies - token.usedCount };
    }
    nodeSecret() {
        const raw = typeof this.opts.nodeSecret === 'function' ? this.opts.nodeSecret() : this.opts.nodeSecret;
        return typeof raw === 'string' && raw.length > 0 ? raw : null;
    }
    errorDetail(message) {
        let out = message;
        for (const sensitive of [this.lockPath(), this.offlineTokenPath(), this.lastVerifyPath(), this.opts.dir].sort((a, b) => b.length - a.length)) {
            if (sensitive)
                out = out.split(sensitive).join('<offline-permit-path>');
        }
        return out.slice(0, ERROR_DETAIL_MAX_CHARS);
    }
}
export function createSolidifyPermitCheck(opts) {
    const store = opts.store ?? new OfflinePermitStore({
        dir: opts.dir,
        nodeSecret: opts.nodeSecret,
        ...(opts.now ? { now: opts.now } : {}),
    });
    const http = new HubFetch({
        baseUrl: opts.hubUrl.replace(/\/+$/, ''),
        auth: opts.auth,
        fetchFn: opts.fetchFn ?? globalFetchLike,
        senderId: opts.senderId,
    });
    return async (ctx) => {
        const online = await requestSolidifyPermit(http, opts, ctx, store);
        if (online.ok)
            return { ok: true, reason: online.reason ?? 'hub_solidify_authorized' };
        if (!online.offline)
            return { ok: false, reason: online.reason };
        const offline = store.consumeOfflinePermit();
        if (offline.ok)
            return { ok: true, reason: 'offline_permit' };
        return {
            ok: false,
            reason: `hub_solidify_offline_denied:${offline.error}`,
            ...(offline.detail ? { detail: offline.detail } : {}),
        };
    };
}
async function requestSolidifyPermit(http, opts, ctx, store) {
    try {
        const body = buildVerifySolidifyBody(opts, ctx);
        const raw = await http.call('POST', '/a2a/verify-solidify', body);
        // Any 2xx response proves the hub's application layer answered, so the node
        // is not actually offline — refresh lastOnlineVerify even on {ok:false}
        // envelopes (quota_exceeded, rate_limited, validation). Previously this only
        // fired on raw.ok===true, so a long streak of envelope errors let the
        // offline-duration counter run past maxOfflineDurationMs (7d) and falsely
        // trip offline_duration_exceeded while the hub was reachable the whole time.
        // (ports v1 PR #149)
        store.recordLastOnlineVerify(opts.now?.());
        // Only trust an offline_token from a genuine {ok:true} envelope — an error
        // envelope must never seed the offline-permit cache with a stale token.
        if (raw['ok'] === true && isOfflinePermitToken(raw['offline_token'])) {
            store.cacheOfflineToken(raw['offline_token']);
        }
        return normalizePermitResult(raw, false);
    }
    catch (err) {
        // 4xx means the hub answered and explicitly rejected (bad auth, forbidden,
        // client error). status < 500 still proves reachability, so refresh
        // lastOnlineVerify here too — mirrors the non-5xx rule above. The solidify
        // stays denied online (offline:false), so this never feeds the offline
        // quota fallback. (ports v1 PR #149)
        if (err instanceof AuthError) {
            store.recordLastOnlineVerify(opts.now?.());
            return { ok: false, offline: false, reason: `HTTP ${err.status}` };
        }
        if (err instanceof HubClientError) {
            store.recordLastOnlineVerify(opts.now?.());
            return { ok: false, offline: false, reason: permitError(rawRecord(err.body)) ?? `HTTP ${err.status}` };
        }
        // 5xx (plain Error), captive-portal/non-API responses (HubUnreachableError),
        // and transport failures are genuinely offline → leave lastOnlineVerify
        // untouched so the offline-duration guard still trips if the hub stays down.
        return { ok: false, offline: true, reason: err instanceof Error ? err.message : String(err) };
    }
}
function buildVerifySolidifyBody(opts, ctx) {
    const ts = opts.now?.() ?? Date.now();
    const signalsHash = hashCompact(JSON.stringify([...ctx.signals].slice(0, 8)));
    const mutationHash = hashCompact(JSON.stringify(ctx.mutation));
    const nodeId = opts.senderId();
    const secret = resolveNodeSecret(opts.nodeSecret);
    const signatureFields = secret && nodeId
        ? {
            client_signature: hmacSha256(createHash('sha256').update(secret).digest('hex'), [nodeId, ctx.geneId || '', signalsHash, mutationHash, String(ts)].join('|')),
        }
        : {};
    return {
        gene_id: ctx.geneId,
        signals_hash: signalsHash,
        mutation_hash: mutationHash,
        ts,
        ...signatureFields,
    };
}
function hashCompact(input) {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
function normalizePermitResult(raw, fallbackOffline) {
    if (raw['ok'] === true)
        return { ok: true, ...(raw['offline'] === true ? { offline: true } : {}) };
    return { ok: false, offline: typeof raw['offline'] === 'boolean' ? raw['offline'] : fallbackOffline, reason: permitError(raw) ?? 'solidify_permit_denied' };
}
function permitError(raw) {
    const value = raw?.['error'] ?? raw?.['reason'];
    return typeof value === 'string' && value.length > 0 ? value.slice(0, ERROR_DETAIL_MAX_CHARS) : undefined;
}
function isOfflinePermitToken(value) {
    return Boolean(value && typeof value === 'object');
}
function rawRecord(value) {
    return value && typeof value === 'object' ? value : null;
}
function resolveNodeSecret(input) {
    const raw = typeof input === 'function' ? input() : input;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
export function hmacSha256(key, data) {
    return createHmac('sha256', key).update(data).digest('hex');
}
function safeHexEqual(expected, received) {
    try {
        const exp = Buffer.from(expected, 'hex');
        const got = Buffer.from(received, 'hex');
        return exp.length === got.length && timingSafeEqual(exp, got);
    }
    catch {
        return false;
    }
}
function isStoredOfflinePermitToken(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return Boolean(v.data && typeof v.data === 'object' && typeof v.hmac === 'string');
}
function finiteNonNegativeNumber(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
function finitePositiveNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return null;
    return Math.floor(value);
}
function isLockTimeoutError(err) {
    if (!(err instanceof Error))
        return false;
    const code = err.code;
    if (code === 'LOCK_TIMEOUT')
        return true;
    if (code)
        return false;
    return /文件锁|lock/i.test(err.message);
}