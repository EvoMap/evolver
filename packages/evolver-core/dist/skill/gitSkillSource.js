import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { checkSkillTree } from './requiredSkills.js';
const FETCH_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Fetch one commit of a public https repository, or the current tip of one of its branches, and read a skill
 * directory out of it. Nothing is checked out: files are read from git objects, so repository filters, hooks,
 * symlinks and submodules never touch the disk. Asynchronous, so a long fetch never stalls the process that waits on
 * it (the MCP server keeps serving).
 */
export async function fetchSkillFiles(source) {
    const dir = mkdtempSync(join(tmpdir(), 'evolver-skill-'));
    // A branch is fetched by its full ref, so it can never be read as an option, a tag or a commit.
    const wanted = 'branch' in source ? `refs/heads/${source.branch}` : source.commit;
    const label = 'branch' in source ? `branch ${source.branch}` : source.commit.slice(0, 12);
    try {
        const forwarded = await forwardedGitConfig(dir);
        await git(dir, ['init', '--quiet']);
        await git(dir, ['fetch', '--quiet', '--depth', '1', '--no-tags', source.repo, wanted], forwarded);
        const commit = 'branch' in source ? (await git(dir, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).toString('utf8').trim() : source.commit;
        const files = await readSkillTree(dir, commit, source.path);
        return files.ok ? { ok: true, value: { commit, files: files.value } } : files;
    }
    catch (error) {
        return { ok: false, message: `git could not fetch ${label} from ${source.repo} (${gitFailure(error)})` };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Read the regular files under `path` at `commit` from a local repository that already has the commit. */
export async function readSkillTree(repoDir, commit, path) {
    let listing;
    try {
        listing = await git(repoDir, ['ls-tree', '-r', '-l', '-z', path ? `${commit}:${path}` : commit]);
    }
    catch {
        return { ok: false, message: `the commit has no directory ${JSON.stringify(path || '/')}` };
    }
    const rows = listing.toString('utf8').split('\0').filter(Boolean).map(parseTreeRow);
    const checked = checkSkillTree(rows);
    if (!checked.ok)
        return checked;
    const files = [];
    for (const row of rows)
        files.push({ path: row.path, content: await git(repoDir, ['cat-file', 'blob', row.object]) });
    return { ok: true, value: files };
}
function parseTreeRow(row) {
    const tab = row.indexOf('\t');
    const [mode = '', type = '', object = '', size = ''] = row.slice(0, tab).split(/ +/);
    return { mode, type, object, size: Number(size) || 0, path: row.slice(tab + 1) };
}
// The fetch runs on an empty configuration: the user's could add headers (http.extraHeader), credentials or
// transports for a host the Gene names. Only what changes where the bytes come from is carried over: a proxy, a CA
// bundle for it, and mirrors that rewrite to another https URL. Which bytes are accepted never depends on it: the
// caller checks them against the sha256 the Gene pins, and nothing is checked out. The values travel in
// GIT_CONFIG_COUNT/KEY/VALUE (git 2.31+), not as -c arguments: a proxy URL may hold credentials, and a command line
// is visible to every local process.
const FORWARDED = '^(http\\.proxy|http\\.sslcainfo|url\\..+\\.insteadof)$'; // POSIX ERE, as git config reads it
export async function forwardedGitConfig(cwd) {
    let raw;
    try {
        raw = await run(cwd, ['config', '-z', '--get-regexp', FORWARDED], userEnv());
    }
    catch (error) {
        if (error.code === 1)
            return {}; // git config exits 1 when no key matches
        throw error;
    }
    const pairs = raw.toString('utf8').split('\0').filter(Boolean).flatMap((record) => {
        const [key = '', value = ''] = record.split(/\n(.*)/s);
        const mirror = key.startsWith('url.') ? key.slice(4, -'.insteadof'.length) : '';
        return key.startsWith('url.') && !mirror.startsWith('https://') ? [] : [[key, value]];
    });
    const env = pairs.length > 0 ? { GIT_CONFIG_COUNT: String(pairs.length) } : {};
    pairs.forEach(([key, value], index) => Object.assign(env, { [`GIT_CONFIG_KEY_${index}`]: key, [`GIT_CONFIG_VALUE_${index}`]: value }));
    return env;
}
const execFileAsync = promisify(execFile);
function git(cwd, args, config = {}) {
    return run(cwd, ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args], { ...userEnv(), ...config, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' });
}
// A caller's GIT_* variables are dropped (a hook that exports GIT_DIR must not redirect these commands); no prompts.
function userEnv() {
    return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' };
}
async function run(cwd, args, env) {
    const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'buffer', timeout: FETCH_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
    return stdout;
}
function gitFailure(error) {
    const record = error;
    if (record.code === 'ENOENT')
        return 'git is not installed';
    if (record.killed === true)
        return 'timed out';
    const stderr = Buffer.isBuffer(record.stderr) ? record.stderr.toString('utf8') : '';
    return stderr.trim().split('\n').pop()?.slice(0, 200) || 'git failed';
}