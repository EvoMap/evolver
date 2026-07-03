// Native request/response BODY capture for LLM traces.
//
// V1-COMPATIBLE DEFAULT: body capture is enabled unless explicitly downgraded with EVOMAP_PROXY_TRACE=metadata/off
// or EVOLVER_LLM_TRACE_CAPTURE_BODIES=0. Captured bodies still go through redaction + size caps, and trace storage
// must fail closed into an encrypted envelope unless the operator explicitly disables trace encryption.
//
// COMPLIANCE GATE: enabling this on real user traffic is a product/compliance decision (user consent, disclosure,
// retention policy). Operators that need metadata-only traces must explicitly configure that downgrade so it is a
// deliberate deployment choice rather than an accidental default.
//
import { createHash } from 'node:crypto';
// Redaction here is best-effort structural scrubbing (emails, phones, card numbers, bearer/api keys, JWTs) plus a
// hard Hub/envelope-sized cap. It is NOT a substitute for a real downstream redaction/PII policy; it exists so
// that captured bodies are never stored fully raw, and so the `redaction` marker on a row reflects an actual pass.
// When a body exceeds the cap, do not keep a preview: downstream must treat the turn as incomplete, not as a
// smaller-but-usable body.
/** Bump when the redaction ruleset changes so downstream can tell which scrub a row went through. */
export const REDACTION_VERSION = 'evolver-redact-v2';
function truthy(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}
function firstConfiguredEnv(env, names) {
    for (const name of names) {
        const value = env[name];
        if (value !== undefined && value.trim() !== '')
            return value;
    }
    return undefined;
}
export function legacyProxyTraceFullEnabled(env = process.env) {
    const raw = env['EVOMAP_PROXY_TRACE'];
    if (raw === undefined || raw.trim() === '')
        return true;
    return raw.trim().toLowerCase() === 'full';
}
/**
 * Native body capture switch. Defaults to the v1-compatible full trace mode, but explicit v2 capture flags win so
 * operators can disable body capture without also setting the legacy EVOMAP_PROXY_TRACE knob.
 */
export function captureBodiesEnabled(env = process.env) {
    const explicitCapture = firstConfiguredEnv(env, [
        'EVOLVER_LLM_TRACE_CAPTURE_BODIES',
        'EVOMAP_PROXY_TRACE_CAPTURE_BODIES',
    ]);
    if (explicitCapture !== undefined)
        return truthy(explicitCapture);
    return legacyProxyTraceFullEnabled(env);
}
/** Default per-body cap (bytes), aligned with the public Hub mailbox outbound envelope limit. A single trace may
 * still exceed the final encrypted outbound envelope when it carries multiple large bodies; in that case the row
 * is explicitly marked incomplete rather than silently downgraded to a preview. */
export const DEFAULT_TRACE_ENVELOPE_MAX_CHARS = 4 * 1024 * 1024;
const AUTHORIZATION_KEY_RE = /^(?:proxy[-_]?)?authorization$/i;
const AUTHORIZATION_VALUE_RE = /^(\s*[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+)[\s\S]+$/;
function redactAuthorizationValue(value) {
    const match = AUTHORIZATION_VALUE_RE.exec(value);
    if (match?.[1])
        return `${match[1]}[REDACTED_TOKEN]`;
    return value.trim() ? '[REDACTED_TOKEN]' : value;
}
export function bodyMaxChars(env = process.env) {
    return positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_BODY_MAX_CHARS', 'EVOMAP_PROXY_TRACE_MAX_FIELD_BYTES'], traceEnvelopeMaxChars(env));
}
export function traceEnvelopeMaxChars(env = process.env) {
    return positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_ENVELOPE_MAX_CHARS', 'EVOMAP_PROXY_TRACE_ENVELOPE_MAX_BYTES'], DEFAULT_TRACE_ENVELOPE_MAX_CHARS);
}
export function positiveIntegerFromEnv(env, names, fallback) {
    for (const name of names) {
        const raw = Number(env[name]);
        if (Number.isSafeInteger(raw) && raw > 0)
            return raw;
    }
    return fallback;
}
const REDACTORS = [
    // Env/config dump lines such as FOO_API_KEY=... or "fooToken": "...". Keep the key name; replace only value.
    { re: /(\b[A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PRIVATE[_-]?KEY)\b\s*[:=]\s*)(["']?)([^"'\s,}\]]{6,})\2/gi, with: '$1[REDACTED_SECRET]' },
    // Plain upstream error pages often echo HTTP headers outside JSON.
    {
        re: /(\b(?:proxy-)?authorization\s*:\s*)([^\r\n]+)/gi,
        with: (_match, prefix, value) => `${String(prefix)}${redactAuthorizationValue(String(value ?? ''))}`,
    },
    // JSON/text fragments such as {"Authorization":"Bearer ..."} or escaped {\"Proxy-Authorization\":\"Basic ...\"}.
    {
        re: /((?:\\?["'])\s*(?:proxy-)?authorization\s*(?:\\?["'])\s*:\s*(?:\\?["']))((?:(?!\\?["'])[\s\S])*?)((?:\\?["']))/gi,
        with: (_match, prefix, value, suffix) => `${String(prefix)}${redactAuthorizationValue(String(value ?? ''))}${String(suffix)}`,
    },
    { re: /(\bcookie\s*:\s*)[^\r\n]+/gi, with: '$1[REDACTED_COOKIE]' },
    // PEM private keys.
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, with: '[REDACTED_PRIVATE_KEY]' },
    // Bearer tokens / Authorization header values.
    { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g, with: 'Bearer [REDACTED_TOKEN]' },
    // Provider API keys (OpenAI sk-..., Anthropic sk-ant-..., generic long secret-ish keys).
    { re: /\bsk-(?:ant-)?[A-Za-z0-9._-]{16,}/g, with: '[REDACTED_API_KEY]' },
    // GitHub personal access tokens.
    { re: /\bghp_[A-Za-z0-9_]{20,}\b/g, with: '[REDACTED_GITHUB_TOKEN]' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, with: '[REDACTED_GITHUB_TOKEN]' },
    // Slack bot/user/app tokens.
    { re: /\bxox[abcprs]-[A-Za-z0-9-]{10,}\b/g, with: '[REDACTED_SLACK_TOKEN]' },
    // Common key/value credentials in text, JSON, YAML, query strings, and form bodies.
    {
        re: /((?:"|')?\b(?:api[_-]?key|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token)\b(?:"|')?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*')/gi,
        with: '$1"[REDACTED_CREDENTIAL]"',
    },
    {
        re: /((?:"|')?\b(?:api[_-]?key|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token)\b(?:"|')?\s*[:=]\s*)(?!["'])[^\r\n,&}]+/gi,
        with: '$1[REDACTED_CREDENTIAL]',
    },
    // AWS access key ids.
    { re: /\bAKIA[0-9A-Z]{16}\b/g, with: '[REDACTED_AWS_KEY]' },
    // JWTs (three base64url segments).
    { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, with: '[REDACTED_JWT]' },
    // Email addresses.
    { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, with: '[REDACTED_EMAIL]' },
    // Credit-card-like 13-19 digit runs (allowing spaces/dashes).
    { re: /\b(?:\d[ -]?){13,19}\b/g, with: '[REDACTED_CARD]', structuredIdentifierSafe: false },
    // Long digit runs that look like phone numbers / national ids (11+ digits, optional +).
    { re: /\+?\d[\d\s-]{9,}\d/g, with: '[REDACTED_NUMBER]', structuredIdentifierSafe: false },
];
function applyRedactors(input, options = {}) {
    let out = input;
    for (const r of REDACTORS) {
        if (options.preserveStructuredIdentifierNumbers === true && r.structuredIdentifierSafe === false)
            continue;
        const replacement = r.with;
        out = typeof replacement === 'string'
            ? out.replace(r.re, replacement)
            : out.replace(r.re, (...args) => replacement(args[0], ...args.slice(1)));
    }
    return out;
}
/** Apply the redaction ruleset to a string. Pure; safe on arbitrary text. */
export function redactText(input) {
    return applyRedactors(input);
}
const SENSITIVE_KEY_RE = /(?:^|[_-])(?:api[_-]?key|token|secret|password|credential|authorization|auth|bearer|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|session[_-]?token|cookie|dsn)(?:$|[_-])|(?:api[_-]?key|token|secret|password|credential|authorization|auth|private[_-]?key)$/i;
const STRUCTURED_IDENTIFIER_KEY_RE = /(?:^|[_-])(?:id|ids|fingerprint|hash|timestamp|time)(?:$|[_-])|(?:^|[_-])(?:created|updated|occurred|started|ended)[_-]at(?:$|[_-])/i;
const STABLE_IDENTITY_KEY_RE = /(?:^|[_-])(?:user|session|device)[_-]?id(?:$|[_-])/i;
const MAX_REDACTION_DEPTH = 30;
function keyParts(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toLowerCase();
}
function redactValueForKey(value) {
    if (value === undefined || value === null)
        return value;
    if (Array.isArray(value))
        return value.map(() => '[REDACTED_SECRET]');
    if (typeof value === 'object')
        return '[REDACTED_SECRET]';
    return '[REDACTED_SECRET]';
}
function redactSensitiveKeyValue(key, value) {
    if (AUTHORIZATION_KEY_RE.test(key) && typeof value === 'string') {
        return redactAuthorizationValue(value);
    }
    return redactValueForKey(value);
}
function isStableIdentityKey(key) {
    return STABLE_IDENTITY_KEY_RE.test(keyParts(key));
}
// Claude Code's metadata.user_id has the shape
// `user_<accountHash>_account__session_<sessionUuid>`. The session uuid changes
// every session, so hashing the whole value yields a different id per session,
// which breaks downstream cross-session de-duplication / anti-sybil. We strip
// the `__session_<uuid>` suffix and hash only the stable account portion so the
// same real account maps to the same redacted id across sessions. Non-Claude
// values (no `__session_` marker) fall back to hashing the whole value.
function stableIdentityHashSource(value) {
    let serialized;
    try {
        serialized = typeof value === 'string' ? value : JSON.stringify(value);
    }
    catch {
        serialized = String(value);
    }
    const sessionMarker = serialized.indexOf('__session_');
    if (sessionMarker > 0)
        return serialized.slice(0, sessionMarker);
    return serialized;
}
function stableIdentityPlaceholder(value) {
    const source = stableIdentityHashSource(value);
    const hash = createHash('sha256').update(`evomap-stable-identity-v1:${source}`, 'utf8').digest('hex').slice(0, 16);
    return `[REDACTED_ID_SHA256:${hash}]`;
}
function redactStableIdentityValue(value) {
    if (value === undefined || value === null)
        return value;
    return stableIdentityPlaceholder(value);
}
// Deterministic, cross-session-stable account hash. Reuses stableIdentityHashSource
// so it matches the in-place redacted user_id token, and lets us emit an explicit
// user_id_hash sibling for downstream de-dup/anti-sybil.
export function stableUserIdHash(value) {
    const source = stableIdentityHashSource(value);
    return createHash('sha256').update(`evomap-stable-identity-v1:${source}`, 'utf8').digest('hex').slice(0, 16);
}
const USER_ID_KEY_RE = /(?:^|[_-])user[_-]?id(?:$|[_-])/i;
function shouldPreserveStructuredIdentifierNumbers(key) {
    if (key === undefined)
        return false;
    return STRUCTURED_IDENTIFIER_KEY_RE.test(keyParts(key));
}
function redactStructured(value, depth = 0, keyContext) {
    if (value === undefined || value === null)
        return value;
    if (typeof value === 'string') {
        return applyRedactors(value, {
            preserveStructuredIdentifierNumbers: shouldPreserveStructuredIdentifierNumbers(keyContext),
        });
    }
    if (typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (depth > MAX_REDACTION_DEPTH)
        return '[MAX_REDACTION_DEPTH]';
    if (Array.isArray(value))
        return value.map((item) => redactStructured(item, depth + 1, keyContext));
    if (typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        out[key] = SENSITIVE_KEY_RE.test(key)
            ? redactSensitiveKeyValue(key, child)
            : (isStableIdentityKey(key) ? redactStableIdentityValue(child) : redactStructured(child, depth + 1, key));
        // Emit a stable, cross-session user_id_hash alongside the redacted user_id so
        // downstream de-dup/anti-sybil has a deterministic per-account key.
        if (USER_ID_KEY_RE.test(key) && (typeof child === 'string' || typeof child === 'number') && out['user_id_hash'] === undefined) {
            out['user_id_hash'] = stableUserIdHash(child);
        }
    }
    return out;
}
function incompleteCaptureEnvelope(redactedChars, redactedBytes, maxBytes) {
    return JSON.stringify({
        truncated: true,
        capture_complete: false,
        body_omitted: true,
        reason: 'body_exceeds_trace_body_max_bytes',
        redacted_bytes: redactedBytes,
        max_bytes: maxBytes,
        omitted_bytes: redactedBytes,
        excess_bytes: Math.max(0, redactedBytes - maxBytes),
        redacted_chars: redactedChars,
        max_chars: maxBytes,
        omitted_chars: redactedChars,
        excess_chars: Math.max(0, redactedChars - maxBytes),
        redaction: REDACTION_VERSION,
    });
}
function tryParseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
/**
 * Serialize a native request/response payload, run it through redaction, and cap its size. Never throws — capture
 * must never break serving — returning a small error envelope instead. Returns undefined for empty/absent input.
 */
export function captureBody(value, env = process.env) {
    if (value === undefined || value === null)
        return undefined;
    let serialized;
    try {
        if (typeof value === 'string') {
            const parsed = tryParseJson(value);
            serialized = parsed === undefined ? redactText(value) : JSON.stringify(redactStructured(parsed));
        }
        else {
            serialized = JSON.stringify(redactStructured(value));
        }
    }
    catch {
        return { body: '"[unserializable_body]"', truncated: false, redaction: REDACTION_VERSION };
    }
    if (!serialized)
        return undefined;
    const redacted = serialized;
    const maxBytes = bodyMaxChars(env);
    const redactedBytes = Buffer.byteLength(redacted, 'utf8');
    const truncated = redactedBytes > maxBytes;
    return {
        body: truncated ? incompleteCaptureEnvelope(redacted.length, redactedBytes, maxBytes) : redacted,
        truncated,
        redaction: REDACTION_VERSION,
    };
}