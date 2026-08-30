import { createHash } from 'node:crypto';
import { classifyProvidedTargetPrefix } from './constraintAblationPredicates.js';
import { redactString, scanForLeaks } from '../hub/sanitize.js';
const KEY_VALUE_SECRET_RE = /\b(?:api[_-]?key|token|secret)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const OPENAI_SECRET_RE = /\bsk-[A-Za-z0-9_-]+\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\b1[3-9]\d{9}\b/g;
const IMPORTANT_TERMS = new Set([
    'ai', 'ask', 'ci', 'log', 'run', 'test', 'tests', 'live', 'selection', 'secret', 'secrets', 'token', 'tokens',
]);
function sha256(text) {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
function normalize(text) {
    return text
        .toLowerCase()
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[`*_#>()[\].,;:!?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
export function redactConstraintText(text) {
    return redactString(text
        .replace(OPENAI_SECRET_RE, '[REDACTED_SECRET]')
        .replace(KEY_VALUE_SECRET_RE, '[REDACTED_SECRET]')
        .replace(EMAIL_RE, '[REDACTED_EMAIL]')
        .replace(PHONE_RE, '[REDACTED_PHONE]'));
}
const CLAUSE_MARKER_RE = /\b(?:(?:(?:must|should|shall|do)\s+not|(?:mustn|shouldn|shalln|shan|don)(?:['\u2018\u2019])t)\s+only|(?:require(?:d|s)?|need(?:s)?)\s+to\s+not\s+only|must\s+(?:not(?!\s+only\b)|never)|must-not|should\s+(?:not(?!\s+only\b)|never)|shall\s+(?:not(?!\s+only\b)|never)|mustn(?:['\u2018\u2019])t(?!\s+only\b)|shouldn(?:['\u2018\u2019])t(?!\s+only\b)|shalln(?:['\u2018\u2019])t(?!\s+only\b)|shan(?:['\u2018\u2019])t(?!\s+only\b)|do\s+not(?!\s+only\b)|don(?:['\u2018\u2019])t(?!\s+only\b)|(?:require(?:d|s)?|need(?:s)?)\s+to\s+not(?!\s+only\b)|never|must|should|shall|require(?:d|s)?|need(?:s)?\s+to)\b/gi;
const NEGATIVE_CONSTRAINT_MARKER_RE = /^(?:must\s+(?:not(?!\s+only\b)|never)|must-not|should\s+(?:not(?!\s+only\b)|never)|shall\s+(?:not(?!\s+only\b)|never)|mustn(?:['\u2018\u2019])t(?!\s+only\b)|shouldn(?:['\u2018\u2019])t(?!\s+only\b)|shalln(?:['\u2018\u2019])t(?!\s+only\b)|shan(?:['\u2018\u2019])t(?!\s+only\b)|do\s+not(?!\s+only\b)|don(?:['\u2018\u2019])t(?!\s+only\b)|(?:require(?:d|s)?|need(?:s)?)\s+to\s+not(?!\s+only\b)|never)$/i;
const REDACTION_MARKER_RE = /\[REDACTED(?:_[A-Z]+)?\]/gi;
const EMAIL_VALUE_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const NEGATED_ACTION_RE = /(?:^not\s+(?!only\b)|\b(?:(?:am|are|did|do|does|had|has|have|is|need|needs|ought|was|were)\s+not(?!\s+only\b)|(?:aren't|couldn't|didn't|doesn't|don't|hadn't|hasn't|haven't|isn't|mightn't|needn't|oughtn't|wasn't|weren't|won't|wouldn't)(?!\s+only\b)|never|must\s+not(?!\s+only\b)|mustn't(?!\s+only\b)|should\s+not(?!\s+only\b)|shouldn't(?!\s+only\b)|shall\s+not(?!\s+only\b)|shalln't(?!\s+only\b)|shan't(?!\s+only\b)|cannot(?!\s+only\b)|can't(?!\s+only\b)|can\s+not(?!\s+only\b)|(?:will|would|can|could|may|might)\s+not(?!\s+only\b))\b)/i;
const WITHOUT_ACTION_RE = /\bwithout\b/i;
const POTENTIAL_CONDITIONAL_SCOPE_RE = /(?:^|,)\s*(?:(?:eventually|finally|initially|later|subsequently)\s+)*(?:assuming|if|once|provided|supposing|unless|when|while)\b|\b(?:and|or|then)\s+(?:(?:eventually|finally|initially|later|subsequently)\s+)*(?:assuming|if|once|provided|supposing|unless|when|while)\b|\bprovided\s+that\b/i;
const CLOSED_IF_ANYTHING_RE = /(^|,)\s*if\s+anything\s*,/gi;
const COORDINATED_PROVIDED_RE = /\b(and|or|then)\s+(?:(?:eventually|finally|initially|later|subsequently)\s+)*provided\b/gi;
const LEADING_PROVIDED_RE = /(^|,)\s*(?:(?:eventually|finally|initially|later|subsequently)\s+)*provided\b/gi;
const PROVIDED_BY_ADJUNCT_RE = /\bprovided\s+by\b/gi;
const LEADING_DISCOURSE_TEMPORAL_RE = /^\s*(?:eventually|finally|initially|later|subsequently)\s*,\s*(?:once|when|while)\b[^,;.!?\r\n]*,\s*/i;
const COORDINATED_TEMPORAL_RE = /\b(and|or|then)\s+(?:(?:eventually|finally|initially|later|subsequently)\s+)*(?:once|when|while)\b/gi;
const NEGATIVE_SUBJECT_MARKER_RE = /\b(?:neither|no|nobody|none|nothing|zero)\b/i;
const COMMA_DELIMITED_WITHOUT_RE = /\bwithout\b[^,;.!?\r\n]*,/gi;
const COMMA_DELIMITED_TEMPORAL_RE = /,\s*(?:once|when|while)\b[^,;.!?\r\n]*,/gi;
const AFFIRMATIVE_ACTION_LEMMAS = [
    'access', 'allow', 'call', 'display', 'emit', 'enable', 'expose', 'export', 'feed', 'include', 'leak',
    'log', 'output', 'print', 'provide', 'publish', 'reveal', 'run', 'send', 'share', 'show', 'store',
    'transmit', 'upload', 'use', 'write',
];
const INDEPENDENT_AFFIRMATIVE_AUXILIARIES = new Set([
    'am', 'are', 'be', 'been', 'being', 'can', 'could', 'did', 'do', 'does', 'had', 'has', 'have', 'is',
    'may', 'might', 'must', 'shall', 'should', 'was', 'were', 'will', 'would',
]);
const CREDENTIAL_LEAK_TYPES = new Set([
    'api_key',
    'azure_client_secret',
    'azure_instrumentation_key',
    'azure_key',
    'basic_auth',
    'bearer_token',
    'db_url',
    'discord_token',
    'env_value_leak',
    'github_token',
    'jwt',
    'npm_token',
    'password',
    'private_key',
    'proxy_token',
    'secret',
    'slack_token',
]);
function splitConstraintCandidates(text) {
    const spans = [];
    const boundary = /\r?\n|(?<=[.!?])\s+/g;
    let start = 0;
    const append = (end) => {
        const raw = text.slice(start, end);
        const leadingWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
        let textStart = start + leadingWhitespace;
        const listMarker = text.slice(textStart, end).match(/^(?:[-*]\s+|\d+[.)]\s+|\[[ xX]\]\s*)/);
        if (listMarker)
            textStart += listMarker[0].length;
        const trailingWhitespace = text.slice(textStart, end).match(/\s*$/)?.[0].length ?? 0;
        const textEnd = end - trailingWhitespace;
        const candidate = text.slice(textStart, textEnd);
        if (candidate)
            spans.push({ text: candidate, start, end, textStart });
    };
    for (const match of text.matchAll(boundary)) {
        const boundaryStart = match.index;
        if (!match[0].includes('\n')) {
            const punctuationIndex = boundaryStart - 1;
            const candidatePrefix = text.slice(start, punctuationIndex + 1);
            if (/^\s*\d+[.)]$/.test(candidatePrefix))
                continue;
        }
        append(boundaryStart);
        start = boundaryStart + match[0].length;
    }
    append(text.length);
    return spans;
}
function kindForMarker(marker) {
    return NEGATIVE_CONSTRAINT_MARKER_RE.test(marker) ? 'must_not' : 'must';
}
function splitConstraintClauses(text) {
    const matches = [...text.matchAll(CLAUSE_MARKER_RE)];
    return matches.flatMap((match, index) => {
        const start = match.index;
        const nextStart = matches[index + 1]?.index ?? text.length;
        const segment = text.slice(start, nextStart);
        const connector = segment.match(/\b(?:and|but|however|although|though)\s*$/i);
        const contentEnd = start + (connector?.index ?? segment.length);
        const trailingWhitespace = text.slice(start, contentEnd).match(/\s*$/)?.[0].length ?? 0;
        const end = contentEnd - trailingWhitespace;
        if (end <= start)
            return [];
        return [{ kind: kindForMarker(match[0]), text: text.slice(start, end), start, end }];
    });
}
function safeSource(source) {
    return source === 'plan' || source === 'task' || source === 'trace' ? source : 'trace';
}
function safeTraceId(traceId) {
    if (typeof traceId !== 'string' || traceId.length === 0)
        return undefined;
    return `trace:${sha256(traceId).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}
function sensitiveClassesForConstraint(text) {
    const normalized = normalize(text);
    const classes = new Set();
    if (/\b(?:secrets?|tokens?|api[_ -]?keys?|credentials?|passwords?|bearer|private[_ -]?keys?)\b/.test(normalized)) {
        classes.add('credential');
    }
    if (/\b(?:email|e-mail|mail)\b/.test(normalized))
        classes.add('email');
    if (/\b(?:paths?|directories?|filesystem|home\s+directory|user\s+profile)\b/.test(normalized)) {
        classes.add('filesystem_path');
    }
    return [...classes];
}
const TARGET_STOPWORDS = new Set([
    'a', 'also', 'although', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'however',
    'in', 'into', 'is', 'of', 'on', 'only', 'or', 'redacted', 'that', 'the', 'this', 'though', 'to', 'until',
    'when', 'with', 'without',
]);
const GENERIC_ACTION_TERMS = new Set(['add', 'call', 'include', 'print', 'use']);
const AMBIGUOUS_DEFERRED_VERB_TERMS = new Set(['live']);
function targetTerms(text, kind) {
    const stripped = normalize(text
        .replace(REDACTION_MARKER_RE, ' ')
        .replace(CLAUSE_MARKER_RE, ' '))
        .replace(/\b(?:must\s+not|must-not|mustn't|do\s+not|don't|never|must|required|requires|require|needs\s+to|need\s+to|should)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const seen = new Set();
    const terms = [];
    let expectVerb = true;
    let skippedExpectedVerb = false;
    const contrastive = isContrastiveConstraint(text);
    let group = 0;
    const groupCounts = new Map();
    const groupLimit = kind === 'must_not' ? 6 : 4;
    for (const term of stripped.split(' ')) {
        if (!term)
            continue;
        if (TARGET_STOPWORDS.has(term)) {
            if (contrastive && term === 'also') {
                group += 1;
                expectVerb = true;
                skippedExpectedVerb = false;
            }
            else if (term === 'and' || term === 'or') {
                expectVerb = true;
                skippedExpectedVerb = false;
            }
            continue;
        }
        const verb = expectVerb;
        const key = `${group}:${term}`;
        if (GENERIC_ACTION_TERMS.has(term)
            || (term.length < 4 && !IMPORTANT_TERMS.has(term))
            || seen.has(key)
            || (groupCounts.get(group) ?? 0) >= groupLimit) {
            if (expectVerb)
                skippedExpectedVerb = true;
            continue;
        }
        expectVerb = false;
        seen.add(key);
        groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
        terms.push({ text: term, verb, verbAfterSkippedTerm: verb && skippedExpectedVerb, group });
        skippedExpectedVerb = false;
    }
    return terms;
}
const IRREGULAR_VERB_FORMS = new Map([
    ['be', ['be', 'am', 'is', 'are', 'was', 'were', 'been', 'being']],
    ['begin', ['begin', 'begins', 'began', 'begun', 'beginning']],
    ['bleed', ['bleed', 'bleeds', 'bled', 'bleeding']],
    ['break', ['break', 'breaks', 'broke', 'broken', 'breaking']],
    ['breed', ['breed', 'breeds', 'bred', 'breeding']],
    ['bring', ['bring', 'brings', 'brought', 'bringing']],
    ['build', ['build', 'builds', 'built', 'building']],
    ['buy', ['buy', 'buys', 'bought', 'buying']],
    ['catch', ['catch', 'catches', 'caught', 'catching']],
    ['choose', ['choose', 'chooses', 'chose', 'chosen', 'choosing']],
    ['do', ['do', 'does', 'did', 'done', 'doing']],
    ['feed', ['feed', 'feeds', 'fed', 'feeding']],
    ['find', ['find', 'finds', 'found', 'finding']],
    ['get', ['get', 'gets', 'got', 'gotten', 'getting']],
    ['give', ['give', 'gives', 'gave', 'given', 'giving']],
    ['go', ['go', 'goes', 'went', 'gone', 'going']],
    ['keep', ['keep', 'keeps', 'kept', 'keeping']],
    ['leave', ['leave', 'leaves', 'left', 'leaving']],
    ['make', ['make', 'makes', 'made', 'making']],
    ['read', ['read', 'reads', 'reading']],
    ['ring', ['ring', 'rings', 'rang', 'rung', 'ringing']],
    ['run', ['run', 'runs', 'ran', 'running']],
    ['send', ['send', 'sends', 'sent', 'sending']],
    ['show', ['show', 'shows', 'showed', 'shown', 'showing']],
    ['sing', ['sing', 'sings', 'sang', 'sung', 'singing']],
    ['speed', ['speed', 'speeds', 'sped', 'speeded', 'speeding']],
    ['take', ['take', 'takes', 'took', 'taken', 'taking']],
    ['teach', ['teach', 'teaches', 'taught', 'teaching']],
    ['tell', ['tell', 'tells', 'told', 'telling']],
    ['think', ['think', 'thinks', 'thought', 'thinking']],
    ['write', ['write', 'writes', 'wrote', 'written', 'writing']],
]);
const IRREGULAR_SIMPLE_PAST_FORMS = new Set(['read', 'was', 'were', ...[...IRREGULAR_VERB_FORMS.entries()]
        .filter(([lemma]) => lemma !== 'be' && lemma !== 'read')
        .map(([, forms]) => forms[2])]
    .filter((form) => form !== undefined && !form.endsWith('ing')));
const IRREGULAR_PAST_PARTICIPLE_FORMS = new Set([
    'been', 'read', 'showed', 'sped',
    ...[...IRREGULAR_VERB_FORMS.entries()]
        .filter(([lemma]) => lemma !== 'be' && lemma !== 'read')
        .map(([, forms]) => forms.at(-2))
        .filter((form) => form !== undefined && !form.endsWith('ing')),
]);
const IRREGULAR_PROGRESSIVE_VERB_LEMMAS = new Map([...IRREGULAR_VERB_FORMS].flatMap(([lemma, forms]) => forms.filter((form) => form.endsWith('ing')).map((form) => [form, lemma])));
const IRREGULAR_NOUN_PLURALS = new Map([
    ['analysis', 'analyses'],
    ['basis', 'bases'],
    ['bus', 'buses'],
    ['crisis', 'crises'],
    ['leaf', 'leaves'],
    ['life', 'lives'],
    ['status', 'statuses'],
]);
const UNAMBIGUOUS_PLURAL_SINGULARS = new Map([
    ['analyses', 'analysis'],
    ['buses', 'bus'],
    ['crises', 'crisis'],
    ['statuses', 'status'],
]);
const DOUBLED_INFLECTION_BASES = new Set([
    'admit', 'commit', 'control', 'debug', 'defer', 'embed', 'format', 'occur', 'permit', 'prefer', 'refer', 'submit',
    'shred', 'transmit',
]);
const NON_DOUBLED_SHORT_CVC_BASES = new Set(['edit', 'open']);
const ED_SUFFIX_BASE_VERBS = new Set(['exceed', 'heed', 'need', 'proceed', 'seed', 'succeed']);
const EXACT_ONLY_PROGRESSIVE_LEMMAS = new Set(['be', 'do', 'go']);
const SHORT_INFLECTED_VERB_LEMMAS = new Map([
    ['died', 'die'],
    ['dying', 'die'],
    ['lied', 'lie'],
    ['lying', 'lie'],
    ['skied', 'ski'],
    ['skiing', 'ski'],
    ['taxied', 'taxi'],
    ['tied', 'tie'],
    ['tying', 'tie'],
    ['vied', 'vie'],
    ['vying', 'vie'],
]);
const SILENT_E_VERB_LEMMAS = new Map([
    ['ac', 'ace'],
    ['ag', 'age'],
    ['ap', 'ape'],
    ['creat', 'create'],
    ['delet', 'delete'],
    ['enabl', 'enable'],
    ['expos', 'expose'],
    ['includ', 'include'],
    ['ic', 'ice'],
    ['leav', 'leave'],
    ['liv', 'live'],
    ['mak', 'make'],
    ['mov', 'move'],
    ['ow', 'owe'],
    ['preserv', 'preserve'],
    ['provid', 'provide'],
    ['requir', 'require'],
    ['sav', 'save'],
    ['shar', 'share'],
    ['stor', 'store'],
    ['su', 'sue'],
    ['tak', 'take'],
    ['us', 'use'],
    ['validat', 'validate'],
    ['writ', 'write'],
]);
function addPluralForm(base, forms) {
    const irregular = IRREGULAR_NOUN_PLURALS.get(base);
    if (irregular)
        forms.add(irregular);
    else if (/[^aeiou]y$/u.test(base))
        forms.add(`${base.slice(0, -1)}ies`);
    else if (/(?:s|x|z|ch|sh)$/u.test(base))
        forms.add(`${base}es`);
    else
        forms.add(`${base}s`);
}
function addSingularCandidates(term, bases) {
    const irregular = UNAMBIGUOUS_PLURAL_SINGULARS.get(term);
    if (irregular) {
        bases.add(irregular);
        return;
    }
    if (/[^aeiou]ies$/u.test(term) && term.length > 3)
        bases.add(`${term.slice(0, -3)}y`);
    if (term.endsWith('ves') && term.length > 4) {
        const stem = term.slice(0, -3);
        bases.add(`${stem}f`);
        bases.add(`${stem}fe`);
        return;
    }
    if (/(?:sses|xes|zzes|ches|shes)$/u.test(term) && term.length > 4)
        bases.add(term.slice(0, -2));
    else if (term.endsWith('s') && term.length > 3 && !/(?:ss|us|is)$/u.test(term))
        bases.add(term.slice(0, -1));
}
function doublesFinalConsonant(base) {
    if (DOUBLED_INFLECTION_BASES.has(base))
        return true;
    if (base.length > 4 || NON_DOUBLED_SHORT_CVC_BASES.has(base))
        return false;
    return /[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghjklmnpqrstvz]$/u.test(base);
}
function addRegularVerbForms(base, forms) {
    forms.add(base);
    addPluralForm(base, forms);
    if (base.endsWith('ie')) {
        forms.add(`${base}d`);
        forms.add(`${base.slice(0, -2)}ying`);
        return;
    }
    if (base.endsWith('e')) {
        forms.add(`${base}d`);
        forms.add(`${base.slice(0, -1)}ing`);
        return;
    }
    if (/[^aeiou]y$/u.test(base))
        forms.add(`${base.slice(0, -1)}ied`);
    if (doublesFinalConsonant(base)) {
        const last = base.at(-1);
        forms.add(`${base}${last}ed`);
        forms.add(`${base}${last}ing`);
    }
    else {
        if (!/[^aeiou]y$/u.test(base))
            forms.add(`${base}ed`);
        forms.add(`${base}ing`);
    }
}
function nominalForms(term) {
    const forms = new Set([term]);
    const bases = new Set();
    addSingularCandidates(term, bases);
    if (bases.size === 0)
        addPluralForm(term, forms);
    for (const base of bases) {
        forms.add(base);
        addPluralForm(base, forms);
    }
    return forms;
}
function verbForms(term, kind) {
    const forms = new Set([term]);
    const lemma = verbLemma(term);
    if (!lemma)
        return forms;
    if (kind === 'must_not'
        && term.endsWith('ing')
        && EXACT_ONLY_PROGRESSIVE_LEMMAS.has(lemma))
        return forms;
    const irregular = IRREGULAR_VERB_FORMS.get(lemma);
    if (irregular) {
        for (const form of irregular)
            forms.add(form);
    }
    else {
        addRegularVerbForms(lemma, forms);
    }
    return forms;
}
function targetTermForms(term, kind) {
    const nominal = nominalForms(term.text);
    if (!term.verb || (term.verbAfterSkippedTerm && AMBIGUOUS_DEFERRED_VERB_TERMS.has(term.text))) {
        return nominal;
    }
    const forms = verbForms(term.text, kind);
    if (term.verbAfterSkippedTerm) {
        for (const form of nominal)
            forms.add(form);
    }
    return forms;
}
const AFFIRMATIVE_ACTION_FORMS = new Set([
    ...AFFIRMATIVE_ACTION_LEMMAS.flatMap((lemma) => [...verbForms(lemma, 'must_not')]),
    'outputted',
    'outputting',
]);
function verbLemma(term) {
    if (IRREGULAR_VERB_FORMS.has(term)
        || DOUBLED_INFLECTION_BASES.has(term)
        || ED_SUFFIX_BASE_VERBS.has(term))
        return term;
    const shortInflectedLemma = SHORT_INFLECTED_VERB_LEMMAS.get(term);
    if (shortInflectedLemma)
        return shortInflectedLemma;
    if (term.endsWith('ied') && term.length > 4) {
        return `${term.slice(0, -3)}y`;
    }
    const suffix = term.endsWith('ing') ? 'ing' : term.endsWith('ed') ? 'ed' : undefined;
    if (!suffix)
        return term;
    const irregularProgressiveLemma = IRREGULAR_PROGRESSIVE_VERB_LEMMAS.get(term);
    if (irregularProgressiveLemma)
        return irregularProgressiveLemma;
    const stem = term.slice(0, -suffix.length);
    const silentELemma = SILENT_E_VERB_LEMMAS.get(stem);
    if (silentELemma)
        return silentELemma;
    if (stem.length <= 2)
        return term;
    const last = stem.at(-1);
    if (last && last === stem.at(-2)) {
        const undoubled = stem.slice(0, -1);
        if (doublesFinalConsonant(undoubled))
            return undoubled;
    }
    return stem;
}
function termMatchIndexes(output, term, kind) {
    const outputTerms = output.match(/[a-z0-9_]+/gu) ?? [];
    const forms = targetTermForms(term, kind);
    return outputTerms.flatMap((outputTerm, index) => forms.has(outputTerm) ? [index] : []);
}
function termMatches(output, term, kind) {
    return termMatchIndexes(output, term, kind).length > 0;
}
function isViolated(kind, terms, matchedTerms, contrastive) {
    if (kind === 'must' && contrastive) {
        const matched = new Set(matchedTerms);
        const groups = new Set(terms.map((term) => term.group));
        return [...groups].some((group) => {
            const groupTerms = terms.filter((term) => term.group === group);
            return groupTerms.filter((term) => matched.has(term.text)).length < Math.min(2, groupTerms.length);
        });
    }
    if (kind === 'must')
        return matchedTerms.length < Math.min(2, terms.length);
    return matchedTerms.length >= Math.min(2, terms.length);
}
function isContrastiveConstraint(text) {
    return /(?:\bnot|n't)\s+only\b[\s\S]*\bbut\s+also\b/i.test(normalize(text));
}
function severityFor(kind) {
    return kind === 'must_not' ? 'high' : 'medium';
}
export function extractConstraints(traces) {
    const seen = new Set();
    const out = [];
    for (const trace of traces) {
        for (const candidate of splitConstraintCandidates(trace.text)) {
            for (const clause of splitConstraintClauses(candidate.text)) {
                const redactedText = redactConstraintText(clause.text);
                const textHash = sha256(normalize(redactedText));
                const source = safeSource(trace.source);
                const traceId = trace.traceId ? safeTraceId(trace.traceId) : undefined;
                const key = `${clause.kind}:${textHash}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                const id = `constraint:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
                out.push({
                    id,
                    kind: clause.kind,
                    textHash,
                    redactedText,
                    source,
                    ...(traceId ? { traceId } : {}),
                    sensitiveClasses: sensitiveClassesForConstraint(clause.text),
                });
            }
        }
    }
    return out;
}
export function buildConstraintAblatedPrompts(prompt, constraints, opts = {}) {
    const candidates = splitConstraintCandidates(prompt);
    const originalPromptHash = sha256(prompt);
    return constraints.flatMap((constraint) => {
        const matches = candidates.flatMap((candidate) => {
            return splitConstraintClauses(candidate.text).flatMap((clause) => {
                if (sha256(normalize(redactConstraintText(clause.text))) !== constraint.textHash)
                    return [];
                let start = candidate.textStart + clause.start;
                let end = start + clause.text.length;
                const before = prompt.slice(candidate.start, start);
                const trailingConnector = before.match(/(?:,\s*|\s+)(?:and|but|however|although|though)\s*$/i);
                if (trailingConnector)
                    start -= trailingConnector[0].length;
                else if (/^\s*(?:[-*]\s+|\d+[.)]\s+|\[[ xX]\]\s*)$/.test(before))
                    start = candidate.start;
                const after = prompt.slice(end, candidate.end);
                const leadingConnector = after.match(/^\s+but\s+also\s+/i)
                    ?? after.match(/^\s+(?:and|but|however|although|though)\s+/i);
                if (leadingConnector && !trailingConnector)
                    end += leadingConnector[0].length;
                return [{ start, end }];
            });
        });
        if (matches.length !== 1)
            return [];
        const match = matches[0];
        if (!match)
            return [];
        const ablatedPrompt = prompt.slice(0, match.start) + prompt.slice(match.end);
        if (ablatedPrompt === prompt)
            return [];
        return [{
                originalPromptHash,
                ablatedPromptHash: sha256(ablatedPrompt),
                removedConstraintIds: [constraint.id],
                ...(opts.includeRedactedPreview ? { redactedPreview: redactConstraintText(ablatedPrompt) } : {}),
            }];
    });
}
function sensitiveClassesForValue(value) {
    const classes = new Set();
    if (EMAIL_VALUE_RE.test(value))
        classes.add('email');
    if (new RegExp(KEY_VALUE_SECRET_RE.source, KEY_VALUE_SECRET_RE.flags).test(value)
        || new RegExp(OPENAI_SECRET_RE.source, OPENAI_SECRET_RE.flags).test(value)) {
        classes.add('credential');
    }
    for (const leak of scanForLeaks(value).leaks) {
        const type = String(leak.type);
        if (type === 'email')
            classes.add('email');
        else if (type === 'local_path')
            classes.add('filesystem_path');
        else if (CREDENTIAL_LEAK_TYPES.has(type))
            classes.add('credential');
    }
    return [...classes];
}
function hasIndependentAffirmativeAction(segment, actionForms, inheritsSubject = false) {
    const stream = lexRequiredEvidence(segment);
    for (let actionIndex = inheritsSubject ? 0 : 1; actionIndex < stream.tokens.length; actionIndex += 1) {
        if (!actionForms.has(stream.tokens[actionIndex]?.value ?? ''))
            continue;
        if (stream.conditional[actionIndex] === true)
            continue;
        if (actionIndex === 0)
            return true;
        let prefixStart = 0;
        while (prefixStart < actionIndex) {
            const term = stream.tokens[prefixStart]?.value ?? '';
            if (!isIgnoredRequiredToken(stream, prefixStart)
                && !LEADING_CLAUSE_MODIFIER_TERMS.has(term)
                && !/ly$/u.test(term))
                break;
            prefixStart += 1;
        }
        const first = stream.tokens[prefixStart]?.value ?? '';
        if (inheritsSubject && prefixStart === actionIndex)
            return true;
        if (INDEPENDENT_AFFIRMATIVE_AUXILIARIES.has(first))
            return true;
        if (leadingSubjectPolarity(stream, prefixStart, actionIndex) !== 'positive')
            continue;
        if (SUBJECT_ARTICLE_TERMS.has(first) && prefixStart + 1 >= actionIndex)
            continue;
        return true;
    }
    return false;
}
const NEGATED_FINITE_AUXILIARIES = new Set([
    'am', 'are', 'can', 'could', 'did', 'do', 'does', 'had', 'has', 'have', 'is', 'may', 'might', 'must',
    'need', 'needs', 'ought', 'shall', 'should', 'was', 'were', 'will', 'would',
]);
const NEGATED_FINITE_CONTRACTIONS = new Set([
    "aren't", "can't", 'cannot', "couldn't", "didn't", "doesn't", "don't", "hadn't", "hasn't", "haven't",
    "isn't", "mightn't", "mustn't", "needn't", "oughtn't", "shan't", "shouldn't", "wasn't", "weren't",
    "won't", "wouldn't",
]);
function hasExplicitSubjectBeforeNegation(segment) {
    const stream = lexRequiredEvidence(segment);
    for (let index = 0; index < stream.tokens.length; index += 1) {
        const term = stream.tokens[index]?.value ?? '';
        const negatedAuxiliary = NEGATED_FINITE_CONTRACTIONS.has(term)
            || (NEGATED_FINITE_AUXILIARIES.has(term) && stream.tokens[index + 1]?.value === 'not');
        if (!negatedAuxiliary)
            continue;
        return index > 0 && leadingSubjectPolarity(stream, 0, index) === 'positive';
    }
    return false;
}
function startsWithSubjectElidedNegation(segment) {
    const stream = lexRequiredEvidence(segment);
    const first = stream.tokens.findIndex((_, index) => !isIgnoredRequiredToken(stream, index));
    if (first < 0)
        return false;
    const term = stream.tokens[first]?.value ?? '';
    if (NEGATED_FINITE_CONTRACTIONS.has(term))
        return true;
    return NEGATED_FINITE_AUXILIARIES.has(term)
        && stream.tokens[first + 1]?.value === 'not';
}
function startsWithSubjectElidedFiniteAction(segment, actionForms) {
    const stream = lexRequiredEvidence(segment);
    for (let index = 0; index < stream.tokens.length; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (LEADING_CLAUSE_MODIFIER_TERMS.has(term) || /ly$/u.test(term))
            continue;
        return stream.conditional[index] !== true
            && actionForms.has(term)
            && (term.endsWith('ed') || term.endsWith('s') || IRREGULAR_SIMPLE_PAST_FORMS.has(term));
    }
    return false;
}
const BASE_AGREEMENT_SUBJECTS = new Set(['i', 'they', 'we', 'you']);
const THIRD_PERSON_SUBJECTS = new Set(['he', 'it', 'she']);
const BASE_AGREEMENT_AUXILIARIES = new Set(['am', 'are', "aren't", 'do', "don't", 'have', "haven't"]);
const THIRD_PERSON_AUXILIARIES = new Set(['does', "doesn't", 'has', "hasn't", 'is', "isn't", 'needs']);
const NEGATED_AUXILIARY_TERMS = new Set([
    'am', 'are', 'can', 'cannot', 'could', 'did', 'do', 'does', 'had', 'has', 'have', 'is', 'may', 'might',
    'must', 'need', 'needs', 'ought', 'shall', 'should', 'was', 'were', 'will', 'would', "aren't", "can't", "couldn't", "didn't",
    "doesn't", "don't", "hadn't", "hasn't", "haven't", "isn't", "mightn't", "mustn't", "shan't",
    "needn't", "oughtn't", "shouldn't", "wasn't", "weren't", "won't", "wouldn't",
]);
function subjectAgreementBeforeNegation(segment) {
    const stream = lexRequiredEvidence(segment);
    let auxiliaryIndex = -1;
    let auxiliary = '';
    for (let index = 0; index < stream.tokens.length; index += 1) {
        const term = stream.tokens[index]?.value ?? '';
        if (NEGATED_AUXILIARY_TERMS.has(term)
            && (term === 'cannot'
                || term.endsWith("n't")
                || ['not', 'never'].includes(stream.tokens[index + 1]?.value ?? ''))) {
            auxiliaryIndex = index;
            auxiliary = term;
            break;
        }
    }
    if (auxiliaryIndex < 0)
        return 'unknown';
    if (BASE_AGREEMENT_AUXILIARIES.has(auxiliary))
        return 'base';
    if (THIRD_PERSON_AUXILIARIES.has(auxiliary))
        return 'third-person';
    let noun = '';
    for (let index = 0; index < auxiliaryIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (BASE_AGREEMENT_SUBJECTS.has(term))
            return 'base';
        if (THIRD_PERSON_SUBJECTS.has(term))
            return 'third-person';
        if (SUBJECT_ARTICLE_TERMS.has(term)
            || NON_SUBJECT_PREFIX_TERMS.has(term)
            || LEADING_CLAUSE_MODIFIER_TERMS.has(term)
            || /ly$/u.test(term))
            continue;
        noun = term;
    }
    if (!noun)
        return 'unknown';
    return noun.endsWith('s') && !/(?:is|ss|us)$/u.test(noun) ? 'base' : 'third-person';
}
function negatedAuxiliaryScope(segment) {
    if (/\b(?:(?:had|has|have)\s+(?:not|never)|hadn't|hasn't|haven't)\b/i.test(segment))
        return 'perfect';
    if (/\b(?:did\s+(?:not|never)|didn't)\b/i.test(segment))
        return 'past-bare';
    const progressive = /\b(?:(?:am|are|is|was|were)\s+(?:not|never)|aren't|isn't|wasn't|weren't)\b/i.exec(segment);
    if (progressive) {
        const suffix = segment.slice(progressive.index + progressive[0].length);
        const localComplement = suffix.split(/[,;]|\b(?:after|because|before|once|so|when|while|without)\b/i, 1)[0] ?? '';
        if (/\b[a-z]+ing\b/i.test(localComplement))
            return 'progressive';
    }
    return /\b(?:(?:can|could|did|do|does|may|might|must|need|needs|ought|shall|should|will|would)\s+(?:not|never)|cannot|can't|couldn't|didn't|doesn't|don't|mightn't|mustn't|needn't|oughtn't|shan't|shouldn't|won't|wouldn't)\b/i.test(segment)
        ? 'bare'
        : 'other';
}
function isThirdPersonActionForm(term, actionForms) {
    if ([...IRREGULAR_VERB_FORMS.values()].some((forms) => forms[1] === term))
        return true;
    const bases = new Set();
    addSingularCandidates(term, bases);
    return [...bases].some((base) => actionForms.has(base));
}
function subjectElidedActionMorphology(segment, actionForms) {
    const stream = lexRequiredEvidence(segment);
    for (let index = 0; index < stream.tokens.length; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (LEADING_CLAUSE_MODIFIER_TERMS.has(term) || /ly$/u.test(term))
            continue;
        if (!actionForms.has(term) || stream.conditional[index] === true)
            return undefined;
        if (term.endsWith('ing'))
            return 'progressive';
        if (IRREGULAR_SIMPLE_PAST_FORMS.has(term) && !IRREGULAR_PAST_PARTICIPLE_FORMS.has(term)) {
            return 'simple-past';
        }
        if (term.endsWith('ed')
            || IRREGULAR_SIMPLE_PAST_FORMS.has(term)
            || IRREGULAR_PAST_PARTICIPLE_FORMS.has(term))
            return 'participle';
        return isThirdPersonActionForm(term, actionForms) ? 'third-person' : 'base';
    }
    return undefined;
}
function startsWithSubjectElidedGerund(segment) {
    const stream = lexRequiredEvidence(segment);
    for (let index = 0; index < stream.tokens.length; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (LEADING_CLAUSE_MODIFIER_TERMS.has(term) || /ly$/u.test(term))
            continue;
        return term.endsWith('ing') && stream.conditional[index] !== true;
    }
    return false;
}
function finiteClauseSubjectPolarity(segment) {
    const stream = lexRequiredEvidence(segment);
    if (!hasFinitePredicatePrefix(stream, 0, stream.tokens.length))
        return 'absent';
    return leadingSubjectPolarity(stream, 0, stream.tokens.length);
}
function matchingActionSubjectPolarity(segment, actionForms) {
    const stream = lexRequiredEvidence(segment);
    for (let actionIndex = 0; actionIndex < stream.tokens.length; actionIndex += 1) {
        if (!actionForms.has(stream.tokens[actionIndex]?.value ?? ''))
            continue;
        return leadingSubjectPolarity(stream, 0, actionIndex);
    }
    return 'absent';
}
function hasIndependentFiniteAction(segment, actionForms) {
    const stream = lexRequiredEvidence(segment);
    for (let actionIndex = 1; actionIndex < stream.tokens.length; actionIndex += 1) {
        const term = stream.tokens[actionIndex]?.value ?? '';
        if (!actionForms.has(term) || stream.conditional[actionIndex] === true)
            continue;
        const finite = term.endsWith('ed') || term.endsWith('s') || IRREGULAR_SIMPLE_PAST_FORMS.has(term);
        if (finite && leadingSubjectPolarity(stream, 0, actionIndex) === 'positive')
            return true;
    }
    return false;
}
function stripCommaDelimitedWithoutAdjuncts(clause, actionForms) {
    return clause.replace(COMMA_DELIMITED_WITHOUT_RE, (match) => {
        const coordinated = match.replace(/^\s*without\b/i, '').replace(/,\s*$/u, '').split(/\band\b/i).slice(1);
        const hasFiniteCoordination = coordinated.some((segment) => (startsWithSubjectElidedFiniteAction(segment, actionForms)
            || hasIndependentFiniteAction(segment, actionForms)));
        return hasFiniteCoordination ? match : ' ';
    });
}
function affirmativePrefixBeforeNegation(segment, actionForms, inheritsSubject = true) {
    const match = NEGATED_ACTION_RE.exec(segment);
    if (!match || match.index === 0)
        return undefined;
    const prefix = normalize(segment.slice(0, match.index));
    return prefix && hasIndependentAffirmativeAction(prefix, actionForms, inheritsSubject) ? prefix : undefined;
}
function hasIndependentSimplePastPredicate(segment) {
    const stream = lexRequiredEvidence(segment);
    for (let predicateIndex = 1; predicateIndex < stream.tokens.length; predicateIndex += 1) {
        const term = stream.tokens[predicateIndex]?.value ?? '';
        const simplePast = ['did', 'had', 'was', 'were'].includes(term)
            || term.endsWith('ed')
            || IRREGULAR_SIMPLE_PAST_FORMS.has(term);
        if (simplePast && leadingSubjectPolarity(stream, 0, predicateIndex) === 'positive')
            return true;
    }
    return false;
}
function hasIndependentSimplePastAction(segment, actionForms, inheritsSubject = false) {
    const stream = lexRequiredEvidence(segment.slice(0, MAX_FACTUAL_TAIL_CHARS));
    actionLoop: for (let index = 0; index < stream.tokens.length; index += 1) {
        const term = stream.tokens[index]?.value ?? '';
        if (!actionForms.has(term) || stream.conditional[index] === true)
            continue;
        for (let prior = index - 1; prior >= 0; prior -= 1) {
            const priorTerm = stream.tokens[prior]?.value ?? '';
            if (PREDICATE_COORDINATOR_TERMS.has(priorTerm))
                break;
            if (MODAL_AUXILIARY_TERMS.has(priorTerm) || SEMI_MODAL_AUXILIARY_TERMS.has(priorTerm)) {
                continue actionLoop;
            }
        }
        const subjectPolarity = leadingSubjectPolarity(stream, 0, index);
        if ((term.endsWith('ed') || IRREGULAR_SIMPLE_PAST_FORMS.has(term))
            && (subjectPolarity === 'positive'
                || (inheritsSubject && subjectPolarity !== 'negative')))
            return true;
    }
    return false;
}
function providedTargetPrefixKind(source, context) {
    const objectTerms = context.terms.filter((term) => !term.verb);
    return classifyProvidedTargetPrefix({
        actionForms: context.actionForms,
        lexicon: {
            commaDelimitedPrepositions: COMMA_DELIMITED_PREPOSITION_TERMS,
            conditionalMarkers: CONDITIONAL_MARKER_TERMS,
            irregularPastParticiples: IRREGULAR_PAST_PARTICIPLE_FORMS,
            irregularSimplePast: IRREGULAR_SIMPLE_PAST_FORMS,
            leadingClauseModifiers: LEADING_CLAUSE_MODIFIER_TERMS,
            passiveAuxiliaries: PASSIVE_AUXILIARY_TERMS,
            subjectArticles: SUBJECT_ARTICLE_TERMS,
        },
        objectForms: objectTerms.map((term) => targetTermForms(term, 'must_not')),
        predicates: {
            finiteClauseSubjectPolarity,
            hasIndependentAffirmativeAction,
            isAttributiveTargetModifier,
            isFinitePredicateTerm,
            tokenize: lexRequiredEvidence,
        },
        source: normalize(source),
    });
}
function hasTargetActionPrefix(source, targetActionForms) {
    const stream = lexRequiredEvidence(source);
    for (let actionIndex = 0; actionIndex < stream.tokens.length; actionIndex += 1) {
        if (!targetActionForms.has(stream.tokens[actionIndex]?.value ?? ''))
            continue;
        if (actionIndex === 0 || leadingSubjectPolarity(stream, 0, actionIndex) === 'positive')
            return true;
    }
    return false;
}
function hasProvidedMatrixAction(source, context) {
    const commaIndex = source.indexOf(',');
    if (commaIndex >= 0) {
        const prefixKind = providedTargetPrefixKind(source.slice(0, commaIndex), context);
        if (prefixKind === 'factual')
            return false;
        if (prefixKind === 'conditional')
            return true;
    }
    let matrixScope = commaIndex >= 0
        ? source.slice(commaIndex + 1)
        : source.replace(/^\s*that\b/iu, ' ');
    const subordinateIndex = matrixScope.search(/\b(?:after|assuming|because|before|if|once|supposing|that|unless|when|while)\b/iu);
    if (subordinateIndex >= 0)
        matrixScope = matrixScope.slice(0, subordinateIndex);
    const candidates = matrixScope.split(/\b(?:and|but|or|then)\b/iu);
    return (commaIndex >= 0 ? candidates : candidates.slice(0, 1))
        .some((candidate) => hasIndependentAffirmativeAction(candidate, context.targetActionForms));
}
function hasPotentialMarker(source, context) {
    const { targetActionForms } = context;
    const normalizedSource = source
        .replace(CLOSED_IF_ANYTHING_RE, '$1 ')
        .replace(COORDINATED_PROVIDED_RE, (match, connector, offset, whole) => (!targetActionForms.has('provided')
        || hasTargetActionPrefix(whole.slice(0, offset), targetActionForms)
        || hasProvidedMatrixAction(whole.slice(offset + match.length), context)
        ? match
        : `${connector} `))
        .replace(LEADING_PROVIDED_RE, (match, boundary, offset, whole) => (!targetActionForms.has('provided')
        || hasTargetActionPrefix(whole.slice(0, offset), targetActionForms)
        || hasProvidedMatrixAction(whole.slice(offset + match.length), context)
        ? match
        : `${boundary} `));
    return POTENTIAL_CONDITIONAL_SCOPE_RE.test(normalizedSource)
        || hasTargetActionBeforePostposedConditionalMarker(normalizedSource, targetActionForms);
}
function hasFactualProvidedAction(source, context) {
    const stream = lexRequiredEvidence(source);
    for (let index = 0; index < stream.tokens.length; index += 1) {
        const token = stream.tokens[index];
        if (token?.value !== 'provided' || isAdjectivalProvided(stream.tokens, index))
            continue;
        let clauseStart = index;
        while (clauseStart > 0 && stream.tokens[clauseStart - 1]?.clause === token.clause)
            clauseStart -= 1;
        if (leadingSubjectPolarity(stream, clauseStart, index) !== 'positive')
            continue;
        const tail = stream.tokens.slice(index + 1)
            .filter((candidate) => candidate.clause === token.clause)
            .map((candidate) => candidate.value)
            .join(' ');
        if (!hasProvidedMatrixAction(tail, context))
            return true;
    }
    return false;
}
function stripFactualTemporalMarkers(segment, context) {
    let probe = segment.replace(PROVIDED_BY_ADJUNCT_RE, ' ');
    probe = probe.replace(COORDINATED_TEMPORAL_RE, (match, connector, offset) => {
        const prefix = probe.slice(0, offset);
        const suffix = probe.slice(offset + match.length);
        return hasIndependentSimplePastPredicate(prefix)
            && hasIndependentSimplePastAction(suffix, context.actionForms, true)
            ? `${connector} `
            : match;
    });
    const leadingTemporal = LEADING_DISCOURSE_TEMPORAL_RE.exec(probe);
    if (!leadingTemporal)
        return probe;
    const suffix = probe.slice(leadingTemporal[0].length);
    return hasIndependentSimplePastAction(suffix, context.actionForms)
        || hasFactualProvidedAction(suffix, context)
        ? suffix
        : probe;
}
function hasConditionalEvidence(probe, hadProvidedBy, context) {
    return hasPotentialMarker(probe, context)
        || hasTargetActionBeforePostposedConditionalMarker(probe, context.targetActionForms)
        || (hadProvidedBy
            && !hasFactualProvidedAction(probe, context)
            && lexRequiredEvidence(probe).conditional.some(Boolean));
}
function hasPotentialConditionalScope(segment, actionForms, targetActionForms, terms) {
    const context = { actionForms, targetActionForms, terms };
    if (!hasPotentialMarker(segment, context))
        return false;
    const hadProvidedBy = segment.search(PROVIDED_BY_ADJUNCT_RE) >= 0;
    const probe = stripFactualTemporalMarkers(segment, context);
    return hasConditionalEvidence(probe, hadProvidedBy, context);
}
const NON_FACTUAL_MATRIX_AUXILIARIES = new Set([
    'can', 'cannot', "can't", 'could', "couldn't", 'may', 'might', "mightn't", 'must', "mustn't",
    'need', "needn't", 'ought', "oughtn't", 'shall', "shan't", 'should', "shouldn't", 'will', "won't",
    'would', "wouldn't",
]);
function hasFactualMatrixPredicate(segment) {
    const stream = lexRequiredEvidence(segment);
    if (stream.tokens.some((token, index) => (!isIgnoredRequiredToken(stream, index) && NON_FACTUAL_MATRIX_AUXILIARIES.has(token.value))))
        return false;
    return finiteClauseSubjectPolarity(segment) !== 'absent';
}
const MAX_FACTUAL_TAIL_PROBES = 256;
const MAX_FACTUAL_TAIL_CHARS = 4_096;
function boundedFactualTail(segment, start) {
    const window = segment.slice(start, start + MAX_FACTUAL_TAIL_CHARS);
    const hardBoundary = window.search(/[.!?;\r\n]/u);
    return normalize(hardBoundary >= 0 ? window.slice(0, hardBoundary) : window);
}
function factualTailsAfterBoundary(segment) {
    const tails = [];
    const seen = new Set();
    const addTail = (start, temporal, matrixEnd, allowsInheritedGerund = false) => {
        const candidate = boundedFactualTail(segment, start);
        if (!candidate || seen.has(candidate))
            return;
        seen.add(candidate);
        if (temporal) {
            const prefixEnd = matrixEnd ?? start;
            const matrixPrefix = normalize(segment.slice(Math.max(0, prefixEnd - MAX_FACTUAL_TAIL_CHARS), prefixEnd));
            const inheritedGerund = allowsInheritedGerund && startsWithSubjectElidedGerund(candidate);
            if (!hasFactualMatrixPredicate(matrixPrefix)
                || (!hasIndependentSimplePastPredicate(candidate) && !inheritedGerund))
                return;
        }
        tails.push(candidate);
    };
    const boundaryRe = /\b(after|because|before|once|so|when|while)\b/gi;
    let boundaryProbes = 0;
    for (const match of segment.matchAll(boundaryRe)) {
        if (boundaryProbes >= MAX_FACTUAL_TAIL_PROBES)
            break;
        boundaryProbes += 1;
        const marker = match[1]?.toLowerCase() ?? '';
        const temporal = marker === 'once' || marker === 'when' || marker === 'while';
        addTail(match.index + match[0].length, temporal, match.index, marker === 'when' || marker === 'while');
    }
    const commaRe = /,/g;
    let commaProbes = 0;
    for (const match of segment.matchAll(commaRe)) {
        if (commaProbes >= MAX_FACTUAL_TAIL_PROBES)
            break;
        commaProbes += 1;
        addTail(match.index + 1, false);
    }
    return tails;
}
function affirmativeFragmentFromTail(candidate, actionForms, inheritsSubject) {
    if (NEGATED_ACTION_RE.test(candidate)) {
        return affirmativePrefixBeforeNegation(candidate, actionForms, inheritsSubject);
    }
    return hasIndependentAffirmativeAction(candidate, actionForms, inheritsSubject) ? candidate : undefined;
}
function factualTailSubjectPolarity(segment) {
    const stream = lexRequiredEvidence(segment);
    for (let predicateIndex = 1; predicateIndex < stream.tokens.length; predicateIndex += 1) {
        if (stream.conditional[predicateIndex] === true)
            continue;
        const term = stream.tokens[predicateIndex]?.value ?? '';
        const finite = isFinitePredicateTerm(term)
            || IRREGULAR_SIMPLE_PAST_FORMS.has(term)
            || term.endsWith('ed')
            || (KNOWN_EVIDENCE_ACTION_TERMS.has(term) && term.endsWith('s'));
        if (finite)
            return leadingSubjectPolarity(stream, 0, predicateIndex);
    }
    return 'absent';
}
function factualTailEvidence(tails, actionForms, inheritsSubject) {
    let subjectMode = 'none';
    let subjectAgreement = 'unknown';
    for (const tail of tails) {
        const affirmative = affirmativeFragmentFromTail(tail, actionForms, inheritsSubject);
        if (affirmative)
            return { affirmative, subjectAgreement: 'unknown', subjectMode: 'affirmative' };
        if (NEGATED_ACTION_RE.test(tail)) {
            if (hasExplicitSubjectBeforeNegation(tail)) {
                const auxiliaryScope = negatedAuxiliaryScope(tail);
                subjectMode = auxiliaryScope === 'bare'
                    ? 'negated-bare'
                    : auxiliaryScope === 'past-bare'
                        ? 'negated-past-bare'
                        : auxiliaryScope === 'perfect'
                            ? 'negated-perfect'
                            : auxiliaryScope === 'progressive'
                                ? 'negated-progressive'
                                : 'finite';
                subjectAgreement = subjectAgreementBeforeNegation(tail);
            }
            continue;
        }
        if (inheritsSubject && startsWithSubjectElidedGerund(tail)) {
            subjectMode = 'affirmative';
            subjectAgreement = 'unknown';
            continue;
        }
        const polarity = factualTailSubjectPolarity(tail);
        if (polarity === 'positive') {
            subjectMode = 'affirmative';
            subjectAgreement = 'unknown';
        }
        else if (polarity === 'negative' && subjectMode === 'none') {
            subjectMode = 'negative';
            subjectAgreement = 'unknown';
        }
    }
    return { subjectAgreement, subjectMode };
}
function contextualNoAdjunctAllowsImperative(segment) {
    const commaIndex = segment.indexOf(',');
    if (commaIndex < 0)
        return false;
    const terms = normalize(segment.slice(0, commaIndex)).split(' ').filter(Boolean);
    return terms[0] === 'no' && (terms[1] === 'later' || terms[1] === 'matter');
}
function predicateConditionality(segment, actionForms) {
    const stream = lexRequiredEvidence(segment);
    let conditional = false;
    let unconditional = false;
    for (let index = 0; index < stream.tokens.length; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        const predicate = actionForms.has(term)
            || isFinitePredicateTerm(term)
            || IRREGULAR_SIMPLE_PAST_FORMS.has(term)
            || term.endsWith('ed')
            || (KNOWN_EVIDENCE_ACTION_TERMS.has(term) && /(?:ing|s)$/u.test(term));
        if (!predicate)
            continue;
        if (stream.conditional[index] === true)
            conditional = true;
        else
            unconditional = true;
    }
    if (conditional && unconditional)
        return 'mixed';
    if (conditional)
        return 'conditional';
    if (unconditional)
        return 'unconditional';
    return 'none';
}
function hasMatrixPredicateBeforeConditionalMarker(segment, actionForms) {
    const stream = lexRequiredEvidence(segment);
    const markerIndex = stream.tokens.findIndex((token, index) => (!isIgnoredRequiredToken(stream, index)
        && CONDITIONAL_MARKER_TERMS.has(token.value)
        && stream.conditional[index] === true));
    if (markerIndex < 0)
        return false;
    for (let index = 0; index < markerIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (actionForms.has(term)
            || isFinitePredicateTerm(term)
            || IRREGULAR_SIMPLE_PAST_FORMS.has(term)
            || term.endsWith('ed')
            || (KNOWN_EVIDENCE_ACTION_TERMS.has(term) && /(?:ing|s)$/u.test(term)))
            return true;
    }
    return false;
}
function hasTargetActionBeforePostposedConditionalMarker(segment, targetActionForms) {
    const stream = lexRequiredEvidence(segment);
    let targetActionIndex;
    for (let index = 0; index < stream.tokens.length; index += 1) {
        const term = stream.tokens[index]?.value ?? '';
        const embeddedGovernorIndex = embeddedIfGovernorIndex(stream.tokens, index);
        const targetActionIsEmbeddedGovernor = embeddedGovernorIndex !== undefined
            && embeddedGovernorIndex === targetActionIndex;
        const postposedMarker = isConditionalMarkerUse(stream.tokens, index)
            || targetActionIsEmbeddedGovernor
            || (TEMPORAL_CONDITIONAL_MARKER_TERMS.has(term)
                && !isMentionedConditionalMarker(stream.tokens, index)
                && !isFactualTemporalMarkerUse(stream.tokens, index));
        if (targetActionIndex !== undefined
            && postposedMarker) {
            if (!TEMPORAL_CONDITIONAL_MARKER_TERMS.has(term))
                return true;
            const prefix = segment.slice(0, stream.tokens[index]?.start ?? 0);
            if (!hasIndependentSimplePastAction(prefix, targetActionForms))
                return true;
        }
        if (targetActionIndex === undefined
            && targetActionForms.has(term)
            && (index === 0 || leadingSubjectPolarity(stream, 0, index) === 'positive')) {
            targetActionIndex = index;
        }
    }
    return false;
}
function affirmativeOutputClauses(redactedOutput, terms) {
    const actionForms = new Set(AFFIRMATIVE_ACTION_FORMS);
    const targetActionForms = new Set();
    for (const term of terms) {
        if (!term.verb)
            continue;
        for (const form of targetTermForms(term, 'must_not')) {
            actionForms.add(form);
            targetActionForms.add(form);
        }
    }
    return redactedOutput
        .split(/(?<=[.!?;])|\r?\n|\b(?:but|however|although|though)\b/gi)
        .map((clause) => clause.replace(REDACTION_MARKER_RE, ' ').trim())
        .filter((clause) => clause.length > 0)
        .flatMap((rawClause) => {
        const scopedClause = stripCommaDelimitedWithoutAdjuncts(rawClause, actionForms);
        const clause = normalize(scopedClause);
        if (!NEGATED_ACTION_RE.test(clause)
            && !WITHOUT_ACTION_RE.test(clause)
            && !NEGATIVE_SUBJECT_MARKER_RE.test(clause)
            && !hasPotentialConditionalScope(scopedClause, actionForms, targetActionForms, terms))
            return [clause];
        const parts = scopedClause.split(/\b(and|but|however|although|though|or|then|without)\b/i);
        const segments = [];
        let connector;
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index] ?? '';
            if (index % 2 === 1) {
                connector = part.trim().toLowerCase();
                continue;
            }
            const rawText = part.trim();
            const text = normalize(rawText);
            if (!text)
                continue;
            segments.push({ ...(connector ? { connector } : {}), rawText, text });
            connector = undefined;
        }
        let requiresIndependentAction = NEGATED_ACTION_RE.test(segments[0]?.text ?? '');
        let inheritedSubjectMode = 'none';
        let inheritedSubjectAgreement = 'unknown';
        let conditionalCoordination = false;
        let conditionalCoordinationAllowsIndependentReset = false;
        return segments.flatMap((segment, index) => {
            if (segment.connector === 'without') {
                requiresIndependentAction = true;
                if (/,\s*$/u.test(segment.rawText)) {
                    conditionalCoordination = false;
                    conditionalCoordinationAllowsIndependentReset = false;
                }
                return [];
            }
            const postposedTargetConditional = hasTargetActionBeforePostposedConditionalMarker(segment.rawText, targetActionForms);
            const ownConditional = postposedTargetConditional
                || (predicateConditionality(segment.text, actionForms) === 'conditional'
                    && !hasMatrixPredicateBeforeConditionalMarker(segment.text, actionForms));
            const inheritedConditional = conditionalCoordination
                && (segment.connector === 'and' || segment.connector === 'or' || segment.connector === 'then')
                && !(conditionalCoordinationAllowsIndependentReset
                    && hasIndependentAffirmativeAction(segment.text, actionForms));
            const conditionalSegment = ownConditional || inheritedConditional;
            const conditionalAllowsIndependentReset = ownConditional
                ? postposedTargetConditional
                : conditionalCoordinationAllowsIndependentReset;
            const carriesConditionalCoordination = !/,\s*$/u.test(segment.rawText);
            if (NEGATED_ACTION_RE.test(segment.text)) {
                const affirmativePrefix = affirmativePrefixBeforeNegation(segment.text, actionForms);
                const negatedSubjectPolarity = finiteClauseSubjectPolarity(segment.text);
                const factualTails = factualTailsAfterBoundary(segment.rawText);
                const tailEvidence = factualTailEvidence(factualTails, actionForms, negatedSubjectPolarity !== 'negative');
                if (conditionalSegment) {
                    conditionalCoordination = carriesConditionalCoordination;
                    conditionalCoordinationAllowsIndependentReset = carriesConditionalCoordination
                        && conditionalAllowsIndependentReset;
                    requiresIndependentAction = true;
                    return [];
                }
                conditionalCoordination = false;
                conditionalCoordinationAllowsIndependentReset = false;
                requiresIndependentAction = true;
                const explicitSubject = hasExplicitSubjectBeforeNegation(segment.text);
                const preservesInheritedSubject = segment.connector === 'and'
                    && inheritedSubjectMode !== 'none'
                    && startsWithSubjectElidedNegation(segment.text);
                if (negatedSubjectPolarity === 'negative') {
                    inheritedSubjectMode = 'negative';
                    inheritedSubjectAgreement = 'unknown';
                }
                else if (explicitSubject) {
                    const auxiliaryScope = negatedAuxiliaryScope(segment.text);
                    inheritedSubjectMode = auxiliaryScope === 'bare'
                        ? 'negated-bare'
                        : auxiliaryScope === 'past-bare'
                            ? 'negated-past-bare'
                            : auxiliaryScope === 'perfect'
                                ? 'negated-perfect'
                                : auxiliaryScope === 'progressive'
                                    ? 'negated-progressive'
                                    : 'finite';
                    inheritedSubjectAgreement = subjectAgreementBeforeNegation(segment.text);
                }
                else if (!preservesInheritedSubject) {
                    inheritedSubjectMode = 'none';
                    inheritedSubjectAgreement = 'unknown';
                }
                if (tailEvidence.subjectMode !== 'none') {
                    inheritedSubjectMode = tailEvidence.subjectMode;
                    inheritedSubjectAgreement = tailEvidence.subjectAgreement;
                }
                return [affirmativePrefix, tailEvidence.affirmative]
                    .filter((fragment) => fragment !== undefined);
            }
            const finiteSubjectPolarity = finiteClauseSubjectPolarity(segment.text);
            const subjectPolarity = finiteSubjectPolarity === 'absent'
                ? matchingActionSubjectPolarity(segment.text, actionForms)
                : finiteSubjectPolarity;
            if (subjectPolarity === 'negative') {
                inheritedSubjectMode = 'negative';
                inheritedSubjectAgreement = 'unknown';
                requiresIndependentAction = true;
                const factualTails = factualTailsAfterBoundary(segment.rawText);
                const tailEvidence = factualTailEvidence(factualTails, actionForms, contextualNoAdjunctAllowsImperative(segment.rawText));
                if (conditionalSegment) {
                    conditionalCoordination = carriesConditionalCoordination;
                    conditionalCoordinationAllowsIndependentReset = carriesConditionalCoordination
                        && conditionalAllowsIndependentReset;
                    return [];
                }
                conditionalCoordination = false;
                conditionalCoordinationAllowsIndependentReset = false;
                if (tailEvidence.subjectMode !== 'none') {
                    inheritedSubjectMode = tailEvidence.subjectMode;
                    inheritedSubjectAgreement = tailEvidence.subjectAgreement;
                }
                return tailEvidence.affirmative ? [tailEvidence.affirmative] : [];
            }
            if (conditionalSegment) {
                conditionalCoordination = carriesConditionalCoordination;
                conditionalCoordinationAllowsIndependentReset = carriesConditionalCoordination
                    && conditionalAllowsIndependentReset;
                requiresIndependentAction = true;
                return [];
            }
            conditionalCoordination = false;
            conditionalCoordinationAllowsIndependentReset = false;
            if (subjectPolarity === 'positive')
                inheritedSubjectMode = 'affirmative';
            if (index === 0 || !requiresIndependentAction)
                return [segment.text];
            const followsComma = /,\s*$/u.test(segments[index - 1]?.rawText ?? '');
            if (segment.connector === 'and'
                && followsComma
                && inheritedSubjectMode !== 'negative'
                && hasIndependentAffirmativeAction(segment.text, actionForms, true))
                return [segment.text];
            if (segment.connector === 'and' && inheritedSubjectMode === 'affirmative'
                && hasIndependentAffirmativeAction(segment.text, actionForms, true))
                return [segment.text];
            const morphology = subjectElidedActionMorphology(segment.text, actionForms);
            if (segment.connector === 'and' && inheritedSubjectMode === 'negated-perfect'
                && ((morphology === 'base' && inheritedSubjectAgreement === 'base')
                    || (morphology === 'third-person' && inheritedSubjectAgreement === 'third-person'))) {
                return [segment.text];
            }
            if (segment.connector === 'and' && inheritedSubjectMode === 'negated-progressive'
                && (morphology === 'participle'
                    || morphology === 'simple-past'
                    || (morphology === 'base' && inheritedSubjectAgreement === 'base')
                    || (morphology === 'third-person' && inheritedSubjectAgreement === 'third-person'))) {
                return [segment.text];
            }
            if (segment.connector === 'and' && inheritedSubjectMode === 'negated-bare'
                && (morphology === 'simple-past'
                    || (morphology === 'third-person' && inheritedSubjectAgreement === 'third-person'))) {
                return [segment.text];
            }
            if (segment.connector === 'and' && inheritedSubjectMode === 'negated-past-bare'
                && (morphology === 'participle'
                    || morphology === 'simple-past'
                    || (morphology === 'third-person' && inheritedSubjectAgreement === 'third-person'))) {
                return [segment.text];
            }
            if (segment.connector === 'and' && inheritedSubjectMode === 'finite'
                && startsWithSubjectElidedFiniteAction(segment.text, actionForms))
                return [segment.text];
            const thenInheritsSubject = segment.connector === 'then' && inheritedSubjectMode !== 'negative';
            return hasIndependentAffirmativeAction(segment.text, actionForms, thenInheritsSubject)
                ? [segment.text]
                : [];
        });
    });
}
function mustNotMatchedTerms(redactedOutput, terms) {
    return affirmativeOutputClauses(redactedOutput, terms)
        .map((clause) => {
        const matched = terms.filter((term) => termMatches(clause, term, 'must_not'));
        if (terms.some((term) => term.verb) && !matched.some((term) => term.verb))
            return [];
        return matched.map((term) => term.text);
    })
        .sort((left, right) => right.length - left.length)[0] ?? [];
}
function isBroadProgressiveAuxiliary(term) {
    if (!term.verb || !term.text.endsWith('ing'))
        return false;
    const lemma = verbLemma(term.text);
    return lemma !== undefined && EXACT_ONLY_PROGRESSIVE_LEMMAS.has(lemma);
}
const BROAD_EVIDENCE_LINK_TERMS = new Set([
    'a', 'an', 'the', 'all', 'any', 'both', 'each', 'every', 'her', 'his', 'its', 'my', 'not', 'only', 'our',
    'some', 'that', 'their', 'these', 'this', 'those', 'your',
]);
const PASSIVE_AUXILIARY_TERMS = new Set([
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
]);
const PASSIVE_BE_AUXILIARY_TERMS = new Set([
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
]);
const PERFECT_AUXILIARY_TERMS = new Set(['had', 'has', 'have']);
const PERFECT_BROAD_FORM_TERMS = new Set(['been', 'done', 'gone']);
const MODAL_AUXILIARY_TERMS = new Set([
    'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
]);
const SEMI_MODAL_AUXILIARY_TERMS = new Set(['need', 'needed', 'needs', 'ought']);
const INDEPENDENT_BROAD_FORM_TERMS = new Set([
    'am', 'are', 'is', 'was', 'were', 'does', 'did', 'goes', 'went', 'has', 'have', 'had',
]);
const NEGATIVE_EVIDENCE_PRONOUNS = new Set(['neither', 'nobody', 'none', 'nothing']);
const NEGATIVE_EVIDENCE_DETERMINERS = new Set(['neither', 'no', 'zero']);
const SUBJECT_PRONOUN_TERMS = new Set([
    'he', 'i', 'it', 'she', 'that', 'they', 'this', 'we', 'who', 'you',
]);
const SUBJECT_ARTICLE_TERMS = new Set(['a', 'an', 'the']);
const AUXILIARY_CHAIN_MODIFIER_TERMS = new Set([
    'already', 'also', 'always', 'ever', 'just', 'still', 'yet',
]);
const LEADING_CLAUSE_MODIFIER_TERMS = new Set([
    'eventually', 'finally', 'initially', 'later', 'subsequently',
]);
// One capped token stream; each predicate probes only bounded nearby targets.
// This keeps replay evaluation O(tokens * target terms * window) and memory linear.
const MAX_REQUIRED_EVIDENCE_TERMS = 1_024;
const MAX_REQUIRED_EVIDENCE_CANDIDATES = 256;
const MAX_REQUIRED_EVIDENCE_PAIR_DISTANCE = 64;
const MAX_REQUIRED_SUBJECT_LOOKBACK = 128;
const PREDICATE_COORDINATOR_TERMS = new Set(['and', 'but', 'then']);
const CONDITIONAL_MARKER_TERMS = new Set([
    'assuming', 'if', 'once', 'provided', 'supposing', 'unless', 'when', 'while',
]);
const TEMPORAL_CONDITIONAL_MARKER_TERMS = new Set(['once', 'when', 'while']);
const CONDITIONAL_MARKER_MENTION_HEAD_TERMS = new Set(['keyword', 'term', 'word']);
const EMBEDDED_IF_GOVERNOR_TERMS = new Set([
    'ask', 'asked', 'asking', 'asks',
    'check', 'checked', 'checking', 'checks',
    'confirm', 'confirmed', 'confirming', 'confirms',
    'decide', 'decided', 'decides', 'deciding',
    'determine', 'determined', 'determines', 'determining',
    'evaluate', 'evaluated', 'evaluates', 'evaluating',
    'learn', 'learned', 'learning', 'learns',
    'see', 'seeing', 'seen', 'sees', 'saw',
    'test', 'tested', 'testing', 'tests',
    'verify', 'verified', 'verifies', 'verifying',
    'wonder', 'wondered', 'wondering', 'wonders',
]);
const PREDICATE_SCOPE_RESET_TERMS = new Set([
    ...CONDITIONAL_MARKER_TERMS,
    'although', 'as', 'because', 'however', 'once', 'though', 'when', 'whereas', 'while', 'without', 'yet',
]);
const COMMA_DELIMITED_SUBORDINATOR_TERMS = new Set([
    ...CONDITIONAL_MARKER_TERMS,
    'although', 'as', 'because', 'once', 'though', 'when', 'whereas', 'while',
]);
const TARGET_SCOPE_RESET_TERMS_LOCAL = new Set([
    ...PREDICATE_SCOPE_RESET_TERMS,
    ...PREDICATE_COORDINATOR_TERMS,
    'after', 'before', 'since', 'than', 'that',
]);
const PASSIVE_SUBJECT_POSTMODIFIER_TERMS = new Set([
    'among', 'around', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'through', 'to', 'with', 'without',
]);
const COMMA_DELIMITED_PREPOSITION_TERMS = new Set([
    ...PASSIVE_SUBJECT_POSTMODIFIER_TERMS,
    'according', 'despite', 'during', 'inside', 'outside', 'regarding', 'within',
]);
const TOTALITY_TARGET_MODIFIER_TERMS = new Set([
    'complete', 'entire', 'full', 'partial', 'total', 'whole',
]);
const KNOWN_EVIDENCE_ACTION_TERMS = new Set([
    ...[...IRREGULAR_VERB_FORMS.values()].flat(),
    ...GENERIC_ACTION_TERMS,
]);
const KNOWN_FINITE_PREDICATE_TERMS = new Set([
    ...INDEPENDENT_BROAD_FORM_TERMS,
    ...MODAL_AUXILIARY_TERMS,
    'said', 'told',
]);
const CONTEXTUAL_ZERO_METRIC_TERMS = new Set([
    'cost', 'downtime', 'latency', 'loss', 'overhead', 'variance',
]);
const ROOT_PREDICATE_BLOCKING_MODIFIER_TERMS = new Set([
    'allegedly', 'almost', 'apparently', 'maybe', 'nearly', 'perhaps', 'possibly', 'reportedly', 'supposedly',
]);
const CLAUSE_INITIAL_EVIDENTIAL_HEDGE_TERMS = new Set([
    ...ROOT_PREDICATE_BLOCKING_MODIFIER_TERMS,
    'likely', 'presumably', 'probably', 'purportedly',
]);
const EMBEDDED_CLAIM_GOVERNOR_TERMS = new Set([
    'allege', 'alleged', 'alleges', 'alleging',
    'assert', 'asserted', 'asserting', 'asserts',
    'believe', 'believed', 'believes', 'believing',
    'claim', 'claimed', 'claims', 'claiming',
    'deny', 'denied', 'denies', 'denying',
    'hear', 'heard', 'hearing', 'hears',
    'report', 'reported', 'reporting', 'reports',
    'say', 'said', 'saying', 'says',
    'suppose', 'supposed', 'supposes', 'supposing',
    'tell', 'telling', 'tells', 'told',
    'think', 'thinking', 'thinks', 'thought',
]);
const UNAMBIGUOUS_EMBEDDED_CLAIM_GOVERNOR_TERMS = new Set([
    'asserts', 'heard', 'said', 'thought', 'told',
]);
const NOMINAL_CLAIM_HEAD_TERMS = new Set(['claim', 'claims', 'report', 'reports']);
const RELATIVE_SAFE_FINITE_COMPLEMENTS = new Map([
    ['made', new Set(['progress'])],
    ['makes', new Set(['progress'])],
    ['pass', new Set(['review'])],
    ['passed', new Set(['review'])],
    ['passes', new Set(['review'])],
    ['survive', new Set(['review'])],
    ['survived', new Set(['review'])],
    ['survives', new Set(['review'])],
    ['takes', new Set(['effect'])],
    ['took', new Set(['effect'])],
]);
const NON_ADVERBIAL_PARENTHETICAL_IF_NOT_TERMS = new Set(['already', 'complete']);
const AFFIRMATIVE_PREDICATE_MODIFIER_TERMS = new Set([
    ...AUXILIARY_CHAIN_MODIFIER_TERMS,
    'actually', 'currently', 'definitely', 'only', 'successfully',
]);
const INVERTED_CONDITIONAL_AUXILIARY_TERMS = new Set([
    ...MODAL_AUXILIARY_TERMS,
    'had', 'was', 'were',
]);
const NON_SUBJECT_PREFIX_TERMS = new Set([
    ...PASSIVE_AUXILIARY_TERMS,
    ...MODAL_AUXILIARY_TERMS,
    ...SEMI_MODAL_AUXILIARY_TERMS,
    ...LEADING_CLAUSE_MODIFIER_TERMS,
    'after', 'before', 'not', 'only', 'to',
]);
function isBlockingRootPredicateModifierTerm(term) {
    return ROOT_PREDICATE_BLOCKING_MODIFIER_TERMS.has(term)
        || (term.endsWith('ly')
            && !AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(term)
            && !LEADING_CLAUSE_MODIFIER_TERMS.has(term));
}
function isClauseInitialEvidentialHedgeTerm(term) {
    return CLAUSE_INITIAL_EVIDENTIAL_HEDGE_TERMS.has(term);
}
function isAdjectivalProvided(tokens, index) {
    if (tokens[index]?.value !== 'provided')
        return false;
    if (tokens[index + 1]?.value === 'by')
        return true;
    const clauseId = tokens[index].clause;
    let previous = index - 1;
    while (previous >= 0
        && tokens[previous]?.clause === clauseId
        && /ly$/u.test(tokens[previous]?.value ?? ''))
        previous -= 1;
    const previousTerm = tokens[previous]?.clause === clauseId ? tokens[previous]?.value ?? '' : '';
    return previousTerm !== 'not'
        && previousTerm !== 'only'
        && BROAD_EVIDENCE_LINK_TERMS.has(previousTerm);
}
function hasSubjectBeforeRegularPast(tokens, predicateIndex, lowerBound) {
    const clauseId = tokens[predicateIndex]?.clause;
    for (let index = predicateIndex - 1; index >= lowerBound; index -= 1) {
        const token = tokens[index];
        if (!token || token.clause !== clauseId)
            return false;
        const term = token.value;
        if (PREDICATE_COORDINATOR_TERMS.has(term) || PREDICATE_SCOPE_RESET_TERMS.has(term))
            return false;
        if (SUBJECT_PRONOUN_TERMS.has(term) || NEGATIVE_EVIDENCE_PRONOUNS.has(term))
            return true;
        if (SUBJECT_ARTICLE_TERMS.has(term)
            || BROAD_EVIDENCE_LINK_TERMS.has(term)
            || NON_SUBJECT_PREFIX_TERMS.has(term)
            || /ly$/u.test(term)
            || isAttributiveTargetModifier(term))
            continue;
        return true;
    }
    return false;
}
function isFinitePredicateBeforeParenthetical(tokens, index, lowerBound) {
    const term = tokens[index]?.value ?? '';
    if (KNOWN_FINITE_PREDICATE_TERMS.has(term) || /n't$/u.test(term))
        return true;
    return term.endsWith('ed') && hasSubjectBeforeRegularPast(tokens, index, lowerBound);
}
function isParentheticalIfNotModifier(tokens, index) {
    if (tokens[index]?.value !== 'if' || tokens[index + 1]?.value !== 'not')
        return false;
    const modifier = tokens[index + 2];
    const next = tokens[index + 3];
    const closedModifier = modifier?.clause === tokens[index]?.clause
        && (next === undefined || next.clause !== modifier.clause || next.commaBefore);
    if (!closedModifier)
        return false;
    if (/ly$/u.test(modifier.value))
        return true;
    if (!tokens[index]?.commaBefore
        || !NON_ADVERBIAL_PARENTHETICAL_IF_NOT_TERMS.has(modifier.value))
        return false;
    const lowerBound = Math.max(0, index - MAX_REQUIRED_SUBJECT_LOOKBACK);
    for (let prior = index - 1; prior >= lowerBound && tokens[prior]?.clause === modifier.clause; prior -= 1) {
        const term = tokens[prior]?.value ?? '';
        if (PREDICATE_COORDINATOR_TERMS.has(term) || PREDICATE_SCOPE_RESET_TERMS.has(term))
            return false;
        if (isFinitePredicateBeforeParenthetical(tokens, prior, lowerBound))
            return true;
    }
    return false;
}
function isParentheticalIfAnythingModifier(tokens, index) {
    const marker = tokens[index];
    const modifier = tokens[index + 1];
    const next = tokens[index + 2];
    if (marker?.value !== 'if'
        || modifier?.value !== 'anything'
        || modifier.clause !== marker.clause)
        return false;
    const closesBeforePostmodifier = next !== undefined
        && next.clause === modifier.clause
        && COMMA_DELIMITED_PREPOSITION_TERMS.has(next.value);
    const closesBeforeClauseBoundary = next !== undefined
        && next.clause === modifier.clause
        && TARGET_SCOPE_RESET_TERMS_LOCAL.has(next.value);
    const closedModifier = next === undefined
        || next.clause !== modifier.clause
        || next.commaBefore
        || closesBeforePostmodifier
        || closesBeforeClauseBoundary;
    return closedModifier && (index === 0
        || marker.commaBefore
        || next === undefined
        || closesBeforePostmodifier
        || closesBeforeClauseBoundary);
}
function isMentionedConditionalMarker(tokens, index) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    return token !== undefined
        && previous?.clause === token.clause
        && CONDITIONAL_MARKER_MENTION_HEAD_TERMS.has(previous.value);
}
function embeddedIfGovernorIndex(tokens, index) {
    const marker = tokens[index];
    if (marker?.value !== 'if' || marker.commaBefore)
        return undefined;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
        const token = tokens[previous];
        if (!token || token.clause !== marker.clause)
            return undefined;
        const term = token.value;
        if (EMBEDDED_IF_GOVERNOR_TERMS.has(term))
            return previous;
        if (PREDICATE_COORDINATOR_TERMS.has(term)
            || CONDITIONAL_MARKER_TERMS.has(term)
            || AFFIRMATIVE_ACTION_FORMS.has(term)
            || isFinitePredicateTerm(term))
            return undefined;
        if (tokens[previous + 1]?.commaBefore)
            return undefined;
    }
    return undefined;
}
function isEmbeddedIfComplement(tokens, index) {
    return embeddedIfGovernorIndex(tokens, index) !== undefined;
}
function isFactualProvidedPredicate(tokens, index) {
    const provided = tokens[index];
    if (provided?.value !== 'provided' || provided.commaBefore)
        return false;
    let segmentStart = index;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
        const token = tokens[previous];
        if (!token || token.clause !== provided.clause)
            break;
        if (tokens[previous + 1]?.commaBefore || PREDICATE_COORDINATOR_TERMS.has(token.value))
            break;
        segmentStart = previous;
    }
    if (segmentStart === index)
        return false;
    for (let previous = segmentStart; previous < index; previous += 1) {
        const term = tokens[previous]?.value ?? '';
        if (AFFIRMATIVE_ACTION_FORMS.has(term)
            || isFinitePredicateTerm(term)
            || KNOWN_EVIDENCE_ACTION_TERMS.has(term))
            return false;
    }
    return hasSubjectBeforeRegularPast(tokens, index, segmentStart);
}
function isConditionalMarkerUse(tokens, index) {
    const term = tokens[index]?.value ?? '';
    if (!CONDITIONAL_MARKER_TERMS.has(term)
        || isAdjectivalProvided(tokens, index)
        || isFactualProvidedPredicate(tokens, index)
        || isParentheticalIfNotModifier(tokens, index)
        || isParentheticalIfAnythingModifier(tokens, index)
        || isMentionedConditionalMarker(tokens, index)
        || isEmbeddedIfComplement(tokens, index))
        return false;
    if (!TEMPORAL_CONDITIONAL_MARKER_TERMS.has(term))
        return true;
    if (isFactualTemporalMarkerUse(tokens, index))
        return false;
    const clauseId = tokens[index]?.clause;
    let hardClauseStart = index;
    while (hardClauseStart > 0 && tokens[hardClauseStart - 1]?.clause === clauseId)
        hardClauseStart -= 1;
    if (term === 'once') {
        let segmentStart = hardClauseStart;
        for (let prior = index - 1; prior >= hardClauseStart; prior -= 1) {
            if (PREDICATE_COORDINATOR_TERMS.has(tokens[prior]?.value ?? '')) {
                segmentStart = prior + 1;
                break;
            }
        }
        let nextIndex = index + 1;
        while (tokens[nextIndex]?.clause === clauseId && /ly$/u.test(tokens[nextIndex]?.value ?? ''))
            nextIndex += 1;
        const next = tokens[nextIndex];
        const nextTerm = next?.value ?? '';
        const followedByPredicate = next !== undefined
            && next.clause === clauseId
            && !next.commaBefore
            && (isFinitePredicateTerm(nextTerm)
                || INDEPENDENT_AFFIRMATIVE_AUXILIARIES.has(nextTerm)
                || KNOWN_EVIDENCE_ACTION_TERMS.has(nextTerm));
        if (followedByPredicate && hasSubjectBeforeRegularPast(tokens, index, segmentStart))
            return false;
    }
    return conditionalScopeStart(tokens, hardClauseStart, index) === index;
}
function isFactualTemporalMarkerUse(tokens, index) {
    const term = tokens[index]?.value ?? '';
    const previous = tokens[index - 1]?.value ?? '';
    const next = tokens[index + 1]?.value ?? '';
    return (term === 'once' && isFactualOnceUse(tokens, index))
        || (term === 'while' && (['a', 'that', 'the', 'this'].includes(previous) || next === 'later'));
}
function isFactualOnceUse(tokens, index) {
    if (tokens[index]?.value !== 'once')
        return false;
    const previous = tokens[index - 1]?.value ?? '';
    const next = tokens[index + 1]?.value ?? '';
    return tokens[index]?.compound === true
        || ['at', 'for', 'just'].includes(previous)
        || ['again', 'more', 'upon'].includes(next);
}
function hasMatrixSubjectBeforeTemporalAdjunct(source, offset) {
    const hardPrefix = source.slice(Math.max(0, offset - 256), offset).split(/[.!?;\r\n]/u).pop() ?? '';
    const segment = hardPrefix.slice(hardPrefix.lastIndexOf(',') + 1);
    const terms = normalize(segment).split(' ').filter(Boolean);
    if (terms.length === 0)
        return false;
    if (terms.some((term) => SUBJECT_PRONOUN_TERMS.has(term)))
        return true;
    if (terms.some((term, index) => SUBJECT_ARTICLE_TERMS.has(term) && index + 1 < terms.length))
        return true;
    if (terms.some((term, index) => NEGATIVE_EVIDENCE_DETERMINERS.has(term) && index + 1 < terms.length))
        return true;
    const first = terms[0] ?? '';
    return !LEADING_CLAUSE_MODIFIER_TERMS.has(first)
        && !COMMA_DELIMITED_PREPOSITION_TERMS.has(first)
        && !NON_SUBJECT_PREFIX_TERMS.has(first)
        && !/ly$/u.test(first);
}
function stripFactualTemporalParentheticals(source) {
    return source.replace(COMMA_DELIMITED_TEMPORAL_RE, (match, offset, whole) => {
        if (!hasMatrixSubjectBeforeTemporalAdjunct(whole, offset))
            return match;
        const suffixStart = offset + match.length;
        const suffixWindow = whole.slice(suffixStart, suffixStart + 256).split(/[.!?;\r\n]/u, 1)[0] ?? '';
        const suffixTerms = normalize(suffixWindow).split(' ').filter(Boolean);
        const keepsModality = suffixTerms.slice(0, 4).some((term) => (MODAL_AUXILIARY_TERMS.has(term) || SEMI_MODAL_AUXILIARY_TERMS.has(term)));
        return keepsModality ? match : ' ';
    });
}
function conditionalScopeStart(tokens, hardClauseStart, markerIndex) {
    let segmentStart = hardClauseStart;
    for (let index = markerIndex - 1; index >= hardClauseStart; index -= 1) {
        if (PREDICATE_COORDINATOR_TERMS.has(tokens[index]?.value ?? '')) {
            segmentStart = index + 1;
            break;
        }
    }
    for (let index = segmentStart; index < markerIndex; index += 1) {
        const term = tokens[index]?.value ?? '';
        if (isFinitePredicateTerm(term)
            || KNOWN_EVIDENCE_ACTION_TERMS.has(term)
            || term.endsWith('ing'))
            return segmentStart;
    }
    return markerIndex;
}
function lexRequiredEvidence(redactedOutput) {
    const source = stripFactualTemporalParentheticals(redactedOutput.replace(REDACTION_MARKER_RE, ' '))
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'");
    const tokens = [];
    const matches = source.matchAll(/[a-z0-9_]+(?:'[a-z]+)?/gu);
    let previousEnd = 0;
    let clause = 0;
    for (const match of matches) {
        if (tokens.length >= MAX_REQUIRED_EVIDENCE_TERMS)
            break;
        const start = match.index;
        const end = start + match[0].length;
        const separator = source.slice(previousEnd, start);
        if (tokens.length > 0 && /[.!?;\r\n]/u.test(separator))
            clause += 1;
        tokens.push({
            value: match[0],
            start,
            end,
            clause,
            commaBefore: separator.includes(','),
            compound: source[start - 1] === '-' || source[end] === '-',
        });
        previousEnd = end;
    }
    const ignored = Array.from({ length: tokens.length }, () => false);
    const transparentCommaBefore = Array.from({ length: tokens.length }, () => false);
    const hardClauseStarts = Array.from({ length: tokens.length }, () => 0);
    const hardClauseEnds = Array.from({ length: tokens.length }, () => tokens.length);
    for (let index = 0; index < tokens.length; index += 1) {
        if (isFactualOnceUse(tokens, index))
            ignored[index] = true;
    }
    let hardClauseStart = 0;
    for (let index = 0; index < tokens.length; index += 1) {
        if (index > 0 && tokens[index - 1]?.clause !== tokens[index]?.clause)
            hardClauseStart = index;
        hardClauseStarts[index] = hardClauseStart;
    }
    let hardClauseEnd = tokens.length;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
        const token = tokens[index];
        const next = tokens[index + 1];
        if (!token)
            continue;
        if (next === undefined || next.clause !== token.clause) {
            hardClauseEnd = index + 1;
        }
        hardClauseEnds[index] = hardClauseEnd;
    }
    const failClosedSubordinateRanges = [];
    for (let index = 0; index + 1 < tokens.length; index += 1) {
        if (!isParentheticalIfNotModifier(tokens, index))
            continue;
        const clauseId = tokens[index].clause;
        let close = index + 1;
        while (close < tokens.length
            && tokens[close]?.clause === clauseId
            && !tokens[close]?.commaBefore)
            close += 1;
        if (close >= tokens.length || tokens[close]?.clause !== clauseId)
            continue;
        const atScopeStart = index === 0
            || tokens[index - 1]?.clause !== clauseId
            || tokens[index]?.commaBefore;
        if (!atScopeStart)
            continue;
        const embedded = index > 0
            && tokens[index - 1]?.clause === clauseId
            && tokens[index]?.commaBefore;
        for (let ignoredIndex = index; ignoredIndex < close; ignoredIndex += 1)
            ignored[ignoredIndex] = true;
        if (embedded) {
            transparentCommaBefore[index] = true;
            transparentCommaBefore[close] = true;
        }
        index = close - 1;
    }
    for (let index = 0; index < tokens.length; index += 1) {
        const startTerm = tokens[index]?.value ?? '';
        const structuralPrefix = COMMA_DELIMITED_SUBORDINATOR_TERMS.has(startTerm)
            || COMMA_DELIMITED_PREPOSITION_TERMS.has(startTerm)
            || isBlockingRootPredicateModifierTerm(startTerm)
            || /ly$/u.test(startTerm);
        if (ignored[index] || !structuralPrefix)
            continue;
        const clauseId = tokens[index].clause;
        let close = index + 1;
        while (close < tokens.length
            && tokens[close]?.clause === clauseId
            && !tokens[close]?.commaBefore)
            close += 1;
        if (close >= tokens.length || tokens[close]?.clause !== clauseId)
            continue;
        const atScopeStart = index === 0
            || tokens[index - 1]?.clause !== clauseId
            || tokens[index]?.commaBefore;
        if (!atScopeStart)
            continue;
        const embedded = index > 0
            && tokens[index - 1]?.clause === clauseId
            && tokens[index]?.commaBefore;
        let containsFinitePredicate = false;
        for (let spanIndex = index; spanIndex < close; spanIndex += 1) {
            if (isFinitePredicateTerm(tokens[spanIndex]?.value ?? ''))
                containsFinitePredicate = true;
        }
        if (isConditionalMarkerUse(tokens, index)) {
            failClosedSubordinateRanges.push({
                start: conditionalScopeStart(tokens, hardClauseStarts[index] ?? 0, index),
                end: hardClauseEnds[index] ?? close,
            });
        }
        else if (isClauseInitialEvidentialHedgeTerm(startTerm)) {
            failClosedSubordinateRanges.push({ start: index, end: hardClauseEnds[index] ?? close });
        }
        else if (containsFinitePredicate) {
            failClosedSubordinateRanges.push({ start: index, end: close });
        }
        else {
            for (let ignoredIndex = index; ignoredIndex < close; ignoredIndex += 1)
                ignored[ignoredIndex] = true;
        }
        if (embedded) {
            transparentCommaBefore[index] = true;
            transparentCommaBefore[close] = true;
        }
        index = close - 1;
    }
    const conditional = Array.from({ length: tokens.length }, () => false);
    // Factual subordinate predicates are ambiguous replay evidence and remain fail-closed.
    for (const range of failClosedSubordinateRanges) {
        for (let index = range.start; index < range.end; index += 1)
            conditional[index] = true;
    }
    for (let index = 0; index < tokens.length; index += 1) {
        if (ignored[index] || !isConditionalMarkerUse(tokens, index))
            continue;
        const clauseId = tokens[index].clause;
        const scopeStart = conditionalScopeStart(tokens, hardClauseStarts[index] ?? 0, index);
        const scopeEnd = hardClauseEnds[index] ?? tokens.length;
        for (let conditionalIndex = scopeStart; conditionalIndex < scopeEnd; conditionalIndex += 1) {
            const token = tokens[conditionalIndex];
            if (!token || token.clause !== clauseId)
                break;
            conditional[conditionalIndex] = true;
        }
    }
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        let clauseInitial = index === 0 || tokens[index - 1]?.clause !== token?.clause;
        if (!clauseInitial && token?.commaBefore) {
            clauseInitial = true;
            for (let prefix = index - 1; prefix >= 0; prefix -= 1) {
                const prefixToken = tokens[prefix];
                if (!prefixToken || prefixToken.clause !== token.clause)
                    break;
                if (ignored[prefix]
                    || LEADING_CLAUSE_MODIFIER_TERMS.has(prefixToken.value)
                    || AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(prefixToken.value))
                    continue;
                clauseInitial = false;
                break;
            }
        }
        if (!token || !clauseInitial || !INVERTED_CONDITIONAL_AUXILIARY_TERMS.has(token.value))
            continue;
        const scopeEnd = hardClauseEnds[index] ?? tokens.length;
        for (let conditionalIndex = index; conditionalIndex < scopeEnd; conditionalIndex += 1) {
            if (tokens[conditionalIndex]?.clause !== token.clause)
                break;
            conditional[conditionalIndex] = true;
        }
    }
    return { tokens, ignored, transparentCommaBefore, conditional };
}
function isIgnoredRequiredToken(stream, index) {
    return stream.ignored[index] === true;
}
function hasEffectiveCommaBefore(stream, index) {
    return stream.tokens[index]?.commaBefore === true && stream.transparentCommaBefore[index] !== true;
}
function isNegativeRequiredToken(stream, index) {
    const token = stream.tokens[index];
    const lexicalNoOne = token?.value === 'no'
        && token.compound
        && stream.tokens[index + 1]?.value === 'one'
        && stream.tokens[index + 1]?.compound === true;
    const zeroMetric = token?.value === 'zero'
        && isContextualZeroMetric(stream, index, stream.tokens.length)
        && !(stream.tokens[index + 1]?.value === 'cost'
            && ['center', 'centers'].includes(stream.tokens[index + 2]?.value ?? ''));
    return token !== undefined
        && (lexicalNoOne || (!token.compound
            && !zeroMetric
            && (NEGATIVE_EVIDENCE_PRONOUNS.has(token.value) || NEGATIVE_EVIDENCE_DETERMINERS.has(token.value))));
}
function isContextualZeroMetric(stream, zeroIndex, end) {
    for (let index = zeroIndex + 1; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        return CONTEXTUAL_ZERO_METRIC_TERMS.has(stream.tokens[index]?.value ?? '');
    }
    return false;
}
function leadingSubjectPolarity(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (isNegativeRequiredToken(stream, index))
            return 'negative';
        if (SUBJECT_PRONOUN_TERMS.has(term) || SUBJECT_ARTICLE_TERMS.has(term))
            return 'positive';
        if (NON_SUBJECT_PREFIX_TERMS.has(term) || /ly$/u.test(term))
            continue;
        return 'positive';
    }
    return 'absent';
}
function isFinitePredicateTerm(term) {
    return KNOWN_FINITE_PREDICATE_TERMS.has(term) || /(?:ed|n't)$/u.test(term);
}
function hasFinitePredicatePrefix(stream, start, end) {
    const terms = [];
    for (let index = start; index < end; index += 1) {
        if (!isIgnoredRequiredToken(stream, index))
            terms.push(stream.tokens[index]?.value ?? '');
    }
    while (terms.length > 0 && (/ly$/u.test(terms[0] ?? '') || LEADING_CLAUSE_MODIFIER_TERMS.has(terms[0] ?? ''))) {
        terms.shift();
    }
    if (terms.length === 0)
        return false;
    const first = terms[0] ?? '';
    if (SUBJECT_PRONOUN_TERMS.has(first) || NEGATIVE_EVIDENCE_PRONOUNS.has(first)) {
        terms.shift();
    }
    else {
        if (SUBJECT_ARTICLE_TERMS.has(first) || NEGATIVE_EVIDENCE_DETERMINERS.has(first))
            terms.shift();
        while (terms.length > 1 && isAttributiveTargetModifier(terms[0] ?? ''))
            terms.shift();
        if (terms.length > 0)
            terms.shift();
    }
    return terms.some((term) => isFinitePredicateTerm(term));
}
function hasNegativePredicateMarker(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (term === 'not') {
            let next = index + 1;
            while (next < end && isIgnoredRequiredToken(stream, next))
                next += 1;
            if (stream.tokens[next]?.value === 'only')
                continue;
        }
        if (term === 'not' || term === 'never' || term === 'cannot' || /n't$/u.test(term))
            return true;
    }
    return false;
}
function hasFinitePredicateInSpan(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (!isIgnoredRequiredToken(stream, index)
            && isFinitePredicateTerm(stream.tokens[index]?.value ?? ''))
            return true;
    }
    return false;
}
function relativeSafeFinitePredicateEnd(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const complements = RELATIVE_SAFE_FINITE_COMPLEMENTS.get(stream.tokens[index]?.value ?? '');
        if (!complements)
            return undefined;
        for (let complement = index + 1; complement < end; complement += 1) {
            if (isIgnoredRequiredToken(stream, complement))
                continue;
            return complements.has(stream.tokens[complement]?.value ?? '') ? complement + 1 : undefined;
        }
        return undefined;
    }
    return undefined;
}
function relativePredicateStart(stream, start, end) {
    let index = start;
    while (index < end) {
        if (isIgnoredRequiredToken(stream, index)) {
            index += 1;
            continue;
        }
        const term = stream.tokens[index]?.value ?? '';
        if (/ly$/u.test(term) || AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(term)) {
            index += 1;
            continue;
        }
        break;
    }
    return index;
}
function hasBoundedRegularRelativePredicate(stream, predicateIndex, end) {
    const term = stream.tokens[predicateIndex]?.value ?? '';
    if (KNOWN_FINITE_PREDICATE_TERMS.has(term) || /n't$/u.test(term))
        return true;
    if (!term.endsWith('ed'))
        return false;
    let next = predicateIndex + 1;
    while (next < end && isIgnoredRequiredToken(stream, next))
        next += 1;
    if (next >= end)
        return true;
    const nextTerm = stream.tokens[next]?.value ?? '';
    if (BROAD_EVIDENCE_LINK_TERMS.has(nextTerm) && nextTerm !== 'that')
        return true;
    return false;
}
function hasBoundedRelativeFinitePredicate(stream, start, end) {
    if (hasFinitePredicatePrefix(stream, start, end))
        return true;
    const predicateIndex = relativePredicateStart(stream, start, end);
    if (predicateIndex >= end)
        return false;
    const term = stream.tokens[predicateIndex]?.value ?? '';
    if (EMBEDDED_CLAIM_GOVERNOR_TERMS.has(term))
        return false;
    if (isRequiredPassiveAuxiliary(term))
        return true;
    return relativeSafeFinitePredicateEnd(stream, predicateIndex, end) !== undefined
        || hasBoundedRegularRelativePredicate(stream, predicateIndex, end);
}
function hasEmbeddedClaimGovernorInSpan(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (!isIgnoredRequiredToken(stream, index)
            && EMBEDDED_CLAIM_GOVERNOR_TERMS.has(stream.tokens[index]?.value ?? ''))
            return true;
    }
    return false;
}
function isExplicitNoDoubtContext(stream, start, end) {
    const values = [];
    for (let index = start; index < end; index += 1) {
        if (!isIgnoredRequiredToken(stream, index))
            values.push(stream.tokens[index]?.value ?? '');
    }
    if (values.shift() !== 'there' || !PASSIVE_BE_AUXILIARY_TERMS.has(values.shift() ?? ''))
        return false;
    while (values.length > 0 && /ly$/u.test(values[0] ?? ''))
        values.shift();
    return values.length === 2 && values[0] === 'no' && values[1] === 'doubt';
}
function complementSubjectScope(stream, initialStart, end) {
    let start = initialStart;
    let negativeGovernor = false;
    for (let index = start; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index) || stream.tokens[index]?.value !== 'that')
            continue;
        if (!hasFinitePredicatePrefix(stream, start, index)) {
            // Ambiguous relative/factual subordinate evidence stays fail-closed.
            if (!hasBoundedRelativeFinitePredicate(stream, index + 1, end))
                negativeGovernor = true;
            continue;
        }
        if (!isExplicitNoDoubtContext(stream, start, index)
            || leadingSubjectPolarity(stream, start, index) === 'negative'
            || hasNegativePredicateMarker(stream, start, index))
            negativeGovernor = true;
        start = index + 1;
    }
    return { start, negativeGovernor };
}
function startsExplicitSubordinateClause(stream, start, verbIndex) {
    for (let index = start; index < verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (SUBJECT_PRONOUN_TERMS.has(term)
            || SUBJECT_ARTICLE_TERMS.has(term)
            || isNegativeRequiredToken(stream, index)
            || isRequiredPassiveAuxiliary(term)
            || INDEPENDENT_BROAD_FORM_TERMS.has(term))
            return true;
    }
    return false;
}
function predicateBoundaryBefore(stream, before) {
    const token = stream.tokens[before];
    if (!token)
        return { start: 0, inheritsSubject: false };
    const lowerBound = Math.max(0, before - MAX_REQUIRED_SUBJECT_LOOKBACK);
    for (let index = before - 1; index >= lowerBound; index -= 1) {
        const current = stream.tokens[index];
        if (!current || current.clause !== token.clause)
            return { start: index + 1, inheritsSubject: false };
        if (isIgnoredRequiredToken(stream, index))
            continue;
        if (hasEffectiveCommaBefore(stream, index + 1)) {
            return { start: index + 1, inheritsSubject: false };
        }
        if (PREDICATE_COORDINATOR_TERMS.has(current.value)) {
            return { start: index + 1, index, inheritsSubject: true };
        }
        if (current.value === 'after' || current.value === 'before') {
            let prefixStart = index;
            while (prefixStart > lowerBound
                && stream.tokens[prefixStart - 1]?.clause === current.clause
                && !hasEffectiveCommaBefore(stream, prefixStart))
                prefixStart -= 1;
            if (hasFinitePredicatePrefix(stream, prefixStart, index)
                && startsExplicitSubordinateClause(stream, index + 1, before)) {
                return { start: index + 1, index, inheritsSubject: false };
            }
        }
        if (PREDICATE_SCOPE_RESET_TERMS.has(current.value)) {
            return {
                start: index + 1,
                index,
                inheritsSubject: false,
                negatesPredicate: current.value === 'without',
            };
        }
    }
    return { start: lowerBound, inheritsSubject: false };
}
function predicateSubjectPolarity(stream, boundary, verbIndex) {
    let cursorBoundary = boundary;
    let cursorEnd = verbIndex;
    while (true) {
        const subjectScope = complementSubjectScope(stream, cursorBoundary.start, cursorEnd);
        const polarity = subjectScope.negativeGovernor
            ? 'negative'
            : leadingSubjectPolarity(stream, subjectScope.start, cursorEnd);
        if (polarity !== 'absent' || !cursorBoundary.inheritsSubject || cursorBoundary.index === undefined) {
            return polarity;
        }
        cursorEnd = cursorBoundary.index;
        cursorBoundary = predicateBoundaryBefore(stream, cursorEnd);
    }
}
function predicateEndAfter(stream, verbIndex) {
    const token = stream.tokens[verbIndex];
    if (!token)
        return verbIndex + 1;
    const upperBound = Math.min(stream.tokens.length, verbIndex + MAX_REQUIRED_EVIDENCE_PAIR_DISTANCE + 1);
    for (let index = verbIndex + 1; index < upperBound; index += 1) {
        const current = stream.tokens[index];
        if (!current || current.clause !== token.clause || hasEffectiveCommaBefore(stream, index))
            return index;
        if (isIgnoredRequiredToken(stream, index))
            continue;
        if (PREDICATE_COORDINATOR_TERMS.has(current.value)
            || PREDICATE_SCOPE_RESET_TERMS.has(current.value))
            return index;
    }
    return upperBound;
}
function predicateCandidates(stream, verbIndexes) {
    const candidates = [];
    const seenVerbIndexes = new Set();
    for (const verbIndex of verbIndexes) {
        if (candidates.length >= MAX_REQUIRED_EVIDENCE_CANDIDATES)
            break;
        if (seenVerbIndexes.has(verbIndex) || isIgnoredRequiredToken(stream, verbIndex))
            continue;
        seenVerbIndexes.add(verbIndex);
        const boundary = predicateBoundaryBefore(stream, verbIndex);
        const subjectScope = complementSubjectScope(stream, boundary.start, verbIndex);
        candidates.push({
            verbIndex,
            localStart: subjectScope.start,
            end: predicateEndAfter(stream, verbIndex),
            subjectNegative: predicateSubjectPolarity(stream, boundary, verbIndex) === 'negative',
            conditional: stream.conditional[verbIndex] === true,
            boundaryNegated: boundary.negatesPredicate === true,
        });
    }
    return candidates;
}
function nextRequiredToken(stream, index, end) {
    for (let next = index + 1; next <= end; next += 1) {
        if (!isIgnoredRequiredToken(stream, next))
            return stream.tokens[next]?.value;
    }
    return undefined;
}
function isLocalPredicateNegated(stream, candidate, through) {
    if (candidate.boundaryNegated)
        return true;
    for (let index = candidate.localStart; index <= through; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (term === 'not' && nextRequiredToken(stream, index, through) === 'only')
            continue;
        if (term === 'not' || term === 'never' || term === 'without' || term === 'cannot' || /n't$/u.test(term)) {
            return true;
        }
    }
    return false;
}
function tokenMatchIndexes(stream, term, kind) {
    const forms = targetTermForms(term, kind);
    const indexes = [];
    for (let index = 0; index < stream.tokens.length; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        if (forms.has(stream.tokens[index]?.value ?? ''))
            indexes.push(index);
    }
    return indexes;
}
function isAttributiveTargetModifier(term) {
    return BROAD_EVIDENCE_LINK_TERMS.has(term)
        || TOTALITY_TARGET_MODIFIER_TERMS.has(term)
        || (term.length <= 3
            && /^[a-z]+$/u.test(term)
            && !KNOWN_EVIDENCE_ACTION_TERMS.has(term)
            && !PASSIVE_SUBJECT_POSTMODIFIER_TERMS.has(term)
            && !PREDICATE_COORDINATOR_TERMS.has(term)
            && !PREDICATE_SCOPE_RESET_TERMS.has(term)
            && !NEGATIVE_EVIDENCE_PRONOUNS.has(term)
            && !NEGATIVE_EVIDENCE_DETERMINERS.has(term))
        || /(?:ed|able|al|ary|ful|ible|ic|ive|less|ory|ous)$/u.test(term);
}
function hasNegativePrenominalTarget(stream, targetIndex, lowerBound) {
    let sawContextualZeroMetric = false;
    for (let index = targetIndex - 1; index >= lowerBound; index -= 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (hasEffectiveCommaBefore(stream, index + 1) || TARGET_SCOPE_RESET_TERMS_LOCAL.has(term))
            return false;
        if (isNegativeRequiredToken(stream, index))
            return term !== 'zero' || !sawContextualZeroMetric;
        if (CONTEXTUAL_ZERO_METRIC_TERMS.has(term)) {
            sawContextualZeroMetric = true;
            continue;
        }
        if (term === 'of' || /ly$/u.test(term) || isAttributiveTargetModifier(term))
            continue;
        if (KNOWN_EVIDENCE_ACTION_TERMS.has(term) || term.endsWith('ing'))
            return false;
    }
    return false;
}
function hasActiveTargetLinks(stream, verbIndex, targetIndex) {
    for (let index = verbIndex + 1; index < targetIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (hasEffectiveCommaBefore(stream, index)
            || PREDICATE_COORDINATOR_TERMS.has(term)
            || PREDICATE_SCOPE_RESET_TERMS.has(term)
            || EMBEDDED_CLAIM_GOVERNOR_TERMS.has(term)
            || !isAttributiveTargetModifier(term))
            return false;
        if (term === 'not' && nextRequiredToken(stream, index, targetIndex) !== 'only')
            return false;
    }
    return true;
}
function nearestPredicateChainTerm(stream, candidate, skipInfinitiveMarker) {
    for (let index = candidate.verbIndex - 1; index >= candidate.localStart; index -= 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (term === 'only') {
            let previous = index - 1;
            while (previous >= candidate.localStart && isIgnoredRequiredToken(stream, previous))
                previous -= 1;
            if (stream.tokens[previous]?.value === 'not') {
                index = previous;
                continue;
            }
        }
        if (AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(term))
            continue;
        if (skipInfinitiveMarker && term === 'to')
            continue;
        return term;
    }
    return undefined;
}
function hasBlockingRootPredicateModifier(stream, candidate) {
    for (let index = candidate.localStart; index < candidate.verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (isBlockingRootPredicateModifierTerm(term)
            && !isSubjectParticipleAdverb(stream, candidate, index))
            return true;
    }
    return false;
}
function hasExplicitEmbeddedSubjectAfter(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (SUBJECT_PRONOUN_TERMS.has(term)
            || SUBJECT_ARTICLE_TERMS.has(term)
            || isNegativeRequiredToken(stream, index))
            return true;
    }
    return false;
}
function isCompletedRelativePredicate(stream, candidate, predicateIndex) {
    for (let index = predicateIndex - 1; index >= candidate.localStart; index -= 1) {
        if (isIgnoredRequiredToken(stream, index) || stream.tokens[index]?.value !== 'that')
            continue;
        return !hasFinitePredicatePrefix(stream, candidate.localStart, index);
    }
    return false;
}
function isParticipialSubjectModifier(stream, candidate, modifierIndex) {
    for (let index = candidate.localStart; index < modifierIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        const determiner = BROAD_EVIDENCE_LINK_TERMS.has(term) && term !== 'not' && term !== 'only';
        if (determiner
            || /ly$/u.test(term)
            || /(?:ed|ing)$/u.test(term)
            || isAttributiveTargetModifier(term))
            continue;
        return false;
    }
    let sawHead = false;
    for (let index = modifierIndex + 1; index < candidate.verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (hasEffectiveCommaBefore(stream, index)
            || PREDICATE_COORDINATOR_TERMS.has(term)
            || PREDICATE_SCOPE_RESET_TERMS.has(term)
            || BROAD_EVIDENCE_LINK_TERMS.has(term)
            || SUBJECT_PRONOUN_TERMS.has(term)
            || term === 'that'
            || term === 'to')
            return false;
        if (isRequiredPassiveAuxiliary(term)) {
            if (!sawHead)
                return false;
            continue;
        }
        if (KNOWN_EVIDENCE_ACTION_TERMS.has(term)) {
            const baseActionNoun = !sawHead
                && (IRREGULAR_VERB_FORMS.has(term) || GENERIC_ACTION_TERMS.has(term))
                && !EXACT_ONLY_PROGRESSIVE_LEMMAS.has(term);
            if (!baseActionNoun)
                return false;
            sawHead = true;
            continue;
        }
        if (/ly$/u.test(term))
            continue;
        if (/(?:ed|ing)$/u.test(term)) {
            if (sawHead)
                return false;
            continue;
        }
        sawHead = true;
    }
    return sawHead;
}
function isRelativeNominalClaimHead(stream, candidate, claimIndex) {
    if (!NOMINAL_CLAIM_HEAD_TERMS.has(stream.tokens[claimIndex]?.value ?? ''))
        return false;
    for (let index = candidate.localStart; index < claimIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        const determiner = BROAD_EVIDENCE_LINK_TERMS.has(term) && term !== 'not' && term !== 'only';
        if (determiner || isNegativeRequiredToken(stream, index) || /ly$/u.test(term)
            || isAttributiveTargetModifier(term))
            continue;
        return false;
    }
    let relativeStart = claimIndex + 1;
    while (relativeStart < candidate.verbIndex && isIgnoredRequiredToken(stream, relativeStart)) {
        relativeStart += 1;
    }
    if (stream.tokens[relativeStart]?.value !== 'that')
        return false;
    const relativePredicate = relativePredicateStart(stream, relativeStart + 1, candidate.verbIndex);
    if (relativePredicate >= candidate.verbIndex)
        return false;
    const firstRelativeValue = stream.tokens[relativePredicate]?.value ?? '';
    if (EMBEDDED_CLAIM_GOVERNOR_TERMS.has(firstRelativeValue))
        return false;
    const copularRelative = isRequiredPassiveAuxiliary(firstRelativeValue);
    if (!copularRelative) {
        const safeEnd = relativeSafeFinitePredicateEnd(stream, relativePredicate, candidate.verbIndex);
        if (safeEnd !== undefined) {
            return !hasEmbeddedClaimGovernorInSpan(stream, safeEnd, candidate.verbIndex);
        }
        return hasBoundedRegularRelativePredicate(stream, relativePredicate, candidate.verbIndex);
    }
    for (let index = relativePredicate; index < candidate.verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (isRequiredPassiveAuxiliary(term)
            || AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(term)
            || term === 'not'
            || term === 'never')
            continue;
        if (EMBEDDED_CLAIM_GOVERNOR_TERMS.has(term))
            return false;
        return true;
    }
    return false;
}
function isSubjectParticipleAdverb(stream, candidate, adverbIndex) {
    let modifierIndex = adverbIndex + 1;
    while (modifierIndex < candidate.verbIndex && isIgnoredRequiredToken(stream, modifierIndex)) {
        modifierIndex += 1;
    }
    return /(?:ed|ing)$/u.test(stream.tokens[modifierIndex]?.value ?? '')
        && isParticipialSubjectModifier(stream, candidate, modifierIndex);
}
function hasEmbeddedClaimGovernor(stream, candidate) {
    for (let index = candidate.localStart; index < candidate.verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (!EMBEDDED_CLAIM_GOVERNOR_TERMS.has(term))
            continue;
        if (isRelativeNominalClaimHead(stream, candidate, index))
            continue;
        if (/(?:ed|ing)$/u.test(term) && isParticipialSubjectModifier(stream, candidate, index))
            continue;
        if (hasExplicitEmbeddedSubjectAfter(stream, index + 1, candidate.verbIndex)
            || hasFinitePredicateInSpan(stream, index + 1, candidate.verbIndex))
            return true;
    }
    return false;
}
function hasPriorNonAuxiliaryGovernor(stream, candidate) {
    if (hasEmbeddedClaimGovernor(stream, candidate))
        return true;
    for (let index = candidate.localStart; index < candidate.verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (isRequiredPassiveAuxiliary(term)
            || AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(term)
            || NON_SUBJECT_PREFIX_TERMS.has(term))
            continue;
        if (isRelativeNominalClaimHead(stream, candidate, index))
            continue;
        if (UNAMBIGUOUS_EMBEDDED_CLAIM_GOVERNOR_TERMS.has(term))
            return true;
        if (/(?:ed|ing)$/u.test(term)) {
            if (isParticipialSubjectModifier(stream, candidate, index))
                continue;
            if (isCompletedRelativePredicate(stream, candidate, index))
                continue;
            return true;
        }
        if (term.length > 3
            && term.endsWith('s')
            && hasExplicitEmbeddedSubjectAfter(stream, index + 1, candidate.verbIndex))
            return true;
    }
    return false;
}
function hasFiniteActivePredicate(stream, candidate) {
    const verb = stream.tokens[candidate.verbIndex]?.value ?? '';
    if (hasBlockingRootPredicateModifier(stream, candidate)
        || hasPriorNonAuxiliaryGovernor(stream, candidate))
        return false;
    if (INDEPENDENT_BROAD_FORM_TERMS.has(verb))
        return true;
    if (verb.endsWith('ing')) {
        if (candidate.verbIndex === candidate.localStart)
            return true;
        const license = nearestPredicateChainTerm(stream, candidate, false);
        return license !== undefined
            && (PASSIVE_BE_AUXILIARY_TERMS.has(license)
                || MODAL_AUXILIARY_TERMS.has(license)
                || SEMI_MODAL_AUXILIARY_TERMS.has(license));
    }
    const license = nearestPredicateChainTerm(stream, candidate, true);
    if (PERFECT_BROAD_FORM_TERMS.has(verb)) {
        return license !== undefined && PERFECT_AUXILIARY_TERMS.has(license);
    }
    return license !== undefined
        && (MODAL_AUXILIARY_TERMS.has(license) || SEMI_MODAL_AUXILIARY_TERMS.has(license));
}
function isRequiredPassiveAuxiliary(term) {
    return PASSIVE_AUXILIARY_TERMS.has(term)
        || MODAL_AUXILIARY_TERMS.has(term)
        || SEMI_MODAL_AUXILIARY_TERMS.has(term);
}
function hasPassiveTargetLinks(stream, targetIndex, verbIndex) {
    const links = [];
    for (let index = targetIndex + 1; index < verbIndex; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (hasEffectiveCommaBefore(stream, index)
            || PREDICATE_COORDINATOR_TERMS.has(term)
            || PREDICATE_SCOPE_RESET_TERMS.has(term))
            return false;
        links.push(term);
    }
    const firstAuxiliary = links.findIndex((term) => isRequiredPassiveAuxiliary(term));
    if (firstAuxiliary < 0)
        return false;
    const postmodifier = links.slice(0, firstAuxiliary);
    if (postmodifier.length > 0
        && !PASSIVE_SUBJECT_POSTMODIFIER_TERMS.has(postmodifier[0] ?? ''))
        return false;
    if (postmodifier.some((term) => NEGATIVE_EVIDENCE_PRONOUNS.has(term)
        || NEGATIVE_EVIDENCE_DETERMINERS.has(term)))
        return false;
    const auxiliaryChain = links.slice(firstAuxiliary);
    if (!auxiliaryChain.some((term) => PASSIVE_BE_AUXILIARY_TERMS.has(term)))
        return false;
    return auxiliaryChain.every((term, index) => ((term !== 'not' || auxiliaryChain[index + 1] === 'only')
        && (isRequiredPassiveAuxiliary(term)
            || term === 'to'
            || BROAD_EVIDENCE_LINK_TERMS.has(term)
            || AFFIRMATIVE_PREDICATE_MODIFIER_TERMS.has(term))));
}
function nearestTargetAfter(candidate, indexes) {
    return indexes.find((index) => index > candidate.verbIndex
        && index < candidate.end
        && index - candidate.verbIndex <= MAX_REQUIRED_EVIDENCE_PAIR_DISTANCE);
}
function nearestTargetBefore(candidate, indexes) {
    for (let offset = indexes.length - 1; offset >= 0; offset -= 1) {
        const index = indexes[offset];
        if (index < candidate.localStart)
            return undefined;
        if (index < candidate.verbIndex
            && candidate.verbIndex - index <= MAX_REQUIRED_EVIDENCE_PAIR_DISTANCE)
            return index;
    }
    return undefined;
}
function hasNegativePredicateTail(stream, start, end) {
    for (let index = start; index < end; index += 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (isNegativeRequiredToken(stream, index))
            return true;
        if (term === 'not' && nextRequiredToken(stream, index, end - 1) === 'only')
            continue;
        if (term === 'not' || term === 'never' || term === 'cannot' || /n't$/u.test(term))
            return true;
    }
    return false;
}
function hasLaterFinitePredicate(stream, start, candidate) {
    return hasFinitePredicateInSpan(stream, start, candidate.end);
}
function hasNonIgnoredHardClauseTail(stream, start, clause) {
    for (let index = start; index < stream.tokens.length; index += 1) {
        const token = stream.tokens[index];
        if (!token || token.clause !== clause)
            break;
        if (!isIgnoredRequiredToken(stream, index))
            return true;
    }
    return false;
}
function standaloneGerundTailStart(stream, candidate) {
    let start = candidate.verbIndex + 1;
    while (start < stream.tokens.length && isIgnoredRequiredToken(stream, start))
        start += 1;
    if (stream.tokens[start]?.value === 'it')
        start += 1;
    return start;
}
function isPassiveTargetOwnedByPriorNominal(stream, targetIndex, lowerBound) {
    let index = targetIndex - 1;
    while (index >= lowerBound) {
        if (isIgnoredRequiredToken(stream, index)) {
            index -= 1;
            continue;
        }
        const term = stream.tokens[index]?.value ?? '';
        if (isAttributiveTargetModifier(term) || /ly$/u.test(term)) {
            index -= 1;
            continue;
        }
        const contextualMetric = CONTEXTUAL_ZERO_METRIC_TERMS.has(term);
        for (let ownerIndex = index - 1; ownerIndex >= lowerBound; ownerIndex -= 1) {
            if (isIgnoredRequiredToken(stream, ownerIndex))
                continue;
            const owner = stream.tokens[ownerIndex]?.value ?? '';
            if (contextualMetric && owner === 'zero')
                return false;
            if (SUBJECT_ARTICLE_TERMS.has(owner)
                || isNegativeRequiredToken(stream, ownerIndex)
                || isAttributiveTargetModifier(owner)
                || /ly$/u.test(owner))
                continue;
            return true;
        }
        return false;
    }
    return false;
}
function hasContextualZeroMetricTarget(stream, targetIndex, lowerBound) {
    for (let index = targetIndex - 1; index >= lowerBound; index -= 1) {
        if (isIgnoredRequiredToken(stream, index))
            continue;
        const term = stream.tokens[index]?.value ?? '';
        if (hasEffectiveCommaBefore(stream, index + 1) || TARGET_SCOPE_RESET_TERMS_LOCAL.has(term))
            return false;
        if (term === 'zero' && isNegativeRequiredToken(stream, index)) {
            return isContextualZeroMetric(stream, index, targetIndex);
        }
    }
    return false;
}
function provesStandaloneBroadEvidence(stream, candidate) {
    const verb = stream.tokens[candidate.verbIndex]?.value ?? '';
    const rootGerund = verb.endsWith('ing') && candidate.verbIndex === candidate.localStart;
    const invalidTail = rootGerund
        ? hasNonIgnoredHardClauseTail(stream, standaloneGerundTailStart(stream, candidate), stream.tokens[candidate.verbIndex]?.clause ?? -1)
        : hasLaterFinitePredicate(stream, candidate.verbIndex + 1, candidate);
    return !candidate.conditional
        && !candidate.subjectNegative
        && hasFiniteActivePredicate(stream, candidate)
        && !isLocalPredicateNegated(stream, candidate, candidate.verbIndex)
        && !invalidTail
        && !hasNegativePredicateTail(stream, candidate.verbIndex + 1, candidate.end);
}
function provesRoleAwareBroadEvidence(stream, lemma, verbIndexes, evidenceIndexes) {
    let pairCount = 0;
    for (const candidate of predicateCandidates(stream, verbIndexes)) {
        if (candidate.conditional)
            continue;
        for (const indexes of evidenceIndexes) {
            if (pairCount >= MAX_REQUIRED_EVIDENCE_CANDIDATES)
                return false;
            pairCount += 1;
            const activeTarget = nearestTargetAfter(candidate, indexes);
            const activeVerb = stream.tokens[candidate.verbIndex]?.value ?? '';
            const rootGerund = activeVerb.endsWith('ing') && candidate.verbIndex === candidate.localStart;
            if (activeTarget !== undefined
                && !candidate.subjectNegative
                && hasFiniteActivePredicate(stream, candidate)
                && !isLocalPredicateNegated(stream, candidate, activeTarget)
                && !hasNegativePrenominalTarget(stream, activeTarget, candidate.verbIndex + 1)
                && hasActiveTargetLinks(stream, candidate.verbIndex, activeTarget)
                && !(rootGerund && hasNonIgnoredHardClauseTail(stream, activeTarget + 1, stream.tokens[candidate.verbIndex]?.clause ?? -1))
                && !(!rootGerund
                    && activeVerb.endsWith('ing')
                    && hasLaterFinitePredicate(stream, activeTarget + 1, candidate))
                && !hasNegativePredicateTail(stream, activeTarget + 1, candidate.end))
                return true;
            if (lemma !== 'do' || stream.tokens[candidate.verbIndex]?.value !== 'done')
                continue;
            const passiveTarget = nearestTargetBefore(candidate, indexes);
            if (passiveTarget !== undefined
                && (!candidate.subjectNegative
                    || hasContextualZeroMetricTarget(stream, passiveTarget, candidate.localStart))
                && !hasEmbeddedClaimGovernor(stream, candidate)
                && !isLocalPredicateNegated(stream, candidate, candidate.verbIndex)
                && !hasNegativePrenominalTarget(stream, passiveTarget, candidate.localStart)
                && !isPassiveTargetOwnedByPriorNominal(stream, passiveTarget, candidate.localStart)
                && !hasNegativePredicateTail(stream, candidate.verbIndex + 1, candidate.end)
                && hasPassiveTargetLinks(stream, passiveTarget, candidate.verbIndex))
                return true;
        }
    }
    return false;
}
function mustMatchedTerms(stream, terms) {
    const indexedTerms = terms.map((term) => ({
        term,
        indexes: tokenMatchIndexes(stream, term, 'must'),
    }));
    const matched = new Set(indexedTerms
        .filter((entry) => !isBroadProgressiveAuxiliary(entry.term) && entry.indexes.length > 0)
        .map((entry) => entry.term.text));
    for (const entry of indexedTerms) {
        if (!isBroadProgressiveAuxiliary(entry.term) || entry.indexes.length === 0)
            continue;
        if (terms.length === 1) {
            const exactIndexes = entry.indexes.filter((index) => stream.tokens[index]?.value === entry.term.text);
            if (predicateCandidates(stream, exactIndexes).some((candidate) => (provesStandaloneBroadEvidence(stream, candidate))))
                matched.add(entry.term.text);
            continue;
        }
        const lemma = verbLemma(entry.term.text);
        if (lemma && provesRoleAwareBroadEvidence(stream, lemma, entry.indexes, indexedTerms.filter((other) => other !== entry).map((other) => other.indexes)))
            matched.add(entry.term.text);
    }
    return terms.filter((term) => matched.has(term.text)).map((term) => term.text);
}
export function detectConstraintViolations(output, constraints) {
    const redactedOutput = redactConstraintText(output);
    const evidenceHash = sha256(redactedOutput);
    const outputSensitiveClasses = new Set(sensitiveClassesForValue(output));
    const violations = [];
    let requiredEvidence;
    for (const constraint of constraints) {
        const terms = targetTerms(constraint.redactedText, constraint.kind);
        const sensitiveMatch = constraint.kind === 'must_not'
            && constraint.sensitiveClasses.some((sensitiveClass) => outputSensitiveClasses.has(sensitiveClass));
        if (terms.length === 0 && !sensitiveMatch)
            continue;
        const matchedTerms = constraint.kind === 'must_not'
            ? mustNotMatchedTerms(redactedOutput, terms)
            : mustMatchedTerms(requiredEvidence ??= lexRequiredEvidence(redactedOutput), terms);
        if (!sensitiveMatch && !isViolated(constraint.kind, terms, matchedTerms, isContrastiveConstraint(constraint.redactedText)))
            continue;
        violations.push({
            constraintId: constraint.id,
            kind: constraint.kind,
            severity: severityFor(constraint.kind),
            evidenceHash,
            matchedTerms: sensitiveMatch && matchedTerms.length === 0 ? ['sensitive_value'] : matchedTerms,
        });
    }
    return violations;
}
export function computeConstraintAblationScore(input) {
    const ablationCount = Math.max(0, input.ablationCount);
    const baselineViolationCount = input.baselineViolations.length;
    const ablatedViolationCount = input.ablatedViolations.length;
    const removedConstraintIds = new Set(input.removedConstraintIds);
    const relevantBaselineViolations = input.baselineViolations.filter((violation) => removedConstraintIds.has(violation.constraintId));
    const relevantAblatedViolations = input.ablatedViolations.filter((violation) => removedConstraintIds.has(violation.constraintId));
    const denominator = Math.max(1, removedConstraintIds.size);
    const sensitivity = Math.max(0, Math.min(1, (relevantAblatedViolations.length - relevantBaselineViolations.length) / denominator));
    const threshold = input.sensitivityThreshold ?? 0.5;
    const sensitive = sensitivity >= threshold;
    return {
        source: 'constraint_ablation_replay',
        sensitivity,
        ablationCount,
        baselineViolationCount,
        ablatedViolationCount,
        mustViolationCount: relevantAblatedViolations.filter((v) => v.kind === 'must').length,
        mustNotViolationCount: relevantAblatedViolations.filter((v) => v.kind === 'must_not').length,
        taskSuccess: input.taskSuccess,
        comparison: compareSensitivityWithSuccess(input.taskSuccess.status, sensitive),
    };
}
function compareSensitivityWithSuccess(status, sensitive) {
    if (status === 'unknown')
        return 'unknown_success';
    if (status === 'success')
        return sensitive ? 'success_constraint_sensitive' : 'success_constraint_insensitive';
    return sensitive ? 'failure_constraint_sensitive' : 'failure_constraint_insensitive';
}