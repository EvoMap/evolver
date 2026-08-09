export const POWERSHELL_STDIN_SCRIPT_COMMAND = '& ([scriptblock]::Create([Console]::In.ReadToEnd()))';
export function windowsAclFailureDetail(cause) {
    const error = cause;
    const parts = [];
    if (typeof error?.code === 'string' && error.code) {
        parts.push('code ' + normalizePowerShellDiagnostic(error.code));
    }
    if (typeof error?.status === 'number')
        parts.push('exit ' + error.status);
    if (typeof error?.signal === 'string' && error.signal) {
        parts.push('signal ' + normalizePowerShellDiagnostic(error.signal));
    }
    const streams = [error?.stderr, error?.stdout]
        .map((stream) => (typeof stream === 'string'
        ? stream
        : Buffer.isBuffer(stream) ? stream.toString('utf8') : ''))
        .map(stripPowerShellClixml)
        .filter((text) => text.length > 0);
    if (streams.length > 0) {
        parts.push(streams.join(' | '));
    }
    else {
        const message = typeof error?.message === 'string' ? error.message : '';
        const detail = stripPowerShellClixml(message.replace(/-EncodedCommand\s+\S+/g, '-EncodedCommand <omitted>'));
        if (detail)
            parts.push(detail);
    }
    return boundPowerShellDiagnostic(parts.join('; '));
}
export function stripPowerShellClixml(text) {
    if (/#<\s*CLIXML\b/i.test(text)) {
        const errorRecords = [];
        const serializedErrors = /<S\b(?=[^>]*\bS=\x22Error\x22)[^>]*>([\s\S]*?)<\/S>/gi;
        for (const match of text.matchAll(serializedErrors)) {
            const record = decodePowerShellClixmlText(match[1] ?? '');
            const hasLocationBoilerplate = /(?:^|\s)At line:\d+ char:\d+/i.test(record);
            const decoded = normalizePowerShellDiagnostic(stripPowerShellLocationBoilerplate(record));
            if (decoded)
                errorRecords.push(decoded);
            if (hasLocationBoilerplate)
                break;
        }
        if (errorRecords.length > 0)
            return [...new Set(errorRecords)].join(' | ');
    }
    return normalizePowerShellDiagnostic(stripPowerShellLocationBoilerplate(text)
        .replace(/<Objs\b[\s\S]*?<\/Objs>/g, ' ')
        .replace(/<Objs\b[^\n]*/g, ' ')
        .replace(/#<\s*CLIXML\b/gi, ' '));
}
function stripPowerShellLocationBoilerplate(text) {
    return text.replace(/(?:^|\s)At line:\d+ char:\d+[\s\S]*$/i, ' ');
}
function decodePowerShellClixmlText(text) {
    return text
        .replace(/_x([0-9a-f]{4})_/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/&#x([0-9a-f]+);/gi, (match, value) => decodeXmlCodePoint(match, value, 16))
        .replace(/&#([0-9]+);/g, (match, value) => decodeXmlCodePoint(match, value, 10))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, String.fromCharCode(34))
        .replace(/&apos;/g, String.fromCharCode(39))
        .replace(/&amp;/g, '&');
}
function decodeXmlCodePoint(match, value, radix) {
    const codePoint = Number.parseInt(value, radix);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return match;
    }
    return String.fromCodePoint(codePoint);
}
const POWERSHELL_DIAGNOSTIC_FORMAT_CHARACTER = /^\p{Cf}$/u;
function normalizePowerShellDiagnostic(text) {
    const sanitized = [];
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
        const isFormat = POWERSHELL_DIAGNOSTIC_FORMAT_CHARACTER.test(character);
        sanitized.push(isControl || isFormat || codePoint === 0x2028 || codePoint === 0x2029 ? ' ' : character);
    }
    return sanitized.join('').replace(/\s+/g, ' ').trim();
}
function boundPowerShellDiagnostic(text) {
    const limit = 300;
    if (text.length <= limit)
        return text;
    const headLength = Math.ceil((limit - 3) / 2);
    const tailLength = limit - 3 - headLength;
    return text.slice(0, headLength) + '...' + text.slice(-tailLength);
}