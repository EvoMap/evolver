import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exec } from '@evomap/evolver-core';
const GIT_TIMEOUT_MS = 60_000;
const GIT_POINTER_MAX_BYTES = 8192;
const GIT_CONFIG_MAX_BYTES = 1024 * 1024;
const PATCH_REJECTION = /^error: (?:patch failed: .+|.+: patch does not apply|binary patch does not apply to '.+'|corrupt patch at line \d+|No valid patches in input \(allow with "--allow-empty"\))$/;
const SAFE_GIT_OPTIONS = [
    '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false',
    '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
];
export class RecordedTreeMismatch extends Error {
}
function inside(root, path) {
    const name = relative(root, path);
    return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}
function hostGit(root, env) {
    const executable = process.platform === 'win32' ? 'git.exe' : 'git';
    for (const directory of env['PATH']?.split(delimiter) ?? []) {
        if (!isAbsolute(directory))
            continue;
        try {
            const file = realpathSync.native(join(directory, executable));
            if (inside(root, file) || !statSync(file).isFile())
                continue;
            accessSync(file, constants.X_OK);
            return file;
        }
        catch { /* Look for the next native Git on the daemon PATH. */ }
    }
    throw new Error('curation Git executable unavailable outside source checkout');
}
function readGitFile(path, limit) {
    let original;
    try {
        original = lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    if (!original.isFile() || original.size >= limit)
        throw new Error('invalid curation Git metadata');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.dev !== original.dev || stat.ino !== original.ino || stat.size !== original.size) {
            throw new Error('curation Git metadata changed');
        }
        const bytes = Buffer.alloc(stat.size + 1);
        const count = readSync(fd, bytes, 0, bytes.length, 0);
        if (count !== stat.size)
            throw new Error('curation Git metadata changed');
        return bytes.subarray(0, count);
    }
    finally {
        closeSync(fd);
    }
}
function readGitPointer(path, prefix) {
    const bytes = readGitFile(path, GIT_POINTER_MAX_BYTES);
    if (bytes === undefined)
        return undefined;
    const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
    if (!line.startsWith(prefix) || line.length <= prefix.length || /[\0\r\n]/.test(line)) {
        throw new Error('invalid curation Git pointer');
    }
    return line.slice(prefix.length);
}
function sourceGitDirectory(root) {
    const dotGit = join(root, '.git');
    const gitDir = lstatSync(dotGit).isDirectory() ? dotGit : resolve(root, readGitPointer(dotGit, 'gitdir: ') ?? '');
    if (gitDir === root)
        throw new Error('curation Git directory unavailable');
    const common = readGitPointer(join(gitDir, 'commondir'), '');
    return realpathSync.native(common === undefined ? gitDir : resolve(gitDir, common));
}
function rejectsRecordedTree(args, diagnostic) {
    if (args[0] === 'rev-parse')
        return diagnostic === 'fatal: Needed a single revision';
    return args[0] === 'apply' && diagnostic.split(/\r?\n/).every((line) => PATCH_REJECTION.test(line));
}
function gitRunner(bin, env) {
    return (args, cwd, input) => new Promise((resolve, reject) => {
        const child = execFile(bin, [...SAFE_GIT_OPTIONS, ...args], {
            cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', env,
        }, (error, stdout, stderr) => {
            const diagnostic = stderr.trim();
            if (!error || (args[0] === 'config' && error.code === 1 && !diagnostic)) {
                resolve(stdout.trim());
                return;
            }
            const mismatch = typeof error.code === 'number' && !error.killed && !error.signal && rejectsRecordedTree(args, diagnostic);
            reject(mismatch ? new RecordedTreeMismatch('recorded Git tree mismatch') : error);
        });
        if (input !== undefined)
            child.stdin?.on('error', () => { }).end(input);
    });
}
/** All checkout and patch operations use our own config and index, even for a linked source worktree. */
export async function createRecordedCheckout(context, parent) {
    const root = realpathSync.native(context.root);
    const gitDir = sourceGitDirectory(root);
    const objects = realpathSync.native(join(gitDir, 'objects'));
    if (!statSync(objects).isDirectory() || /[\0\r\n]/.test(objects))
        throw new Error('invalid curation Git object directory');
    const nullDevice = '/dev/null';
    const env = {
        ...exec.scrubAgentEnv(process.env),
        LC_ALL: 'C', LANGUAGE: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_GLOBAL: nullDevice,
        GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
        // An explicit ceiling keeps the metadata-only config command outside any ancestor repository.
        GIT_CEILING_DIRECTORIES: parent,
    };
    const git = gitRunner(hostGit(root, env), env);
    const sourceConfig = readGitFile(join(gitDir, 'config'), GIT_CONFIG_MAX_BYTES);
    if (!sourceConfig)
        throw new Error('curation Git config unavailable');
    const configured = await git(['config', '--file', '-', '--no-includes', '--get', 'extensions.objectFormat'], parent, sourceConfig);
    const format = configured || 'sha1';
    if (format !== 'sha1' && format !== 'sha256')
        throw new Error('unsupported curation Git object format');
    const copy = join(parent, 'tree');
    await git(['init', '--quiet', '--template=', `--object-format=${format}`, '--', copy], parent);
    // Git reads alternate objects but writes all local metadata and new objects to the disposable repository.
    // Only tracked attributes can select built-in checkout conversions; the source's filter config is absent.
    const objectPath = process.platform === 'win32' ? objects.replaceAll('\\', '/') : objects;
    writeFileSync(join(copy, '.git', 'objects', 'info', 'alternates'), `${objectPath}\n`, { flag: 'wx', mode: 0o600 });
    const commit = await git(['rev-parse', '--verify', '--end-of-options', `${context.head}^{commit}`], copy);
    await git(['checkout', '--quiet', '--detach', commit], copy);
    if (context.diff)
        await git(['apply', '--whitespace=nowarn', '-'], copy, context.diff);
    return copy;
}