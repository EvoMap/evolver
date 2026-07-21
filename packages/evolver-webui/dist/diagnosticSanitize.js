const MAX_TEXT = 500;
const MAX_ARRAY = 50;
const MAX_KEYS = 50;
const MAX_DEPTH = 5;
const SECRET_KEY = /(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|private[_-]?key)/i;
function stripUnsafeControls(value) {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)
            out += char;
    }
    return out;
}
export function redactDiagnosticText(value, maxChars = MAX_TEXT) {
    const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
    const redacted = stripUnsafeControls(raw)
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[redacted private key]')
        .replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
        .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
        .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[path]')
        .replace(/\\\\[^\\\s"']+\\[^\\\s"']+(?:\\[^\\\s"']+)*/g, '[path]')
        .replace(/(?:\/(?:Users|home|var|tmp|private|opt)\/[^\s"']+)+/g, '[path]')
        .trim();
    return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}
export function sanitizeDiagnosticValue(value, depth = 0) {
    if (depth >= MAX_DEPTH)
        return '[truncated]';
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' || typeof value === 'bigint')
        return redactDiagnosticText(value);
    if (Array.isArray(value))
        return value.slice(0, MAX_ARRAY).map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
    if (typeof value !== 'object')
        return redactDiagnosticText(value);
    const out = {};
    for (const [rawKey, entry] of Object.entries(value).slice(0, MAX_KEYS)) {
        const key = redactDiagnosticText(rawKey, 120);
        if (!key)
            continue;
        out[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitizeDiagnosticValue(entry, depth + 1);
    }
    return out;
}