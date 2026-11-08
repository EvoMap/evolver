import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { trustedValidationRuntime } from './trustedValidationRuntime.js';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Not /bin/sh: macOS lets an administrator repoint it at dash or zsh, whose `ulimit -f` units differ from bash.
const SYSTEM_BASH = '/bin/bash';
const SYSTEM_PS = '/bin/ps';
const TRUSTED_SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const OPEN_FILES_LIMIT = 1024;
// Linux hides HOME, /tmp and /run; the macOS counterparts are every account home plus the shared and per-user
// temporary roots. Seatbelt matches canonical paths, so /var/tmp and /System/Volumes/Data aliases resolve here too.
const HIDDEN_READ_SUBPATHS = ['/Users', '/private/tmp', '/private/var/tmp', '/private/var/folders'];
/**
 * Every host path enters through `-D` parameters, never through the profile text, so a checkout path cannot
 * inject SBPL. Seatbelt applies the last matching rule, which lets the narrow allows re-open the checkout,
 * session and runtime inside the broader hidden subpaths.
 */
function seatbeltProfile(ancestorCount, readRootCount, linkCount, writableSource) {
    const ancestors = Array.from({ length: ancestorCount }, (_unused, index) => `(literal (param "ANCESTOR_${index}"))`).join(' ');
    const links = Array.from({ length: linkCount }, (_unused, index) => `(literal (param "LINK_${index}"))`).join(' ');
    const readRoots = Array.from({ length: readRootCount }, (_unused, index) => `(subpath (param "READ_${index}"))`).join(' ');
    return [
        '(version 1)',
        '(deny default)',
        '(allow process-fork)',
        '(allow process-exec)',
        '(allow signal (target same-sandbox))',
        '(allow sysctl-read)',
        '(allow file-read*)',
        `(deny file-read* ${HIDDEN_READ_SUBPATHS.map((path) => `(subpath "${path}")`).join(' ')} (subpath (param "HOME")))`,
        `(allow file-read* (subpath (param "SOURCE")) (subpath (param "SESSION")) (literal (param "RUNTIME")) ${readRoots})`,
        // Runtimes canonicalize their own path and the cwd at startup; lstat on each ancestor must succeed even
        // though listing those directories stays denied.
        ...(ancestorCount + linkCount > 0 ? [`(allow file-read-metadata ${ancestors} ${links})`] : []),
        '(allow file-write* (subpath (param "SESSION")) (literal "/dev/null"))',
        ...(writableSource ? ['(allow file-write* (subpath (param "SOURCE")))'] : []),
        // The account's own terminals are user-owned devices readable by default: reading one steals keystrokes,
        // and the Linux tier hides them behind a private /dev.
        '(deny file-read* file-write* file-ioctl (regex #"^/dev/(tty|pty|cu\\.)"))',
    ].join('\n');
}
// Mirrors the Linux supervisor: stdin is a pipe held by the parent, so EOF without a line means the parent died
// (even by SIGKILL). The guard then kills the process group this shell leads when it was started detached; started
// inside the caller's group it kills only the workload and the shell, never the caller's other processes. The
// workload cannot signal this trusted shell because the profile only allows signals inside the same sandbox.
// RLIMIT_NPROC counts every process of the uid, so the budget is the account's current count plus this tree's share.
const SEATBELT_SUPERVISOR = [
    'cpu="$1"; fsize_kib="$2"; nofile="$3"; nproc="$4"; shift 4',
    'ulimit -t "$cpu" -f "$fsize_kib" -n "$nofile" -u "$nproc" || exit 126',
    'exec 3<&0',
    '"$@" </dev/null 3<&- & workload_pid=$!',
    '(IFS= read -r _ <&3 || kill -KILL -- "-$$" 2>/dev/null || kill -KILL "$workload_pid" "$$") & guard_pid=$!',
    'exec 3<&-',
    'wait "$workload_pid"; status=$?',
    'kill "$guard_pid" 2>/dev/null',
    'wait "$guard_pid" 2>/dev/null',
    'exit "$status"',
].join('\n');
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function properAncestors(path) {
    const out = [];
    for (let current = dirname(path);; current = dirname(current)) {
        out.push(current);
        if (dirname(current) === current)
            return out;
    }
}
function seatbeltPathsAllowed(paths) {
    const { readOnlyRoot, cwd, writableTmpDir, runtime, home } = paths;
    const readRoots = paths.readRoots ?? [];
    const readLinks = paths.readLinks ?? [];
    return [readOnlyRoot, cwd, writableTmpDir, runtime, home, ...readRoots, ...readLinks].every(isAbsolute)
        && readLinks.every((link) => lstatSync(link).isSymbolicLink())
        && readRoots.every((root) => dirname(root) !== root && !pathIsWithin(root, home) && !pathIsWithin(root, writableTmpDir))
        && dirname(readOnlyRoot) !== readOnlyRoot
        && pathIsWithin(readOnlyRoot, cwd)
        && !pathIsWithin(readOnlyRoot, home)
        && !pathIsWithin(readOnlyRoot, writableTmpDir)
        && !pathIsWithin(writableTmpDir, readOnlyRoot);
}
/** Canonical paths matter: Seatbelt matches resolved vnode paths, so /var/tmp must be spelled /private/var/tmp. */
function canonicalSeatbeltPaths(paths) {
    const canonical = {
        readOnlyRoot: realpathSync(paths.readOnlyRoot),
        cwd: realpathSync(paths.cwd),
        writableTmpDir: realpathSync(paths.writableTmpDir),
        runtime: realpathSync(paths.runtime),
        home: realpathSync(paths.home),
        readRoots: (paths.readRoots ?? []).map((root) => realpathSync(root)),
        readLinks: (paths.readLinks ?? []).map((link) => join(realpathSync(dirname(link)), basename(link))),
        ...(paths.writableSource ? { writableSource: true } : {}),
    };
    if (!seatbeltPathsAllowed(canonical))
        throw new Error('seatbelt isolation has conflicting or unsafe paths');
    return canonical;
}
/**
 * Build a per-command session inside the validation scratch directory and the supervised `sandbox-exec` argv.
 * The session is the only writable location and doubles as HOME/TMPDIR, so commands never share state.
 */
function accountProcessCount() {
    const result = spawnSync(SYSTEM_PS, ['-U', String(process.getuid?.() ?? -1), '-o', 'pid='], { encoding: 'utf8', timeout: 5_000, env: {} });
    if (result.status !== 0 || typeof result.stdout !== 'string')
        throw new Error('seatbelt process budget is unavailable');
    return result.stdout.split('\n').filter((line) => line.trim()).length;
}
export function seatbeltCommand(bin, args, requested, limits) {
    const paths = canonicalSeatbeltPaths(requested);
    const processBudget = accountProcessCount() + limits.processes;
    const session = mkdtempSync(join(paths.writableTmpDir, 'session-'));
    try {
        const home = join(session, 'home');
        const tmp = join(session, 'tmp');
        mkdirSync(home);
        mkdirSync(tmp);
        const readRoots = paths.readRoots ?? [];
        const readLinks = paths.readLinks ?? [];
        const ancestors = [...new Set([paths.cwd, paths.readOnlyRoot, session, paths.runtime, ...readRoots, ...readLinks].flatMap(properAncestors))];
        const params = [
            ['HOME', paths.home],
            ['SOURCE', paths.readOnlyRoot],
            ['SESSION', session],
            ['RUNTIME', paths.runtime],
            ...readRoots.map((root, index) => [`READ_${index}`, root]),
            ...readLinks.map((link, index) => [`LINK_${index}`, link]),
            ...ancestors.map((path, index) => [`ANCESTOR_${index}`, path]),
        ].flatMap(([key, value]) => ['-D', `${key}=${value}`]);
        return {
            cmd: SYSTEM_BASH,
            args: [
                '-c', SEATBELT_SUPERVISOR, 'bash',
                String(Math.max(1, Math.ceil(limits.cpuSeconds))), String(Math.floor(limits.fileSizeBytes / 1024)), String(OPEN_FILES_LIMIT),
                String(processBudget),
                SANDBOX_EXEC, '-p', seatbeltProfile(ancestors.length, readRoots.length, readLinks.length, paths.writableSource === true), ...params, bin, ...args,
            ],
            env: { HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
            cwd: paths.cwd,
            cleanup: () => rmSync(session, { recursive: true, force: true }),
        };
    }
    catch (error) {
        rmSync(session, { recursive: true, force: true });
        throw error;
    }
}
/** The real account home, not $HOME: a caller that overrides HOME must not move the secret boundary with it. */
export function accountHome() {
    return userInfo().homedir;
}
// Each check must fail for the right reason: EPERM is Seatbelt, while a successful write would mean the boundary
// is absent even though the command "worked". The network check uses UDP because an unsandboxed send to a closed
// port succeeds, whereas a refused TCP connect looks the same as a denied one under Bun (both ECONNREFUSED).
const PROBE_SOURCE = [
    "const fs = require('node:fs'); const dgram = require('node:dgram'); const os = require('node:os');",
    'const [source, home] = process.argv.slice(1);',
    "const isDenial = (error) => Boolean(error) && error.code === 'EPERM';",
    'const denied = (fn) => { try { fn(); return false; } catch (error) { return isDenial(error); } };',
    "if (!denied(() => fs.writeFileSync(source + '/probe', 'x'))) process.exit(2);",
    'if (!denied(() => fs.readdirSync(home))) process.exit(3);',
    "fs.writeFileSync(os.tmpdir() + '/probe', 'x');",
    'const settle = (error) => process.exit(isDenial(error) ? 0 : 4);',
    "try { const socket = dgram.createSocket('udp4'); socket.on('error', settle); socket.send('x', 9, '127.0.0.1', settle); }",
    'catch (error) { settle(error); }',
].join('\n');
let seatbeltAvailableCache;
/** Proves the generated profile is enforced on this host (network, checkout writes, HOME reads) before trusting it. */
export function seatbeltIsolationAvailable() {
    if (process.platform !== 'darwin')
        return false;
    if (seatbeltAvailableCache !== undefined)
        return seatbeltAvailableCache;
    if (![SANDBOX_EXEC, SYSTEM_BASH, SYSTEM_PS].every((path) => existsSync(path))) {
        seatbeltAvailableCache = false;
        return false;
    }
    let probeRoot;
    const cleanups = [];
    try {
        probeRoot = mkdtempSync('/var/tmp/evolver-seatbelt-probe-');
        const source = join(probeRoot, 'source');
        const scratch = join(probeRoot, 'scratch');
        mkdirSync(source);
        mkdirSync(scratch);
        const home = accountHome();
        const runtime = trustedValidationRuntime(PROBE_SOURCE, [realpathSync(source), realpathSync(home)]);
        cleanups.push(runtime.cleanup);
        const launch = seatbeltCommand(runtime.cmd, runtime.args, {
            readOnlyRoot: source, cwd: source, writableTmpDir: scratch, runtime: process.execPath, home,
        }, { cpuSeconds: 5, fileSizeBytes: 1024 * 1024, processes: 8 });
        cleanups.push(launch.cleanup);
        seatbeltAvailableCache = spawnSync(launch.cmd, launch.args, {
            cwd: launch.cwd,
            env: { PATH: TRUSTED_SYSTEM_PATH, ...launch.env, ...runtime.env },
            input: '\n',
            timeout: 5_000,
            stdio: ['pipe', 'ignore', 'ignore'],
        }).status === 0;
    }
    catch {
        seatbeltAvailableCache = false;
    }
    finally {
        for (const cleanup of cleanups) {
            try {
                cleanup();
            }
            catch {
                seatbeltAvailableCache = false;
            }
        }
        if (probeRoot) {
            try {
                rmSync(probeRoot, { recursive: true, force: true });
            }
            catch {
                seatbeltAvailableCache = false;
            }
        }
    }
    return seatbeltAvailableCache;
}