import { REDACTED, detectEnvValueLeaks, isRedactionAllowlisted, leakScannerPatterns, redactString } from '../hub/sanitize.js';
import { say } from './locale.js';
export const REDACTION_RULES_VERSION = 'redact.v1';
const PATH_TOKENS = ['<agent-tmp>', '%2F~', '-~-', '~'];
const TOKENS = [REDACTED, ...PATH_TOKENS];
const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const KNOWN_SECRET = /^(?:Basic\s|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA|npm_|xox[baprsv]-|eyJ|AIza|ya29\.|(?:xai|hf|glpat|dop_v1|pk_live|pk_test|sk_live|sk_test|rk_live|rk_test)[-_]|sq0|-----BEGIN|AccountKey=|client_secret=|instrumentationkey=|Bearer\s)/i;
const OPAQUE = /^[A-Za-z0-9._~+=-]{24,}$/;
const SCANNER_KINDS = {
    db_url: 'db_url', internal_ip: 'private_ip', ssh_target: 'email', basic_auth: 'url_credential', local_path: 'home_path',
};
function tokenize(output) {
    const parts = [];
    let literal = '';
    for (let index = 0; index < output.length;) {
        const token = TOKENS.find((candidate) => output.startsWith(candidate, index));
        if (!token) {
            literal += output[index];
            index += 1;
            continue;
        }
        if (literal) {
            parts.push({ literal });
            literal = '';
        }
        const last = parts.at(-1);
        if (last && 'token' in last)
            last.token += token;
        else
            parts.push({ token });
        index += token.length;
    }
    if (literal)
        parts.push({ literal });
    return parts;
}
function classify(input, from, to, replacement) {
    if (!replacement.includes(REDACTED))
        return 'home_path';
    const original = input.slice(from, to).trim();
    if (EMAIL.test(original))
        return 'email';
    if (input.slice(Math.max(0, from - 3), from) === '://' && input[to] === '@')
        return 'url_credential';
    if (KNOWN_SECRET.test(original))
        return 'secret';
    return OPAQUE.test(original) ? 'high_entropy' : 'secret';
}
/** Recover redactString's edits: literal runs of its output are copied input, each placeholder run replaces one span. */
function alignedPieces(input, output) {
    const parts = tokenize(output);
    const pieces = [];
    let at = 0;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if ('literal' in part) {
            if (!input.startsWith(part.literal, at))
                return null;
            pieces.push({ from: at, to: at + part.literal.length, text: part.literal, kind: null });
            at += part.literal.length;
            continue;
        }
        const next = parts[index + 1];
        const end = !next ? input.length
            : index + 1 === parts.length - 1 ? input.length - next.literal.length : input.indexOf(next.literal, at + 1);
        if (end <= at || (next && index + 1 === parts.length - 1 && !input.endsWith(next.literal)))
            return null;
        const unchanged = input.slice(at, end) === part.token;
        pieces.push({ from: at, to: end, text: part.token, kind: unchanged ? null : classify(input, at, end, part.token) });
        at = end;
    }
    return at === input.length ? pieces : null;
}
/** When alignment is ambiguous, one span from the first to the last difference still yields exactly the same text. */
function coarsePieces(input, output) {
    let prefix = 0;
    while (prefix < input.length && prefix < output.length && input[prefix] === output[prefix])
        prefix += 1;
    let suffix = 0;
    while (suffix < input.length - prefix && suffix < output.length - prefix
        && input[input.length - 1 - suffix] === output[output.length - 1 - suffix])
        suffix += 1;
    const middle = output.slice(prefix, output.length - suffix);
    return [
        { from: 0, to: prefix, text: input.slice(0, prefix), kind: null },
        { from: prefix, to: input.length - suffix, text: middle, kind: classify(input, prefix, input.length - suffix, middle) },
        { from: input.length - suffix, to: input.length, text: input.slice(input.length - suffix), kind: null },
    ].filter((piece) => piece.to > piece.from || piece.text);
}
function offsetsOf(pieces) {
    const starts = [];
    pieces.reduce((offset, piece) => { starts.push(offset); return offset + piece.text.length; }, 0);
    return starts;
}
/** One edit inside a copied run (edits never touch a placeholder), in current-output coordinates. */
function applyEdit(pieces, edit) {
    const starts = offsetsOf(pieces);
    const index = pieces.findIndex((piece, at) => !piece.kind && starts[at] <= edit.start && edit.end <= starts[at] + piece.text.length);
    if (index < 0)
        return [...pieces];
    const piece = pieces[index];
    const head = edit.start - starts[index];
    const tail = edit.end - starts[index];
    return [
        ...pieces.slice(0, index),
        ...(head > 0 ? [{ from: piece.from, to: piece.from + head, text: piece.text.slice(0, head), kind: null }] : []),
        { from: piece.from + head, to: piece.from + tail, text: edit.replacement, kind: edit.kind },
        ...(tail < piece.text.length ? [{ from: piece.from + tail, to: piece.to, text: piece.text.slice(tail), kind: null }] : []),
        ...pieces.slice(index + 1),
    ];
}
/** Edits are non-overlapping; applied from the end so each one's offsets stay valid. */
function rewrite(pieces, edits) {
    return [...edits].sort((a, b) => b.start - a.start).reduce((current, edit) => applyEdit(current, edit), [...pieces]);
}
function nonOverlapping(edits) {
    const sorted = edits.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const edit of sorted)
        if (!kept.length || edit.start >= kept.at(-1).end)
            kept.push(edit);
    return kept;
}
function scannerEdits(text, env) {
    const edits = [];
    for (const { type, pattern } of leakScannerPatterns()) {
        for (const match of text.matchAll(pattern)) {
            if (isRedactionAllowlisted(match[0]))
                continue;
            edits.push({ start: match.index, end: match.index + match[0].length, replacement: REDACTED, kind: SCANNER_KINDS[type] ?? 'secret' });
        }
    }
    for (const [key, value] of Object.entries(env)) {
        if (!value || detectEnvValueLeaks(value, { [key]: value }).length === 0)
            continue;
        for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) {
            edits.push({ start: at, end: at + value.length, replacement: REDACTED, kind: 'env_value' });
        }
    }
    return edits;
}
const escapedTerm = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termEdits(text, terms) {
    const edits = [];
    for (const { term, replacement } of [...terms].sort((a, b) => b.term.length - a.term.length)) {
        // Lower-casing the whole text can change its length (İ → i̇) and shift every later offset; match in place instead.
        for (const match of text.matchAll(new RegExp(escapedTerm(term), 'giu'))) {
            edits.push({ start: match.index, end: match.index + match[0].length, replacement, kind: 'term' });
        }
    }
    return edits;
}
/** A value already replaced is not matched again: a placeholder's own characters would read as a new secret. */
function outsidePlaceholders(pieces, edits) {
    const starts = offsetsOf(pieces);
    const replaced = pieces.flatMap((piece, index) => (piece.kind ? [[starts[index], starts[index] + piece.text.length]] : []));
    return nonOverlapping(edits.filter((edit) => !replaced.some(([start, end]) => edit.start < end && edit.end > start)));
}
const outputOf = (pieces) => pieces.map((piece) => piece.text).join('');
const MASK_VISIBLE_CHARS = 3;
const MASK_MIN_CHARS = 12;
/** The report hints at what it removed without repeating it; the caller locates the span in its own input by offset. */
function masked(original) {
    return original.length >= MASK_MIN_CHARS ? `${original.slice(0, MASK_VISIBLE_CHARS)}…` : '…';
}
/**
 * redactString's rule families plus the publish-time leak scanners and the caller's terms, as located findings.
 * Offsets are UTF-16 indices into the input; applying every finding to the input yields `text` exactly.
 */
export function redactWithFindings(request) {
    const input = request.text;
    const redacted = redactString(input);
    let pieces = alignedPieces(input, redacted) ?? coarsePieces(input, redacted);
    pieces = rewrite(pieces, outsidePlaceholders(pieces, scannerEdits(outputOf(pieces), request.env)));
    const terms = [
        ...(request.terms ?? []).map((term) => ({ term: term.trim(), replacement: say(request.locale, '[项目代号]', '[codename]') })),
        ...(request.identifiers ?? []).map((term) => ({ term: term.trim(), replacement: '[term]' })),
    ].filter(({ term }) => term.length > 0);
    pieces = rewrite(pieces, outsidePlaceholders(pieces, termEdits(outputOf(pieces), terms)));
    const findings = pieces.flatMap((piece) => {
        const original = input.slice(piece.from, piece.to);
        return piece.kind && original !== piece.text
            ? [{ kind: piece.kind, start: piece.from, end: piece.to, original: masked(original), replacement: piece.text }] : [];
    });
    return { rulesVersion: REDACTION_RULES_VERSION, text: outputOf(pieces), findings };
}