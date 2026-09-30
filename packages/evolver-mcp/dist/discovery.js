import { setTimeout as delay } from 'node:timers/promises';
export const DISCOVERY_TIMEOUT_MS = 20_000;
export const DISCOVERY_MAX_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 250;
const DISCOVERY_PATHS = new Set(['/recipe/search', '/asset/search', '/agent/search', '/agent/profile', '/agent/discover']);
const NETWORK_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
export class DiscoveryError extends Error {
    code;
    status;
    retryable;
    retryAfterMs;
    timeoutMs;
    constructor(code, status, retryable, retryAfterMs, timeoutMs) {
        super(code);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.timeoutMs = timeoutMs;
        this.name = 'DiscoveryError';
    }
}
export function isDiscoveryPath(path) {
    return DISCOVERY_PATHS.has(path);
}
export function isDegradedDiscovery(value) {
    const body = record(value);
    return body['search_status'] === 'degraded' || body['complete'] === false;
}
export function discoveryTimeout(value) {
    if (value === undefined)
        return DISCOVERY_TIMEOUT_MS;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > DISCOVERY_MAX_TIMEOUT_MS) {
        throw new DiscoveryError('invalid_discovery_timeout', 400, false);
    }
    return value;
}
export function discoveryHttpError(status, value) {
    const body = record(value);
    const error = record(body['error']);
    const rawCode = body['code'] ?? error['code'] ?? body['error'];
    const code = typeof rawCode === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(rawCode) ? rawCode : undefined;
    const retryAfterMs = milliseconds(body['retryAfterMs'] ?? body['retry_after_ms'] ?? error['retryAfterMs']);
    const timeoutMs = milliseconds(body['timeoutMs'] ?? error['timeoutMs']);
    const retryable = body['retryable'] !== false && error['retryable'] !== false;
    const permissionCode = [body['code'], error['code'], body['error']].find((value) => value === 'permission_denied' || value === 'auth_failed');
    if (status === 401 || status === 403 || permissionCode) {
        return new DiscoveryError(permissionCode ?? code ?? 'permission_denied', status, false);
    }
    // Older proxies mislabeled upstream timeouts as invalid_request. Match only the known transport message.
    const legacyTimeout = typeof body['error'] === 'string'
        ? /^(?:GET|POST) \/a2a\/(?:recipe\/(?:search|list)|assets\/semantic-search|directory\/(?:search|profile\/[^ ]+)|fetch) timed out after (\d+)ms$/.exec(body['error'])
        : null;
    if (status === 400 && legacyTimeout)
        return new DiscoveryError('hub_timeout', 504, retryable, undefined, Number(legacyTimeout[1]));
    if (status === 429)
        return new DiscoveryError(code ?? 'hub_rate_limited', status, retryable, retryAfterMs);
    if (status === 408 || status === 504)
        return new DiscoveryError(code ?? 'hub_timeout', status, retryable, retryAfterMs, timeoutMs);
    if ([500, 502, 503].includes(status) && retryable) {
        return new DiscoveryError(code ?? 'hub_unavailable', status, true, retryAfterMs, timeoutMs);
    }
    return new DiscoveryError(code ?? 'discovery_request_failed', status, false, retryAfterMs);
}
export async function discoverWithRetry(call, timeoutMs = DISCOVERY_TIMEOUT_MS) {
    const budget = discoveryTimeout(timeoutMs);
    const controller = new AbortController();
    const timeout = new DiscoveryError('discovery_timeout', 504, true, undefined, budget);
    const timer = setTimeout(() => controller.abort(timeout), budget);
    const started = performance.now();
    let attempts = 0;
    try {
        for (;;) {
            attempts += 1;
            try {
                return await withAbort(call(controller.signal), controller.signal);
            }
            catch (error) {
                const failure = controller.signal.aborted ? timeout : transientFailure(error);
                if (!failure?.retryable)
                    throw error;
                const waitMs = failure.retryAfterMs ?? RETRY_DELAY_MS;
                if (attempts >= 2 || controller.signal.aborted || waitMs + 100 >= budget - (performance.now() - started)) {
                    return degraded(failure, attempts);
                }
                try {
                    await delay(waitMs, undefined, { signal: controller.signal });
                }
                catch {
                    return degraded(timeout, attempts);
                }
            }
        }
    }
    finally {
        clearTimeout(timer);
    }
}
function transientFailure(error) {
    if (error instanceof DiscoveryError)
        return error;
    const source = record(error);
    const cause = record(source['cause']);
    if (NETWORK_CODES.has(String(source['code'] ?? cause['code']))
        || (error instanceof TypeError && /^(?:fetch failed|Failed to fetch)$/.test(error.message))) {
        return new DiscoveryError('proxy_unavailable', 503, true);
    }
    return undefined;
}
function degraded(error, attempts) {
    return {
        search_status: 'degraded',
        complete: false,
        retryable: true,
        code: error.code,
        status: error.status,
        attempts,
        retryAfterMs: error.retryAfterMs ?? 1_000,
        ...(error.timeoutMs !== undefined ? { timeoutMs: error.timeoutMs } : {}),
        message: 'Discovery is temporarily unavailable; whether matches exist is unknown. Continue the main task without this optional lookup. Do not treat this as no_match, loop on retries, or start a paid fallback automatically.',
    };
}
async function withAbort(pending, signal) {
    return new Promise((resolve, reject) => {
        const aborted = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener('abort', aborted);
        if (signal.aborted)
            aborted();
        else
            signal.addEventListener('abort', aborted, { once: true });
        void pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function milliseconds(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}