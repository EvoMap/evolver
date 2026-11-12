import { say } from './locale.js';
export const DEFAULT_FORBIDDEN_PATHS = ['.git', 'node_modules', '.env'];
export const USE_WHEN = 'Use when: ';
export const DO_NOT_USE_WHEN = 'Do not use when: ';
const SECTION_ORDER = ['use', 'notUse', 'preconditions', 'steps', 'validation', 'success'];
export const HEADINGS = {
    use: { 'zh-CN': '什么时候用', en: 'When to use' },
    notUse: { 'zh-CN': '什么时候不用', en: 'When not to use' },
    preconditions: { 'zh-CN': '前提条件', en: 'Preconditions' },
    steps: { 'zh-CN': '步骤', en: 'Steps' },
    validation: { 'zh-CN': '检查命令', en: 'Validation' },
    success: { 'zh-CN': '成功标准', en: 'Success criteria' },
};
const SECTION_BY_HEADING = new Map(SECTION_ORDER.flatMap((section) => Object.values(HEADINGS[section]).map((heading) => [heading.toLowerCase(), section])));
const FRONT_MATTER_KEYS = new Set(['id', 'category', 'signals', 'max_files', 'forbidden_paths', 'supersedes']);
function splitFrontMatter(text) {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const match = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(normalized);
    return match ? { front: match[1] ?? '', body: normalized.slice(match[0].length) } : { front: null, body: normalized };
}
function scalar(raw) {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
            return String(JSON.parse(value));
        }
        catch {
            return value.slice(1, -1);
        }
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
        return value.slice(1, -1).replace(/''/g, "'");
    return value;
}
/** Splits a YAML flow list body on commas outside quotes; `''` inside single quotes is an escaped quote. */
function flowItems(body) {
    const items = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (quote === "'" && char === "'" && body[index + 1] === "'") {
            current += "''";
            index += 1;
            continue;
        }
        if (quote === '"' && char === '\\') {
            current += char + (body[index + 1] ?? '');
            index += 1;
            continue;
        }
        if ((char === '"' || char === "'") && (quote === null || quote === char))
            quote = quote ? null : char;
        if (char === ',' && quote === null) {
            items.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    return [...items, current];
}
function inlineList(raw) {
    const value = raw.trim();
    if (!value.startsWith('[') || !value.endsWith(']'))
        return null;
    return flowItems(value.slice(1, -1)).map(scalar).filter(Boolean);
}
function parseFrontMatter(front, locale, issues) {
    const fields = new Map();
    let listKey = null;
    front.split('\n').forEach((line, index) => {
        if (!line.trim() || line.trim().startsWith('#'))
            return;
        const item = /^\s*-\s*(.*)$/.exec(line);
        if (item && listKey) {
            const value = scalar(item[1] ?? '');
            if (value)
                fields.get(listKey).push(value);
            return;
        }
        const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        listKey = null;
        if (!pair) {
            issues.push({ path: `/front_matter/${index + 1}`, code: 'front_matter',
                message: say(locale, `开头设置第 ${index + 1} 行看不懂，请写成“名称: 值”。`, `Front matter line ${index + 1} is not "key: value".`) });
            return;
        }
        const key = pair[1];
        const value = pair[2] ?? '';
        if (!FRONT_MATTER_KEYS.has(key)) {
            issues.push({ path: `/front_matter/${key}`, code: 'unknown_field',
                message: say(locale, `不认识开头设置里的“${key}”。`, `Unknown front matter field "${key}".`) });
            return;
        }
        if (!value.trim()) {
            fields.set(key, []);
            listKey = key;
            return;
        }
        fields.set(key, inlineList(value) ?? scalar(value));
    });
    return fields;
}
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s+(.*)|\s*)$/;
const FENCE = /^\s*(?:```|~~~)/;
function unwrapCode(item) {
    const match = /^`([^`]+)`$/.exec(item);
    return match ? match[1].trim() : item;
}
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
function onHeading(body, cursor, level, name, locale, issues) {
    if (level === '#' && !body.title && cursor.section === null) {
        body.title = name;
        cursor.section = 'summary';
        return;
    }
    const known = level === '##' ? SECTION_BY_HEADING.get(name.toLowerCase()) : undefined;
    if (!known) {
        issues.push({ path: `/sections/${name}`, code: 'unknown_section',
            message: say(locale, `不认识“${name}”这一节，请删掉或改成模板里的标题。`, `Unknown section "${name}"; remove it or use a template heading.`) });
        cursor.section = 'ignored';
        return;
    }
    cursor.items = body.sections.get(known) ?? [];
    body.sections.set(known, cursor.items);
    cursor.section = known;
}
function onSummaryLine(cursor, line, locale, issues) {
    if (!line.trim()) {
        if (cursor.summary.length > 0)
            cursor.paragraphEnded = true;
        return;
    }
    if (cursor.paragraphEnded) {
        issues.push({ path: '/summary', code: 'ignored_text',
            message: say(locale, '标题下只读第一段作为简介；其余文字请放进对应的小节。', 'Only the first paragraph under the title is the summary; move other text into a section.') });
        cursor.section = 'ignored';
        return;
    }
    cursor.summary.push(line.trim());
    cursor.section = 'summary';
}
/** Inside a fence each line is one command; a trailing `\` continues it on the next line, as a shell would read it. */
function onItemLine(cursor, line, fenced) {
    const listItem = fenced ? null : LIST_ITEM.exec(line);
    const last = cursor.items.length - 1;
    if (fenced && last >= 0 && cursor.items[last].endsWith('\\'))
        cursor.items[last] = `${cursor.items[last].slice(0, -1).trimEnd()} ${line.trim()}`;
    else if (fenced || listItem || last < 0)
        cursor.items.push((listItem ? listItem[1] ?? '' : line).trim());
    else
        cursor.items[last] = `${cursor.items[last]} ${line.trim()}`.trim();
}
/** HTML comments are author hints outside code fences; inside a fence they are part of a command and are kept. */
function withoutCommentsOutsideFences(raw) {
    const kept = [];
    let fenced = false;
    let inComment = false;
    for (const line of raw.split('\n')) {
        if (!inComment && FENCE.test(line)) {
            fenced = !fenced;
            kept.push(line);
            continue;
        }
        if (fenced) {
            kept.push(line);
            continue;
        }
        let rest = line;
        let out = '';
        for (;;) {
            if (inComment) {
                const close = rest.indexOf('-->');
                if (close < 0) {
                    rest = '';
                    break;
                }
                rest = rest.slice(close + 3);
                inComment = false;
            }
            const open = rest.indexOf('<!--');
            if (open < 0) {
                out += rest;
                break;
            }
            out += rest.slice(0, open);
            rest = rest.slice(open + 4);
            inComment = true;
        }
        kept.push(out);
    }
    return kept;
}
function parseBody(raw, locale, issues) {
    const body = { title: '', summary: '', sections: new Map() };
    const cursor = { section: null, items: [], summary: [], paragraphEnded: false };
    let fenced = false;
    for (const line of withoutCommentsOutsideFences(raw)) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        const heading = fenced ? null : HEADING.exec(line);
        if (heading)
            onHeading(body, cursor, heading[1], heading[2].trim(), locale, issues);
        else if (cursor.section === 'summary' || cursor.section === null)
            onSummaryLine(cursor, line, locale, issues);
        else if (cursor.section !== 'ignored' && line.trim())
            onItemLine(cursor, line, fenced);
    }
    body.summary = cursor.summary.join(' ');
    for (const [key, values] of body.sections)
        body.sections.set(key, values.map(unwrapCode).filter(Boolean));
    return body;
}
function asList(value) {
    if (value === undefined)
        return undefined;
    return Array.isArray(value) ? value : [value];
}
function integerOrRaw(value) {
    if (value === undefined)
        return undefined;
    if (typeof value === 'string' && /^\d+$/.test(value))
        return Number(value);
    return value;
}
function prefixed(prefix, values) {
    return values.map((value) => (value.toLowerCase().startsWith(prefix.trim().toLowerCase()) ? value : `${prefix}${value}`));
}
/** A GENE.md document read into the Gene fields it can carry; parse problems are reported, never fatal. */
export function parseGeneMarkdown(text, locale) {
    const issues = [];
    const { front, body } = splitFrontMatter(text);
    const fields = front === null ? new Map() : parseFrontMatter(front, locale, issues);
    const parsed = parseBody(body, locale, issues);
    const section = (name) => parsed.sections.get(name) ?? [];
    const id = fields.get('id');
    const gene = {
        type: 'Gene',
        ...(typeof id === 'string' && id ? { id } : {}),
        ...(fields.has('category') ? { category: fields.get('category') } : {}),
        ...(fields.has('signals') ? { signals_match: asList(fields.get('signals')) } : {}),
        preconditions: [...prefixed(USE_WHEN, section('use')), ...prefixed(DO_NOT_USE_WHEN, section('notUse')), ...section('preconditions')],
        strategy: section('steps'),
        ...(fields.has('max_files') || fields.has('forbidden_paths') ? { constraints: {
                ...(fields.has('max_files') ? { max_files: integerOrRaw(fields.get('max_files')) } : {}),
                ...(fields.has('forbidden_paths') ? { forbidden_paths: asList(fields.get('forbidden_paths')) } : {}),
            } } : {}),
        validation: section('validation'),
        ...(parsed.summary ? { summary: parsed.summary } : {}),
        ...(section('success').length > 0 ? { claims: section('success').map((predicate) => ({ predicate, kind: 'behavioral' })) } : {}),
    };
    const supersedes = fields.get('supersedes');
    return { gene, title: parsed.title, ...(typeof supersedes === 'string' && supersedes ? { supersedes } : {}), issues };
}
export function yamlScalar(value) {
    const text = String(value ?? '');
    return /^[\w./@~-][\w ./@~|()-]*$/.test(text) && text.trim() === text ? text : JSON.stringify(text);
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
function oneLine(text) {
    return text.replace(/\s*\n\s*/g, ' ').trim();
}
function frontMatter(gene, supersedes) {
    const constraints = gene['constraints'] && typeof gene['constraints'] === 'object' ? gene['constraints'] : {};
    const list = (key, values) => (values.length > 0
        ? [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)] : [`${key}: []`]);
    return [
        '---',
        ...(typeof gene['id'] === 'string' && gene['id'] ? [`id: ${yamlScalar(gene['id'])}`] : []),
        `category: ${yamlScalar(gene['category'] ?? '')}`,
        ...list('signals', strings(gene['signals_match'])),
        ...(constraints['max_files'] === undefined ? [] : [`max_files: ${typeof constraints['max_files'] === 'number' ? constraints['max_files'] : yamlScalar(constraints['max_files'])}`]),
        ...(constraints['forbidden_paths'] === undefined ? [] : list('forbidden_paths', strings(constraints['forbidden_paths']))),
        ...(supersedes ? [`supersedes: ${yamlScalar(supersedes)}`] : []),
        '---',
    ];
}
function sectionLines(locale, section, values, ordered = false) {
    return ['', `## ${HEADINGS[section][locale]}`, '', ...values.map((value, index) => `${ordered ? `${index + 1}.` : '-'} ${oneLine(value)}`)];
}
function withoutPrefix(prefix, value) {
    return value.slice(prefix.length).trim();
}
/** The canonical GENE.md rendering of a Gene: every field the grammar carries, in the requested locale. */
export function renderGeneMarkdown(gene, locale) {
    const meta = gene['generation_meta'] && typeof gene['generation_meta'] === 'object' ? gene['generation_meta'] : {};
    const preconditions = strings(gene['preconditions']);
    const startsWith = (prefix) => (value) => value.toLowerCase().startsWith(prefix.trim().toLowerCase());
    const use = preconditions.filter(startsWith(USE_WHEN)).map((value) => withoutPrefix(USE_WHEN.trim(), value));
    const notUse = preconditions.filter(startsWith(DO_NOT_USE_WHEN)).map((value) => withoutPrefix(DO_NOT_USE_WHEN.trim(), value));
    const other = preconditions.filter((value) => !startsWith(USE_WHEN)(value) && !startsWith(DO_NOT_USE_WHEN)(value));
    const claims = Array.isArray(gene['claims']) ? gene['claims'] : [];
    const predicates = claims.flatMap((claim) => (claim && typeof claim === 'object' && typeof claim['predicate'] === 'string'
        ? [claim['predicate']] : []));
    const lines = [
        ...frontMatter(gene, typeof meta['supersedes'] === 'string' ? meta['supersedes'] : undefined),
        '',
        `# ${oneLine(typeof meta['title'] === 'string' ? meta['title'] : '')}`.trimEnd(),
        '',
        ...(typeof gene['summary'] === 'string' && gene['summary'] ? [oneLine(gene['summary'])] : []),
        ...sectionLines(locale, 'use', use),
        ...sectionLines(locale, 'notUse', notUse),
        ...(other.length > 0 ? sectionLines(locale, 'preconditions', other) : []),
        ...sectionLines(locale, 'steps', strings(gene['strategy']), true),
        ...sectionLines(locale, 'validation', strings(gene['validation'])),
        ...sectionLines(locale, 'success', predicates),
    ];
    return `${lines.join('\n')}\n`;
}