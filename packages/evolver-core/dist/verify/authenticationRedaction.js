/** Move completed-scalar ownership through sorted edits whose replacements contain no raw input. */
export function remapCredentialTextRanges(ranges, edits) {
    let index = 0;
    let delta = 0;
    let written = 0;
    const boundary = (position, end) => {
        let edit = edits[index];
        while (edit && edit.end <= position) {
            delta += edit.replacementLength - (edit.end - edit.start);
            edit = edits[++index];
        }
        return edit && edit.start < position
            ? edit.start + delta + (end ? edit.replacementLength : 0) : position + delta;
    };
    for (let read = 0; read < ranges.length; read++) {
        const range = ranges[read];
        const start = boundary(range.start, false);
        const end = boundary(range.end, true);
        if (start === end)
            continue;
        const previous = ranges[written - 1];
        if (previous && start <= previous.end)
            previous.end = Math.max(previous.end, end);
        else
            ranges[written++] = { start, end };
    }
    ranges.length = written;
}
export function readQuotedCredentialValue(input, start) {
    let opening = start;
    while (input[opening] === '\\')
        opening++;
    const depth = opening - start;
    const char = input[opening];
    if ((char !== '"' && char !== "'") || (depth > 0 && (char !== '"' || (depth & (depth + 1)) !== 0)))
        return undefined;
    const quote = input.slice(start, opening + 1);
    for (let index = opening + 1; index < input.length; index++) {
        const run = index;
        while (input[index] === '\\')
            index++;
        // JSON encoding doubles each escape layer; trailing escaped backslashes are value content.
        if (input[index] === char && (index - run) % (2 * (depth + 1)) === depth) {
            return { end: index + 1, quote, raw: input.slice(start, index + 1) };
        }
        if ((input[index] === '\n' || input[index] === '\r') && (depth > 0 || (index - run) % 2 === 0))
            return undefined;
    }
    return undefined;
}
const REDACTION_MARKER = /\[redacted\]/iy;
function credentialFramingEnd(input, start) {
    let end = start;
    let lastQuote = start - 1;
    while (/["'\\]/.test(input[end] ?? '')) {
        if (input[end] !== '\\')
            lastQuote = end;
        end++;
    }
    // An escaped separator is value content even after a quote.
    if ((end - lastQuote - 1) % 2 === 1 && /[,;]/.test(input[end] ?? ''))
        return end + 1;
    // Serialized strings can end with several encoded closing quotes.
    if (lastQuote >= start && valueBoundary(input, end))
        return start;
    return end;
}
/** Markers are value content; only a framed delimiter can end the value. */
export function readUnquotedCredentialValue(input, start) {
    let end = start;
    while (end < input.length) {
        if (/["'\\]/.test(input[end] ?? '')) {
            const framing = credentialFramingEnd(input, end);
            if (framing === end)
                break;
            end = framing;
            continue;
        }
        REDACTION_MARKER.lastIndex = end;
        if (input[end] === '[' && REDACTION_MARKER.test(input)) {
            end = REDACTION_MARKER.lastIndex;
            continue;
        }
        if (/[\s,;)}\]]/.test(input[end]) || (input[end] === ':' && /\s/.test(input[end + 1] ?? '')))
            break;
        end += 1;
    }
    return end > start ? { end, quote: '', raw: input.slice(start, end) } : undefined;
}
function valueBoundary(input, end) {
    return end === input.length || /[\s,;)}\]]/.test(input[end]);
}
function ownsQuotedValue(input, start, end, authentication) {
    let prefix = start - 1;
    while (prefix >= 0 && /\s/.test(input[prefix]))
        prefix--;
    const fieldValue = prefix >= 0 && /[:=]/.test(input[prefix]);
    const arrayValue = prefix >= 0 && (input[prefix] === '[' || input[prefix] === ',');
    if (start !== 0 && !fieldValue && !arrayValue && !authentication)
        return false;
    if (!authentication && !valueBoundary(input, end))
        return false;
    return !arrayValue || !/^\s*:/.test(input.slice(end));
}
function redactQuotedValue(raw, quote, redact) {
    let inner = raw.slice(quote.length, -quote.length);
    let json = false;
    if (quote === '"') {
        try {
            const decoded = JSON.parse(raw);
            if (typeof decoded === 'string') {
                inner = decoded;
                json = true;
            }
        }
        catch { /* Non-JSON diagnostic quotes retain their existing raw escape semantics. */ }
    }
    const sanitized = redact(inner);
    if (sanitized === inner)
        return raw;
    return json ? JSON.stringify(sanitized) : `${quote}${sanitized}${quote}`;
}
/** Redact inside owned string values, not apostrophes paired across unrelated prose.
 * JSON escapes are decoded one scalar at a time; unchanged scalars keep their original bytes. */
export function redactQuotedCredentialText(input, redact, processed) {
    let cursor = 0;
    let output = '';
    for (let start = 0; start < input.length; start++) {
        const char = input[start];
        const span = readQuotedCredentialValue(input, start);
        const authentication = span && /^(?:(?:Authorization|auth)\s*[:=]\s*)?Bearer\s+/i.test(input.slice(start + span.quote.length));
        if (char === '\\' && !authentication) {
            let end = start;
            while (input[end] === '\\')
                end++;
            start = end - ((end - start) % 2 === 0 ? 1 : 0);
            continue;
        }
        if (!span || !ownsQuotedValue(input, start, span.end, authentication))
            continue;
        const rendered = redactQuotedValue(span.raw, span.quote, redact);
        const at = output.length + start - cursor;
        processed?.push({ start: at + span.quote.length, end: at + rendered.length - span.quote.length });
        if (rendered !== span.raw) {
            output += input.slice(cursor, start);
            output += rendered;
            cursor = span.end;
        }
        start = span.end - 1;
    }
    return cursor === 0 ? input : output + input.slice(cursor);
}
/** Never consume a following field's key as a partial Bearer token or its '=' as padding. */
export function redactBearerCredentials(input, replacement, credentialFields, processed = []) {
    let index = 0;
    return input.replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)(?![A-Za-z0-9._~+/=-])/gi, (match, token, offset) => {
        const end = offset + match.length;
        while (processed[index] && processed[index].end <= offset)
            index++;
        const range = processed[index];
        // Ownership comes from completed scalar processing or parsed fields, never a placeholder.
        if ((range && range.start <= offset && end <= range.end) || credentialFields.has(end - token.length))
            return match;
        return replacement;
    });
}