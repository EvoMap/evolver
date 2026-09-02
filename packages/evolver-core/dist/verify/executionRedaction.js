export const EXECUTION_REDACTION_POLICY_VERSION = 'execution-redaction.v1';
export const EXECUTION_REDACTED = '[REDACTED]';
const MAX_EXECUTION_TEXT_LENGTH = 64 * 1024;
// These expressions intentionally exclude email and filesystem paths. Execution evidence needs those diagnostics,
// while credential-bearing URL authorities, authorization headers, private keys, and provider tokens remain secret.
const KNOWN_CREDENTIAL_PATTERNS = [
    /Bearer\s+[A-Za-z0-9-._~+/]+=*/gi,
    /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}(?=$|[\s,;)}\]])/gi,
    /\b(?:AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,}|(?:xai|hf|glpat|dop_v1|pk_live|pk_test|sk_live|sk_test|rk_live|rk_test)[-_][A-Za-z0-9_-]{16,}|sq0(?:atp|csp)-[A-Za-z0-9_-]{16,})\b/g,
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36,})\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
    /\bxox[baprsv]-[A-Za-z0-9-]{10,}\b/g,
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/g,
    /AccountKey=[^;\s]+/gi,
    /instrumentationkey=[0-9a-f-]{20,}/gi,
    /https:\/\/(?:hooks\.slack\.com\/services|(?:discord(?:app)?\.com)\/api\/webhooks)\/[^\s"']+/gi,
    /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    /(?<=:\/\/)[^@\s]+:[^@\s]+(?=@)/g,
];
const SENSITIVE_NAMES = new Set([
    'access-key', 'access-key-id', 'access-token', 'api-key', 'apikey', 'auth', 'authorization',
    'bearer', 'client-secret', 'cookie', 'credential', 'credentials', 'dsn', 'id-token', 'key',
    'node-secret', 'pass', 'passwd', 'password', 'passphrase', 'private-key', 'refresh-token',
    'secret', 'secret-access-key', 'secret-key', 'session', 'session-token', 'signature', 'signed',
    'token', 'webhook',
]);
const SENSITIVE_NAME_PARTS = new Set([
    'auth', 'authorization', 'bearer', 'cookie', 'credential', 'credentials', 'dsn', 'key',
    'pass', 'passwd', 'password', 'passphrase', 'secret', 'signature', 'signed', 'token', 'webhook',
]);
const HEADER_FLAGS = new Set(['-H', '--header']);
const CURL_EXECUTABLES = new Set(['curl']);
const CURL_CREDENTIAL_FLAGS = new Set(['-u', '--user', '--proxy-user']);
const SHELL_EXECUTABLES = new Set(['bash', 'cmd', 'dash', 'fish', 'ksh', 'nu', 'powershell', 'pwsh', 'sh', 'zsh']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '-command']);
const STRUCTURED_CREDENTIAL_PREFIX = /(?<![A-Za-z0-9_-])(["']?)(node[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|passwd|passphrase|credential|credentials|authorization|auth|bearer|cookie|dsn|webhook|signature)\1(\s*[:=]\s*)/gi;
const DIAGNOSTIC_STATUS_VALUE = /^(?:ok|success|successful|succeeded|failed|failure|pending|missing|invalid|expired|mismatch|denied|unavailable|refresh needed|not configured|not found|none|null|true|false|enabled|disabled|present|absent|unknown|skipped|unsupported)$/i;
const DIAGNOSTIC_ASSIGNMENT_VALUE = /^(?:policy|mode|state|status|configured|enabled)=(?:ok|success|successful|succeeded|failed|failure|pending|missing|invalid|expired|mismatch|denied|unavailable|none|null|true|false|enabled|disabled|present|absent|unknown|skipped|unsupported)$/i;
function normalizeName(value) {
    return value.replace(/^--?/, '').replace(/_/g, '-').toLowerCase();
}
function isSensitiveName(value) {
    const normalized = normalizeName(value);
    if (SENSITIVE_NAMES.has(normalized))
        return true;
    const parts = normalized.split('-').filter(Boolean);
    return parts.some((part) => SENSITIVE_NAME_PARTS.has(part));
}
function tokenizeWithoutExecution(input) {
    const tokens = [];
    let index = 0;
    let malformed = false;
    while (index < input.length) {
        if (/\s/.test(input[index] ?? '')) {
            index += 1;
            continue;
        }
        const start = index;
        if (/[|&;()]/.test(input[index] ?? '')) {
            const raw = input.slice(start, start + 1);
            tokens.push({ start, end: start + 1, raw, semantic: raw, separator: true });
            index += 1;
            continue;
        }
        let quote = '';
        let escaped = false;
        let semantic = '';
        while (index < input.length) {
            const char = input[index] ?? '';
            if (escaped) {
                semantic += char;
                escaped = false;
                index += 1;
                continue;
            }
            if (char === '\\' && quote !== "'") {
                escaped = true;
                index += 1;
                continue;
            }
            if (quote) {
                if (char === quote)
                    quote = '';
                else
                    semantic += char;
                index += 1;
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
                index += 1;
                continue;
            }
            if (/\s/.test(char) || /[|&;()]/.test(char))
                break;
            semantic += char;
            index += 1;
        }
        if (quote || escaped)
            malformed = true;
        tokens.push({ start, end: index, raw: input.slice(start, index), semantic, separator: false });
    }
    return { tokens, malformed };
}
function outerQuote(raw) {
    const first = raw[0] ?? '';
    return raw.length >= 2 && (first === '"' || first === "'") && raw.at(-1) === first ? first : '';
}
function semanticValue(raw) {
    const quote = outerQuote(raw);
    return quote ? raw.slice(1, -1) : raw;
}
function redactedValue(raw) {
    const quote = outerQuote(raw);
    return quote ? `${quote}${EXECUTION_REDACTED}${quote}` : EXECUTION_REDACTED;
}
function unquotedEquals(raw) {
    let quote = '';
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index] ?? '';
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\' && quote !== "'") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote)
                quote = '';
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '=')
            return index;
    }
    return -1;
}
function isClearlyNonSecret(value) {
    const candidate = semanticValue(value).trim();
    if (!candidate || candidate === EXECUTION_REDACTED)
        return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate))
        return true;
    if (/^(?:[A-Za-z]:[\\/]|[.~]{0,2}[\\/]|\\\\)/.test(candidate))
        return true;
    if (/[\\/]/.test(candidate) && /[\\/][^\\/]+\.[A-Za-z0-9]{1,12}(?:$|[?#])/.test(candidate))
        return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate))
        return true;
    if (/^(?:sha(?:1|256|512):)?[0-9a-f]{32,128}$/i.test(candidate))
        return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate))
        return true;
    if (/^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate))
        return true;
    return false;
}
function isHighEntropyCredential(raw) {
    const candidate = semanticValue(raw).trim();
    if (isClearlyNonSecret(candidate) || /\s/.test(candidate))
        return false;
    const compact = candidate.replace(/[._~+/=-]/g, '');
    const classes = Number(/[a-z]/.test(compact)) + Number(/[A-Z]/.test(compact)) + Number(/[0-9]/.test(compact));
    if (compact.length < 24 || /^[0-9a-f]+$/i.test(compact))
        return false;
    const frequencies = new Map();
    for (const char of compact)
        frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
        const probability = count / compact.length;
        return sum - probability * Math.log2(probability);
    }, 0);
    return classes >= 3 ? entropy >= 3.5 : compact.length >= 32 && entropy >= 4.2;
}
function readStructuredValue(input, start) {
    const quote = input[start] ?? '';
    if (quote === '"' || quote === "'") {
        let escaped = false;
        for (let index = start + 1; index < input.length; index += 1) {
            const char = input[index] ?? '';
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote)
                return { end: index + 1, raw: input.slice(start, index + 1), quote };
            if (char === '\r' || char === '\n')
                return undefined;
        }
        return undefined;
    }
    if (input.startsWith(EXECUTION_REDACTED, start)) {
        return { end: start + EXECUTION_REDACTED.length, raw: EXECUTION_REDACTED, quote: '' };
    }
    let end = start;
    while (end < input.length && !/[\s,;)}\]]/.test(input[end] ?? ''))
        end += 1;
    return end > start ? { end, raw: input.slice(start, end), quote: '' } : undefined;
}
function structuredValueIsDiagnostic(key, raw) {
    const normalizedKey = normalizeName(key);
    if (!new Set(['token', 'secret', 'credential', 'credentials', 'authorization', 'auth', 'cookie', 'signature']).has(normalizedKey))
        return false;
    const value = semanticValue(raw).trim();
    const status = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return !value || value === EXECUTION_REDACTED || DIAGNOSTIC_STATUS_VALUE.test(status) || DIAGNOSTIC_ASSIGNMENT_VALUE.test(value);
}
function redactStructuredCredentials(input, reasons) {
    let cursor = 0;
    let output = '';
    STRUCTURED_CREDENTIAL_PREFIX.lastIndex = 0;
    let match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
    while (match) {
        const valueStart = STRUCTURED_CREDENTIAL_PREFIX.lastIndex;
        const span = readStructuredValue(input, valueStart);
        if (!span || structuredValueIsDiagnostic(match[2] ?? '', span.raw)) {
            match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
            continue;
        }
        output += input.slice(cursor, valueStart);
        output += `${span.quote}${EXECUTION_REDACTED}${span.quote}`;
        reasons.add('known_credential');
        cursor = span.end;
        STRUCTURED_CREDENTIAL_PREFIX.lastIndex = span.end;
        match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
    }
    return cursor === 0 ? input : output + input.slice(cursor);
}
function redactKnownCredentials(input, reasons) {
    const quote = outerQuote(input);
    if (quote) {
        const inner = redactKnownCredentials(input.slice(1, -1), reasons);
        return `${quote}${inner}${quote}`;
    }
    let output = input;
    for (const pattern of KNOWN_CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        output = output.replace(pattern, (match) => {
            if (match === EXECUTION_REDACTED)
                return match;
            reasons.add('known_credential');
            return EXECUTION_REDACTED;
        });
    }
    return redactStructuredCredentials(output, reasons);
}
function redactHeaderCredential(raw, reasons) {
    const quote = outerQuote(raw);
    const value = semanticValue(raw);
    const colon = value.indexOf(':');
    if (colon <= 0 || !isSensitiveName(value.slice(0, colon)))
        return raw;
    const headerValue = value.slice(colon + 1);
    if (!headerValue.trim() || headerValue.trim() === EXECUTION_REDACTED)
        return raw;
    const spacing = /^\s*/.exec(headerValue)?.[0] ?? '';
    reasons.add('sensitive_flag');
    const redacted = `${value.slice(0, colon + 1)}${spacing}${EXECUTION_REDACTED}`;
    return quote ? `${quote}${redacted}${quote}` : redacted;
}
function redactUrlQueryCredentials(raw, reasons) {
    const quote = outerQuote(raw);
    const value = semanticValue(raw);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return raw;
    const redacted = value.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator, encodedKey, encodedValue) => {
        let key = encodedKey;
        let candidate = encodedValue;
        try {
            key = decodeURIComponent(encodedKey);
        }
        catch { /* retain encoded form */ }
        try {
            candidate = decodeURIComponent(encodedValue);
        }
        catch { /* retain encoded form */ }
        if (!isSensitiveName(key) && !isHighEntropyCredential(candidate))
            return match;
        reasons.add(isSensitiveName(key) ? 'sensitive_assignment' : 'high_entropy_value');
        return `${separator}${encodedKey}=${EXECUTION_REDACTED}`;
    });
    return quote ? `${quote}${redacted}${quote}` : redacted;
}
function replacementForValue(raw, force, reason, reasons) {
    if (!semanticValue(raw).trim())
        return raw;
    const urlSafe = redactUrlQueryCredentials(raw, reasons);
    const known = redactKnownCredentials(urlSafe, reasons);
    if (known !== raw)
        return known;
    if (!force && !isHighEntropyCredential(raw))
        return raw;
    reasons.add(force ? reason : 'high_entropy_value');
    return redactedValue(raw);
}
function nextValueToken(tokens, start) {
    for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token)
            continue;
        if (token.separator)
            return undefined;
        return index;
    }
    return undefined;
}
function executableTokenIndexes(tokens, names) {
    const indexes = new Set();
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token || token.separator)
            continue;
        const name = token.semantic.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
        if (names.has(name))
            indexes.add(index);
    }
    return indexes;
}
function sanitizeText(input) {
    const reasons = new Set();
    if (input.length > MAX_EXECUTION_TEXT_LENGTH) {
        reasons.add('input_too_large');
        return { value: EXECUTION_REDACTED, changed: input !== EXECUTION_REDACTED, malformed: true, reasons };
    }
    if (input.includes('\0')) {
        reasons.add('malformed_input');
        return { value: EXECUTION_REDACTED, changed: input !== EXECUTION_REDACTED, malformed: true, reasons };
    }
    const parsed = tokenizeWithoutExecution(input);
    if (parsed.malformed) {
        reasons.add('malformed_input');
        return { value: EXECUTION_REDACTED, changed: input !== EXECUTION_REDACTED, malformed: true, reasons };
    }
    const replacements = new Map();
    const shellIndexes = executableTokenIndexes(parsed.tokens, SHELL_EXECUTABLES);
    const curlIndexes = executableTokenIndexes(parsed.tokens, CURL_EXECUTABLES);
    let seenShell = false;
    let seenCurl = false;
    for (let index = 0; index < parsed.tokens.length; index += 1) {
        const token = parsed.tokens[index];
        if (!token || token.separator || replacements.has(index))
            continue;
        const raw = token.raw;
        const semantic = token.semantic;
        seenShell ||= shellIndexes.has(index);
        seenCurl ||= curlIndexes.has(index);
        const equals = unquotedEquals(raw);
        const semanticEquals = semantic.indexOf('=');
        if (semanticEquals > 0) {
            const semanticName = semantic.slice(0, semanticEquals);
            const semanticAssignmentValue = semantic.slice(semanticEquals + 1);
            const rawName = equals > 0 ? raw.slice(0, equals) : semanticName;
            const value = equals > 0 ? raw.slice(equals + 1) : semanticAssignmentValue;
            const assignment = /^[A-Za-z_][A-Za-z0-9_]*$/.test(semanticName);
            const flag = /^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(semanticName);
            if (assignment || flag) {
                const sensitive = isSensitiveName(semanticName);
                const headerFlag = HEADER_FLAGS.has(semanticName) || HEADER_FLAGS.has(semanticName.toLowerCase());
                const curlCredentialFlag = seenCurl && CURL_CREDENTIAL_FLAGS.has(semanticName.toLowerCase());
                const headerRedacted = headerFlag ? redactHeaderCredential(value, reasons) : value;
                const replaced = headerRedacted !== value
                    ? headerRedacted
                    : replacementForValue(value, sensitive || curlCredentialFlag, assignment ? 'sensitive_assignment' : 'sensitive_flag', reasons);
                if (replaced !== value) {
                    const replacement = `${rawName}=${replaced}`;
                    const quote = equals < 0 ? outerQuote(raw) : '';
                    replacements.set(index, quote ? `${quote}${replacement}${quote}` : replacement);
                }
                continue;
            }
        }
        const lower = semantic.toLowerCase();
        const curlShortAttached = seenCurl && /^-u(.+)$/i.exec(semantic);
        if (curlShortAttached) {
            const quote = outerQuote(raw);
            const replacement = `-u${EXECUTION_REDACTED}`;
            replacements.set(index, quote ? `${quote}${replacement}${quote}` : replacement);
            reasons.add('sensitive_flag');
            continue;
        }
        if (seenCurl && CURL_CREDENTIAL_FLAGS.has(lower)) {
            const next = nextValueToken(parsed.tokens, index + 1);
            if (next !== undefined) {
                const nextRaw = parsed.tokens[next]?.raw ?? '';
                replacements.set(next, replacementForValue(nextRaw, true, 'sensitive_flag', reasons));
            }
            continue;
        }
        if (seenShell && SHELL_COMMAND_FLAGS.has(lower)) {
            const next = nextValueToken(parsed.tokens, index + 1);
            if (next !== undefined) {
                const nextRaw = parsed.tokens[next]?.raw ?? '';
                if (semanticValue(nextRaw).trim()) {
                    replacements.set(next, redactedValue(nextRaw));
                    reasons.add('nested_command');
                }
            }
            continue;
        }
        if (isSensitiveName(semantic)) {
            const next = nextValueToken(parsed.tokens, index + 1);
            if (next !== undefined) {
                const nextRaw = parsed.tokens[next]?.raw ?? '';
                replacements.set(next, replacementForValue(nextRaw, true, 'sensitive_flag', reasons));
            }
            continue;
        }
        if (HEADER_FLAGS.has(semantic) || HEADER_FLAGS.has(lower)) {
            const next = nextValueToken(parsed.tokens, index + 1);
            if (next !== undefined) {
                const nextRaw = parsed.tokens[next]?.raw ?? '';
                const headerRedacted = redactHeaderCredential(nextRaw, reasons);
                const replaced = headerRedacted !== nextRaw
                    ? headerRedacted
                    : replacementForValue(nextRaw, false, 'sensitive_flag', reasons);
                if (replaced !== nextRaw)
                    replacements.set(next, replaced);
            }
            continue;
        }
        const replaced = replacementForValue(raw, false, 'high_entropy_value', reasons);
        if (replaced !== raw)
            replacements.set(index, replaced);
    }
    let cursor = 0;
    let output = '';
    for (let index = 0; index < parsed.tokens.length; index += 1) {
        const token = parsed.tokens[index];
        if (!token)
            continue;
        output += input.slice(cursor, token.start);
        output += replacements.get(index) ?? token.raw;
        cursor = token.end;
    }
    output += input.slice(cursor);
    output = redactKnownCredentials(output, reasons);
    return { value: output, changed: output !== input, malformed: false, reasons };
}
function result(value, mode) {
    const sanitized = sanitizeText(value);
    return {
        value: sanitized.value,
        changed: sanitized.changed,
        blocked: sanitized.malformed || (mode === 'command' && sanitized.changed),
        policyVersion: EXECUTION_REDACTION_POLICY_VERSION,
        reasons: [...sanitized.reasons],
    };
}
export function sanitizeExecutionCommand(value) {
    return result(String(value ?? ''), 'command');
}
export function sanitizeExecutionDiagnostic(value) {
    return result(String(value ?? ''), 'diagnostic');
}
const COMMAND_KEYS = new Set(['cmd', 'command']);
const COMMAND_ARRAY_KEYS = new Set(['validation', 'verification', 'validation_commands']);
/**
 * Common safe outlet for verifier receipts, IPC responses, persisted execution evidence, logs, and Hub payloads.
 * Command changes propagate `blocked=true`; callers must not execute or promote that evidence after redaction.
 */
export function sanitizeExecutionPayload(input) {
    const reasons = new Set();
    let changed = false;
    let blocked = false;
    const walk = (value, key = '', commandArray = false) => {
        if (typeof value === 'string') {
            const sanitized = commandArray || COMMAND_KEYS.has(key)
                ? sanitizeExecutionCommand(value)
                : sanitizeExecutionDiagnostic(value);
            changed ||= sanitized.changed;
            blocked ||= sanitized.blocked;
            for (const reason of sanitized.reasons)
                reasons.add(reason);
            return sanitized.value;
        }
        if (Array.isArray(value))
            return value.map((entry) => walk(entry, key, commandArray || COMMAND_ARRAY_KEYS.has(key)));
        if (value && typeof value === 'object') {
            const output = {};
            for (const [childKey, childValue] of Object.entries(value)) {
                output[childKey] = walk(childValue, childKey, COMMAND_ARRAY_KEYS.has(childKey));
            }
            return output;
        }
        return value;
    };
    return {
        value: walk(input),
        changed,
        blocked,
        policyVersion: EXECUTION_REDACTION_POLICY_VERSION,
        reasons: [...reasons],
    };
}