import { createHash } from 'node:crypto';
const GIT_PREFIX = 'skill:git+';
const MAX_REQUIRED_SKILLS = 8;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 8;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BRANCH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_BRANCH_LENGTH = 200;
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
        return malformed('expected <repository>@<commit>#sha256=<digest> or <repository>@<branch>');
    const repo = httpsRepository(location.slice(0, at));
    const rev = location.slice(at + 1);
    const params = fragmentOf(fragment);
    if (!repo)
        return malformed('the repository must be a plain https:// URL without credentials or query');
    if (!params)
        return malformed('the fragment may hold only sha256=<64 lowercase hex> and path=<plain relative directory>');
    const { sha256, path } = params;
    const name = installName(path || new URL(repo).pathname);
    if (!name)
        return malformed('no usable directory name');
    if (sha256 !== undefined) {
        // A digest only means something next to a commit: a branch moves, and its content with it.
        if (!COMMIT.test(rev))
            return malformed('with #sha256 the reference must name a full lowercase hex commit id');
        return { ok: true, value: { name, repo, commit: rev, path, sha256 } };
    }
    if (COMMIT.test(rev))
        return malformed('a commit reference needs #sha256=<64 lowercase hex> of the skill directory');
    if (!isBranchName(rev))
        return malformed(`${JSON.stringify(rev)} is not a usable branch name`);
    return { ok: true, value: { name, repo, branch: rev, path } };
}
function fragmentOf(fragment) {
    const params = new URLSearchParams(fragment);
    const sha256 = params.get('sha256') ?? undefined;
    const path = params.get('path') ?? '';
    const known = [...params.keys()].every((key) => key === 'sha256' || key === 'path');
    const valid = known && (sha256 === undefined || SHA256.test(sha256)) && (path === '' || isSafeRelativePath(path));
    return valid ? { ...(sha256 === undefined ? {} : { sha256 }), path } : null;
}
/**
 * A branch name git takes as nothing but `refs/heads/<name>` (a subset of `git check-ref-format`): plain characters,
 * no empty, dot-led or `.lock` segment, no `..`, and no leading `-` that git could read as an option.
 */
function isBranchName(name) {
    return name.length <= MAX_BRANCH_LENGTH && !name.startsWith('-') && !name.includes('..') && !name.endsWith('.')
        && name.split('/').every((segment) => BRANCH_SEGMENT.test(segment) && !segment.startsWith('.') && !segment.endsWith('.lock'));
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
/** The `preconditions` entry that pins a skill directory with this content, or follows a branch. */
export function formatRequiredSkill(ref) {
    const pinned = 'sha256' in ref;
    const params = new URLSearchParams({ ...(pinned ? { sha256: ref.sha256 } : {}), ...(ref.path ? { path: ref.path } : {}) });
    return `${GIT_PREFIX}${ref.repo}@${pinned ? ref.commit : ref.branch}#${params.toString().replace(/%2F/g, '/')}`;
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