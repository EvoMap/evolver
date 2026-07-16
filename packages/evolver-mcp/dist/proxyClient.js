import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export class EvolverProxyClient {
    baseUrl;
    token;
    fetchFn;
    reloadSettings;
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.token = opts.token;
        this.fetchFn = opts.fetchFn ?? globalFetch;
        this.reloadSettings = opts.reloadSettings;
    }
    status(opts = {}) {
        return this.call('GET', '/proxy/status', undefined, opts);
    }
    search(args) {
        return this.call('POST', '/asset/search', {
            ...(args.text ? { text: args.text } : {}),
            ...(args.signalsAny && args.signalsAny.length > 0 ? { signals: args.signalsAny } : {}),
            ...(args.kind ? { kind: args.kind } : {}),
            ...(args.category ? { category: args.category } : {}),
            ...(args.gene ? { gene: args.gene } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
    }
    fetchAsset(args) {
        return this.call('POST', '/asset/fetch', {
            ...(args.assetId ? { asset_id: args.assetId } : {}),
            ...(args.assetIds ? { asset_ids: args.assetIds } : {}),
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
        return this.call('POST', '/asset/submit', { assets: [asset] });
    }
    /** Pre-publish dry-run: the hub runs its quality + content-safety gate but stores nothing and charges no credits. */
    validateAsset(asset) {
        return this.validateAssetBundle({ assets: [asset] });
    }
    validateAssetBundle(bundle) {
        return this.call('POST', '/asset/validate', bundle);
    }
    distillConversation(input) {
        return this.call('POST', '/conversation/distill', input);
    }
    recordReuseResult(args) {
        return this.call('POST', '/asset/reuse-result', {
            asset_id: args.assetId,
            outcome: args.outcome,
            ...(args.taskId ? { task_id: args.taskId } : {}),
            ...(args.traceId ? { trace_id: args.traceId } : {}),
            ...(args.timeSavedSeconds !== undefined ? { time_saved_seconds: args.timeSavedSeconds } : {}),
            ...(args.reason ? { reason: args.reason } : {}),
        });
    }
    async call(method, path, body, opts = {}) {
        try {
            const result = await this.callOnce(method, path, body, opts);
            if (result.ok)
                return result.parsed;
            if (result.status === 401 && this.reloadFromSettings()) {
                const retry = await this.callOnce(method, path, body, opts);
                if (retry.ok)
                    return retry.parsed;
                throw this.proxyError(retry, path);
            }
            throw this.proxyError(result, path);
        }
        catch (err) {
            if (this.reloadFromSettings()) {
                const retry = await this.callOnce(method, path, body, opts);
                if (retry.ok)
                    return retry.parsed;
                throw this.proxyError(retry, path);
            }
            throw err;
        }
    }
    async callOnce(method, path, body, opts) {
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json',
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
        });
        return { ok: res.ok, status: res.status, parsed: await res.json() };
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
    const token = env['EVOLVER_IPC_TOKEN']?.trim();
    if (!token)
        return proxyClientFromSettings(env, env === process.env);
    const explicitUrl = env['EVOLVER_PROXY_URL']?.trim();
    const port = env['EVOLVER_IPC_PORT']?.trim() || env['EVOMAP_PROXY_PORT']?.trim() || '19820';
    return new EvolverProxyClient({ baseUrl: explicitUrl || `http://127.0.0.1:${port}`, token });
}
export async function reachableProxyClientFromEnv(env = process.env, opts = {}) {
    const token = env['EVOLVER_IPC_TOKEN']?.trim();
    if (token) {
        const explicitUrl = env['EVOLVER_PROXY_URL']?.trim();
        const port = env['EVOLVER_IPC_PORT']?.trim() || env['EVOMAP_PROXY_PORT']?.trim() || '19820';
        return new EvolverProxyClient({ baseUrl: explicitUrl || `http://127.0.0.1:${port}`, token, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
    }
    const client = proxyClientFromSettings(env, env === process.env, opts.fetchFn);
    if (!client)
        return undefined;
    return await proxyClientReachable(client, opts.timeoutMs ?? 250) ? client : undefined;
}
function proxyClientFromSettings(env, allowDefaultHome, fetchFn) {
    const settings = readProxySettings(env, allowDefaultHome);
    return settings ? new EvolverProxyClient({
        ...settings,
        ...(fetchFn ? { fetchFn } : {}),
        reloadSettings: () => readProxySettings(env, allowDefaultHome),
    }) : undefined;
}
function readProxySettings(env, allowDefaultHome) {
    const homeDir = env['HOME']?.trim() || (allowDefaultHome ? homedir() : '');
    if (!homeDir)
        return undefined;
    const settingsPath = join(homeDir, '.evolver', 'settings.json');
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
function isLoopbackHttpUrl(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
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
    catch {
        return false;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function globalFetch(url, init) {
    return fetch(url, init);
}