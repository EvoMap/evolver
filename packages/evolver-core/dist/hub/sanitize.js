// Pre-publish sanitize (ported from v1 src/gep/sanitize.js): before any asset leaves for the hub, deep-redact
// strings (30+ secret/path/email patterns) and scan for leaks (25 scanners + reverse env-value detection).
// Pure functions, never throw — the block decision is returned to the chokepoint (bindings), which raises a
// terminal PublishRejectedError. Command point: when redaction changes content the asset_id MUST be recomputed
// (computeAssetId excludes asset_id by default), else the published body hash won't match its id and the hub
// rejects it. See feedback_public_repo_no_internal_leak.
import { computeAssetId } from '../wire/index.js';
export const REDACTED = '[REDACTED]';
/** Redaction patterns (ported verbatim from v1, 30 entries). A match is replaced with [REDACTED]. */
const REDACT_PATTERNS = [
    // API keys & tokens (generic)
    /Bearer\s+[A-Za-z0-9-._~+/]+=*/g,
    /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}(?=$|[\s,;)}\]])/gi,
    /\b(?:AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,}|(?:xai|hf|glpat|dop_v1|pk_live|pk_test|sk_live|sk_test|rk_live|rk_test)[-_][A-Za-z0-9_-]{16,}|sq0(?:atp|csp)-[A-Za-z0-9_-]{16,})\b/g,
    /sk-[A-Za-z0-9]{20,}/g,
    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
    /ghp_[A-Za-z0-9]{36,}/g,
    /gho_[A-Za-z0-9]{36,}/g,
    /ghu_[A-Za-z0-9]{36,}/g,
    /ghs_[A-Za-z0-9]{36,}/g,
    /ghr_[A-Za-z0-9]{36,}/g,
    /github_pat_[A-Za-z0-9_]{22,}/g,
    // AWS access keys
    /AKIA[0-9A-Z]{16}/g,
    // OpenAI / Anthropic tokens
    /sk-proj-[A-Za-z0-9-_]{20,}/g,
    /sk-ant-[A-Za-z0-9-_]{20,}/g,
    // npm tokens
    /npm_[A-Za-z0-9]{36,}/g,
    // Slack tokens (bot/user/app/refresh/verification)
    /xox[baprsv]-[A-Za-z0-9-]{10,}/g,
    // JSON Web Tokens (header.payload.signature)
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/g,
    // Azure storage connection strings (redact the key field only)
    /AccountKey=[^;\s]+/gi,
    // Azure AD client secret + App Insights instrumentation key (value only)
    /client_secret=[A-Za-z0-9~._-]{8,}/gi,
    /instrumentationkey=[0-9a-fA-F-]{20,}/gi,
    // Discord bot tokens: three base64url segments (uppercase leading char avoids matching dotted lowercase identifiers).
    /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
    // Private keys
    /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    // Basic auth in URLs (redact only credentials, keep :// and @)
    /(?<=:\/\/)[^@\s]+:[^@\s]+(?=@)/g,
    // Email addresses
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    // .env file references — only when the dot-env token looks like a real path (preceded by a path separator) or
    // carries a suffix like `.env.production`. Bare prose mentions such as "Read from `.env` file" are intentionally
    // NOT matched: the filename itself is a convention, not a secret, and over-redacting it strips useful debugging
    // context from capsules without protecting anything the patterns above don't already cover (keys/tokens inside
    // the env file). Ported from v1 src/gep/sanitize.js (PR #151).
    /\.env\.[a-zA-Z]+\b/g,
    /(?<=[\\/])\.env\b/g,
];
// 结构化执行诊断可能来自 JSON、YAML 或键值输出，字段名与分隔符之间也可能有空格。
// 这里只识别字段前缀，值由下面两个小解析器分别读取：带引号的值读取到匹配的闭合引号，
// 不带引号的值在空白或结构分隔符处停止，避免把凭据后的普通说明文字一起吞掉。
const STRUCTURED_CREDENTIAL_PREFIX = /(?<![A-Za-z0-9_-])(["']?)(node[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|passwd|passphrase|credential|credentials|authorization|auth|bearer|cookie|dsn|webhook|signature)\1(\s*[:=]\s*)/gi;
const OPAQUE_CREDENTIAL_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9][A-Za-z0-9._~+=-]{31,}(?![A-Za-z0-9_-])/g;
const AMBIGUOUS_STRUCTURED_KEYS = new Set([
    'token', 'secret', 'credential', 'credentials', 'authorization', 'auth', 'cookie', 'signature',
]);
const DIAGNOSTIC_STATUS_VALUE = /^(?:ok|success|successful|succeeded|failed|failure|pending|missing|invalid|expired|mismatch|denied|unavailable|refresh needed|not configured|not found|none|null|true|false|enabled|disabled|present|absent|unknown|skipped|unsupported)$/i;
const DIAGNOSTIC_ASSIGNMENT_VALUE = /^(?:policy|mode|state|status|configured|enabled)=(?:ok|success|successful|succeeded|failed|failure|pending|missing|invalid|expired|mismatch|denied|unavailable|none|null|true|false|enabled|disabled|present|absent|unknown|skipped|unsupported)$/i;
function unquoteStructuredValue(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function shouldRedactStructuredField(key, rawValue) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    if (!AMBIGUOUS_STRUCTURED_KEYS.has(normalizedKey))
        return true;
    const value = unquoteStructuredValue(rawValue);
    const normalizedStatus = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!value
        || /^\[redacted\]$/i.test(value)
        || DIAGNOSTIC_STATUS_VALUE.test(normalizedStatus)
        || DIAGNOSTIC_ASSIGNMENT_VALUE.test(value))
        return false;
    if (/^(?:Bearer|Digest|NTLM|Negotiate|AWS)\s+\S+/i.test(value))
        return true;
    if (/^Basic\s+[A-Za-z0-9+/]{8,}={0,2}$/i.test(value))
        return true;
    // 歧义字段只有在值呈现紧凑凭据形态时才脱敏，保留“auth: denied by policy”等诊断上下文。
    return !/\s/.test(value) && value.length >= 8;
}
function readQuotedStructuredValue(input, start) {
    const quote = input[start];
    if (quote !== '"' && quote !== "'")
        return undefined;
    let escaped = false;
    for (let index = start + 1; index < input.length; index += 1) {
        const char = input[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === quote) {
            const end = index + 1;
            return { end, raw: input.slice(start, end), quote };
        }
        if (char === '\r' || char === '\n')
            break;
    }
    return undefined;
}
function readUnquotedStructuredValue(input, start) {
    if (input.startsWith(REDACTED, start)) {
        return { end: start + REDACTED.length, raw: REDACTED, quote: '' };
    }
    let end = start;
    while (end < input.length) {
        const char = input[end] ?? '';
        if (/[\s,;)}\]]/.test(char) || (char === ':' && /\s/.test(input[end + 1] ?? '')))
            break;
        end += 1;
    }
    if (end === start)
        return undefined;
    return { end, raw: input.slice(start, end), quote: '' };
}
function redactStructuredCredentials(input) {
    let cursor = 0;
    let output = '';
    STRUCTURED_CREDENTIAL_PREFIX.lastIndex = 0;
    let match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
    while (match) {
        if (match.index < cursor) {
            match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
            continue;
        }
        const valueStart = STRUCTURED_CREDENTIAL_PREFIX.lastIndex;
        const span = readQuotedStructuredValue(input, valueStart) ?? readUnquotedStructuredValue(input, valueStart);
        if (!span) {
            match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
            continue;
        }
        output += input.slice(cursor, valueStart);
        output += shouldRedactStructuredField(match[2] ?? '', span.raw)
            ? `${span.quote}${REDACTED}${span.quote}`
            : span.raw;
        cursor = span.end;
        STRUCTURED_CREDENTIAL_PREFIX.lastIndex = span.end;
        match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
    }
    return cursor === 0 ? input : output + input.slice(cursor);
}
function isOpaqueCredential(candidate) {
    const compact = candidate.replace(/[._~+/=-]/g, '');
    const classes = Number(/[a-z]/.test(compact)) + Number(/[A-Z]/.test(compact)) + Number(/[0-9]/.test(compact));
    if (compact.length < 24 || classes < 3 || /^[0-9a-f]+$/i.test(compact))
        return false;
    const frequencies = new Map();
    for (const char of compact)
        frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
        const probability = count / compact.length;
        return sum - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
}
// Post-filter allowlist (ported from v1 src/gep/sanitize.js, PR #151): strings the patterns above — and the path
// anonymizer below — WILL catch but that are not actually sensitive. If any entry matches a captured string it is
// kept verbatim instead of being redacted / anonymized / flagged as a leak. Keeping this as a post-filter rather
// than bolting more lookaheads into every pattern keeps the patterns readable and the carve-outs easy to audit.
const REDACT_ALLOWLIST = [
    // --- CI runner paths --- (well-known build infrastructure, no user PII)
    /^\/home\/runner(?:[/]|$)/, // GitHub Actions Linux
    /^\/Users\/runner(?:[/]|$)/, // GitHub Actions macOS
    /^\/home\/circleci(?:[/]|$)/, // CircleCI Linux
    /^\/Users\/distiller(?:[/]|$)/, // CircleCI macOS
    /^\/home\/vsts(?:[/]|$)/, // Azure Pipelines
    /^\/home\/travis(?:[/]|$)/, // Travis CI
    /^\/home\/jenkins(?:[/]|$)/, // Jenkins default
    // --- Bot / no-reply / SSH-alias addresses --- (not personal mailboxes)
    // The domain MUST be anchored to a well-known public code host. An open noreply@<anything> allowlist would leak
    // internal corp infra domains like noreply@internal-codename.corp (Bugbot PR #151 Low).
    /^(?:noreply|no-reply|donotreply|do-not-reply)@(?:github\.com|users\.noreply\.github\.com|gitlab\.com|bitbucket\.org|npmjs\.com|claude\.ai|anthropic\.com)$/i,
    /^[0-9]+\+[a-zA-Z0-9._-]+@users\.noreply\.github\.com$/i, // GitHub commit-author noreply (full digits+user form)
    // The ssh_target scanner's local part is [a-zA-Z0-9_.-]{1,64} (no `+`), so `8275028+user@users.noreply.github.com`
    // is captured as just `user@users.noreply.github.com` — the full-form anchor above can't match the truncated
    // value. Allow any local part on this domain since the domain itself is by design non-personal (Bugbot PR #151
    // round 2 Medium).
    /^[a-zA-Z0-9_.-]+@users\.noreply\.github\.com$/i,
    /^git@github\.com$/i, // SSH alias, not a real mailbox
    /^git@gitlab\.com$/i,
    /^git@bitbucket\.org$/i,
];
function isAllowlisted(match) {
    for (const re of REDACT_ALLOWLIST)
        if (re.test(match))
            return true;
    return false;
}
// Anonymize (not redact) local filesystem paths (#12): a file path is usually the gene's CONTENT ("fix
// ~/proj/src/auth.ts"), not a secret — only the user/home prefix is PII. Strip the prefix to `~`, keeping the
// rest of the path so the shared experience stays useful, instead of [REDACTED]-ing the whole thing.
const ANONYMIZE_PATTERNS = [
    [/\/(?:home|Users)\/[^/\s"',;)}\]]+/g, '~'], // /home/alice/proj → ~/proj
    [/[A-Za-z]:\\Users\\[^\\/\s"',;)}\]]+/g, '~'], // C:\Users\alice\proj → ~\proj
];
/** Apply every redaction pattern (secrets → [REDACTED]) then anonymize local paths (~/...) to a single string. */
export function redactString(s) {
    if (typeof s !== 'string' || !s)
        return s;
    let out = s;
    for (const p of REDACT_PATTERNS) {
        p.lastIndex = 0;
        out = out.replace(p, (m) => (isAllowlisted(m) ? m : REDACTED));
    }
    out = redactStructuredCredentials(out);
    OPAQUE_CREDENTIAL_PATTERN.lastIndex = 0;
    out = out.replace(OPAQUE_CREDENTIAL_PATTERN, (candidate) => (isOpaqueCredential(candidate) ? REDACTED : candidate));
    for (const [p, rep] of ANONYMIZE_PATTERNS) {
        p.lastIndex = 0;
        out = out.replace(p, (m) => (isAllowlisted(m) ? m : rep));
    }
    return out;
}
/** Deep redaction: recursively redact string values in objects/arrays (keys untouched). Returns a copy; does not mutate the input. */
export function redactDeep(v) {
    if (typeof v === 'string')
        return redactString(v);
    if (Array.isArray(v))
        return v.map((x) => redactDeep(x));
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v))
            out[k] = redactDeep(val);
        return out;
    }
    return v;
}
/**
 * Redact a single asset and RECOMPUTE its asset_id (command point). When redaction changes content, the id must
 * change with it, otherwise the published body and id disagree. computeAssetId excludes the asset_id field by
 * default; on the rare null return we fall back to the original id.
 */
export function sanitizeAsset(asset) {
    const redacted = redactDeep(asset);
    const id = computeAssetId(redacted);
    return { ...redacted, asset_id: id ?? asset.asset_id };
}
/** Leak scanners (ported verbatim from v1, 25 entries): each match yields an env-var replacement suggestion. */
const LEAK_SCANNERS = [
    { type: 'api_key', pattern: /sk-[A-Za-z0-9]{20,}/g, suggest: 'process.env.OPENAI_API_KEY' },
    { type: 'api_key', pattern: /sk-proj-[A-Za-z0-9-_]{20,}/g, suggest: 'process.env.OPENAI_API_KEY' },
    { type: 'api_key', pattern: /sk-ant-[A-Za-z0-9-_]{20,}/g, suggest: 'process.env.ANTHROPIC_API_KEY' },
    { type: 'api_key', pattern: /AKIA[0-9A-Z]{16}/g, suggest: 'process.env.AWS_ACCESS_KEY_ID' },
    { type: 'github_token', pattern: /gh(?:p|o|u|s|r)_[A-Za-z0-9]{36,}/g, suggest: 'process.env.GITHUB_TOKEN' },
    { type: 'github_token', pattern: /github_pat_[A-Za-z0-9_]{22,}/g, suggest: 'process.env.GITHUB_TOKEN' },
    { type: 'npm_token', pattern: /npm_[A-Za-z0-9]{36,}/g, suggest: 'process.env.NPM_TOKEN' },
    { type: 'slack_token', pattern: /xox[baprsv]-[A-Za-z0-9-]{10,}/g, suggest: 'process.env.SLACK_TOKEN' },
    { type: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/g, suggest: 'process.env.JWT' },
    { type: 'azure_key', pattern: /AccountKey=[^;\s]+/gi, suggest: 'process.env.AZURE_STORAGE_KEY' },
    { type: 'azure_client_secret', pattern: /client_secret=[A-Za-z0-9~._-]{8,}/gi, suggest: 'process.env.AZURE_CLIENT_SECRET' },
    { type: 'azure_instrumentation_key', pattern: /instrumentationkey=[0-9a-fA-F-]{20,}/gi, suggest: 'process.env.APPINSIGHTS_INSTRUMENTATIONKEY' },
    { type: 'discord_token', pattern: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, suggest: 'process.env.DISCORD_TOKEN' },
    { type: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9-._~+/]{20,}=*/g, suggest: 'process.env.AUTH_TOKEN' },
    { type: 'proxy_token', pattern: /"?token"?[=:]\s*["']?[A-Za-z0-9-._~+/]{16,}["']?/gi, suggest: 'proxy token (ephemeral, stored in settings.json)' },
    { type: 'private_key', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, suggest: 'process.env.PRIVATE_KEY_PATH' },
    { type: 'db_url', pattern: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s"',;)}\]]{10,}/gi, suggest: 'process.env.DATABASE_URL' },
    { type: 'local_path', pattern: /\/home\/[a-zA-Z0-9_.-]+\//g, suggest: 'process.env.HOME' },
    { type: 'local_path', pattern: /\/Users\/[a-zA-Z0-9_.-]+\//g, suggest: 'process.env.HOME' },
    { type: 'local_path', pattern: /[A-Z]:\\Users\\[a-zA-Z0-9_.-]+\\/g, suggest: 'process.env.USERPROFILE' },
    { type: 'internal_ip', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?::\d{2,5})?\b/g, suggest: 'process.env.SERVICE_HOST' },
    // Bounded quantifiers ({1,64}/{1,255}/{2,24}) instead of unbounded `+`: the unbounded user/host classes against
    // a required `@`/`.` anchor backtrack O(n^2) on long untrusted hub content (100k took ~6s — a real ReDoS, #198).
    // The bounds cover every realistic ssh target (usernames <=64, hosts <=255, TLDs <=24) and make the scan linear.
    { type: 'ssh_target', pattern: /[a-zA-Z0-9_.-]{1,64}@(?:(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24})/g, suggest: 'process.env.SSH_HOST' },
    { type: 'password', pattern: /password[=:]\s*["']?[^\s"',;)}\]]{6,}["']?/gi, suggest: 'process.env.PASSWORD' },
    { type: 'secret', pattern: /secret[=:]\s*["']?[A-Za-z0-9-._~+/]{16,}["']?/gi, suggest: 'process.env.SECRET' },
    { type: 'basic_auth', pattern: /:\/\/[^@\s:]+:[^@\s]+@/g, suggest: 'process.env.SERVICE_URL' },
];
/** Env keys skipped by the reverse-value scan (non-sensitive; ported verbatim from v1). */
const ENV_SCAN_SKIP_KEYS = new Set([
    'PATH', 'HOME', 'SHELL', 'TERM', 'LANG', 'USER', 'LOGNAME',
    'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', 'DISPLAY', 'EDITOR',
    'PAGER', 'LESS', 'LS_COLORS', 'COLORTERM', 'TERM_PROGRAM',
    'XDG_SESSION_ID', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID', '_',
]);
const ENV_VALUE_FILESYSTEM_PATH_RE = /^(\/|[A-Za-z]:\\)/;
const ENV_VALUE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SENSITIVE_ENV_KEY_PARTS = new Set([
    'WEBHOOK', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'PASSWD', 'PASSPHRASE',
    'KEY', 'CREDENTIAL', 'CREDENTIALS', 'SIGNATURE', 'SIGNED', 'DSN', 'BEARER',
    'COOKIE', 'SESSION', 'CERT', 'CERTIFICATE',
]);
const SENSITIVE_ENV_KEY_RE = /WEBHOOK|TOKEN|SECRET|PASSWORD|CREDENTIAL|SIGNATURE|SIGNED|DSN|BEARER|COOKIE|SESSION|APIKEY|ACCESSKEY|PRIVATEKEY|CERTIFICATE/;
const HIGH_RISK_URL_QUERY_KEYS = new Set([
    'token', 'access_token', 'auth', 'authorization', 'api_key', 'apikey', 'key',
    'secret', 'signature', 'sig', 'signed', 'x-amz-signature', 'x-amz-credential',
    'x-amz-security-token', 'x-goog-signature', 'x-goog-credential',
    'sharedaccesssignature',
]);
function normalizeEnvKey(key) {
    const normalized = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || key.toUpperCase();
}
function isFilesystemPathEnvValue(value) {
    return ENV_VALUE_FILESYSTEM_PATH_RE.test(value);
}
function isUrlEnvValue(value) {
    return ENV_VALUE_URL_RE.test(value);
}
function isSensitiveEnvKey(key) {
    const normalized = normalizeEnvKey(key);
    const parts = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
    if (parts.some((part) => SENSITIVE_ENV_KEY_PARTS.has(part)))
        return true;
    return SENSITIVE_ENV_KEY_RE.test(normalized);
}
function isHighRiskUrlEnvValue(value) {
    if (!isUrlEnvValue(value))
        return false;
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return false;
    }
    if (parsed.username || parsed.password)
        return true;
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (/(^|\.)hooks?\./.test(hostname) || /(^|\.)webhooks?\./.test(hostname))
        return true;
    if (/\/(?:api\/)?webhooks?\//.test(pathname) || /\/hooks?\//.test(pathname))
        return true;
    if (/\/(?:tokens?|secrets?|signed|signatures?|credentials?)\//.test(pathname))
        return true;
    for (const queryKey of parsed.searchParams.keys()) {
        if (HIGH_RISK_URL_QUERY_KEYS.has(queryKey.toLowerCase()))
            return true;
    }
    return false;
}
function shouldSkipEnvValueReverseScan(key, value) {
    if (isSensitiveEnvKey(key))
        return false;
    if (isFilesystemPathEnvValue(value))
        return true;
    if (isUrlEnvValue(value) && !isHighRiskUrlEnvValue(value))
        return true;
    return false;
}
const clip = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);
/** Pattern-scan content for sensitive info. Does not mutate content; returns a structured result. */
export function scanForLeaks(content) {
    if (typeof content !== 'string' || !content)
        return { found: false, leaks: [] };
    const leaks = [];
    const seen = new Set();
    for (const scanner of LEAK_SCANNERS) {
        scanner.pattern.lastIndex = 0;
        let m;
        while ((m = scanner.pattern.exec(content)) !== null) {
            const val = m[0];
            // Apply the same allowlist redactString uses: CI runner roots and bot/no-reply/SSH-alias addresses are not
            // leaks. Without this, strict-mode sanitizeBundle would block a publish over a `/home/runner/` path or
            // `noreply@github.com` (an ssh_target) — exactly the false positives the allowlist exists to fix, and a
            // contradiction with redactString, which keeps them verbatim (Bugbot PR #151 Medium).
            if (isAllowlisted(val))
                continue;
            const key = scanner.type + ':' + val;
            if (seen.has(key))
                continue;
            seen.add(key);
            leaks.push({ type: scanner.type, value: clip(val), suggestion: scanner.suggest });
        }
    }
    return { found: leaks.length > 0, leaks };
}
/** Reverse detection: if any process.env value (>=8 chars) appears verbatim in content, an env value was hardcoded and should be replaced with the env reference. */
export function detectEnvValueLeaks(content, env) {
    if (typeof content !== 'string' || !content)
        return [];
    const leaks = [];
    for (const [key, val] of Object.entries(env)) {
        if (!val || val.length < 8)
            continue;
        if (ENV_SCAN_SKIP_KEYS.has(normalizeEnvKey(key)))
            continue;
        // Env paths and ordinary URLs are often reproducible runtime metadata; sensitive keys and high-risk URLs still scan.
        if (shouldSkipEnvValueReverseScan(key, val))
            continue;
        if (content.includes(val))
            leaks.push({ type: 'env_value_leak', value: REDACTED, suggestion: 'process.env.' + key });
    }
    return leaks;
}
/** Full leak check: pattern scan + reverse env-value detection. */
export function fullLeakCheck(content, env) {
    const scan = scanForLeaks(content);
    const envLeaks = detectEnvValueLeaks(content, env);
    const all = scan.leaks.concat(envLeaks);
    return { found: all.length > 0, leaks: all };
}
/** Leak types that are PII (anonymized, not credentials) and so must NOT hard-block a strict publish (#12). */
const PII_ONLY_LEAK_TYPES = new Set(['local_path']);
/** Read the leak-check mode from env (EVOLVER_LEAK_CHECK, default strict, matching v1). */
export function leakCheckModeFromEnv(env) {
    const v = (env['EVOLVER_LEAK_CHECK'] ?? '').toLowerCase();
    return v === 'warn' || v === 'off' ? v : 'strict';
}
/**
 * Pre-publish sanitize of a bundle (pure, never throws):
 * 1) mode != off: scan the ORIGINAL (pre-redaction) content for leaks; strict + found → blocked=true (chokepoint refuses); warn → flag only.
 * 2) REGARDLESS of mode, always deep-redact every asset + recompute asset_id (the leak-proof floor; off only skips the scan, not the redaction).
 */
export function sanitizeBundle(bundle, opts) {
    const mode = opts.mode ?? leakCheckModeFromEnv(opts.env);
    let leaks = [];
    if (mode !== 'off') {
        const combined = bundle.map((a) => JSON.stringify(a)).join('');
        leaks = fullLeakCheck(combined, opts.env).leaks;
    }
    // #12: a bare local path is PII (anonymized to ~/ by the redaction floor), not a credential — it must not
    // hard-block a publish in strict mode. Real secrets (everything else) still block. Path leaks stay reported.
    const blocked = mode === 'strict' && leaks.some((l) => !PII_ONLY_LEAK_TYPES.has(l.type));
    const sanitized = bundle.map((a) => sanitizeAsset(a));
    return { bundle: sanitized, blocked, leaks, mode };
}
/** Collapse a leak list into a one-line human-readable summary (for logs / rejection reason). */
export function summarizeLeaks(leaks) {
    return leaks.map((l) => `${l.type}→${l.suggestion}`).join('; ');
}