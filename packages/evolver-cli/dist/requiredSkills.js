import { createHash } from 'node:crypto';
const GIT_PREFIX = 'skill:git+';
const MAX_REQUIRED_SKILLS = 8;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 8;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
// Windows opens these as devices, extension or not (CON, NUL.txt, COM1.md), so they never name a plain file.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
/**
 * Read the skills a Gene requires from its `preconditions`. Only entries that start with `skill:git+` are
 * references; everything else, other `skill:` text included, stays an ordinary precondition. A reference that
 * cannot be honoured in full is an error, not a shorter list: installing some of what a Gene needs would hand the
 * agent a broken strategy.
 */
export function requiredSkillsOf(gene) {
    const preconditions = Array.isArray(gene['preconditions']) ? gene['preconditions'] : [];
    const declared = preconditions.filter((entry) => typeof entry === 'string' && entry.startsWith(GIT_PREFIX));
    if (declared.length > MAX_REQUIRED_SKILLS)
        return { ok: false, message: `a Gene may require at most ${MAX_REQUIRED_SKILLS} skills` };
    const refs = [];
    for (const entry of declared) {
        const ref = parseRequiredSkill(entry);
        if (!ref.ok)
            return ref;
        if (refs.some((known) => known.name === ref.value.name)) {
            return { ok: false, message: `two required skills would install to skills/${ref.value.name}` };
        }
        refs.push(ref.value);
    }
    return { ok: true, value: refs };
}
function parseRequiredSkill(entry) {
    const malformed = (why) => ({ ok: false, message: `required skill reference is not valid (${why})` });
    const [location = '', fragment = '', ...extra] = entry.slice(GIT_PREFIX.length).split('#');
    const at = location.lastIndexOf('@');
    if (extra.length > 0 || at < 0)
        return malformed('expected <repository>@<commit>#sha256=<digest>');
    const repo = httpsRepository(location.slice(0, at));
    const commit = location.slice(at + 1);
    const pin = pinOf(fragment);
    if (!repo)
        return malformed('the repository must be a plain https:// URL without credentials or query');
    if (!COMMIT.test(commit))
        return malformed('the commit must be a full lowercase hex commit id');
    if (!pin)
        return malformed('expected #sha256=<64 lowercase hex>, optionally &path=<plain relative directory>');
    const { sha256, path } = pin;
    const name = installName(path || new URL(repo).pathname);
    if (!name)
        return malformed('no usable directory name');
    return { ok: true, value: { name, repo, commit, path, sha256 } };
}
function pinOf(fragment) {
    const params = new URLSearchParams(fragment);
    const sha256 = params.get('sha256') ?? '';
    const path = params.get('path') ?? '';
    const known = [...params.keys()].every((key) => key === 'sha256' || key === 'path');
    return known && SHA256.test(sha256) && (path === '' || isSafeRelativePath(path)) ? { sha256, path } : null;
}
function httpsRepository(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    const plain = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.length > 1;
    return plain && url.href === raw ? raw : null;
}
function installName(source) {
    const last = source.split('/').filter(Boolean).pop() ?? '';
    return last.replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
/** The `preconditions` entry that pins a skill directory with this content. */
export function formatRequiredSkill(ref) {
    const params = new URLSearchParams({ sha256: ref.sha256, ...(ref.path ? { path: ref.path } : {}) });
    return `${GIT_PREFIX}${ref.repo}@${ref.commit}#${params.toString().replace(/%2F/g, '/')}`;
}
/**
 * Content digest of a skill directory: SHA-256 over one `<sha256 of the file>  <path>\n` line per file, sorted by
 * path. It is the output of `sha256sum` over the sorted files, so an author can reproduce it without this tool.
 */
export function digestOfSkillFiles(files) {
    const lines = [...files]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => `${createHash('sha256').update(file.content).digest('hex')}  ${file.path}\n`);
    return createHash('sha256').update(lines.join('')).digest('hex');
}
/** Decide from the tree listing alone, before any file content is read, whether this directory may be installed. */
export function checkSkillTree(entries) {
    if (!entries.some((entry) => entry.path === 'SKILL.md'))
        return { ok: false, message: 'the directory has no SKILL.md' };
    if (entries.length > MAX_FILES)
        return { ok: false, message: `it has more than ${MAX_FILES} files` };
    const seen = new Set();
    let total = 0;
    for (const entry of entries) {
        if (entry.type !== 'blob' || !REGULAR_FILE_MODES.has(entry.mode)) {
            return { ok: false, message: `${entry.path} is a symlink or submodule, not a regular file` };
        }
        if (!isSafeRelativePath(entry.path) || seen.has(entry.path.toLowerCase())) {
            return { ok: false, message: `${JSON.stringify(entry.path)} is not a plain, unique relative path` };
        }
        seen.add(entry.path.toLowerCase());
        total += entry.size;
        if (entry.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
            return { ok: false, message: `it is larger than ${MAX_FILE_BYTES} bytes per file or ${MAX_TOTAL_BYTES} bytes in total` };
        }
    }
    return { ok: true, value: true };
}
function isSafeRelativePath(path) {
    const segments = path.split('/');
    return segments.length <= MAX_DEPTH
        && segments.every((segment) => SEGMENT.test(segment) && !/^\.+$/.test(segment) && segment.toLowerCase() !== '.git' && !segment.endsWith('.')
            && !WINDOWS_DEVICE.test(segment));
}