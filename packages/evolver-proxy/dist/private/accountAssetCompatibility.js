import { AuthError, HubClientError, HubUnreachableError, } from '@evomap/evolver-adapter-public';
const PRIVATE_PUBLISHED_ASSETS_PATH = '/a2a/assets/published-by-me';
const PRIVATE_PUBLISHED_MAX_PAGE_SIZE = 500;
const PRIVATE_CURSOR_MAX_LENGTH = 4096;
/**
 * Older official private adapters predate account inventory listing. Keep the
 * compatibility wire at the private composition edge, and never replace a
 * future adapter's native implementation.
 */
export function withPrivateAccountAssetCompatibility(hubCapability, opts) {
    const candidate = hubCapability;
    if (typeof candidate['listAccountAssets'] === 'function') {
        return hubCapability;
    }
    if (candidate['listAccountAssets'] !== undefined) {
        throw new Error('private Hub adapter exposes an invalid account asset sync capability');
    }
    const client = new PrivateAccountAssetCompatibility(opts);
    try {
        Object.defineProperty(hubCapability, 'listAccountAssets', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: (listOpts) => client.list(listOpts),
        });
    }
    catch {
        throw new Error('private Hub adapter cannot be extended with account asset sync compatibility');
    }
    return hubCapability;
}
class PrivateAccountAssetCompatibility {
    opts;
    baseUrl;
    fetchFn;
    constructor(opts) {
        this.opts = opts;
        this.baseUrl = normalizePrivateHubBaseUrl(opts.baseUrl, opts.env);
        this.fetchFn = opts.fetchFn ?? globalPrivateCompatibilityFetch;
    }
    async list(opts) {
        assertAccountAssetListOptions(opts);
        if (opts.scope === 'purchased') {
            // Private Hub has no marketplace/purchase ledger. An empty inventory is
            // distinct from published assets and avoids importing arbitrary recall hits.
            if (opts.cursor)
                throw new HubClientError(400, { code: 'private_marketplace_cursor_unsupported' });
            return { assets: [], count: 0, hasMore: false };
        }
        const limit = Math.min(opts.limit ?? 100, PRIVATE_PUBLISHED_MAX_PAGE_SIZE);
        const query = new URLSearchParams({ limit: String(limit) });
        const senderId = this.opts.senderId()?.trim();
        if (senderId)
            query.set('sender_id', senderId);
        if (opts.cursor)
            query.set('cursor', opts.cursor);
        if (opts.type)
            query.set('type', opts.type);
        if (opts.status && opts.status !== 'all')
            query.set('status', opts.status);
        const signed = await this.opts.auth.authenticate({ method: 'GET', path: PRIVATE_PUBLISHED_ASSETS_PATH });
        const headers = accountAssetHeaders(signed);
        const url = `${this.baseUrl}${PRIVATE_PUBLISHED_ASSETS_PATH}?${query.toString()}`;
        assertPrivateCompatibilityUrlSecure(url, this.opts.env);
        let response;
        try {
            response = await this.fetchFn(url, { method: 'GET', headers });
        }
        catch (error) {
            if (error instanceof AuthError || error instanceof HubClientError || error instanceof HubUnreachableError)
                throw error;
            throw new HubUnreachableError('Private Hub account asset request failed before a response arrived', {
                context: `GET ${PRIVATE_PUBLISHED_ASSETS_PATH}`,
            });
        }
        const body = await parseCompatibilityResponse(response);
        if (response.status === 401 || response.status === 403)
            throw new AuthError(response.status, body);
        if (response.status >= 400 && response.status < 500)
            throw new HubClientError(response.status, body);
        if (response.status >= 500)
            throw new Error(`private hub ${response.status} ${PRIVATE_PUBLISHED_ASSETS_PATH}`);
        return parsePublishedPage(body, limit);
    }
}
function assertAccountAssetListOptions(opts) {
    if (!opts || (opts.scope !== 'purchased' && opts.scope !== 'published')) {
        throw new HubClientError(400, { code: 'invalid_account_asset_scope' });
    }
    if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit <= 0)) {
        throw new HubClientError(400, { code: 'invalid_account_asset_limit' });
    }
    if (opts.cursor !== undefined && (!opts.cursor.trim() || opts.cursor.length > PRIVATE_CURSOR_MAX_LENGTH)) {
        throw new HubClientError(400, { code: 'invalid_account_asset_cursor' });
    }
    if (opts.type !== undefined && opts.type !== 'Gene' && opts.type !== 'Capsule') {
        throw new HubClientError(400, { code: 'invalid_account_asset_type' });
    }
    if (opts.status !== undefined && opts.status !== 'draft' && opts.status !== 'promoted' && opts.status !== 'all') {
        throw new HubClientError(400, { code: 'invalid_account_asset_status' });
    }
}
function accountAssetHeaders(signed) {
    const headers = { accept: 'application/json', ...signed.headers };
    const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
    const bodyNodeSecret = signed.bodyFields?.['node_secret'];
    if (!hasAuthorization && typeof bodyNodeSecret === 'string' && bodyNodeSecret) {
        headers['authorization'] = `Bearer ${bodyNodeSecret}`;
    }
    return headers;
}
async function parseCompatibilityResponse(response) {
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new HubUnreachableError('Private Hub account asset response has an invalid HTTP status', {
            context: `GET ${PRIVATE_PUBLISHED_ASSETS_PATH}`,
        });
    }
    try {
        const parsed = await response.json();
        const record = asRecord(parsed);
        if (record)
            return record;
    }
    catch {
        // The normalized error below intentionally excludes response data.
    }
    throw new HubUnreachableError('Private Hub account asset response is not a JSON object', {
        status: response.status,
        context: `GET ${PRIVATE_PUBLISHED_ASSETS_PATH}`,
    });
}
function parsePublishedPage(body, limit) {
    const payload = asRecord(body['payload']) ?? body;
    const assets = payload['assets'];
    const hasMore = payload['has_more'] ?? payload['hasMore'];
    const rawCursor = payload['next_cursor'] ?? payload['nextCursor'];
    const count = payload['count'];
    if (!Array.isArray(assets) || assets.length > limit || typeof hasMore !== 'boolean') {
        throw malformedPublishedPage();
    }
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
        throw malformedPublishedPage();
    }
    const nextCursor = rawCursor === null || rawCursor === undefined ? undefined : rawCursor;
    if (nextCursor !== undefined && (typeof nextCursor !== 'string' || !nextCursor.trim() || nextCursor.length > PRIVATE_CURSOR_MAX_LENGTH)) {
        throw malformedPublishedPage();
    }
    if (hasMore && nextCursor === undefined)
        throw malformedPublishedPage();
    return {
        assets: assets,
        ...(count !== undefined ? { count: count } : {}),
        hasMore,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
}
function malformedPublishedPage() {
    return new HubUnreachableError('Private Hub returned a malformed published asset page', {
        context: `GET ${PRIVATE_PUBLISHED_ASSETS_PATH}`,
    });
}
function normalizePrivateHubBaseUrl(raw, env) {
    const normalized = raw.trim().replace(/\/+$/, '');
    assertPrivateCompatibilityUrlSecure(normalized, env);
    const parsed = new URL(normalized);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Private Hub URL must not contain credentials, query parameters, or a fragment');
    }
    return normalized;
}
function assertPrivateCompatibilityUrlSecure(url, env) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error('Private Hub URL is invalid');
    }
    if (parsed.protocol === 'https:')
        return;
    if (parsed.protocol === 'http:' && env['EVOLVER_PRIVATE_ALLOW_INSECURE'] === '1')
        return;
    throw new Error('Private Hub URL must use https');
}
const globalPrivateCompatibilityFetch = async (url, init) => {
    const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body ? { body: init.body } : {}),
        redirect: 'error',
    });
    return { status: response.status, json: () => response.json() };
};
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}