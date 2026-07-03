import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const PLACEHOLDER_VERSIONS = new Set(['', '0.0.0']);
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
export function resolveRuntimeVersion(opts) {
    const fallback = opts.fallback ?? '0.0.0';
    const found = findRuntimePackage(opts.startDir, opts.isPackage);
    const packageVersion = found?.pkg.version?.trim() ?? '';
    if (!PLACEHOLDER_VERSIONS.has(packageVersion))
        return packageVersion;
    const gitVersion = resolveGitVersion(found?.dir ?? opts.startDir, opts.execGit);
    return gitVersion ?? fallback;
}
function findRuntimePackage(startDir, isPackage) {
    let dir = startDir;
    for (let i = 0; i < 8; i += 1) {
        try {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            if (isPackage(pkg))
                return { dir, pkg };
        }
        catch {
            // Source and built layouts put package.json at different depths.
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
function resolveGitVersion(startDir, execGit = defaultExecGit) {
    const sha = safeGit(['rev-parse', '--short=12', 'HEAD'], startDir, execGit);
    if (!sha || !GIT_SHA_RE.test(sha))
        return null;
    const dirty = safeGit(['status', '--porcelain'], startDir, execGit);
    return `0.0.0+git.${sha.toLowerCase()}${dirty ? '.dirty' : ''}`;
}
function safeGit(args, cwd, execGit) {
    try {
        const out = execGit(args, cwd).trim();
        return out.length > 0 ? out : null;
    }
    catch {
        return null;
    }
}
function defaultExecGit(args, cwd) {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}