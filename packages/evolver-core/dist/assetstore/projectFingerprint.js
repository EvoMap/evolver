import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const GIT_TIMEOUT_MS = 2_000;
// The daemon's own GIT_DIR, GIT_WORK_TREE and friends would point git at another repository than the one asked about;
// Windows reads environment names without regard to case.
function gitEnvironment() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    return { ...env, GIT_TERMINAL_PROMPT: '0' };
}
// Git itself reads the checkout: includes, comments, quoting, worktrees and subdirectories follow its own rules. It runs
// asynchronously so a slow repository holds up only the recall that asked, never the daemon's other requests.
function git(dir, args) {
    return new Promise((resolve) => {
        execFile('git', ['-C', dir, ...args], {
            encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: gitEnvironment(), windowsHide: true,
        }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
    });
}
function existingDir(dir) {
    try {
        return realpathSync(dir);
    }
    catch {
        return undefined;
    }
}
/**
 * Stable, path-free identity of the project a host works in: the hash of its git checkout's root and origin. Local
 * project contexts carry it so recall can tell this project's notes from another's; it never names the directory
 * itself. Undefined without an origin (or without git): a plain directory may be reused by an unrelated project, and
 * its notes are then not worth the risk of reaching the wrong one (docs/local-project-context.md). Undefined for
 * anything but an absolute path, so a caller cannot make two projects collide by sending a relative one.
 */
export async function projectFingerprint(dir) {
    if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir.trim()))
        return undefined;
    const canonical = existingDir(dir.trim());
    if (!canonical)
        return undefined;
    const root = await git(canonical, ['rev-parse', '--show-toplevel']);
    // Only the repository's own config names its origin; a global or system one would name every checkout alike.
    const origin = root ? await git(root, ['config', '--local', '--includes', '--get', 'remote.origin.url']) : '';
    if (!root || !origin)
        return undefined;
    return `project:${createHash('sha256').update(`${existingDir(root) ?? root}\n${origin}`).digest('hex').slice(0, 32)}`;
}