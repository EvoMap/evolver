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
import { classifyNodeValidationInvocation, isNodeExecutable, nodeFlagViolation, SHELL_METACHARS, tokenizeValidationCommand, } from './validation.js';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;
const PROCESS_TREE_EXIT_WAIT_MS = 5_000;
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
    const tokens = tokenizeValidationCommand(cmd);
    if (!tokens)
        return null;
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
 * 终止完整的验证进程树，而不只是启动器。POSIX 启动器会独立成组，
 * 可以安全地按进程组寻址；Windows 没有可移植的 Node API，因此使用受信任的
 * System32 taskkill，并在该工具不可用时保留直接子进程兜底。
 */
function terminateProcessTree(child) {
    const pid = child.pid;
    if (pid === undefined)
        return;
    if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
        const taskkill = systemRoot && isAbsolute(systemRoot)
            ? join(systemRoot, 'System32', 'taskkill.exe')
            : undefined;
        if (taskkill && existsSync(taskkill)) {
            try {
                const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
                    shell: false,
                    windowsHide: true,
                    stdio: 'ignore',
                    timeout: PROCESS_TREE_KILL_TIMEOUT_MS,
                });
                if (result.status === 0)
                    return;
            }
            catch {
                // 回退到下面的直接子进程终止；命令结果仍保持 fail-closed。
            }
        }
        try {
            child.kill('SIGKILL');
        }
        catch { /* 尽力终止；最终失败状态仍由 close/error 决定 */ }
        return;
    }
    // 负 PID 指向 detached 进程组；若子进程未能成为组长，下面的直接终止仍是兜底。
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch { /* 进程组不存在或已退出 */ }
    try {
        if (!child.killed)
            child.kill('SIGKILL');
    }
    catch { /* 尽力终止 */ }
}
function processTreeExists(pid) {
    try {
        process.kill(process.platform === 'win32' ? pid : -pid, 0);
        return true;
    }
    catch (error) {
        // EPERM 说明进程仍存在但当前用户暂时没有查询权限；不能把它当成已退出，
        // 否则取消结果可能在后代仍运行时提前返回。
        return error?.code === 'EPERM';
    }
}
/** 取消后短暂等待，确保后代进程不会在 runner 返回成功解析后继续存活。 */
async function waitForProcessTreeExit(pid) {
    if (pid === undefined)
        return;
    const deadline = Date.now() + PROCESS_TREE_EXIT_WAIT_MS;
    while (Date.now() < deadline && processTreeExists(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
/**
 * Build a hardened CommandRunner. The executable allowlist is the ValidationPlan's job (runValidation);
 * this only hardens how an allowed command runs.
 */
export function makeSandboxRunner(opts = {}) {
    const timeout = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const envAllow = opts.envAllowKeys ?? DEFAULT_ENV_ALLOW;
    return (cmd, signal) => new Promise((resolve) => {
        const activeSignal = signal ?? opts.signal;
        let settled = false;
        let aborted = false;
        let timedOut = false;
        let terminationStarted = false;
        let timeoutTimer;
        let removeAbortListener = () => { };
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            removeAbortListener();
            resolve(result);
        };
        const deny = (msg, code = 126) => finish({ exitCode: code, stdout: `[sandbox] ${msg}` });
        if (activeSignal?.aborted)
            return deny('cancelled', 130);
        const parsed = parse(cmd);
        if (!parsed)
            return deny('invalid command syntax', 1);
        const { executable, args } = parsed;
        if (!executable)
            return deny('empty command', 1);
        if (isNodeExecutable(executable) && (args.length === 0 || (args.length === 1 && args[0] === '--'))) {
            return deny('rejected: node script is required');
        }
        if (SHELL_METACHARS.test(cmd))
            return deny('rejected: shell metacharacter (no shell is provided; split compound commands)');
        const badFlag = nodeFlagViolation(executable, args);
        if (badFlag)
            return deny(`rejected: blocked node flag ${badFlag}`);
        if (isNodeExecutable(executable)) {
            const invocation = classifyNodeValidationInvocation(executable, args);
            if (invocation.kind === 'invalid') {
                return invocation.option
                    ? deny(`rejected: unsupported node option ${invocation.option}`)
                    : deny('rejected: node script is required');
            }
        }
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
            if (timeoutTimer !== undefined)
                clearTimeout(timeoutTimer);
            removeAbortListener();
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
                // POSIX 依靠 detached 进程组执行整树终止；Windows 的 taskkill 直接沿父子树追踪，保持启动器附着可
                // 避免兜底终止时产生孤儿进程。
                detached: process.platform !== 'win32',
                windowsHide: true,
                stdio: [opts.readOnlyFilesystem ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });
            let childClosed = false;
            let out = '';
            const cap = (d) => { if (out.length < MAX_OUTPUT_CHARS)
                out += String(d); };
            child.stdout?.on('data', cap);
            child.stderr?.on('data', cap);
            const complete = async (result) => {
                if (terminationStarted)
                    await waitForProcessTreeExit(child.pid);
                cleanup();
                finish(result);
            };
            // 先注册生命周期处理器，再暴露 AbortSignal 监听器，堵住快速命令退出后 runner 尚未观察 close
            // 事件、调用方却已经 abort 的竞态窗口。
            child.on('error', (err) => {
                childClosed = true;
                void complete({ exitCode: aborted ? 130 : timedOut ? 137 : 127, stdout: `[sandbox] spawn error: ${err.message}` });
            });
            child.on('close', (code, childSignal) => {
                childClosed = true;
                void complete({
                    exitCode: aborted ? 130 : timedOut ? 137 : code ?? (childSignal ? 137 : 1),
                    stdout: out.slice(0, MAX_OUTPUT_CHARS),
                });
            });
            const terminate = (reason) => {
                // close 事件等待继承的 stdio 句柄时，exitCode 可能已经设置。必须持续启用整树终止直到观察到
                // close，否则快速退出的启动器可能留下仍在运行的后代进程。
                if (terminationStarted || childClosed)
                    return;
                terminationStarted = true;
                aborted = reason === 'abort';
                timedOut = reason === 'timeout';
                resourceGroup?.cleanup();
                terminateProcessTree(child);
            };
            const onAbort = () => terminate('abort');
            if (activeSignal) {
                removeAbortListener = () => activeSignal.removeEventListener('abort', onAbort);
                if (activeSignal.aborted)
                    onAbort();
                else
                    activeSignal.addEventListener('abort', onAbort, { once: true });
            }
            timeoutTimer = timeout > 0 ? setTimeout(() => terminate('timeout'), timeout) : undefined;
            timeoutTimer?.unref?.();
        }
        catch (e) {
            cleanup();
            finish({ exitCode: 127, stdout: `[sandbox] spawn failed: ${e instanceof Error ? e.message : 'err'}` });
        }
    });
}