const DEFAULT_COOLDOWN_MS = 6 * 60 * 60_000;
const MIN_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 30 * 24 * 60 * 60_000;
const MAX_STATE_ENTRIES = 32;
const STATE_KEY = 'lifecycle:claim_nudge:v1';
const CLAIM_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
export function createClaimNudge(options) {
    const env = options.env ?? process.env;
    const now = options.now ?? (() => Date.now());
    const write = options.write ?? ((text) => { process.stderr.write(text); });
    let memory = { version: 1, entries: {} };
    return (result) => {
        if (!result.ok || env['EVOLVER_DISABLE_CLAIM_NUDGE'] === '1')
            return false;
        const code = normalizeClaimCode(result.claimCode);
        const url = code ? trustedClaimUrl(result.claimUrl, options.hubUrl) : undefined;
        if (!code || !url)
            return false;
        const at = now();
        const cooldownMs = claimNudgeCooldownMs(env['EVOLVER_CLAIM_NUDGE_COOLDOWN_MS']);
        const state = mergeState(readState(options.store), memory);
        const lastPrintedAt = state.entries[code] ?? 0;
        if (lastPrintedAt > 0 && at - lastPrintedAt < cooldownMs)
            return false;
        const message = [
            '',
            '[evolver-proxy] This node is not linked to an EvoMap web account.',
            `Claim URL: ${url}`,
            `Claim code: ${code}`,
            'Claiming is optional; the proxy continues to run without it.',
            '',
        ].join('\n');
        try {
            write(message);
        }
        catch {
            return false;
        }
        memory = pruneState({ ...state.entries, [code]: at });
        try {
            options.store.setState(STATE_KEY, JSON.stringify(memory));
        }
        catch { /* memory still suppresses repeats */ }
        return true;
    };
}
export function wrapHelloWithClaimNudge(hello, nudge) {
    return async (options) => {
        const result = await hello(options);
        try {
            nudge(result);
        }
        catch { /* a terminal nudge must never break hello */ }
        return result;
    };
}
export function claimNudgeCooldownMs(raw) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return DEFAULT_COOLDOWN_MS;
    return Math.max(MIN_COOLDOWN_MS, Math.min(Math.floor(parsed), MAX_COOLDOWN_MS));
}
function normalizeClaimCode(value) {
    const code = value?.trim();
    return code && CLAIM_CODE_RE.test(code) ? code : undefined;
}
function trustedClaimUrl(value, hubUrl) {
    const raw = value?.trim();
    if (!raw || raw.length > 2_048)
        return undefined;
    try {
        const url = new URL(raw);
        const hub = new URL(hubUrl);
        if (url.username || url.password)
            return undefined;
        const sameOrigin = url.origin === hub.origin;
        const evomapHost = url.hostname === 'evomap.ai' || url.hostname.endsWith('.evomap.ai');
        if (url.protocol === 'https:' && (sameOrigin || evomapHost))
            return url.toString();
        if (url.protocol === 'http:' && sameOrigin && isLoopback(url.hostname))
            return url.toString();
    }
    catch {
        // Invalid or non-absolute URLs are never printed.
    }
    return undefined;
}
function isLoopback(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
function readState(store) {
    try {
        const raw = store.getState(STATE_KEY);
        if (!raw)
            return { version: 1, entries: {} };
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
            return { version: 1, entries: {} };
        }
        const entries = {};
        for (const [code, value] of Object.entries(parsed.entries)) {
            if (CLAIM_CODE_RE.test(code) && typeof value === 'number' && Number.isFinite(value) && value > 0)
                entries[code] = value;
        }
        return { version: 1, entries };
    }
    catch {
        return { version: 1, entries: {} };
    }
}
function mergeState(a, b) {
    const entries = { ...a.entries };
    for (const [code, at] of Object.entries(b.entries))
        entries[code] = Math.max(entries[code] ?? 0, at);
    return { version: 1, entries };
}
function pruneState(entries) {
    return {
        version: 1,
        entries: Object.fromEntries(Object.entries(entries)
            .sort((left, right) => right[1] - left[1])
            .slice(0, MAX_STATE_ENTRIES)),
    };
}