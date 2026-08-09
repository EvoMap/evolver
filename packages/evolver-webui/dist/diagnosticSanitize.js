import { hub } from '@evomap/evolver-core';
// The package main entry is a UMD wrapper whose shadowed `require` leaves
// './impl/format' unresolved inside bun standalone binaries. Import the scanner
// impl via the shim so bundlers inline it statically.
import { createScanner } from './jsoncScannerShim.js';
const MAX_TEXT = 500;
const MAX_ARRAY = 50;
const MAX_KEYS = 50;
const MAX_DEPTH = 5;
const MAX_SERIALIZED_JSON_DEPTH = 10;
const MAX_JSON_CONTAINER_DEPTH = 10_000;
const SECRET_KEY = /(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|api[_-]?key|account[_-]?key|instrumentation[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|private[_-]?key)/i;
const SENSITIVE_HTTP_HEADER_NAME = /\b(proxy[-_]?authorization|authorization|set[-_]?cookie|cookie)\b/gi;
const SENSITIVE_HTTP_HEADER_CANDIDATE = /\b(?:proxy[-_]?authorization|authorization|set[-_]?cookie|cookie)\b/i;
const SENSITIVE_HTTP_HEADER_KEY = /^(?:(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie)$/i;
const REDACTED_HEADER_VALUE = '[redacted]';
const REDACTED_JSON_VALUE = JSON.stringify(REDACTED_HEADER_VALUE);
// jsonc-parser declares SyntaxKind as an ambient const enum, which cannot be imported with verbatimModuleSyntax.
const JSON_TOKEN = {
    openBrace: 1,
    closeBrace: 2,
    openBracket: 3,
    closeBracket: 4,
    comma: 5,
    colon: 6,
    null: 7,
    true: 8,
    false: 9,
    string: 10,
    number: 11,
    unknown: 16,
    eof: 17,
};
function isHeaderFraming(char) {
    return char === ' ' || char === '\t';
}
function physicalLineEnd(value, start) {
    for (let index = start; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x0d || code === 0x0a)
            return index;
    }
    return value.length;
}
function isPhysicalHeaderNamePosition(value, lineStart, nameStart) {
    for (let index = lineStart; index < nameStart; index += 1) {
        if (value[index] !== ' ' && value[index] !== '\t')
            return false;
    }
    return true;
}
function physicalHeaderEnd(value, start) {
    return physicalHeaderEndFromLineEnd(value, physicalLineEnd(value, start));
}
function physicalHeaderEndFromLineEnd(value, firstLineEnd, physicalHeaderEndCache) {
    const cached = physicalHeaderEndCache?.get(firstLineEnd);
    if (cached !== undefined)
        return cached;
    const traversedLineEnds = [];
    let end = firstLineEnd;
    while (end < value.length) {
        traversedLineEnds.push(end);
        const nextLine = value[end] === '\r' && value[end + 1] === '\n' ? end + 2 : end + 1;
        if (value[nextLine] !== ' ' && value[nextLine] !== '\t')
            break;
        end = physicalLineEnd(value, nextLine);
    }
    for (const lineEnd of traversedLineEnds)
        physicalHeaderEndCache?.set(lineEnd, end);
    return end;
}
function looksLikeSensitiveHttpHeaderValue(headerName, value, start, end) {
    const rawCandidate = value.slice(start, Math.min(end, start + 512)).trim();
    const candidate = rawCandidate[0] === '\x22' || rawCandidate[0] === '\x27'
        ? rawCandidate.slice(1)
        : rawCandidate;
    const normalizedName = headerName.toLowerCase().replace(/[-_]/g, '');
    if (normalizedName.endsWith('authorization')) {
        const auth = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]+(.+)$/.exec(candidate);
        if (!auth)
            return false;
        const credentials = (auth[2] ?? '').trim();
        return /^[A-Za-z0-9._~+/-]+={0,}(?:[ \t]*(?:[,;)\]}>\x27\x22]|$))/.test(credentials)
            || /\b[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=/.test(credentials);
    }
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:\x22[^\x22]*\x22|[^\s;,\x22\x27]*)(?:[ \t]*(?:[,;)\]}>;\x27\x22]|$))/.test(candidate);
}
function needsFoldedHeaderInspection(headerName, value, start, lineEnd) {
    const boundedEnd = Math.min(lineEnd, start + 512);
    if (looksLikeSensitiveHttpHeaderValue(headerName, value, start, boundedEnd))
        return true;
    const rawCandidate = value.slice(start, boundedEnd).trim();
    if (rawCandidate.length === 0)
        return true;
    const candidate = rawCandidate[0] === '\x22' || rawCandidate[0] === '\x27'
        ? rawCandidate.slice(1)
        : rawCandidate;
    return candidate.startsWith('[')
        || /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(candidate)
        || /[,;]$/.test(candidate)
        || rawCandidate[0] === '\x22'
        || rawCandidate[0] === '\x27';
}
function quotedValueEnd(value, start, lineEnd) {
    const quote = value[start];
    if (quote !== '\x22' && quote !== '\x27')
        return undefined;
    let ambiguous = false;
    for (let index = start + 1; index < lineEnd; index += 1) {
        if (value[index] === '\\') {
            index += 1;
            continue;
        }
        if (value[index] !== quote)
            continue;
        const next = value[index + 1];
        if (next === undefined || isHeaderFraming(next) || /[,;)\]}>/]/.test(next)) {
            return { end: index + 1, ambiguous };
        }
        ambiguous = true;
    }
    return undefined;
}
function token68ValueEnd(headerName, value, start, lineEnd) {
    const normalizedName = headerName.toLowerCase().replace(/[-_]/g, '');
    if (!normalizedName.endsWith('authorization'))
        return undefined;
    const match = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+[A-Za-z0-9._~+/-]+={0,}/.exec(value.slice(start, Math.min(lineEnd, start + 512)));
    if (!match)
        return undefined;
    const end = start + match[0].length;
    if (match[0].endsWith('=') && (value[end] === '\x22' || value[end] === '\x27'))
        return undefined;
    let boundary = end;
    while (isHeaderFraming(value[boundary]))
        boundary += 1;
    return boundary >= lineEnd || /[,;)\]}>\x27\x22]/.test(value[boundary] ?? '') ? end : undefined;
}
function cookieValueEnd(headerName, value, start, lineEnd) {
    const normalizedName = headerName.toLowerCase().replace(/[-_]/g, '');
    if (normalizedName !== 'cookie')
        return undefined;
    let quoted;
    for (let index = start; index < lineEnd; index += 1) {
        const char = value[index];
        if (char === '\\' && quoted) {
            index += 1;
            continue;
        }
        if (char === '\x22' || char === '\x27') {
            quoted = quoted === char ? undefined : (quoted ?? char);
            continue;
        }
        if (!quoted && char === ',')
            return index;
    }
    return undefined;
}
function inspectArrayValueEnd(headerName, value, start, end, budget) {
    if (value[start] !== '[')
        return undefined;
    let depth = 0;
    let quote;
    let quoteStart = -1;
    let credentialFound = false;
    for (let index = start; index < end; index += 1) {
        budget.remaining -= 1;
        if (budget.remaining < 0)
            return { end };
        const char = value[index];
        if (quote) {
            if (char === '\\') {
                index += 1;
                continue;
            }
            if (char !== quote)
                continue;
            if (depth === 1) {
                let before = quoteStart - 1;
                while (isHeaderFraming(value[before]))
                    before -= 1;
                let after = index + 1;
                while (isHeaderFraming(value[after]))
                    after += 1;
                if ((value[before] === '[' || value[before] === ',')
                    && (value[after] === ',' || value[after] === ']')) {
                    const decoded = value.slice(quoteStart + 1, index).replace(/\\([\\'"])/g, '$1');
                    if (looksLikeSensitiveHttpHeaderValue(headerName, decoded, 0, decoded.length)) {
                        credentialFound = true;
                    }
                }
            }
            quote = undefined;
            continue;
        }
        if (char === '\x22' || char === '\x27') {
            quote = char;
            quoteStart = index;
            continue;
        }
        if (char === '[') {
            depth += 1;
            continue;
        }
        if (char !== ']')
            continue;
        depth -= 1;
        if (depth === 0)
            return credentialFound ? { end: index + 1 } : undefined;
        if (depth < 0)
            return undefined;
    }
    return depth > 0 ? { end } : undefined;
}
function collectFoldedCandidate(value, start, end, budget) {
    let cursor = start;
    const spendFraming = () => {
        budget.remaining -= 1;
        return budget.remaining >= 0;
    };
    while (cursor < end && isHeaderFraming(value[cursor])) {
        if (!spendFraming())
            return { text: '', failClosed: true };
        cursor += 1;
    }
    let text = '';
    while (cursor < end && text.length < 512) {
        if (value[cursor] !== '\r' && value[cursor] !== '\n') {
            text += value[cursor];
            cursor += 1;
            continue;
        }
        if (!spendFraming())
            return { text, failClosed: true };
        cursor += value[cursor] === '\r' && value[cursor + 1] === '\n' ? 2 : 1;
        let skipped = false;
        while (cursor < end && isHeaderFraming(value[cursor])) {
            if (!spendFraming())
                return { text, failClosed: true };
            cursor += 1;
            skipped = true;
        }
        if (!skipped)
            break;
        if (text.length > 0 && text[text.length - 1] !== ' ')
            text += ' ';
    }
    return { text, failClosed: false };
}
function foldedValueStart(value, start, end, budget) {
    let cursor = start;
    while (cursor < end) {
        if (isHeaderFraming(value[cursor])) {
            budget.remaining -= 1;
            if (budget.remaining < 0)
                return undefined;
            cursor += 1;
            continue;
        }
        if (value[cursor] !== '\r' && value[cursor] !== '\n')
            break;
        const width = value[cursor] === '\r' && value[cursor + 1] === '\n' ? 2 : 1;
        budget.remaining -= width;
        if (budget.remaining < 0)
            return undefined;
        cursor += width;
    }
    return cursor;
}
function rawHeaderSpan(value, headerName, lineStart, lineEnd, physicalEnd, nameStart, nameEnd, embedded) {
    if (!isPhysicalHeaderNamePosition(value, lineStart, nameStart))
        return undefined;
    let cursor = nameEnd;
    while (isHeaderFraming(value[cursor]))
        cursor += 1;
    if (value[cursor] !== ':')
        return undefined;
    let separatorEnd = cursor + 1;
    while (value[separatorEnd] === ' ' || value[separatorEnd] === '\t')
        separatorEnd += 1;
    if (embedded
        && !looksLikeSensitiveHttpHeaderValue(headerName, value, separatorEnd, lineEnd))
        return undefined;
    return {
        start: nameStart,
        end: physicalEnd,
        replacement: value.slice(nameStart, separatorEnd) + REDACTED_HEADER_VALUE,
        resumeAt: physicalEnd,
    };
}
function inlineHeaderSpan(value, headerName, lineEnd, physicalEnd, nameStart, nameEnd, budget) {
    const labelQuote = value[nameStart - 1] === '\x22' || value[nameStart - 1] === '\x27'
        ? value[nameStart - 1]
        : undefined;
    let cursor = nameEnd;
    if (labelQuote && value[cursor] === labelQuote)
        cursor += 1;
    while (value[cursor] === ' ' || value[cursor] === '\t')
        cursor += 1;
    if (labelQuote && value[cursor] === ']') {
        cursor += 1;
        while (value[cursor] === ' ' || value[cursor] === '\t')
            cursor += 1;
    }
    let separatorEnd;
    if (value[cursor] === ':' || value[cursor] === '=') {
        separatorEnd = cursor + 1;
        if (value[cursor] === '=' && value[separatorEnd] === '>')
            separatorEnd += 1;
    }
    else if (labelQuote && value[cursor] === ',') {
        separatorEnd = cursor + 1;
    }
    else {
        return undefined;
    }
    while (value[separatorEnd] === ' ' || value[separatorEnd] === '\t')
        separatorEnd += 1;
    let shapeStart = separatorEnd;
    const folded = physicalEnd > lineEnd;
    if (separatorEnd >= lineEnd && physicalEnd > lineEnd) {
        shapeStart = value[lineEnd] === '\r' && value[lineEnd + 1] === '\n'
            ? lineEnd + 2
            : lineEnd + 1;
    }
    if (folded
        && separatorEnd < lineEnd
        && !needsFoldedHeaderInspection(headerName, value, separatorEnd, lineEnd))
        return undefined;
    const advancedFoldedStart = folded
        ? foldedValueStart(value, shapeStart, physicalEnd, budget)
        : shapeStart;
    const foldedFramingExhausted = advancedFoldedStart === undefined;
    if (advancedFoldedStart !== undefined)
        shapeStart = advancedFoldedStart;
    const inspectArray = foldedFramingExhausted
        ? undefined
        : inspectArrayValueEnd(headerName, value, shapeStart, physicalEnd, budget);
    const unfoldedCandidate = folded && !foldedFramingExhausted
        ? collectFoldedCandidate(value, shapeStart, physicalEnd, budget)
        : (foldedFramingExhausted ? { text: '', failClosed: true } : undefined);
    if (!inspectArray
        && !unfoldedCandidate?.failClosed
        && !(unfoldedCandidate
            ? looksLikeSensitiveHttpHeaderValue(headerName, unfoldedCandidate.text, 0, unfoldedCandidate.text.length)
            : looksLikeSensitiveHttpHeaderValue(headerName, value, shapeStart, physicalEnd)))
        return undefined;
    const candidateQuotedValue = folded
        ? undefined
        : quotedValueEnd(value, separatorEnd, physicalEnd);
    const quotedEnd = candidateQuotedValue && !candidateQuotedValue.ambiguous
        ? candidateQuotedValue.end
        : undefined;
    const preciseEnd = (folded ? undefined : inspectArray?.end)
        ?? quotedEnd
        ?? (folded ? undefined : token68ValueEnd(headerName, value, separatorEnd, lineEnd))
        ?? (folded ? undefined : cookieValueEnd(headerName, value, separatorEnd, lineEnd));
    const end = preciseEnd ?? physicalEnd;
    const quote = quotedEnd
        ? value[separatorEnd]
        : (inspectArray ? (labelQuote ?? '\x22') : undefined);
    return {
        start: separatorEnd,
        end,
        replacement: quote ? quote + REDACTED_HEADER_VALUE + quote : REDACTED_HEADER_VALUE,
        resumeAt: end,
    };
}
function jsonContainerForOpen(kind) {
    if (kind === JSON_TOKEN.openBracket)
        return 'array';
    if (kind === JSON_TOKEN.openBrace)
        return 'object';
    return undefined;
}
function jsonContainerForClose(kind) {
    if (kind === JSON_TOKEN.closeBracket)
        return 'array';
    if (kind === JSON_TOKEN.closeBrace)
        return 'object';
    return undefined;
}
function isJsonScalar(kind) {
    return kind === JSON_TOKEN.string
        || kind === JSON_TOKEN.number
        || kind === JSON_TOKEN.null
        || kind === JSON_TOKEN.true
        || kind === JSON_TOKEN.false;
}
function mightContainStructuredHeader(value) {
    return /['"]/.test(value)
        && (SENSITIVE_HTTP_HEADER_CANDIDATE.test(value) || /\\u[0-9a-f]{4}/i.test(value));
}
function applyRedactionSpans(value, spans) {
    if (spans.length === 0)
        return value;
    spans.sort((left, right) => left.start - right.start || right.end - left.end);
    let cursor = 0;
    let output = '';
    for (const span of spans) {
        if (span.start < cursor)
            continue;
        output += value.slice(cursor, span.start) + span.replacement;
        cursor = span.end;
    }
    return output + value.slice(cursor);
}
function redactStructuredJsonText(value, serializedDepth = 0) {
    if (serializedDepth >= MAX_SERIALIZED_JSON_DEPTH)
        return REDACTED_HEADER_VALUE;
    if (!mightContainStructuredHeader(value))
        return value;
    const scanner = createScanner(value, true);
    const containers = [];
    const spans = [];
    let headerLabel;
    let awaitingHeaderValue;
    let activeComposite;
    let depthOverflow = false;
    let structuralMismatch = false;
    let structuredCoveredUntil = 0;
    const pushContainer = (container) => {
        if (containers.length >= MAX_JSON_CONTAINER_DEPTH) {
            depthOverflow = true;
            return false;
        }
        containers.push(container);
        return true;
    };
    const popContainer = (container) => {
        if (containers.at(-1) !== container) {
            structuralMismatch = true;
            return;
        }
        containers.pop();
    };
    const redactValue = (kind, offset, length, headerName, requireCredentialShape) => {
        if (requireCredentialShape && kind === JSON_TOKEN.string) {
            const decoded = scanner.getTokenValue();
            if (!looksLikeSensitiveHttpHeaderValue(headerName, decoded, 0, decoded.length))
                return false;
        }
        const container = jsonContainerForOpen(kind);
        if (container) {
            if (requireCredentialShape && container !== 'array')
                return false;
            activeComposite = {
                start: offset,
                baseDepth: containers.length,
                ...(requireCredentialShape
                    ? { credentialHeaderName: headerName, credentialFound: false }
                    : {}),
            };
            pushContainer(container);
            return true;
        }
        if (requireCredentialShape && kind !== JSON_TOKEN.string)
            return false;
        if (isJsonScalar(kind)) {
            spans.push({
                start: offset,
                end: offset + length,
                replacement: REDACTED_JSON_VALUE,
                resumeAt: offset + length,
            });
            return true;
        }
        if (kind === JSON_TOKEN.unknown) {
            if (offset < structuredCoveredUntil)
                return true;
            const end = physicalHeaderEnd(value, offset);
            spans.push({ start: offset, end, replacement: REDACTED_JSON_VALUE, resumeAt: end });
            structuredCoveredUntil = end;
            return true;
        }
        return false;
    };
    for (let kind = scanner.scan(); kind !== JSON_TOKEN.eof; kind = scanner.scan()) {
        const offset = scanner.getTokenOffset();
        const length = scanner.getTokenLength();
        const openedContainer = jsonContainerForOpen(kind);
        const closedContainer = jsonContainerForClose(kind);
        if (activeComposite) {
            if (activeComposite.credentialHeaderName
                && containers.length === activeComposite.baseDepth + 1
                && kind === JSON_TOKEN.string) {
                const decoded = stripUnsafeControls(stripTerminalEscapes(scanner.getTokenValue()));
                if (looksLikeSensitiveHttpHeaderValue(activeComposite.credentialHeaderName, decoded, 0, decoded.length))
                    activeComposite.credentialFound = true;
            }
            if (openedContainer)
                pushContainer(openedContainer);
            if (closedContainer) {
                popContainer(closedContainer);
                if (containers.length <= activeComposite.baseDepth) {
                    const completed = activeComposite;
                    if (!completed.credentialHeaderName || completed.credentialFound) {
                        spans.push({
                            start: completed.start,
                            end: offset + length,
                            replacement: REDACTED_JSON_VALUE,
                            resumeAt: offset + length,
                        });
                    }
                    else {
                        const original = value.slice(completed.start, offset + length);
                        const nested = redactStructuredJsonText(original, serializedDepth + 1);
                        if (nested !== original) {
                            spans.push({
                                start: completed.start,
                                end: offset + length,
                                replacement: nested === REDACTED_HEADER_VALUE ? REDACTED_JSON_VALUE : nested,
                                resumeAt: offset + length,
                            });
                        }
                    }
                    activeComposite = undefined;
                }
            }
            if (depthOverflow || structuralMismatch)
                break;
            continue;
        }
        if (awaitingHeaderValue) {
            const pending = awaitingHeaderValue;
            awaitingHeaderValue = undefined;
            if (redactValue(kind, offset, length, pending.name, pending.requireCredentialShape)) {
                if (depthOverflow)
                    break;
                continue;
            }
        }
        else if (headerLabel) {
            const isSeparator = (headerLabel.container === 'object' && kind === JSON_TOKEN.colon)
                || (headerLabel.container === 'array' && kind === JSON_TOKEN.comma);
            const pending = headerLabel;
            headerLabel = undefined;
            if (isSeparator) {
                awaitingHeaderValue = {
                    name: pending.name,
                    requireCredentialShape: kind === JSON_TOKEN.comma,
                };
                continue;
            }
        }
        if (openedContainer) {
            pushContainer(openedContainer);
            if (depthOverflow)
                break;
            continue;
        }
        if (closedContainer) {
            popContainer(closedContainer);
            if (structuralMismatch)
                break;
            continue;
        }
        if (kind !== JSON_TOKEN.string)
            continue;
        const decoded = scanner.getTokenValue();
        const normalizedDecoded = stripUnsafeControls(stripTerminalEscapes(decoded));
        const currentContainer = containers.at(-1);
        if (currentContainer && SENSITIVE_HTTP_HEADER_KEY.test(normalizedDecoded)) {
            headerLabel = { name: normalizedDecoded, container: currentContainer };
            continue;
        }
        if (!SENSITIVE_HTTP_HEADER_CANDIDATE.test(normalizedDecoded)
            && !/\\u[0-9a-f]{4}/i.test(normalizedDecoded)) {
            if (normalizedDecoded !== decoded) {
                spans.push({
                    start: offset,
                    end: offset + length,
                    replacement: JSON.stringify(normalizedDecoded),
                    resumeAt: offset + length,
                });
            }
            continue;
        }
        const structured = redactStructuredJsonText(normalizedDecoded, serializedDepth + 1);
        const redacted = redactUnstructuredHttpHeaders(structured, true);
        if (redacted === decoded)
            continue;
        spans.push({
            start: offset,
            end: offset + length,
            replacement: JSON.stringify(redacted),
            resumeAt: offset + length,
        });
    }
    if (depthOverflow || structuralMismatch)
        return REDACTED_HEADER_VALUE;
    if (activeComposite && (!activeComposite.credentialHeaderName || activeComposite.credentialFound)) {
        spans.push({
            start: activeComposite.start,
            end: value.length,
            replacement: REDACTED_JSON_VALUE,
            resumeAt: value.length,
        });
    }
    return applyRedactionSpans(value, spans);
}
function stripUnsafeControls(value) {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if ((code >= 0x20 && (code < 0x7f || code > 0x9f))
            || code === 0x09 || code === 0x0a || code === 0x0d)
            out += char;
    }
    return out;
}
function stripTerminalEscapes(value) {
    const skipCsi = (start) => {
        let cursor = start;
        while (cursor < value.length) {
            const code = value.charCodeAt(cursor);
            cursor += 1;
            if (code >= 0x40 && code <= 0x7e)
                break;
        }
        return cursor;
    };
    const skipControlString = (start, allowBell) => {
        let cursor = start;
        while (cursor < value.length) {
            const code = value.charCodeAt(cursor);
            if ((allowBell && code === 0x07) || code === 0x9c)
                return cursor + 1;
            if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c)
                return cursor + 2;
            cursor += 1;
        }
        return cursor;
    };
    const skipEscapeSequence = (start) => {
        let cursor = start;
        while (cursor < value.length) {
            const code = value.charCodeAt(cursor);
            if (code < 0x20 || code > 0x2f)
                break;
            cursor += 1;
        }
        const final = value.charCodeAt(cursor);
        if (final >= 0x30 && final <= 0x7e)
            return cursor + 1;
        return cursor > start ? value.length : start;
    };
    let output = '';
    for (let index = 0; index < value.length;) {
        const code = value.charCodeAt(index);
        if (code === 0x9b) {
            index = skipCsi(index + 1);
            continue;
        }
        if (code === 0x9d) {
            index = skipControlString(index + 1, true);
            continue;
        }
        if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            index = skipControlString(index + 1, false);
            continue;
        }
        if (code === 0x1b) {
            const next = value.charCodeAt(index + 1);
            if (next === 0x5b) {
                index = skipCsi(index + 2);
            }
            else if (next === 0x5d) {
                index = skipControlString(index + 2, true);
            }
            else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
                index = skipControlString(index + 2, false);
            }
            else {
                index = skipEscapeSequence(index + 1);
            }
            continue;
        }
        output += value[index];
        index += 1;
    }
    return output;
}
function redactUnstructuredHttpHeaders(value, embedded) {
    const spans = [];
    const budget = { remaining: Math.max(value.length * 2, 1_024) };
    SENSITIVE_HTTP_HEADER_NAME.lastIndex = 0;
    let lineStart = 0;
    let lineEnd = physicalLineEnd(value, 0);
    let cachedLineEnd = -1;
    let cachedPhysicalEnd = lineEnd;
    const physicalHeaderEndCache = new Map();
    let rawPositionAvailable = true;
    let match;
    while ((match = SENSITIVE_HTTP_HEADER_NAME.exec(value)) !== null) {
        const headerName = match[1];
        if (!headerName)
            continue;
        const nameStart = match.index;
        const nameEnd = nameStart + headerName.length;
        while (nameStart > lineEnd && lineEnd < value.length) {
            lineStart = value[lineEnd] === '\r' && value[lineEnd + 1] === '\n'
                ? lineEnd + 2
                : lineEnd + 1;
            lineEnd = physicalLineEnd(value, lineStart);
            rawPositionAvailable = true;
        }
        if (cachedLineEnd !== lineEnd) {
            cachedLineEnd = lineEnd;
            cachedPhysicalEnd = physicalHeaderEndFromLineEnd(value, lineEnd, physicalHeaderEndCache);
        }
        const span = (rawPositionAvailable
            ? rawHeaderSpan(value, headerName, lineStart, lineEnd, cachedPhysicalEnd, nameStart, nameEnd, embedded)
            : undefined)
            ?? inlineHeaderSpan(value, headerName, lineEnd, cachedPhysicalEnd, nameStart, nameEnd, budget);
        rawPositionAvailable = false;
        if (!span) {
            SENSITIVE_HTTP_HEADER_NAME.lastIndex = nameEnd;
            continue;
        }
        spans.push(span);
        SENSITIVE_HTTP_HEADER_NAME.lastIndex = Math.max(span.resumeAt, nameEnd);
    }
    SENSITIVE_HTTP_HEADER_NAME.lastIndex = 0;
    if (spans.length === 0)
        return value;
    let cursor = 0;
    let output = '';
    for (const span of spans) {
        output += value.slice(cursor, span.start) + span.replacement;
        cursor = span.end;
    }
    return output + value.slice(cursor);
}
export function redactSensitiveHttpHeaders(value) {
    const couldBeStructured = value.includes('{')
        || value.includes('[')
        || value.includes('\x22')
        || value.includes('\x27');
    const structured = couldBeStructured
        ? redactStructuredJsonText(value)
        : value;
    const normalized = stripUnsafeControls(stripTerminalEscapes(structured));
    return redactUnstructuredHttpHeaders(normalized, false);
}
export function redactDiagnosticText(value, maxChars = MAX_TEXT) {
    const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
    const diagnosticRedacted = redactSensitiveHttpHeaders(raw)
        .replace(/^([ \t]*)(proxy[-_]?authorization|authorization|set[-_]?cookie|cookie)\b\s*:\s*\[redacted\]/gim, '$1$2=[redacted]')
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[redacted private key]')
        .replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
        .replace(/\b(proxy[-_]?authorization|authorization)\b\s*=\s*(?!(?:\x22|')?\[redacted\](?:\x22|')?)(?:\x22[^\x22]*\x22|'[^']*'|[^\s,;\x22']+)/gi, '$1=[redacted]')
        .replace(/\b(cookie|set[-_]?cookie)\b\s*=\s*(?!(?:\x22|')?\[redacted\](?:\x22|')?)(?:\x22[^\x22]*\x22|'[^']*'|[^\s,;\x22']+)/gi, '$1=[redacted]')
        .replace(/\b(api[_-]?key|account[_-]?key|instrumentation[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|node[_-]?secret|token|password|passwd|secret)\b\s*[:=]\s*(?!(?:\x22|')?\[redacted\](?:\x22|')?)(?:\x22[^\x22]*\x22|'[^']*'|[^\s,;\x22']+)/gi, '$1=[redacted]')
        .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[path]')
        .replace(/\\\\[^\\\s"']+\\[^\\\s"']+(?:\\[^\\\s"']+)*/g, '[path]')
        .replace(/(?:\/(?:Users|home|var|tmp|private|opt)\/[^\s"']+)+/g, '[path]')
        .trim();
    const redacted = diagnosticRedacted
        .split('[redacted]')
        .map((segment) => hub.redactString(segment))
        .join('[redacted]')
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