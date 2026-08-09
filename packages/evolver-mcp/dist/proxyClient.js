import { lstatSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export class EvolverProxyClient {
    baseUrl;
    token;
    fetchFn;
    expectedHubMode;
    reloadSettings;
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.token = opts.token;
        this.expectedHubMode = opts.expectedHubMode;
        this.fetchFn = opts.fetchFn ?? globalFetch;
        this.reloadSettings = opts.reloadSettings;
    }
    status(opts = {}) {
        return this.call('GET', '/proxy/status', undefined, opts);
    }
    search(args) {
        const expectedHubMode = args.expectedHubMode ?? this.expectedHubMode;
        return this.call('POST', '/asset/search', {
            ...(args.text ? { text: args.text } : {}),
            ...(args.signalsAny && args.signalsAny.length > 0 ? { signals: args.signalsAny } : {}),
            ...(args.kind ? { kind: args.kind } : {}),
            ...(args.category ? { category: args.category } : {}),
            ...(args.gene ? { gene: args.gene } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(expectedHubMode ? { expected_hub_mode: expectedHubMode } : {}),
        });
    }
    fetchAsset(args) {
        const expectedHubMode = args.expectedHubMode ?? this.expectedHubMode;
        return this.call('POST', '/asset/fetch', {
            ...(args.assetId ? { asset_id: args.assetId } : {}),
            ...(args.assetIds ? { asset_ids: args.assetIds } : {}),
            ...(expectedHubMode ? { expected_hub_mode: expectedHubMode } : {}),
        });
    }
    searchAgents(args) {
        return this.call('POST', '/agent/search', agentDirectoryBody(args));
    }
    getAgentProfile(agentId, timeoutMs) {
        return this.call('POST', '/agent/profile', { agent_id: agentId, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) });
    }
    discoverAgentsForTask(args) {
        return this.call('POST', '/agent/discover', {
            title: args.title,
            ...(args.description ? { description: args.description } : {}),
            ...agentDirectoryBody(args),
        });
    }
    submitAsset(asset) {
        // MCP publishing remains durable and outage-tolerant; the bare route is reserved for V1 synchronous callers.
        return this.call('POST', '/asset/submit?mode=async', this.modeBoundBody({
            assets: [asset],
            request_id: randomUUID(),
        }));
    }
    submitAssetBundle(bundle) {
        return this.call('POST', '/asset/submit', this.modeBoundBody(bundle));
    }
    /** Pre-publish dry-run: the hub runs its quality + content-safety gate but stores nothing and charges no credits. */
    validateAsset(asset) {
        return this.validateAssetBundle({ assets: [asset] });
    }
    validateAssetBundle(bundle) {
        return this.call('POST', '/asset/validate', this.modeBoundBody(bundle));
    }
    distillConversation(input) {
        return this.call('POST', '/conversation/distill', this.modeBoundBody(input));
    }
    recordReuseResult(args) {
        const expectedHubMode = args.expectedHubMode ?? this.expectedHubMode;
        return this.call('POST', '/asset/reuse-result', {
            asset_id: args.assetId,
            outcome: args.outcome,
            ...(args.taskId ? { task_id: args.taskId } : {}),
            ...(args.traceId ? { trace_id: args.traceId } : {}),
            ...(args.timeSavedSeconds !== undefined ? { time_saved_seconds: args.timeSavedSeconds } : {}),
            ...(args.reason ? { reason: args.reason } : {}),
            ...(expectedHubMode ? { expected_hub_mode: expectedHubMode } : {}),
        });
    }
    modeBoundBody(input) {
        if (!this.expectedHubMode || !input || typeof input !== 'object' || Array.isArray(input))
            return input;
        const body = input;
        return { ...body, expected_hub_mode: body['expected_hub_mode'] ?? this.expectedHubMode };
    }
    async call(method, path, body, opts = {}) {
        let connection = this.connectionSnapshot();
        try {
            if (path !== '/proxy/status' && this.expectedHubMode === 'private') {
                await this.verifyExpectedHubMode(connection, opts);
            }
            const result = await this.callOnce(method, path, body, opts, connection);
            if (result.ok)
                return this.acceptResult(result, path);
            if (result.status === 401 && this.reloadFromSettings()) {
                connection = this.connectionSnapshot();
                await this.verifyReloadedHubMode(path, connection, opts);
                const retry = await this.callOnce(method, path, body, opts, connection);
                if (retry.ok)
                    return this.acceptResult(retry, path);
                throw this.proxyError(retry, path);
            }
            throw this.proxyError(result, path);
        }
        catch (err) {
            if (this.reloadFromSettings()) {
                connection = this.connectionSnapshot();
                await this.verifyReloadedHubMode(path, connection, opts);
                const retry = await this.callOnce(method, path, body, opts, connection);
                if (retry.ok)
                    return this.acceptResult(retry, path);
                throw this.proxyError(retry, path);
            }
            throw err;
        }
    }
    async verifyExpectedHubMode(connection, opts) {
        // A proxy can restart on the same loopback URL with the same operator-supplied token. Verify every private
        // operation against the same immutable connection snapshot used for its payload. This prevents a concurrent
        // settings reload from moving the payload to an endpoint that the status probe never verified.
        const result = await this.callOnce('GET', '/proxy/status', undefined, opts, connection);
        if (!result.ok)
            throw this.proxyError(result, '/proxy/status');
        this.acceptResult(result, '/proxy/status');
    }
    async verifyReloadedHubMode(path, connection, opts) {
        if (path !== '/proxy/status' && this.expectedHubMode === 'private') {
            await this.verifyExpectedHubMode(connection, opts);
        }
    }
    acceptResult(result, path) {
        if (path === '/proxy/status' && this.expectedHubMode === 'private') {
            const status = recordValue(result.parsed);
            if (status['hub_mode'] !== 'private')
                throw new Error('proxy_hub_mode_mismatch');
        }
        return result.parsed;
    }
    async callOnce(method, path, body, opts, connection) {
        const res = await this.fetchFn(`${connection.baseUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${connection.token}`,
                'content-type': 'application/json',
                ...(this.expectedHubMode ? { 'x-evomap-expected-hub-mode': this.expectedHubMode } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
        });
        return { ok: res.ok, status: res.status, parsed: await res.json() };
    }
    connectionSnapshot() {
        return { baseUrl: this.baseUrl, token: this.token };
    }
    reloadFromSettings() {
        const next = this.reloadSettings?.();
        if (!next)
            return false;
        const nextBaseUrl = next.baseUrl.replace(/\/+$/, '');
        if (nextBaseUrl === this.baseUrl && next.token === this.token)
            return false;
        this.baseUrl = nextBaseUrl;
        this.token = next.token;
        return true;
    }
    proxyError(result, path) {
        const message = result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed) && typeof result.parsed.error === 'string'
            ? result.parsed.error
            : `evolver proxy ${result.status} ${path}`;
        return new Error(message);
    }
}
function agentDirectoryBody(args) {
    return {
        ...(args.query ? { query: args.query } : {}),
        ...(args.signals && args.signals.length > 0 ? { signals: args.signals } : {}),
        ...(args.availability ? { availability: args.availability } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.order ? { order: args.order } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.timeoutMs !== undefined ? { timeout_ms: args.timeoutMs } : {}),
    };
}
export function proxyClientFromEnv(env = process.env) {
    const expectedHubMode = expectedHubModeFromEnv(env);
    if (!expectedHubMode)
        return undefined;
    const token = env['EVOLVER_IPC_TOKEN']?.trim();
    if (!token)
        return proxyClientFromSettings(env, env === process.env, undefined, expectedHubMode);
    const baseUrl = proxyBaseUrlFromEnv(env);
    return baseUrl ? new EvolverProxyClient({ baseUrl, token, expectedHubMode }) : undefined;
}
export async function reachableProxyClientFromEnv(env = process.env, opts = {}) {
    const expectedHubMode = expectedHubModeFromEnv(env);
    if (!expectedHubMode)
        return undefined;
    const token = env['EVOLVER_IPC_TOKEN']?.trim();
    if (token) {
        const baseUrl = proxyBaseUrlFromEnv(env);
        return baseUrl ? new EvolverProxyClient({ baseUrl, token, expectedHubMode, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) }) : undefined;
    }
    const client = proxyClientFromSettings(env, env === process.env, opts.fetchFn, expectedHubMode);
    if (!client)
        return undefined;
    return await proxyClientReachable(client, opts.timeoutMs ?? 250) ? client : undefined;
}
function proxyClientFromSettings(env, allowDefaultHome, fetchFn, expectedHubMode = 'public') {
    const settings = readProxySettings(env, allowDefaultHome);
    return settings ? new EvolverProxyClient({
        ...settings,
        expectedHubMode,
        ...(fetchFn ? { fetchFn } : {}),
        reloadSettings: () => readProxySettings(env, allowDefaultHome),
    }) : undefined;
}
function expectedHubModeFromEnv(env) {
    const value = env['EVOMAP_HUB_MODE']?.trim().toLowerCase() || 'public';
    return value === 'public' || value === 'private' ? value : undefined;
}
function readProxySettings(env, allowDefaultHome) {
    const settingsPath = resolveProxySettingsPath(env, allowDefaultHome);
    if (!settingsPath)
        return undefined;
    try {
        if (!lstatSync(settingsPath).isFile())
            return undefined;
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const proxy = recordValue(recordValue(parsed)['proxy']);
        const baseUrl = typeof proxy['url'] === 'string' ? proxy['url'].trim() : '';
        const token = typeof proxy['token'] === 'string' ? proxy['token'].trim() : '';
        if (!baseUrl || !token || !isLoopbackHttpUrl(baseUrl))
            return undefined;
        return { baseUrl, token };
    }
    catch {
        return undefined;
    }
}
function resolveProxySettingsPath(env, allowDefaultHome) {
    const explicit = env['EVOLVER_PROXY_SETTINGS_FILE']?.trim();
    if (explicit)
        return explicit;
    const settingsDir = env['EVOLVER_SETTINGS_DIR']?.trim();
    if (settingsDir)
        return join(settingsDir, 'settings.json');
    const homeDir = env['HOME']?.trim() || (allowDefaultHome ? homedir() : '');
    return homeDir ? join(homeDir, '.evolver', 'settings.json') : undefined;
}
function isLoopbackHttpUrl(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return false;
        if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/'))
            return false;
        const hostname = url.hostname.toLowerCase();
        return hostname === '127.0.0.1'
            || hostname === 'localhost'
            || hostname === '[::1]'
            || hostname === '::1';
    }
    catch {
        return false;
    }
}
function proxyBaseUrlFromEnv(env) {
    const explicitUrl = env['EVOLVER_PROXY_URL']?.trim();
    if (explicitUrl)
        return isLoopbackHttpUrl(explicitUrl) ? explicitUrl : undefined;
    const rawPort = env['EVOLVER_IPC_PORT']?.trim() || env['EVOMAP_PROXY_PORT']?.trim() || '19820';
    if (!/^\d+$/.test(rawPort))
        return undefined;
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
        return undefined;
    const baseUrl = `http://127.0.0.1:${port}`;
    return isLoopbackHttpUrl(baseUrl) ? baseUrl : undefined;
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
async function proxyClientReachable(client, timeoutMs) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
        await client.status({ signal: controller.signal });
        return true;
    }
    catch (error) {
        if (error instanceof Error && error.message === 'proxy_hub_mode_mismatch')
            throw error;
        return false;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function globalFetch(url, init) {
    return fetch(url, { ...init, redirect: 'error' });
}