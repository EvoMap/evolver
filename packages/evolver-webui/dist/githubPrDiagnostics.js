import { execFile } from 'node:child_process';
import { redactDiagnosticText } from './diagnosticSanitize.js';
export const GITHUB_PR_TIMEOUT_MS = 15_000;
export const GITHUB_PR_MAX_BUFFER_BYTES = 512 * 1024;
export const GITHUB_PR_CACHE_TTL_MS = 45_000;
export const GITHUB_PR_MAX_ITEMS = 50;
const GH_FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,reviewDecision,statusCheckRollup';
export const defaultGithubPrRunner = async (command, args, options) => new Promise((resolve) => {
    execFile(command, [...args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        shell: options.shell,
        windowsHide: true,
    }, (error, stdout) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
    });
});
function boundedInteger(value, fallback, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(maximum, Math.floor(value)));
}
function safeText(value, maxChars) {
    return redactDiagnosticText(value, maxChars);
}
function safeGithubUrl(value) {
    if (typeof value !== 'string' || value.length > 2_000)
        return null;
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.port || (hostname !== 'github.com' && !hostname.endsWith('.github.com')))
            return null;
        url.username = '';
        url.password = '';
        url.hash = '';
        url.search = '';
        return url.toString().slice(0, 2_000);
    }
    catch {
        return null;
    }
}
function safeState(value) {
    const state = String(value ?? '').toUpperCase();
    return state === 'OPEN' || state === 'CLOSED' || state === 'MERGED' ? state : 'UNKNOWN';
}
function safeReviewDecision(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const decision = String(value).toUpperCase();
    return decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED'
        ? decision
        : 'UNKNOWN';
}
function safeTimestamp(value) {
    if (typeof value !== 'string')
        return null;
    const text = safeText(value, 64);
    return Number.isNaN(Date.parse(text)) ? null : text;
}
function checkCounts(value) {
    const counts = { total: 0, passed: 0, failed: 0, pending: 0 };
    if (!Array.isArray(value))
        return counts;
    for (const raw of value.slice(0, 200)) {
        const record = raw && typeof raw === 'object' ? raw : {};
        const status = String(record['conclusion'] ?? record['state'] ?? record['status'] ?? '').toUpperCase();
        counts.total += 1;
        if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(status))
            counts.passed += 1;
        else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(status))
            counts.failed += 1;
        else
            counts.pending += 1;
    }
    return counts;
}
function parsePr(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const record = raw;
    const number = typeof record['number'] === 'number' ? Math.floor(record['number']) : Number.NaN;
    const url = safeGithubUrl(record['url']);
    if (!Number.isSafeInteger(number) || number <= 0 || !url)
        return null;
    return {
        number,
        title: safeText(record['title'], 300),
        url,
        state: safeState(record['state']),
        isDraft: record['isDraft'] === true,
        head: safeText(record['headRefName'], 200),
        base: safeText(record['baseRefName'], 200),
        updatedAt: safeTimestamp(record['updatedAt']),
        reviewDecision: safeReviewDecision(record['reviewDecision']),
        checks: checkCounts(record['statusCheckRollup']),
    };
}
async function loadGithubPrDiagnostics(runner, options) {
    try {
        const result = await runner('gh', [
            'pr', 'list', '--state', 'all', '--limit', String(options.maxItems), '--json', GH_FIELDS,
        ], {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            timeoutMs: GITHUB_PR_TIMEOUT_MS,
            maxBufferBytes: GITHUB_PR_MAX_BUFFER_BYTES,
            shell: false,
        });
        if (result.code !== 0)
            return { available: false, error: 'github_pr_unavailable' };
        let raw;
        try {
            raw = JSON.parse(result.stdout || '[]');
        }
        catch {
            return { available: false, error: 'github_pr_invalid_response' };
        }
        if (!Array.isArray(raw))
            return { available: false, error: 'github_pr_invalid_response' };
        const selected = raw.slice(0, options.maxItems);
        const prs = selected.map(parsePr).filter((row) => row !== null);
        return {
            available: true,
            data: {
                prs,
                truncated: raw.length > selected.length || prs.length < selected.length,
                refreshedAt: new Date(options.now()).toISOString(),
            },
        };
    }
    catch {
        return { available: false, error: 'github_pr_unavailable' };
    }
}
export function createGithubPrDiagnosticsProvider(options = {}) {
    const runner = options.runner ?? defaultGithubPrRunner;
    const now = options.now ?? Date.now;
    const requestedTtl = boundedInteger(options.ttlMs, GITHUB_PR_CACHE_TTL_MS, 60_000);
    const ttlMs = Math.max(30_000, requestedTtl);
    const maxItems = boundedInteger(options.maxItems, GITHUB_PR_MAX_ITEMS, GITHUB_PR_MAX_ITEMS);
    let cached = null;
    let inflight = null;
    return {
        read() {
            const current = now();
            if (cached && current - cached.at < ttlMs)
                return Promise.resolve(cached.value);
            if (inflight)
                return inflight;
            inflight = loadGithubPrDiagnostics(runner, { cwd: options.cwd, now, maxItems })
                .then((value) => {
                if (value.available)
                    cached = { at: now(), value };
                return value;
            })
                .finally(() => { inflight = null; });
            return inflight;
        },
    };
}