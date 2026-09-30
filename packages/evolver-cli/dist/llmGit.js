import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exec, verify } from '@evomap/evolver-core';
const TIMEOUT_MS = 30_000;
const CONFIG_PATTERN = '^(filter[.].*[.](clean|smudge|process)|includeif[.].*[.]path|extensions[.]partialclone|remote[.].*[.]promisor|core[.](alternaterefscommand|worktree))$';
const GUARDS = [
    '--no-pager',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.excludesFile=/dev/null',
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'submodule.recurse=false',
    '-c', 'protocol.allow=never',
];
function inside(root, path) {
    const value = relative(root, path);
    return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}
function directoryIdentity(path) {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return undefined;
        return { path: realpathSync.native(path), dev: stat.dev, ino: stat.ino };
    }
    catch {
        return undefined;
    }
}
function sameDirectory(actual, expected) {
    return actual !== undefined && expected !== undefined && actual.path === expected.path
        && actual.dev === expected.dev && actual.ino === expected.ino;
}
function absent(path) {
    try {
        lstatSync(path);
        return false;
    }
    catch (error) {
        return error.code === 'ENOENT';
    }
}
/** Only Git's own incomplete-creation lock permits stronger removal than ordinary cleanup. */
function initializingLock(path) {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32n)
            return undefined;
        if (!/^initializing\n?$/u.test(readFileSync(path, 'utf8')))
            return undefined;
        return { path, dev: stat.dev, ino: stat.ino };
    }
    catch {
        return undefined;
    }
}
/** Resolve a host executable once; subsequent model writes cannot change command lookup. */
function hostGit(repo, env) {
    const root = realpathSync.native(repo);
    const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    for (const directory of path.split(delimiter)) {
        if (!isAbsolute(directory))
            continue;
        try {
            const candidate = realpathSync.native(join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
            if (inside(root, candidate) || !statSync(candidate).isFile())
                continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch { /* A missing PATH entry is not executable authority. */ }
    }
    throw new Error('llm cycle requires a native Git executable outside the repository');
}
function command(args) {
    if (!['rev-parse', 'worktree', 'diff', 'ls-files', 'add', 'reset'].includes(args[0] ?? '')) {
        throw new Error('unsupported llm Git operation');
    }
    const separator = args.indexOf('--');
    const flags = args.slice(1, separator < 0 ? undefined : separator);
    if (flags.some((arg) => arg === '--ext-diff' || arg === '--textconv' || arg === '--recurse-submodules')) {
        throw new Error('executable Git extensions are not allowed for llm cycle');
    }
    return [...GUARDS, args[0], ...(args[0] === 'diff' ? ['--no-ext-diff', '--no-textconv'] : []), ...args.slice(1)];
}
/**
 * Trusted host Git composition for the bounded file executor. Repository configuration is
 * rechecked for each invocation, including worktree creation before model dispatch. This is
 * not a sandbox for custom Git runners: an injected runner and patch writer are trusted seams.
 */
export function createLlmGit(repo, acceptancePaths = []) {
    if (acceptancePaths.length > 64)
        throw new Error('llm Git acceptance paths exceed their bound');
    const paths = Object.freeze(acceptancePaths.map((path) => verify.declarativeValidationPath(path)));
    const env = {
        ...exec.scrubAgentEnv(process.env),
        // Git localizes its incomplete-worktree lock reason; ownership proof needs stable metadata.
        LC_ALL: 'C',
        LANGUAGE: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_ATTR_NOSYSTEM: '1',
    };
    const executable = hostGit(repo, env);
    const repository = directoryIdentity(repo);
    if (!repository)
        throw new Error('llm Git repository identity is unavailable');
    const ownedWorktrees = new Map();
    const complete = (result, allowMissing = false) => {
        if (result.termination !== 'exit')
            throw new Error(`llm Git operation ${result.termination}`);
        if (result.stdoutTruncated)
            throw new Error('llm Git proof exceeds its capture bound');
        if (result.code !== 0 && !(allowMissing && result.code === 1))
            throw new Error('llm Git operation failed');
    };
    const metadata = async (args, cwd, signal, options) => {
        const result = await exec.spawnCapture(executable, [...GUARDS, ...args], {
            cwd, timeoutMs: TIMEOUT_MS, env, ...(signal ? { signal } : {}), ...options,
        });
        complete(result);
        return result.stdout;
    };
    const metadataDirectory = async (flag, cwd, signal, options) => {
        const output = await metadata(['rev-parse', '--path-format=absolute', flag], cwd, signal, options);
        const path = output.endsWith('\n') ? output.slice(0, -1) : '';
        return isAbsolute(path) ? directoryIdentity(path) : undefined;
    };
    const reserveCreation = async (path, cwd, signal, options) => {
        const target = resolve(cwd, path);
        const parent = directoryIdentity(dirname(target));
        if (!parent || !absent(target))
            return undefined;
        const common = await metadataDirectory('--git-common-dir', cwd, signal, options);
        if (!common || !sameDirectory(directoryIdentity(cwd), repository)
            || !sameDirectory(directoryIdentity(dirname(target)), parent) || !absent(target))
            return undefined;
        // Observing absence is not ownership: another Git process could create the target
        // before our add starts. Atomically create the empty leaf Git will populate instead.
        try {
            mkdirSync(target, { mode: 0o700 });
        }
        catch (error) {
            if (error.code === 'EEXIST')
                return undefined;
            throw error;
        }
        const leaf = directoryIdentity(target);
        if (!leaf || leaf.path !== join(parent.path, basename(target))
            || !sameDirectory(directoryIdentity(dirname(target)), parent)) {
            throw new Error('llm Git reserved worktree identity changed; retain reservation for recovery');
        }
        return { path: leaf.path, parent, common, leaf };
    };
    const creationUnchanged = (creation) => sameDirectory(directoryIdentity(repo), repository)
        && sameDirectory(directoryIdentity(dirname(creation.path)), creation.parent)
        && sameDirectory(directoryIdentity(creation.path), creation.leaf)
        && sameDirectory(directoryIdentity(creation.common.path), creation.common);
    const worktreeListing = async () => {
        const listing = await metadata(['worktree', 'list', '--porcelain', '-z'], repo, undefined, { processSignalMode: 'ignore' });
        const records = listing.split('\0\0');
        if (records.pop() !== '' || records.length === 0)
            throw new Error('llm Git worktree listing is incomplete');
        return records.map((record) => {
            const [location, ...fields] = record.split('\0');
            if (!location?.startsWith('worktree ') || !isAbsolute(location.slice('worktree '.length)) || fields.length === 0) {
                throw new Error('llm Git worktree listing is malformed');
            }
            return { path: location.slice('worktree '.length), detached: fields.includes('detached') };
        });
    };
    const listedCreation = (path, creation) => {
        const actual = resolve(path);
        return (process.platform === 'win32' ? actual.toLowerCase() === creation.path.toLowerCase() : actual === creation.path)
            || sameDirectory(directoryIdentity(path), creation.leaf);
    };
    const removeEmptyCreation = async (creation) => {
        if (!creationUnchanged(creation) || readdirSync(creation.path).length !== 0)
            return;
        // Only a successful, complete listing proving absence permits empty-reservation
        // cleanup. A failed/truncated/unknown proof must retain the directory for recovery.
        const listing = await worktreeListing();
        if (listing.some((entry) => listedCreation(entry.path, creation)) || !creationUnchanged(creation))
            return;
        // Nonrecursive removal also refuses a directory populated after the readback.
        rmdirSync(creation.path);
    };
    const reconcileCreation = async (creation) => {
        const created = creation.leaf;
        if (!creationUnchanged(creation))
            return undefined;
        // Fixed metadata-only commands do not checkout files or run filters. Shield the original
        // cancellation only after spawnCapture has returned its settled child result.
        const cleanup = { processSignalMode: 'ignore' };
        const common = await metadataDirectory('--git-common-dir', created.path, undefined, cleanup);
        const admin = await metadataDirectory('--git-dir', created.path, undefined, cleanup);
        if (!sameDirectory(common, creation.common) || !admin
            || dirname(admin.path) !== join(creation.common.path, 'worktrees'))
            return undefined;
        const backPointer = join(admin.path, 'gitdir');
        const pointerStat = lstatSync(backPointer);
        if (!pointerStat.isFile() || pointerStat.isSymbolicLink() || pointerStat.size > 4096)
            return undefined;
        const pointer = readFileSync(backPointer, 'utf8');
        if (!pointer.endsWith('\n') || realpathSync.native(pointer.slice(0, -1)) !== join(created.path, '.git'))
            return undefined;
        const listing = await worktreeListing();
        const registered = listing.some((entry) => entry.detached && listedCreation(entry.path, creation));
        if (!registered || !creationUnchanged(creation) || !sameDirectory(directoryIdentity(admin.path), admin))
            return undefined;
        const lock = initializingLock(join(admin.path, 'locked'));
        return { ...created, ...(lock ? { initializingLock: lock } : {}) };
    };
    let versionChecked = false;
    const preflight = async (cwd, signal, options, cleanup = false) => {
        const spawnOptions = { cwd, timeoutMs: TIMEOUT_MS, env, ...(signal ? { signal } : {}), ...options };
        if (!versionChecked) {
            const result = await exec.spawnCapture(executable, ['--version'], spawnOptions);
            complete(result);
            const match = /^git version (\d+)\.(\d+)(?:\.|\s)/.exec(result.stdout);
            if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 43)) {
                throw new Error('llm cycle requires Git 2.43 or newer for non-executable monitoring and committed attribute proof');
            }
            versionChecked = true;
        }
        // Exact cleanup calls have already established ownership below. Their fixed argv does
        // not inspect working-tree content, so changed admission policy cannot strand that owner.
        if (cleanup)
            return;
        const config = await exec.spawnCapture(executable, [...GUARDS, 'config', '--null', '--get-regexp', CONFIG_PATTERN], spawnOptions);
        complete(config, true);
        for (const entry of config.stdout.split('\0').filter(Boolean)) {
            const newline = entry.indexOf('\n');
            const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
            const value = newline < 0 ? '' : entry.slice(newline + 1);
            // A pinned cwd does not constrain Git when repository config redirects its worktree.
            if (key === 'core.worktree')
                throw new Error('llm cycle refuses Git worktree redirection');
            // Conditional includes may activate inside `worktree add` before that new cwd can be checked.
            if (!key.startsWith('filter.') || value.trim() !== '') {
                throw new Error('llm cycle refuses executable Git filters, conditional configuration, or lazy object sources');
            }
        }
        const tree = await exec.spawnCapture(executable, [...GUARDS, 'ls-tree', '-r', '-z', 'HEAD'], spawnOptions);
        complete(tree);
        if (tree.stdout.split('\0').some((entry) => entry.startsWith('160000 '))) {
            throw new Error('llm cycle does not admit submodules whose output is absent from the outer Git patch');
        }
        if (paths.length > 0) {
            // Worktree creation reads committed attributes, which an uncommitted local file may mask.
            for (const source of [[], ['--source=HEAD']]) {
                const attrs = await exec.spawnCapture(executable, [...GUARDS, 'check-attr', '-z', ...source, 'text', 'eol', 'crlf', 'ident', 'filter', 'working-tree-encoding', '--', ...paths], spawnOptions);
                complete(attrs);
                const fields = attrs.stdout.split('\0');
                if (fields.pop() !== '' || fields.length !== paths.length * 6 * 3)
                    throw new Error('llm Git attributes proof is incomplete');
                for (let index = 0; index < fields.length; index += 3) {
                    if (!paths.includes(fields[index]) || !['unspecified', 'unset'].includes(fields[index + 2])) {
                        throw new Error('llm cycle refuses byte-transforming Git attributes on acceptance paths');
                    }
                }
            }
        }
    };
    const git = async (args, cwd, signal, options) => {
        const argv = command(args);
        const cwdIdentity = directoryIdentity(cwd);
        const atRepository = sameDirectory(cwdIdentity, repository);
        const atOwnedWorktree = cwdIdentity !== undefined && sameDirectory(cwdIdentity, ownedWorktrees.get(cwdIdentity.path));
        const commonDirectory = args.length === 3 && args[0] === 'rev-parse'
            && args[1] === '--path-format=absolute' && args[2] === '--git-common-dir'
            && (atRepository || atOwnedWorktree);
        const removed = args.length === 4 && args[0] === 'worktree' && args[1] === 'remove' && args[2] === '--force'
            && atRepository ? directoryIdentity(resolve(cwd, args[3])) : undefined;
        const removeOwned = removed !== undefined && sameDirectory(removed, ownedWorktrees.get(removed.path));
        if (args[0] === 'worktree' && args[1] === 'remove' && !removeOwned) {
            throw new Error('llm Git worktree removal requires an exact owned identity');
        }
        const retainedLock = removed && ownedWorktrees.get(removed.path)?.initializingLock;
        if (removeOwned && retainedLock && sameDirectory(initializingLock(retainedLock.path), retainedLock))
            argv.push('--force');
        // No exemption for arbitrary rev-parse flags, unowned/replaced directories, or reset.
        await preflight(cwd, signal, options, commonDirectory || removeOwned);
        const adding = args.length === 5 && args[0] === 'worktree' && args[1] === 'add' && args[2] === '--detach'
            && args[4] === 'HEAD' && atRepository;
        const creation = adding ? await reserveCreation(args[3], cwd, signal, options) : undefined;
        if (adding && !creation)
            throw new Error('llm Git worktree target must be absent under a stable parent');
        if (creation && !creationUnchanged(creation))
            throw new Error('llm Git reserved worktree identity changed; retain reservation for recovery');
        const result = await exec.spawnCapture(executable, argv, {
            cwd, timeoutMs: TIMEOUT_MS, env, ...(signal ? { signal } : {}), ...options,
        });
        try {
            complete(result);
        }
        catch (error) {
            // A failed result can follow a real registration/checkout. Never adopt an existing
            // target or reconcile a rejected spawn whose child settlement is unknown.
            if (creation) {
                let retained;
                try {
                    retained = await reconcileCreation(creation);
                }
                catch { /* Missing or ambiguous proof cannot confer cleanup authority. */ }
                if (retained)
                    ownedWorktrees.set(retained.path, retained);
                else {
                    try {
                        await removeEmptyCreation(creation);
                    }
                    catch { /* Preserve the original failure and retained recovery evidence. */ }
                }
            }
            throw error;
        }
        if (adding) {
            let created;
            try {
                created = await reconcileCreation(creation);
            }
            catch { /* Unknown proof cannot confer cleanup authority. */ }
            if (!created) {
                try {
                    await removeEmptyCreation(creation);
                }
                catch { /* Retain ambiguous or populated reservations for recovery. */ }
                throw new Error('llm Git worktree identity could not be retained');
            }
            ownedWorktrees.set(created.path, created);
        }
        if (removeOwned)
            ownedWorktrees.delete(removed.path);
        return result.stdout;
    };
    const gitPatchWriter = async (args, cwd, destination, signal, onDestinationOpened) => {
        if (args[0] !== 'diff')
            throw new Error('llm patch writer only accepts a Git diff');
        const argv = command(args);
        await preflight(cwd, signal);
        // spawnCapture owns exclusive creation, complete streaming, and settlement of this file.
        // Preserve its finalize error so the bridge can retain the correct cleanup ownership.
        const result = await exec.spawnCapture(executable, argv, {
            cwd, timeoutMs: TIMEOUT_MS, env, stdoutFile: destination,
            ...(signal ? { signal } : {}),
            ...(onDestinationOpened ? { onStdoutFileOpened: onDestinationOpened } : {}),
        });
        if (result.termination !== 'exit' || result.code !== 0 || result.stdoutRedirected !== true) {
            throw new Error('llm Git patch streaming did not complete');
        }
    };
    return { git, gitPatchWriter };
}