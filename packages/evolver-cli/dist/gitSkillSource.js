import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSkillTree } from './requiredSkills.js';
const FETCH_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Fetch one commit of a public https repository and read a skill directory out of it. Nothing is checked out:
 * files are read from git objects, so repository filters, hooks, symlinks and submodules never touch the disk.
 */
export function fetchSkillFiles(source) {
    const dir = mkdtempSync(join(tmpdir(), 'evolver-skill-'));
    try {
        git(dir, ['init', '--quiet']);
        git(dir, ['fetch', '--quiet', '--depth', '1', '--no-tags', source.repo, source.commit]);
        return readSkillTree(dir, source.commit, source.path);
    }
    catch (error) {
        return { ok: false, message: `git could not fetch ${source.commit.slice(0, 12)} from ${source.repo} (${gitFailure(error)})` };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Read the regular files under `path` at `commit` from a local repository that already has the commit. */
export function readSkillTree(repoDir, commit, path) {
    let listing;
    try {
        listing = git(repoDir, ['ls-tree', '-r', '-l', '-z', path ? `${commit}:${path}` : commit]);
    }
    catch {
        return { ok: false, message: `the commit has no directory ${JSON.stringify(path || '/')}` };
    }
    const rows = listing.toString('utf8').split('\0').filter(Boolean).map(parseTreeRow);
    const checked = checkSkillTree(rows);
    if (!checked.ok)
        return checked;
    return { ok: true, value: rows.map((row) => ({ path: row.path, content: git(repoDir, ['cat-file', 'blob', row.object]) })) };
}
function parseTreeRow(row) {
    const tab = row.indexOf('\t');
    const [mode = '', type = '', object = '', size = ''] = row.slice(0, tab).split(/ +/);
    return { mode, type, object, size: Number(size) || 0, path: row.slice(tab + 1) };
}
// https only, no prompts, and neither the user's git configuration nor a caller's GIT_* variables: a hook that
// exports GIT_DIR, a url.insteadOf rewrite or a credential helper must not change what gets fetched.
function git(cwd, args) {
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
    return execFileSync('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args], {
        cwd,
        env: { ...Object.fromEntries(inherited), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
    });
}
function gitFailure(error) {
    const record = error;
    if (record.code === 'ENOENT')
        return 'git is not installed';
    if (record.code === 'ETIMEDOUT')
        return 'timed out';
    const stderr = Buffer.isBuffer(record.stderr) ? record.stderr.toString('utf8') : '';
    return stderr.trim().split('\n').pop()?.slice(0, 200) || 'git failed';
}