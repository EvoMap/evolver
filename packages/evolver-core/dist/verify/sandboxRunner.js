// Hardened sandbox CommandRunner (ported from v1 src/gep/validator/sandboxExecutor.js). Fills the
// CommandRunner seam in validation.ts so the validator role can actually EXECUTE validation commands
// (e.g. `node test.js`) to verify an evolution — safely, without trusting the caller. The executable
// allowlist stays data-driven in the ValidationPlan (runValidation checks it before calling this); this
// module hardens EXECUTION: blocked node eval-flags, shell-metachar rejection, a fresh wiped temp cwd,
// a scrubbed env (no secrets leak in), and a SIGKILL timeout. Output is folded + truncated.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isNodeExecutable, nodeFlagViolation, SHELL_METACHARS } from './validation.js';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const CGROUP_ROOT = '/sys/fs/cgroup';
const TRUSTED_SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const SYSTEM_SH = '/bin/sh';
const SYSTEM_UNSHARE = ['/usr/bin/unshare', '/bin/unshare'].find((path) => existsSync(path)) ?? '/usr/bin/unshare';
const RESOURCE_LIMITS = {
    memoryBytes: 1024 * 1024 * 1024,
    processes: 64,
    cpuQuota: '100000 100000',
    scratchBytes: 256 * 1024 * 1024,
};
// Env scrub: only these keys reach the child, so node-secrets/tokens in the parent env cannot leak into validation.
const DEFAULT_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'];
/** Credential dirs hidden under $HOME when hideHomeSecrets is set (dirs only — never where binaries live). */
const SECRET_HOME_DIRS = ['.evomap', '.ssh', '.aws', '.gnupg', '.docker', '.kube'];
// Fixed setup run inside the mount ns: tmpfs over each existing secret dir, then exec the command. The command
// is passed as POSITIONAL args (`exec "$@"`), never interpolated into the script — no shell-injection vector.
const HIDE_SECRETS_SETUP = `PATH=${TRUSTED_SYSTEM_PATH}; export PATH; for d in ${SECRET_HOME_DIRS.map((d) => `"$HOME/${d}"`).join(' ')}; do if [ -d "$d" ]; then mount -t tmpfs none "$d" 2>/dev/null || exit 126; fi; done`;
const READ_ONLY_FILESYSTEM_SETUP = [
    `PATH=${TRUSTED_SYSTEM_PATH}; export PATH`,
    'session_tmp="$1"; shift',
    'validation_root="$1"; shift',
    'validation_cwd="$1"; shift',
    'host_bin="$1"; shift',
    '[ -n "$HOME" ] && [ "$HOME" != / ] && [ -d "$HOME" ] || exit 126',
    'case "$validation_cwd/" in "$validation_root/"*) ;; *) exit 126 ;; esac',
    'case "$HOME/" in "$validation_root/"*) exit 126 ;; esac',
    `mount -t tmpfs -o size=${RESOURCE_LIMITS.scratchBytes},nr_inodes=65536 none "$session_tmp" 2>/dev/null || exit 126`,
    'mkdir -p "$session_tmp/source" "$session_tmp/home" || exit 126',
    'mkdir -p "$session_tmp/dev" || exit 126',
    ': > "$session_tmp/node" || exit 126',
    'mount --bind "$validation_root" "$session_tmp/source" 2>/dev/null || exit 126',
    'mount --bind "$host_bin" "$session_tmp/node" 2>/dev/null || exit 126',
    'for device in null zero random urandom; do : > "$session_tmp/dev/$device" || exit 126; mount --bind "/dev/$device" "$session_tmp/dev/$device" 2>/dev/null || exit 126; done',
    'mount -t tmpfs none "$HOME" 2>/dev/null || exit 126',
    '[ ! -d /run ] || mount -t tmpfs none /run 2>/dev/null || exit 126',
    'mount -t tmpfs none /tmp 2>/dev/null || exit 126',
    'mkdir -p "$validation_root" || exit 126',
    'mount --bind "$session_tmp/source" "$validation_root" 2>/dev/null || exit 126',
    'mounts="$(findmnt -rn -o TARGET -R /)" || exit 126',
    '[ -n "$mounts" ] || exit 126',
    'printf "%s\\n" "$mounts" | while IFS= read -r target; do mount -o remount,bind,ro "$target" 2>/dev/null || exit 126; done || exit 126',
    'mount -o remount,bind,rw,exec "$session_tmp" 2>/dev/null || exit 126',
    'mount -t tmpfs -o mode=755,size=65536,nr_inodes=64 none /dev 2>/dev/null || exit 126',
    'for device in null zero random urandom; do : > "/dev/$device" || exit 126; mount --bind "$session_tmp/dev/$device" "/dev/$device" 2>/dev/null || exit 126; done',
    'mount -o remount,ro /dev 2>/dev/null || exit 126',
    'mount --rbind "$session_tmp" /tmp 2>/dev/null || exit 126',
    'cd "$validation_cwd" || exit 126',
    'export HOME=/tmp/home TMPDIR=/tmp TMP=/tmp TEMP=/tmp',
].join('; ');
const DROP_NAMESPACE_PRIVILEGES = [
    'supervisor_pid=$$',
    'exec 3<&0',
    'setpriv --no-new-privs --securebits=+noroot,+noroot_locked --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- /tmp/node "$@" </dev/null 3<&- & workload_pid=$!',
    // The pipe is owned by the parent Node process. Kernel EOF is therefore a reliable parent-death signal,
    // including SIGKILL, while unshare --kill-child propagates supervisor death through the PID namespace.
    '(IFS= read -r _ <&3 || kill -KILL "$supervisor_pid") & watchdog_pid=$!',
    'exec 3<&-',
    'wait "$workload_pid"; status=$?',
    'kill "$watchdog_pid" 2>/dev/null || true',
    'wait "$watchdog_pid" 2>/dev/null || true',
    'exit "$status"',
].join('; ');
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function currentCgroupPath() {
    const entry = readFileSync('/proc/self/cgroup', 'utf8')
        .split(/\r?\n/)
        .find((line) => line.startsWith('0::'));
    if (!entry)
        return null;
    const relativePath = entry.slice(3).replace(/^\/+/, '');
    const path = resolve(CGROUP_ROOT, relativePath);
    return pathIsWithin(CGROUP_ROOT, path) ? path : null;
}
/** Configure an already-created cgroup. Kept separate so limit values are testable without resource exhaustion. */
export function configureSandboxResourceGroup(path) {
    try {
        const required = ['cgroup.procs', 'cgroup.kill', 'memory.max', 'memory.swap.max', 'memory.oom.group', 'pids.max', 'cpu.max'];
        if (!required.every((name) => existsSync(join(path, name))))
            return false;
        writeFileSync(join(path, 'memory.max'), String(RESOURCE_LIMITS.memoryBytes));
        writeFileSync(join(path, 'memory.swap.max'), '0');
        writeFileSync(join(path, 'memory.oom.group'), '1');
        writeFileSync(join(path, 'pids.max'), String(RESOURCE_LIMITS.processes));
        writeFileSync(join(path, 'cpu.max'), RESOURCE_LIMITS.cpuQuota);
        return true;
    }
    catch {
        return false;
    }
}
/** Allocate a delegated cgroup v2 for one validation command. Returns null unless every limit is enforceable. */
export function createSandboxResourceGroup() {
    if (process.platform !== 'linux' || !existsSync(join(CGROUP_ROOT, 'cgroup.controllers')))
        return null;
    let path = null;
    try {
        const parent = currentCgroupPath();
        if (!parent)
            return null;
        path = join(parent, `evolver-validation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        mkdirSync(path, { mode: 0o700 });
        if (!configureSandboxResourceGroup(path))
            throw new Error('required cgroup v2 controllers are not delegated');
        let cleaned = false;
        return {
            procsFile: join(path, 'cgroup.procs'),
            cleanup: () => {
                if (cleaned)
                    return;
                cleaned = true;
                try {
                    writeFileSync(join(path, 'cgroup.kill'), '1');
                }
                catch { /* already empty or removed */ }
                try {
                    rmdirSync(path);
                }
                catch { /* kernel may release the empty group asynchronously */ }
            },
        };
    }
    catch {
        if (path) {
            try {
                writeFileSync(join(path, 'cgroup.kill'), '1');
            }
            catch { /* best effort */ }
            try {
                rmdirSync(path);
            }
            catch { /* best effort */ }
        }
        return null;
    }
}
/** Join the cgroup before exec, so attacker-controlled code never runs outside the aggregate resource budget. */
export function resourceLimitedCommand(cmd, args, procsFile) {
    const setup = 'printf "%s" "$$" > "$1" || exit 126; shift; exec "$@"';
    return { cmd: SYSTEM_SH, args: ['-c', setup, 'sh', procsFile, cmd, ...args] };
}
export function sandboxResourceLimitsAvailable() {
    const group = createSandboxResourceGroup();
    if (!group)
        return false;
    group.cleanup();
    return true;
}
/** Wrap an (executable,args) in unprivileged namespaces per the requested isolation (pure — testable). */
export function isolationCommand(bin, args, opts) {
    if (opts.readOnlyFilesystem && !opts.writableTmpDir) {
        throw new Error('read-only filesystem isolation requires writableTmpDir');
    }
    if (opts.readOnlyFilesystem && (!opts.readOnlyRoot || !opts.cwd)) {
        throw new Error('read-only filesystem isolation requires readOnlyRoot and cwd');
    }
    const flags = ['-r'];
    if (opts.hideHomeSecrets || opts.readOnlyFilesystem)
        flags.push('-m');
    if (opts.noNetwork)
        flags.push('-n');
    if (opts.readOnlyFilesystem)
        flags.push('-p', '-i', '-u');
    if (!opts.noNetwork && !opts.hideHomeSecrets && !opts.readOnlyFilesystem)
        return { cmd: bin, args: [...args] };
    const base = [...flags, '--fork', '--kill-child', ...(opts.readOnlyFilesystem ? ['--mount-proc'] : []), '--'];
    const setup = [
        ...(opts.hideHomeSecrets && !opts.readOnlyFilesystem ? [HIDE_SECRETS_SETUP] : []),
        ...(opts.readOnlyFilesystem ? [READ_ONLY_FILESYSTEM_SETUP] : []),
        opts.readOnlyFilesystem ? DROP_NAMESPACE_PRIVILEGES : 'exec "$@"',
    ].join('; ');
    // Mount setup needs a launcher (sh runs the FIXED script then exec "$@"); net-only needs no shell.
    return opts.hideHomeSecrets || opts.readOnlyFilesystem
        ? {
            cmd: SYSTEM_UNSHARE,
            args: [...base, SYSTEM_SH, '-c', setup, 'sh', ...(opts.readOnlyFilesystem
                    ? [opts.writableTmpDir, opts.readOnlyRoot, opts.cwd]
                    : []), bin, ...args],
        }
        : { cmd: SYSTEM_UNSHARE, args: [...base, bin, ...args] };
}
let unshareCache;
/** Whether unprivileged user+mount+net namespaces (`unshare -r -m -n`) work here (cached) — covers both isolation modes. */
export function unshareNetAvailable() {
    if (unshareCache === undefined) {
        try {
            unshareCache = spawnSync(SYSTEM_UNSHARE, ['-r', '-m', '-n', 'true'], {
                env: { PATH: TRUSTED_SYSTEM_PATH },
                timeout: 5000,
            }).status === 0;
        }
        catch {
            unshareCache = false;
        }
    }
    return unshareCache;
}
function parse(cmd) {
    const tokens = cmd.trim().split(/\s+/).filter(Boolean);
    return { executable: tokens[0] ?? '', args: tokens.slice(1) };
}
function scrubEnv(allow) {
    const out = {};
    for (const k of allow) {
        const v = process.env[k];
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
/**
 * Build a hardened CommandRunner. The executable allowlist is the ValidationPlan's job (runValidation);
 * this only hardens how an allowed command runs.
 */
export function makeSandboxRunner(opts = {}) {
    const timeout = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const envAllow = opts.envAllowKeys ?? DEFAULT_ENV_ALLOW;
    return (cmd) => new Promise((resolve) => {
        const deny = (msg, code = 126) => resolve({ exitCode: code, stdout: `[sandbox] ${msg}` });
        const { executable, args } = parse(cmd);
        if (!executable)
            return deny('empty command', 1);
        if (SHELL_METACHARS.test(cmd))
            return deny('rejected: shell metacharacter (no shell is provided; split compound commands)');
        const badFlag = nodeFlagViolation(executable, args);
        if (badFlag)
            return deny(`rejected: blocked node flag ${badFlag}`);
        // Isolation (#26): fail-safe — if we can't actually create the namespaces, refuse rather than run un-isolated.
        if ((opts.noNetwork || opts.hideHomeSecrets || opts.readOnlyFilesystem) && !(opts.unshareCheck ?? unshareNetAvailable)()) {
            return deny('rejected: requested namespace isolation is unavailable');
        }
        const resourceGroup = opts.resourceLimits
            ? (opts.resourceGroupFactory ?? createSandboxResourceGroup)()
            : null;
        if (opts.resourceLimits && !resourceGroup)
            return deny('rejected: cgroup v2 resource limits are unavailable');
        const ownTemp = !opts.cwd;
        let cwd;
        try {
            cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'evo-sbx-'));
        }
        catch (e) {
            resourceGroup?.cleanup();
            return deny(`temp dir failed: ${e instanceof Error ? e.message : 'err'}`, 1);
        }
        let cleaned = false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            resourceGroup?.cleanup();
            if (ownTemp) {
                try {
                    rmSync(cwd, { recursive: true, force: true });
                }
                catch { /* best effort */ }
            }
        };
        // Resolve 'node' to the running binary so spawn(shell:false) works on Windows too (where bare 'node' would ENOENT).
        const bin = isNodeExecutable(executable) ? process.execPath : executable;
        try {
            const { cmd: spawnCmd, args: spawnArgs } = isolationCommand(bin, args, {
                noNetwork: opts.noNetwork,
                hideHomeSecrets: opts.hideHomeSecrets,
                readOnlyFilesystem: opts.readOnlyFilesystem,
                writableTmpDir: opts.writableTmpDir,
                readOnlyRoot: opts.readOnlyRoot ?? cwd,
                cwd,
            });
            const env = scrubEnv(envAllow);
            if (opts.noNetwork || opts.hideHomeSecrets || opts.readOnlyFilesystem || opts.resourceLimits) {
                env['PATH'] = TRUSTED_SYSTEM_PATH;
            }
            if (opts.readOnlyFilesystem) {
                Object.assign(env, { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' });
            }
            const limited = resourceGroup ? resourceLimitedCommand(spawnCmd, spawnArgs, resourceGroup.procsFile) : { cmd: spawnCmd, args: spawnArgs };
            const child = spawn(limited.cmd, limited.args, {
                shell: false,
                cwd,
                env,
                timeout,
                killSignal: 'SIGKILL',
                stdio: [opts.readOnlyFilesystem ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });
            let out = '';
            const cap = (d) => { if (out.length < MAX_OUTPUT_CHARS)
                out += String(d); };
            child.stdout?.on('data', cap);
            child.stderr?.on('data', cap);
            child.on('error', (err) => { cleanup(); resolve({ exitCode: 127, stdout: `[sandbox] spawn error: ${err.message}` }); });
            child.on('close', (code, signal) => { cleanup(); resolve({ exitCode: code ?? (signal ? 137 : 1), stdout: out.slice(0, MAX_OUTPUT_CHARS) }); });
        }
        catch (e) {
            cleanup();
            resolve({ exitCode: 127, stdout: `[sandbox] spawn failed: ${e instanceof Error ? e.message : 'err'}` });
        }
    });
}