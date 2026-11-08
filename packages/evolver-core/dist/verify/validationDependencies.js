import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { editableImportRoots } from './editableInstalls.js';
const MAX_PACKAGE_DEPTH = 8;
// Tool scratch and caches, not dependencies: mirroring them would point the copy's writes back at the source.
const TOOL_CACHE_ENTRIES = new Set(['.cache', '.vite', '.vite-temp', '.vitest']);
const MAX_PACKAGE_DIRS = 512;
const BUILD_OUTPUT_EXTENSIONS = new Set(['.py', '.pyi', '.so', '.pyd']);
const MAX_BUILD_OUTPUTS = 4096;
const MAX_BUILD_OUTPUT_BYTES = 512 * 1024 ** 2;
const GIT_TIMEOUT_MS = 10_000;
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function isDirectory(path) {
    try {
        return lstatSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** Package directories tracked in the copy; dot directories and installed trees are never descended into. */
function packageDirs(copyRoot) {
    const found = [];
    const visit = (dir, depth) => {
        if (found.length >= MAX_PACKAGE_DIRS || depth > MAX_PACKAGE_DEPTH)
            return;
        if (existsSync(join(dir, 'package.json')))
            found.push(relative(copyRoot, dir));
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
                visit(join(dir, entry.name), depth + 1);
        }
    };
    visit(copyRoot, 0);
    return found;
}
/**
 * Mirror one entry: a symlink keeps its own target text so workspace links (`../../packages/x`) resolve inside the
 * copy, while a real package becomes an absolute link into the source's read-only tree.
 */
function mirrorEntry(source, target) {
    if (lstatSync(source).isSymbolicLink())
        symlinkSync(readlinkSync(source), target);
    else
        symlinkSync(realpathSync(source), target);
}
function shadowNodeModules(source, target) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (TOOL_CACHE_ENTRIES.has(entry.name))
            continue;
        const from = join(source, entry.name);
        const to = join(target, entry.name);
        if (entry.name.startsWith('@') && entry.isDirectory()) {
            mkdirSync(to);
            for (const scoped of readdirSync(from))
                mirrorEntry(join(from, scoped), join(to, scoped));
        }
        else {
            mirrorEntry(from, to);
        }
    }
}
function gitEnvironment() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    return { ...env, GIT_TERMINAL_PROMPT: '0' };
}
/**
 * Untracked files git ignores beneath `roots`; an ignored directory is reported once with a trailing slash. A source
 * that is not a git checkout has nothing to tell apart; any other failure is an error, not an empty listing.
 */
function ignoredEntries(source, roots) {
    // A checkout's own fsmonitor hook would otherwise run a configured program on this listing.
    const result = spawnSync('git', ['-C', source, '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--others', '--ignored',
        '--exclude-standard', '--directory', '--', ...roots.map((root) => root || '.')], {
        encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...gitEnvironment(), LC_ALL: 'C' }, windowsHide: true, maxBuffer: 64 * 1024 ** 2,
    });
    if (result.status === 0)
        return result.stdout.split('\0').filter(Boolean);
    if (!result.error && result.status === 128 && /not a git repository/.test(result.stderr))
        return [];
    throw new Error('validation_dependency_build_outputs_unavailable', { cause: result.error ?? result.stderr });
}
/**
 * Files an editable install generated into its sources (setuptools_scm's `_version.py`, compiled extensions) are
 * git-ignored, so the recorded copy lacks them. Only Python artifacts inside a package are taken: an ignored
 * `.env` or settings file at a project root stays out of the copy.
 */
function editableBuildOutputs(venv, source, copy) {
    const roots = editableImportRoots(venv, source);
    if (roots.length === 0)
        return [];
    return ignoredEntries(source, roots).filter((entry) => !entry.endsWith('/')
        && BUILD_OUTPUT_EXTENSIONS.has(extname(entry))
        && existsSync(join(copy, dirname(entry), '__init__.py'))
        && !existsSync(join(copy, entry))
        && lstatSync(join(source, entry)).isFile());
}
function copyBuildOutputs(venv, source, copy, created) {
    const outputs = editableBuildOutputs(venv, source, copy);
    const bytes = outputs.reduce((sum, entry) => sum + lstatSync(join(source, entry)).size, 0);
    if (outputs.length > MAX_BUILD_OUTPUTS || bytes > MAX_BUILD_OUTPUT_BYTES)
        throw new Error('validation_dependency_build_outputs_too_large');
    for (const entry of outputs) {
        const target = join(copy, entry);
        if (!pathIsWithin(copy, realpathSync(dirname(target))))
            throw new Error('validation_dependency_links_escaped_copy');
        copyFileSync(join(source, entry), target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        created.push(owned(target));
    }
}
function owned(path) {
    const { dev, ino } = lstatSync(path);
    return { path, dev, ino };
}
/**
 * A writable copy lets the workload swap a parent directory for a symlink, even between a check and a removal, so
 * the entry is first moved, in one step, to a name directly in the copy root, which the workload cannot redirect,
 * and removed there only if it is still the very entry this run created; anything else is moved back untouched.
 */
function removeOwned(copy, entry) {
    if (!pathIsWithin(copy, realpathSync(dirname(entry.path))))
        throw new Error('validation_dependency_links_escaped_copy');
    const trash = join(copy, `.evolver-cleanup-${randomUUID()}`);
    renameSync(entry.path, trash);
    const moved = lstatSync(trash);
    if (moved.dev !== entry.dev || moved.ino !== entry.ino) {
        renameSync(trash, entry.path);
        throw new Error('validation_dependency_links_escaped_copy');
    }
    rmSync(trash, { recursive: true, force: true });
}
export function provideValidationDependencies(sourceRoot, copyRoot) {
    const source = realpathSync(sourceRoot);
    const copy = realpathSync(copyRoot);
    const created = [];
    const readRoots = [];
    let venvRoot;
    const cleanup = () => {
        const errors = [];
        for (let index = created.length - 1; index >= 0; index--) {
            try {
                removeOwned(copy, created[index]);
                created.splice(index, 1);
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, 'validation_dependency_cleanup_failed', { cause: errors[0] });
    };
    if (source === copy)
        return { readRoots, cleanup };
    try {
        for (const dir of packageDirs(copy)) {
            const from = join(source, dir, 'node_modules');
            const to = join(copy, dir, 'node_modules');
            if (!isDirectory(from) || existsSync(to))
                continue;
            const dependencyRoot = realpathSync(from);
            if (!pathIsWithin(source, dependencyRoot) || dependencyRoot === source) {
                throw new Error('validation_dependency_source_escaped_checkout');
            }
            mkdirSync(to);
            created.push(owned(to));
            shadowNodeModules(dependencyRoot, to);
            readRoots.push(dependencyRoot);
        }
        const venv = join(source, '.venv');
        const venvTarget = join(copy, '.venv');
        if (isDirectory(venv) && !existsSync(venvTarget)) {
            venvRoot = realpathSync(venv);
            if (venvRoot !== venv)
                throw new Error('validation_dependency_source_escaped_checkout');
            symlinkSync(venvRoot, venvTarget);
            created.push(owned(venvTarget));
            readRoots.push(venvRoot);
            copyBuildOutputs(venvRoot, source, copy, created);
        }
    }
    catch (error) {
        try {
            cleanup();
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'validation_dependency_setup_and_cleanup_failed', { cause: error });
        }
        throw error;
    }
    return { readRoots, ...(venvRoot ? { venvRoot } : {}), cleanup };
}