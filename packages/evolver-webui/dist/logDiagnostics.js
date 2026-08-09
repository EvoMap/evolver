import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { hub } from '@evomap/evolver-core';
import { redactSensitiveHttpHeaders } from './diagnosticSanitize.js';
export const LOG_DIAGNOSTICS_MAX_BYTES = 128 * 1024;
export const LOG_DIAGNOSTICS_MAX_LINES = 200;
const LOG_DIAGNOSTICS_HARD_MAX_BYTES = 1024 * 1024;
const LOG_DIAGNOSTICS_HARD_MAX_LINES = 1_000;
const MAX_LINE_CHARS = 4_000;
function boundedInteger(value, fallback, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(maximum, Math.floor(value)));
}
function redactSecrets(input) {
    let text = replaceUnsafeControls(input);
    text = text.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, '[redacted private key]');
    text = text.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*$/gi, '[redacted private key]');
    text = text.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]');
    text = text.replace(/\b(proxy[-_]?authorization|authorization)\b(\s*=\s*)(?!(?:"|')?\[redacted\](?:"|')?)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1$2[redacted]');
    text = text.replace(/\b(cookie|set[-_]?cookie)\b(\s*=\s*)(?!(?:"|')?\[redacted\](?:"|')?)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1$2[redacted]');
    text = text.replace(/\b(api[_ -]?key|token|access[_ -]?token|refresh[_ -]?token|password|passwd)\b(\s*[=:]\s*)(?!(?:"|')?\[redacted\](?:"|')?)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1$2[redacted]');
    text = text.replace(/([?&](?:api[_-]?key|token|access_token|password)=)[^&\s]+/gi, '$1[redacted]');
    text = text.replace(/\b(id[_ -]?token|private[_ -]?key|node[_ -]?secret|account[_ -]?key|instrumentation[_ -]?key)\b(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]');
    return text
        .split('[redacted]')
        .map((segment) => hub.redactString(segment))
        .join('[redacted]');
}
function replaceUnsafeControls(value) {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        out += code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d ? char : ' ';
    }
    return out;
}
function safeLine(line) {
    const normalized = replaceUnsafeControls(line);
    if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(normalized.trim()))
        return '[redacted private key material]';
    return normalized.slice(0, MAX_LINE_CHARS);
}
function redactTruncatedLeadingContinuations(value) {
    return value.replace(/^(?:[ \t]+[^\r\n]*(?:\r?\n|$))+/, '[redacted truncated continuation]\n');
}
export function readLogDiagnostics(logFile, options = {}) {
    const maxBytes = boundedInteger(options.maxBytes, LOG_DIAGNOSTICS_MAX_BYTES, LOG_DIAGNOSTICS_HARD_MAX_BYTES);
    const maxLines = boundedInteger(options.maxLines, LOG_DIAGNOSTICS_MAX_LINES, LOG_DIAGNOSTICS_HARD_MAX_LINES);
    let fd;
    try {
        const before = lstatSync(logFile);
        if (before.isSymbolicLink() || !before.isFile())
            return { available: false, error: 'log_unavailable' };
        const noFollow = constants.O_NOFOLLOW ?? 0;
        fd = openSync(logFile, constants.O_RDONLY | noFollow);
        const stats = fstatSync(fd);
        const current = lstatSync(logFile);
        if (current.isSymbolicLink() || !current.isFile() || !stats.isFile()
            || current.dev !== stats.dev || current.ino !== stats.ino) {
            return { available: false, error: 'log_unavailable' };
        }
        const size = stats.size;
        const bytes = Math.min(size, maxBytes);
        const start = Math.max(0, size - bytes);
        const buffer = Buffer.alloc(bytes);
        if (bytes > 0)
            readSync(fd, buffer, 0, bytes, start);
        let startsAtLineBoundary = start === 0;
        if (start > 0) {
            const previous = Buffer.allocUnsafe(1);
            startsAtLineBoundary = readSync(fd, previous, 0, 1, start - 1) === 1 && previous[0] === 0x0a;
        }
        let text = buffer.toString('utf8');
        if (start > 0) {
            if (!startsAtLineBoundary) {
                const firstNewline = text.indexOf('\n');
                text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
            }
            text = redactTruncatedLeadingContinuations(replaceUnsafeControls(redactSensitiveHttpHeaders(text)));
        }
        else {
            text = replaceUnsafeControls(redactSensitiveHttpHeaders(text));
        }
        const redacted = redactSecrets(text);
        const allLines = redacted.split(/\r?\n/).filter((line) => line.length > 0);
        const lineTruncated = allLines.length > maxLines;
        return {
            available: true,
            data: {
                lines: allLines.slice(-maxLines).map(safeLine),
                truncated: start > 0 || lineTruncated,
            },
        };
    }
    catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined;
        return { available: false, error: code === 'ENOENT' ? 'log_not_found' : 'log_unavailable' };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}