// Pre-publish sanitize (ported from v1 src/gep/sanitize.js): before any asset leaves for the hub, deep-redact
// strings (30+ secret/path/email patterns) and scan for leaks (25 scanners + reverse env-value detection).
// Pure functions, never throw — the block decision is returned to the chokepoint (bindings), which raises a
// terminal PublishRejectedError. Command point: when redaction changes content the asset_id MUST be recomputed
// (computeAssetId excludes asset_id by default), else the published body hash won't match its id and the hub
// rejects it. See feedback_public_repo_no_internal_leak.
import { computeAssetId } from '../wire/index.js';
import { sanitizeExecutionCommand, sanitizeExecutionPayload } from '../verify/executionRedaction.js';
import { redactQuotedCredentialText, redactBearerCredentials, readQuotedCredentialValue, readUnquotedCredentialValue, remapCredentialTextRanges } from '../verify/authenticationRedaction.js';
import { checkEmbeddedSourceIntegrity, embeddedSourceTexts, sanitizeEmbeddedSourceContent } from './embeddedSource.js';
export { checkEmbeddedSourceIntegrity } from './embeddedSource.js';
export const REDACTED = '[REDACTED]';
/** Redaction patterns (ported verbatim from v1, 30 entries). A match is replaced with [REDACTED]. */
const REDACT_PATTERNS = [
    // API keys & tokens (generic)
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
const STRUCTURED_CREDENTIAL_PREFIX = /(?<![A-Za-z0-9_-])(["']?)(node[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|passwd|passphrase|credential|credentials|authorization|auth|bearer|cookie|dsn|webhook|signature|status)\1(\s*(?:#[^\r\n]*\r?\n\s*)*[:=]\s*)/gi;
const OPAQUE_CREDENTIAL_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9][A-Za-z0-9._~+=-]{31,}(?![A-Za-z0-9_-])/g;
const AMBIGUOUS_STRUCTURED_KEYS = new Set([
    'token', 'secret', 'credential', 'credentials', 'authorization', 'auth', 'cookie', 'signature',
]);
const DIAGNOSTIC_STATUS_VALUE = /^(?:ok|success|successful|succeeded|failed|failure|pending|missing|invalid|expired|mismatch|denied|unavailable|refresh needed|not configured|not found|none|null|true|false|enabled|disabled|present|absent|unknown|skipped|unsupported)$/i;
const DIAGNOSTIC_ASSIGNMENT_VALUE = /^(?:policy|mode|state|status|configured|enabled)=(?:ok|success|successful|succeeded|failed|failure|pending|missing|invalid|expired|mismatch|denied|unavailable|none|null|true|false|enabled|disabled|present|absent|unknown|skipped|unsupported)$/i;
function unquoteStructuredValue(value) {
    const trimmed = value.trim();
    const span = readQuotedCredentialValue(trimmed, 0);
    if (span?.end === trimmed.length)
        return trimmed.slice(span.quote.length, -span.quote.length).trim();
    return trimmed;
}
function shouldRedactStructuredField(key, rawValue) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    // Exact Python null and this public API-key fixture are not credentials. Do not
    // allow arbitrary identifiers, quoted nulls, or values merely prefixed with "test".
    const quoted = readQuotedCredentialValue(rawValue, 0);
    if (normalizedKey === 'apikey' && (rawValue === 'None'
        || (quoted?.end === rawValue.length && rawValue.slice(quoted.quote.length, -quoted.quote.length) === 'test-key')))
        return false;
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
/** Consume a credential's YAML block once, stopping before the next sibling.
 * Unknown/malformed indentation inside the block is withheld conservatively.
 * This is a bounded text redactor, not a YAML document parser. */
function readBlockStructuredValue(input, parentIndent, start) {
    if (!'|>!&'.includes(input[start] ?? '\0'))
        return undefined;
    // Consume properties and their whitespace/comments once. A bare '!' is a valid tag.
    let scalarStart = start;
    while (input[scalarStart] === '!' || input[scalarStart] === '&') {
        const propertyStart = scalarStart++;
        while (scalarStart < input.length && !/\s/.test(input[scalarStart]))
            scalarStart++;
        if (input[propertyStart] === '&' && scalarStart === propertyStart + 1)
            return undefined;
        for (;;) {
            while (scalarStart < input.length && /\s/.test(input[scalarStart]))
                scalarStart++;
            if (input[scalarStart] !== '#')
                break;
            const newline = input.indexOf('\n', scalarStart);
            if (newline < 0)
                return undefined;
            scalarStart = newline + 1;
        }
    }
    const header = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(input.slice(scalarStart));
    if (!header)
        return undefined;
    let end = scalarStart + header[0].length;
    while (end < input.length) {
        const nextNewline = input.indexOf('\n', end);
        const lineEnd = nextNewline < 0 ? input.length : nextNewline;
        let contentStart = end;
        while (contentStart < lineEnd && (input[contentStart] === ' ' || input[contentStart] === '\t'))
            contentStart++;
        const blank = contentStart === lineEnd || (contentStart === lineEnd - 1 && input[contentStart] === '\r');
        if (!blank && contentStart - end <= parentIndent)
            break;
        end = nextNewline < 0 ? lineEnd : nextNewline + 1;
    }
    const raw = input.slice(start, end);
    const blockSuffix = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    return { end, raw, quote: '', blockSuffix };
}
function readQuotedStructuredValue(input, start) {
    return readQuotedCredentialValue(input, start);
}
function redactStructuredCredentials(input, credentialFields, processed) {
    const edits = processed?.length ? [] : undefined;
    let cursor = 0;
    let output = '';
    let lineStart = 0;
    let lineEnd = input.indexOf('\n');
    // 每行只扫描一次prefix。key的tag/anchor不属于mapping缩进，不能把其长度当作块内容边界。
    const keyPrefix = () => {
        const end = lineEnd < 0 ? input.length : lineEnd;
        let position = lineStart;
        const horizontal = (index) => input[index] === ' ' || input[index] === '\t';
        const skipHorizontal = () => { while (position < end && horizontal(position))
            position++; };
        skipHorizontal();
        while (input[position] === '-' && horizontal(position + 1)) {
            position++;
            skipHorizontal();
        }
        if (input[position] === '?' && horizontal(position + 1)) {
            position++;
            skipHorizontal();
        }
        const indent = position - lineStart;
        while (position < end && (input[position] === '!' || input[position] === '&')) {
            const property = position++;
            if (input[property] === '!' && input[position] === '<') {
                position++;
                while (position < end && input[position] !== '>' && !/\s/.test(input[position]))
                    position++;
                if (input[position] !== '>')
                    return { start: -1, indent };
                position++;
            }
            else {
                while (position < end && !/\s/.test(input[position]))
                    position++;
                if (input[property] === '&' && position === property + 1)
                    return { start: -1, indent };
            }
            if (position < end && !horizontal(position))
                return { start: -1, indent };
            skipHorizontal();
        }
        return { start: position, indent };
    };
    let blockKey = keyPrefix();
    STRUCTURED_CREDENTIAL_PREFIX.lastIndex = 0;
    let match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
    while (match) {
        if (match.index < cursor) {
            match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
            continue;
        }
        // Advance monotonically: repeated inline candidates must not rescan the line backwards.
        while (lineEnd >= 0 && lineEnd < match.index) {
            lineStart = lineEnd + 1;
            lineEnd = input.indexOf('\n', lineStart);
            blockKey = keyPrefix();
        }
        const valueStart = STRUCTURED_CREDENTIAL_PREFIX.lastIndex;
        if (match[2]?.toLowerCase() === 'status') {
            const span = readQuotedStructuredValue(input, valueStart);
            if (span && (span.end === input.length || /[\s,;)}\]]/.test(input[span.end]))) {
                credentialFields?.add(output.length + match.index - cursor);
            }
            // Do not consume diagnostic values or repeatedly scan an unquoted suffix.
            match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
            continue;
        }
        let block;
        if (match.index === blockKey.start) {
            // An explicit key's ':' can be on a later line, at a different indentation.
            const separator = match[3];
            const delimiter = valueStart - separator.length + separator.trimEnd().length - 1;
            const valueLineStart = input.lastIndexOf('\n', delimiter) + 1;
            const parentIndent = valueLineStart === lineStart ? blockKey.indent : delimiter - valueLineStart;
            block = readBlockStructuredValue(input, parentIndent, valueStart);
        }
        const span = block
            ?? readQuotedStructuredValue(input, valueStart) ?? readUnquotedCredentialValue(input, valueStart);
        if (!span) {
            match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
            continue;
        }
        const quotedField = span.quote && (span.end === input.length || /[\s,;)}\]]/.test(input[span.end]));
        output += input.slice(cursor, valueStart);
        if (span.blockSuffix !== undefined || shouldRedactStructuredField(match[2] ?? '', span.raw)
            || /^\[redacted\]$/i.test(unquoteStructuredValue(span.raw)) || quotedField) {
            credentialFields?.add(output.length - (valueStart - match.index));
        }
        // 裸[REDACTED]会成为YAML sequence；块标量替换仍保持string。
        const replacement = span.blockSuffix !== undefined ? `"${REDACTED}"${span.blockSuffix}`
            : shouldRedactStructuredField(match[2] ?? '', span.raw) ? `${span.quote}${REDACTED}${span.quote}` : span.raw;
        output += replacement;
        if (replacement !== span.raw)
            edits?.push({ start: valueStart, end: span.end, replacementLength: replacement.length });
        cursor = span.end;
        STRUCTURED_CREDENTIAL_PREFIX.lastIndex = span.end;
        match = STRUCTURED_CREDENTIAL_PREFIX.exec(input);
    }
    if (processed && edits?.length)
        remapCredentialTextRanges(processed, edits);
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
    // Agent scratch dirs embed the user's project path and the session id: /private/tmp/claude-501/-Users-alice-repo/<uuid>/x
    [/(?:\/private)?\/tmp\/claude-\d+\/[^/\s"',;)}\]]+(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/gi, '<agent-tmp>'],
    [/\/(?:home|Users)\/[^/\s"',;)}\]]+/g, '~'], // /home/alice/proj → ~/proj
    [/[A-Za-z]:\\Users\\[^\\/\s"',;)}\]]+/g, '~'], // C:\Users\alice\proj → ~\proj
    [/-(?:home|Users)-[A-Za-z0-9_.]+-/g, '-~-'], // agent project dirs: -Users-alice-repo → -~-repo
    [/%2F(?:home|Users)%2F[^%/\s"',;)}\]]+/gi, '%2F~'], // URL-encoded session dirs: %2FUsers%2Falice → %2F~
];
/** Apply every redaction pattern (secrets → [REDACTED]) then anonymize local paths (~/...) to a single string. */
export function redactString(s) {
    if (typeof s !== 'string' || !s)
        return s;
    const processed = [];
    const scoped = redactQuotedCredentialText(s, redactString, processed);
    const credentialFields = new Set();
    let out = redactBearerCredentials(redactStructuredCredentials(scoped, credentialFields, processed), REDACTED, credentialFields, processed);
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
    return redactDeepWith(v, redactString);
}
function redactDeepWith(v, redact) {
    if (typeof v === 'string')
        return redact(v);
    if (Array.isArray(v))
        return v.map((x) => redactDeepWith(x, redact));
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v))
            out[k] = redactDeepWith(val, redact);
        return out;
    }
    return v;
}
const PROJECT_CONTEXT_FIELDS = new Set(['project_notes', 'project_fingerprint']);
function withoutProjectContext(value) {
    if (Array.isArray(value))
        return value.map(withoutProjectContext);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([field]) => !PROJECT_CONTEXT_FIELDS.has(field))
        .map(([field, nested]) => [field, withoutProjectContext(nested)]));
}
const EXECUTION_PAYLOAD_KEYS = new Set(['execution', 'execution_trace', 'execution_receipt', 'receipt', 'validator']);
function sanitizeAssetContent(asset, env) {
    const fixtureIsCredential = detectEnvValueLeaks('test-key', env).length > 0;
    const redactText = (text) => {
        const safe = redactString(text);
        return fixtureIsCredential ? safe.replaceAll('test-key', REDACTED) : safe;
    };
    const redact = (value) => redactDeepWith(value, redactText);
    const output = {};
    for (const [key, value] of Object.entries(asset)) {
        if (key === 'trigger_context' && asset.type === 'Capsule') {
            // The task prompt stays local with the project context; only its signals and model leave this node.
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const { prompt: _local, ...shared } = value;
                output[key] = redact(shared);
            }
            continue;
        }
        if (key === 'content') {
            // Project context remains local even when a draft uses a generic publication entrypoint.
            const content = asset.type === 'Capsule' ? withoutProjectContext(value) : value;
            output[key] = sanitizeEmbeddedSourceContent(content, redact, REDACTED, (text) => (detectEnvValueLeaks(text, env).length > 0 ? REDACTED : redactText(text)));
            continue;
        }
        if (key === 'validation' && Array.isArray(value)) {
            output[key] = value.map((command) => typeof command === 'string' ? sanitizeExecutionCommand(command).value : redact(command));
            continue;
        }
        if (EXECUTION_PAYLOAD_KEYS.has(key)) {
            output[key] = sanitizeExecutionPayload(value).value;
            continue;
        }
        if (key === 'provenance' && value && typeof value === 'object') {
            const provenance = value;
            const sanitizedProvenance = redact(provenance);
            if (Array.isArray(provenance['validation'])) {
                sanitizedProvenance['validation'] = provenance['validation'].map((command) => (typeof command === 'string' ? sanitizeExecutionCommand(command).value : redact(command)));
            }
            for (const executionKey of EXECUTION_PAYLOAD_KEYS) {
                if (provenance[executionKey] !== undefined) {
                    sanitizedProvenance[executionKey] = sanitizeExecutionPayload(provenance[executionKey]).value;
                }
            }
            output[key] = sanitizedProvenance;
            continue;
        }
        output[key] = redact(value);
    }
    return output;
}
/**
 * Redact a single asset and RECOMPUTE its asset_id (command point). When redaction changes content, the id must
 * change with it, otherwise the published body and id disagree. computeAssetId excludes the asset_id field by
 * default; on the rare null return we fall back to the original id.
 */
export function sanitizeAsset(asset, opts = {}) {
    const redacted = sanitizeAssetContent(asset, opts.env ?? {});
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
/** Keep each Event's content references attached after redaction changes IDs. */
export function rebindSanitizedEvolutionEventBundle(original, sanitized) {
    const output = [...sanitized];
    if (original.length !== output.length || !original.some((asset) => asset.type === 'EvolutionEvent'))
        return output;
    const geneRefs = new Map();
    const capsuleIds = new Map();
    const remember = (map, source, target, same) => {
        if (!source)
            return;
        if (!map.has(source))
            map.set(source, target);
        else {
            const previous = map.get(source);
            if (previous !== null && previous !== undefined && !same(previous, target))
                map.set(source, null);
        }
    };
    const sameGene = (a, b) => a.reference === b.reference && a.assetId === b.assetId;
    for (let index = 0; index < original.length; index++) {
        const before = original[index];
        const after = output[index];
        if (before.type !== 'Gene' || after.type !== 'Gene')
            continue;
        remember(geneRefs, before.asset_id, { reference: after.asset_id, assetId: after.asset_id }, sameGene);
        if (typeof before['id'] === 'string' && typeof after['id'] === 'string') {
            remember(geneRefs, before['id'], { reference: after['id'], assetId: after.asset_id }, sameGene);
        }
    }
    for (let index = 0; index < original.length; index++) {
        const before = original[index];
        let after = output[index];
        if (before.type !== 'Capsule' || after.type !== 'Capsule')
            continue;
        const gene = typeof before['gene'] === 'string' ? geneRefs.get(before['gene']) : undefined;
        // A CLI path may already have changed a logical reference to the final content ID.
        if (gene && after['gene'] !== gene.reference && after['gene'] !== gene.assetId) {
            after = { ...after, gene: gene.reference };
            after = { ...after, asset_id: computeAssetId(after) ?? after.asset_id };
            output[index] = after;
        }
        remember(capsuleIds, before.asset_id, after.asset_id, (a, b) => a === b);
    }
    for (let index = 0; index < original.length; index++) {
        const before = original[index];
        const after = output[index];
        if (before.type !== 'EvolutionEvent' || after.type !== 'EvolutionEvent')
            continue;
        const rebound = { ...after };
        let changed = false;
        const capsuleId = typeof before['capsule_id'] === 'string' ? capsuleIds.get(before['capsule_id']) : undefined;
        if (capsuleId && rebound['capsule_id'] !== capsuleId) {
            rebound['capsule_id'] = capsuleId;
            changed = true;
        }
        const beforeUsed = before['genes_used'];
        const afterUsed = after['genes_used'];
        if (Array.isArray(beforeUsed) && Array.isArray(afterUsed)
            && beforeUsed.length === afterUsed.length) {
            const used = afterUsed.map((id, offset) => {
                const source = beforeUsed[offset];
                const target = typeof source === 'string' ? geneRefs.get(source) : undefined;
                return target ? target.reference : id;
            });
            if (used.some((id, offset) => id !== afterUsed[offset])) {
                rebound['genes_used'] = used;
                changed = true;
            }
        }
        const reused = typeof before['reused_asset_id'] === 'string' ? geneRefs.get(before['reused_asset_id']) : undefined;
        if (reused && rebound['reused_asset_id'] !== reused.reference) {
            rebound['reused_asset_id'] = reused.reference;
            changed = true;
        }
        const beforeMeta = before['meta'];
        const afterMeta = after['meta'];
        if (beforeMeta && typeof beforeMeta === 'object' && !Array.isArray(beforeMeta)
            && afterMeta && typeof afterMeta === 'object' && !Array.isArray(afterMeta)) {
            const selected = beforeMeta['selected_asset_id'];
            const target = typeof selected === 'string' ? geneRefs.get(selected) : undefined;
            if (target && afterMeta['selected_asset_id'] !== target.assetId) {
                rebound['meta'] = { ...afterMeta, selected_asset_id: target.assetId };
                changed = true;
            }
        }
        if (changed)
            output[index] = { ...rebound, asset_id: computeAssetId(rebound) ?? rebound.asset_id };
    }
    return output;
}
/**
 * Pre-publish sanitize of a bundle (pure, never throws):
 * 1) mode != off: scan the ORIGINAL (pre-redaction) content for leaks; strict + found → blocked=true (chokepoint refuses); warn → flag only.
 * 2) REGARDLESS of mode, always deep-redact every asset + recompute asset_id (the leak-proof floor; off only skips the scan, not the redaction).
 * 3) Embedded-file manifests must match their original UTF-8 hashes before AND after sanitization in every mode.
 */
export function sanitizeBundle(bundle, opts) {
    const mode = opts.mode ?? leakCheckModeFromEnv(opts.env);
    let leaks = [];
    if (mode !== 'off') {
        const combined = bundle.map((a) => JSON.stringify(a)).join('');
        leaks = fullLeakCheck(combined, opts.env).leaks;
        for (const asset of bundle) {
            for (const text of embeddedSourceTexts(asset))
                leaks.push(...fullLeakCheck(text, opts.env).leaks);
            const executionSurfaces = [];
            if (Array.isArray(asset['validation']))
                executionSurfaces.push({ validation: asset['validation'] });
            for (const key of EXECUTION_PAYLOAD_KEYS) {
                if (asset[key] !== undefined)
                    executionSurfaces.push({ [key]: asset[key] });
            }
            const provenance = asset['provenance'];
            if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
                const provenanceRecord = provenance;
                if (Array.isArray(provenanceRecord['validation'])) {
                    executionSurfaces.push({ validation: provenanceRecord['validation'] });
                }
                for (const key of EXECUTION_PAYLOAD_KEYS) {
                    if (provenanceRecord[key] !== undefined)
                        executionSurfaces.push({ [key]: provenanceRecord[key] });
                }
            }
            if (executionSurfaces.some((surface) => sanitizeExecutionPayload(surface).changed)) {
                leaks.push({
                    type: 'execution_credential',
                    value: REDACTED,
                    suggestion: 'remove credentials from execution commands and evidence',
                });
            }
        }
    }
    // #12: a bare local path is PII (anonymized to ~/ by the redaction floor), not a credential — it must not
    // hard-block a publish in strict mode. Real secrets (everything else) still block. Path leaks stay reported.
    const leakBlocked = mode === 'strict' && leaks.some((l) => !PII_ONLY_LEAK_TYPES.has(l.type));
    const sanitized = rebindSanitizedEvolutionEventBundle(bundle, bundle.map((a) => sanitizeAsset(a, { env: opts.env })));
    let integrityBlocked = false;
    for (const asset of [...bundle, ...sanitized]) {
        const integrity = checkEmbeddedSourceIntegrity(asset);
        if (!integrity.ok) {
            integrityBlocked = true;
            if (!leaks.some((leak) => leak.type === 'embedded_source_integrity' && leak.suggestion === integrity.reason)) {
                leaks.push({ type: 'embedded_source_integrity', value: REDACTED, suggestion: integrity.reason });
            }
        }
    }
    return { bundle: sanitized, blocked: leakBlocked || integrityBlocked, leaks, mode };
}
/** Collapse a leak list into a one-line human-readable summary (for logs / rejection reason). */
export function summarizeLeaks(leaks) {
    return leaks.map((l) => `${l.type}→${l.suggestion}`).join('; ');
}