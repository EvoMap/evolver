// The runner layer of the exec bridge (#66, split out per #91 item 6): how to spawn a coding-agent CLI
// shell-free, the per-runner argv builders + headless factories, and the runner registry that maps a runner
// name → { factory, env-auth allowlist }. claudeBridge.ts (the bridge orchestration) imports from here; this
// module never imports back from claudeBridge, so the dependency is one-directional (no cycle). Pure/seam-able:
// nothing here spawns a real agent in tests except through spawnCapture, which the bridge injects fakes around.
import { spawn } from 'node:child_process';
import { join as joinPath, delimiter as pathDelimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, } from 'node:fs';
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_AGENT_SESSION_ID_CHARS = 128;
const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Per-stream stdout/stderr capture ceiling. A child can emit indefinitely without growing the parent heap. */
export const DEFAULT_MAX_CAPTURE_BYTES = 1_048_576;
const MIN_MAX_CAPTURE_BYTES = 256;
export class AgentSessionResumeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'AgentSessionResumeError';
    }
}
/** Validate before spawn so malformed or cross-harness session targets always fail closed. */
export function validateAgentSessionResume(resume, expectedRunner) {
    if (resume.runner !== expectedRunner) {
        throw new AgentSessionResumeError('runner_mismatch', `session resume runner '${resume.runner}' does not match selected runner '${expectedRunner}'`);
    }
    if (expectedRunner !== 'claude' && expectedRunner !== 'cursor') {
        throw new AgentSessionResumeError('unsupported_runner', `runner '${expectedRunner}' does not support native session resume`);
    }
    if (!NATIVE_SESSION_ID_PATTERN.test(resume.sessionId)) {
        throw new AgentSessionResumeError('invalid_session_id', `session resume identifier must be ${MAX_AGENT_SESSION_ID_CHARS} characters or fewer and use only letters, numbers, '.', '_', or '-'`);
    }
    return resume;
}
/** Thrown when permission bypass is requested without bounding the agent's tools (would be an unbounded autonomous agent). */
export class UnboundedSkipPermissionsError extends Error {
    constructor() {
        super("skipPermissions requires a non-empty allowedTools — refusing to bypass permission prompts without bounding the agent (e.g. allowedTools: ['Read','Edit','Write'])");
        this.name = 'UnboundedSkipPermissionsError';
    }
}
/** Thrown when Codex permission options cannot be enforced by its CLI. */
export class UnsupportedCodexPermissionOptionsError extends Error {
    constructor() {
        super('codex runner does not support skipPermissions or allowedTools: the bypass is danger-full-access and Codex has no per-tool allowlist');
        this.name = 'UnsupportedCodexPermissionOptionsError';
    }
}
/** Thrown when Cursor skipPermissions is requested before the runner can enforce per-run permissions. */
export class UnsupportedCursorSkipPermissionsError extends Error {
    constructor() {
        super('cursor runner does not support skipPermissions yet: cursor-agent has no verified per-run allowlist or sandbox mapping, so --force --trust is refused');
        this.name = 'UnsupportedCursorSkipPermissionsError';
    }
}
/** Thrown when Cursor workspace trust is requested without verified host containment. */
export class UnsupportedCursorWorkspaceTrustError extends Error {
    constructor() {
        super('cursor runner does not support workspaceTrust: --trust grants host filesystem and network access that a Git worktree cannot contain');
        this.name = 'UnsupportedCursorWorkspaceTrustError';
    }
}
/** Thrown when Gemini permission options cannot be mapped to a verified bounded CLI contract. */
export class UnsupportedGeminiPermissionOptionsError extends Error {
    constructor() {
        super('gemini runner does not support skipPermissions or allowedTools: --yolo is unbounded and --allowed-tools is deprecated; the verified runner uses --approval-mode auto_edit only');
        this.name = 'UnsupportedGeminiPermissionOptionsError';
    }
}
/** Thrown when Cursor's Windows installation cannot be reduced to a shell-free node.exe + index.js launch. */
export class UnsupportedCursorWindowsRunnerError extends Error {
    constructor() {
        super('cursor runner on Windows could not resolve the installed cursor-agent bundle shell-free; reinstall/update cursor-agent or use claude/codex until node.exe + index.js are available');
        this.name = 'UnsupportedCursorWindowsRunnerError';
    }
}
export function assertCursorRunnerPlatformSupported(platform = process.platform, env = process.env) {
    if (platform !== 'win32')
        return;
    if (resolveSpawnCommand('cursor-agent', [], env, platform).cmd === 'cursor-agent') {
        throw new UnsupportedCursorWindowsRunnerError();
    }
}
/**
 * Make a bare command name spawnable shell-free on Windows. `spawn(shell:false)` cannot execute an npm CLI
 * shim (a `.cmd`/`.bat`), and routing through a shell would expose the prompt arg to cmd.exe quoting
 * (injection). npm shims are node wrappers, so we resolve the bare name on PATH and, when it's a node shim,
 * run `node <entry.js>` directly. Cursor's installer uses a PowerShell shim around a bundled
 * `versions/<version>/node.exe + index.js`; that known layout is resolved directly too, without invoking
 * cmd.exe or PowerShell. A native `.exe` (claude) resolves to itself. No-op on POSIX and for any command that
 * is already a path or has an extension. Surfaced by codex/cursor-agent on Windows (#66).
 */
export function resolveSpawnCommand(cmd, args, env = process.env, platform = process.platform) {
    if (platform !== 'win32' || /[\\/]/.test(cmd) || /\.[a-z0-9]+$/i.test(cmd))
        return { cmd, args: [...args] };
    const delimiter = platform === 'win32' ? ';' : pathDelimiter;
    for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
        for (const ext of ['.exe', '.cmd', '.bat']) {
            const full = joinPath(dir, cmd + ext);
            if (!existsSync(full))
                continue;
            if (ext === '.exe')
                return { cmd: full, args: [...args] };
            try {
                const shim = readFileSync(full, 'utf8');
                const rel = shim.match(/%~?dp0%?\\([^"\s]+\.js)/i)?.[1]; // npm node-shim: node "%dp0%\...\entry.js" %*
                if (rel) {
                    const js = joinPath(dir, rel);
                    if (existsSync(js))
                        return { cmd: process.execPath, args: [js, ...args] };
                }
                if (cmd.toLowerCase() === 'cursor-agent' && /cursor-agent\.ps1/i.test(shim)) {
                    const cursor = resolveCursorAgentBundle(dir, args);
                    if (cursor)
                        return cursor;
                }
            }
            catch { /* unreadable shim — keep searching */ }
            // A .cmd/.bat whose node entry we can't extract is NOT runnable shell-free — DON'T return it (that would
            // ENOENT and also stop the search). Keep scanning later PATH dirs/exts for a real .exe or resolvable shim.
        }
    }
    return { cmd, args: [...args] };
}
function resolveCursorAgentBundle(dir, args) {
    const direct = cursorBundleAt(dir, args);
    if (direct)
        return direct;
    let versions;
    try {
        versions = readdirSync(joinPath(dir, 'versions'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && cursorVersionKey(entry.name) !== undefined)
            .map((entry) => entry.name)
            .sort((a, b) => cursorVersionKey(b).localeCompare(cursorVersionKey(a)));
    }
    catch {
        return undefined;
    }
    for (const version of versions) {
        const resolved = cursorBundleAt(joinPath(dir, 'versions', version), args);
        if (resolved)
            return resolved;
    }
    return undefined;
}
function cursorBundleAt(dir, args) {
    const node = joinPath(dir, 'node.exe');
    const entry = joinPath(dir, 'index.js');
    return existsSync(node) && existsSync(entry) ? { cmd: node, args: [entry, ...args] } : undefined;
}
function cursorVersionKey(version) {
    const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{1,2})-(\d{1,2})-(\d{1,2}))?-[a-f0-9]+$/i.exec(version);
    if (!match)
        return undefined;
    const year = match[1];
    const month = match[2];
    const day = match[3];
    const hour = match[4] ?? '0';
    const minute = match[5] ?? '0';
    const second = match[6] ?? '0';
    return [year, month, day, hour, minute, second].map((part, index) => index === 0 ? part : part.padStart(2, '0')).join('');
}
const WINDOWS_TREE_KILL_TIMEOUT_MS = 5_000;
/** Build the shell-free taskkill invocation used for Windows process-tree termination. */
export function windowsTreeKillCommand(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new RangeError(`invalid process id: ${pid}`);
    return { command: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'] };
}
/** Run taskkill and report whether Windows accepted the process-tree termination request. */
export function killWindowsProcessTree(pid, spawnCommand = spawn, timeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS) {
    const { command, args } = windowsTreeKillCommand(pid);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
        throw new RangeError(`invalid taskkill timeout: ${timeoutMs}`);
    return new Promise((resolve) => {
        let settled = false;
        let killer;
        const finish = (ok, terminateKiller = false) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (terminateKiller) {
                try {
                    killer?.kill?.('SIGKILL');
                }
                catch { /* best-effort watchdog cleanup */ }
            }
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false, true), timeoutMs);
        timer.unref?.();
        try {
            killer = spawnCommand(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
            killer.once('error', () => finish(false));
            killer.once('close', (code) => finish(code === 0));
        }
        catch {
            finish(false);
        }
    });
}
/** Thrown when Cursor allowedTools are requested without a verified per-tool CLI allowlist. */
export class UnsupportedCursorAllowedToolsError extends Error {
    constructor() {
        super('cursor runner does not support allowedTools: cursor-agent has no verified per-run tool allowlist');
        this.name = 'UnsupportedCursorAllowedToolsError';
    }
}
/** A redirected stdout artifact could not be finalized; the subprocess outcome remains available for classification. */
export class SpawnCaptureFinalizeError extends Error {
    result;
    constructor(result, cause) {
        const detail = cause instanceof Error ? `: ${cause.message}` : '';
        super(`redirected stdout finalization failed${detail}`, { cause });
        this.name = 'SpawnCaptureFinalizeError';
        this.result = result;
    }
}
/**
 * Retain a bounded prefix and suffix while counting every byte received. Keeping raw buffers until rendering
 * avoids corrupting multi-byte UTF-8 characters when Node splits a character across stream chunks.
 */
class BoundedStreamCapture {
    maxBytes;
    headCapacity;
    tailCapacity;
    head;
    tail;
    headLength = 0;
    tailLength = 0;
    tailWriteOffset = 0;
    totalBytes = 0;
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
        this.headCapacity = Math.ceil(maxBytes / 2);
        this.tailCapacity = maxBytes - this.headCapacity;
    }
    append(value) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.totalBytes += chunk.length;
        let offset = 0;
        if (this.headLength < this.headCapacity) {
            const take = Math.min(this.headCapacity - this.headLength, chunk.length);
            const head = this.ensureHeadCapacity(this.headLength + take);
            chunk.copy(head, this.headLength, 0, take);
            this.headLength += take;
            offset = take;
        }
        if (offset < chunk.length)
            this.appendTail(chunk.subarray(offset));
    }
    result() {
        const head = this.head?.subarray(0, this.headLength) ?? Buffer.alloc(0);
        const tail = this.orderedTail();
        if (this.totalBytes <= this.maxBytes) {
            return {
                text: Buffer.concat([head, tail]).toString('utf8'),
                bytes: this.totalBytes,
                truncated: false,
            };
        }
        const marker = Buffer.from(`\n...[evolver output truncated; total_bytes=${this.totalBytes}]...\n`);
        const retainedBudget = this.maxBytes - marker.length;
        const headBudget = Math.ceil(retainedBudget / 2);
        const tailBudget = retainedBudget - headBudget;
        const retainedHead = trimIncompleteUtf8Suffix(head.subarray(0, headBudget));
        const tailStart = Math.max(0, tail.length - tailBudget);
        const retainedTail = trimUtf8ContinuationPrefix(tail.subarray(tailStart));
        return {
            text: Buffer.concat([retainedHead, marker, retainedTail]).toString('utf8'),
            bytes: this.totalBytes,
            truncated: true,
        };
    }
    ensureHeadCapacity(required) {
        const current = this.head;
        if (current && current.length >= required)
            return current;
        let capacity = current?.length ?? Math.min(4_096, this.headCapacity);
        while (capacity < required)
            capacity = Math.min(this.headCapacity, capacity * 2);
        const next = Buffer.allocUnsafe(capacity);
        if (current)
            current.copy(next, 0, 0, this.headLength);
        this.head = next;
        return next;
    }
    appendTail(incoming) {
        const tail = this.tail ??= Buffer.allocUnsafe(this.tailCapacity);
        if (incoming.length >= this.tailCapacity) {
            incoming.copy(tail, 0, incoming.length - this.tailCapacity);
            this.tailLength = this.tailCapacity;
            this.tailWriteOffset = 0;
            return;
        }
        const first = Math.min(incoming.length, this.tailCapacity - this.tailWriteOffset);
        incoming.copy(tail, this.tailWriteOffset, 0, first);
        if (first < incoming.length)
            incoming.copy(tail, 0, first);
        this.tailWriteOffset = (this.tailWriteOffset + incoming.length) % this.tailCapacity;
        this.tailLength = Math.min(this.tailCapacity, this.tailLength + incoming.length);
    }
    orderedTail() {
        const tail = this.tail;
        if (!tail || this.tailLength === 0)
            return Buffer.alloc(0);
        if (this.tailLength < this.tailCapacity)
            return tail.subarray(0, this.tailLength);
        if (this.tailWriteOffset === 0)
            return tail;
        return Buffer.concat([
            tail.subarray(this.tailWriteOffset),
            tail.subarray(0, this.tailWriteOffset),
        ]);
    }
}
function trimIncompleteUtf8Suffix(value) {
    if (value.length === 0)
        return value;
    let lead = value.length - 1;
    while (lead >= 0 && (value[lead] & 0xc0) === 0x80)
        lead -= 1;
    if (lead < 0)
        return Buffer.alloc(0);
    const first = value[lead];
    const expected = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
    return value.length - lead < expected ? value.subarray(0, lead) : value;
}
function trimUtf8ContinuationPrefix(value) {
    let offset = 0;
    while (offset < value.length && (value[offset] & 0xc0) === 0x80)
        offset += 1;
    return value.subarray(offset);
}
/**
 * Promise wrapper over spawn (shell:false). Optionally writes `input` to stdin; resolves with stdout/exit.
 * On timeout the WHOLE process group is killed, not just the direct child (finding #39.5): an agent spawns
 * tool subprocesses (grandchildren) that would otherwise orphan and leak. On POSIX we spawn detached (the
 * child becomes its own group leader) and SIGKILL the group via the negative pid. Windows runs
 * `taskkill.exe /PID <pid> /T /F` without a shell and waits for that command before resolving.
 */
export function spawnCapture(cmd, args, opts) {
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    if (!Number.isSafeInteger(maxOutputBytes)
        || maxOutputBytes < MIN_MAX_CAPTURE_BYTES
        || maxOutputBytes > DEFAULT_MAX_CAPTURE_BYTES) {
        throw new RangeError(`maxOutputBytes must be an integer between ${MIN_MAX_CAPTURE_BYTES} and ${DEFAULT_MAX_CAPTURE_BYTES}`);
    }
    return new Promise((resolve, reject) => {
        if (opts.signal?.aborted) {
            resolve({
                code: null,
                stdout: '',
                stderr: '',
                termination: 'cancelled',
                stdoutBytes: 0,
                stderrBytes: 0,
                stdoutTruncated: false,
                stderrTruncated: false,
            });
            return;
        }
        const platform = opts.processPlatform ?? process.platform;
        const detached = platform !== 'win32';
        const r = resolveSpawnCommand(cmd, args, opts.env, opts.resolvePlatform ?? process.platform);
        let stdoutFd;
        let ownsStdoutFile = false;
        const cleanupOwnedStdoutFile = () => {
            if (!ownsStdoutFile || !opts.stdoutFile)
                return;
            try {
                rmSync(opts.stdoutFile, { force: true });
                ownsStdoutFile = false;
            }
            catch { /* best-effort; a caller ownership hook can retry */ }
        };
        try {
            if (opts.stdoutFile) {
                stdoutFd = openSync(opts.stdoutFile, 'wx', 0o600);
                ownsStdoutFile = true;
                opts.onStdoutFileOpened?.(opts.stdoutFile);
            }
        }
        catch (error) {
            if (stdoutFd !== undefined) {
                try {
                    closeSync(stdoutFd);
                }
                catch { /* best-effort cleanup before the child exists */ }
                stdoutFd = undefined;
            }
            cleanupOwnedStdoutFile();
            reject(error);
            return;
        }
        let child;
        try {
            child = (opts.spawnCommand ?? spawn)(r.cmd, r.args, {
                cwd: opts.cwd,
                shell: false,
                detached,
                ...(opts.env ? { env: opts.env } : {}),
                ...(stdoutFd !== undefined ? { stdio: ['pipe', stdoutFd, 'pipe'] } : {}),
            });
        }
        catch (error) {
            if (stdoutFd !== undefined) {
                try {
                    closeSync(stdoutFd);
                }
                catch { /* best-effort cleanup before rejection */ }
                stdoutFd = undefined;
            }
            cleanupOwnedStdoutFile();
            reject(error);
            return;
        }
        const stdoutCapture = new BoundedStreamCapture(maxOutputBytes);
        const stderrCapture = new BoundedStreamCapture(maxOutputBytes);
        let termination = 'exit';
        let killPromise;
        let settled = false;
        let redirectedStdoutBytes;
        const killTree = () => {
            if (killPromise)
                return killPromise;
            killPromise = (async () => {
                if (platform === 'win32' && typeof child.pid === 'number') {
                    let killed = false;
                    try {
                        killed = await (opts.windowsProcessTreeKiller ?? killWindowsProcessTree)(child.pid);
                    }
                    catch {
                        // Treat an injected/custom killer rejection like taskkill failure and fall back to the direct child.
                    }
                    if (killed)
                        return;
                }
                if (detached && typeof child.pid === 'number') {
                    try {
                        process.kill(-child.pid, 'SIGKILL');
                        return;
                    }
                    catch { /* group gone; fall back */ }
                }
                child.kill('SIGKILL');
            })();
            return killPromise;
        };
        const cancel = () => {
            if (termination !== 'exit')
                return;
            termination = 'cancelled';
            void killTree();
        };
        const timeout = () => {
            if (termination !== 'exit')
                return;
            termination = 'timeout';
            void killTree();
        };
        const ignoreProcessSignal = () => { };
        const cleanup = () => {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', cancel);
            if (opts.processSignalMode === 'ignore') {
                process.removeListener('SIGINT', ignoreProcessSignal);
                process.removeListener('SIGTERM', ignoreProcessSignal);
            }
            else {
                process.removeListener('SIGINT', cancel);
                process.removeListener('SIGTERM', cancel);
            }
        };
        const settle = async (finish) => {
            if (settled)
                return;
            settled = true;
            if (killPromise)
                await killPromise;
            cleanup();
            let stdoutFileError;
            if (stdoutFd !== undefined) {
                const fd = stdoutFd;
                stdoutFd = undefined;
                try {
                    redirectedStdoutBytes = opts.stdoutFileOps?.size(fd) ?? fstatSync(fd).size;
                }
                catch (error) {
                    stdoutFileError = error;
                }
                try {
                    (opts.stdoutFileOps?.close ?? closeSync)(fd);
                }
                catch (error) {
                    stdoutFileError ??= error;
                    try {
                        closeSync(fd);
                    }
                    catch { /* retry a failed/injected close before removing our artifact */ }
                }
            }
            finish(stdoutFileError);
        };
        const timer = setTimeout(timeout, opts.timeoutMs);
        opts.signal?.addEventListener('abort', cancel, { once: true });
        // A detached POSIX child would otherwise survive Ctrl-C/SIGTERM. Cancel first so the bridge can clean its
        // worktree and return a failure instead of leaking an agent or tool subprocess.
        if (opts.processSignalMode === 'ignore') {
            process.on('SIGINT', ignoreProcessSignal);
            process.on('SIGTERM', ignoreProcessSignal);
        }
        else {
            process.once('SIGINT', cancel);
            process.once('SIGTERM', cancel);
        }
        child.stdout?.on('data', (d) => { stdoutCapture.append(d); });
        child.stderr?.on('data', (d) => { stderrCapture.append(d); });
        const stdinCompletion = opts.input === undefined
            ? Promise.resolve(undefined)
            : new Promise((resolveInput) => {
                const stdin = child.stdin;
                if (!stdin) {
                    resolveInput(new Error('runner stdin is unavailable'));
                    void killTree();
                    return;
                }
                let completed = false;
                const complete = (error) => {
                    if (completed)
                        return false;
                    completed = true;
                    resolveInput(error);
                    return true;
                };
                stdin.on('error', (error) => {
                    if (complete(error instanceof Error ? error : new Error(String(error)))) {
                        void killTree();
                    }
                });
                stdin.on('finish', () => complete());
                stdin.on('close', () => {
                    if (complete(new Error('runner stdin closed before prompt delivery'))) {
                        void killTree();
                    }
                });
                try {
                    stdin.end(opts.input);
                }
                catch (error) {
                    if (complete(error instanceof Error ? error : new Error(String(error)))) {
                        void killTree();
                    }
                }
            });
        child.on('error', (e) => {
            void settle(() => {
                cleanupOwnedStdoutFile();
                reject(e);
            });
        });
        child.on('close', (code) => {
            void stdinCompletion.then((inputError) => {
                void settle((stdoutFileError) => {
                    const stdout = stdoutCapture.result();
                    const stderr = stderrCapture.result();
                    const result = {
                        code,
                        stdout: stdout.text,
                        stderr: stderr.text,
                        termination,
                        stdoutBytes: redirectedStdoutBytes ?? stdout.bytes,
                        stderrBytes: stderr.bytes,
                        stdoutTruncated: stdout.truncated,
                        stderrTruncated: stderr.truncated,
                        ...(opts.stdoutFile ? { stdoutRedirected: true } : {}),
                    };
                    if (stdoutFileError !== undefined) {
                        cleanupOwnedStdoutFile();
                        reject(new SpawnCaptureFinalizeError(result, stdoutFileError));
                        return;
                    }
                    if (inputError && termination === 'exit' && code === 0) {
                        cleanupOwnedStdoutFile();
                        reject(inputError);
                        return;
                    }
                    resolve(result);
                });
            });
        });
        // Defined input is delivered and closed by stdin.end(opts.input) above. With no input, still close the pipe so
        // EOF-driven CLIs cannot hang.
        if (opts.input === undefined)
            child.stdin?.end();
    });
}
/** Map the shared process result into the failure taxonomy used by plain-text runners. */
export function classifyBasicRunnerResult(runner, result, timeoutMs, resume) {
    if (result.termination === 'timeout') {
        return {
            ok: false,
            output: resume ? '' : result.stdout,
            error: `${runner} timed out after ${timeoutMs}ms`,
            failureKind: 'timeout',
            exitCode: result.code,
        };
    }
    if (result.termination === 'cancelled') {
        return {
            ok: false,
            output: resume ? '' : result.stdout,
            error: `${runner} execution cancelled`,
            failureKind: 'cancelled',
            exitCode: result.code,
        };
    }
    // Runner stdout is agent content and may legitimately discuss these errors, including on a later failure.
    const diagnostic = result.stderr;
    if (result.code !== 0 && /permission denied|access denied|not authorized|unauthorized|authentication required|please (?:log|sign) in|login required/i.test(diagnostic)) {
        return {
            ok: false,
            output: resume ? '' : result.stdout,
            error: `${runner} permission denied while executing${resume ? ' resumed session' : ''}`,
            failureKind: 'permission_denied',
            exitCode: result.code,
        };
    }
    const escapedResumeId = resume?.sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const contextualMissingSession = escapedResumeId
        ? new RegExp(`(?:session|conversation|chat)\\s+(?:(?:with\\s+)?id[:=]?\\s+)?["']?${escapedResumeId}["']?\\s+(?:was\\s+)?(?:not found|does not exist)`, 'i').test(diagnostic)
        : false;
    if (resume && (contextualMissingSession || /(?:session|conversation|chat) (?:was )?not found|no (?:conversation|session|chat) found|invalid session(?: id)?|unable to resume|cannot resume|(?:session|conversation|chat) does not exist|expired session/i.test(diagnostic))) {
        return {
            ok: false,
            output: '',
            error: `${runner} resume session is missing, stale, or unavailable`,
            failureKind: 'runtime_error',
            exitCode: result.code,
        };
    }
    if (result.code !== 0) {
        const error = result.stderr || `${runner} exited with code ${String(result.code)}`;
        const safeError = resume
            ? error.replaceAll(resume.sessionId, '[session-id]')
            : error;
        return {
            ok: false,
            output: result.stdout,
            error: safeError,
            failureKind: 'non_zero_exit',
            exitCode: result.code,
        };
    }
    return { ok: true, output: result.stdout };
}
function spawnFailureResult(error) {
    return {
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        failureKind: 'spawn_failed',
        exitCode: null,
    };
}
export const CLAUDE_SAFE_AUTONOMOUS_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const CLAUDE_SAFE_AUTONOMOUS_TOOL_SET = new Set(CLAUDE_SAFE_AUTONOMOUS_TOOLS);
export function hasBoundedClaudeFileAccess(opts) {
    return opts?.permissionMode === 'acceptEdits'
        && opts.skipPermissions !== true
        && (opts.allowedTools?.length ?? 0) === 0
        && Array.isArray(opts.tools)
        && opts.tools.length > 0
        && opts.tools.every((tool) => CLAUDE_SAFE_AUTONOMOUS_TOOL_SET.has(tool));
}
/**
 * Build the `claude -p` argv for the given options (pure and testable without spawning).
 * Safety invariant: skipPermissions (bypassing prompts) is only allowed together with a non-empty
 * allowedTools; otherwise it would be an unattended agent with full tools and no gate; refuse loudly.
 */
export function claudeRunnerArgs(opts = {}, resume) {
    const bounded = !!(opts.allowedTools && opts.allowedTools.length > 0);
    if (opts.skipPermissions && !bounded)
        throw new UnboundedSkipPermissionsError();
    const args = ['-p', '--output-format', 'text'];
    if (opts.skipPermissions)
        args.push('--dangerously-skip-permissions');
    if (opts.allowedTools && opts.allowedTools.length > 0)
        args.push('--allowedTools', ...opts.allowedTools);
    if (opts.permissionMode)
        args.push('--permission-mode', opts.permissionMode);
    if (opts.tools && opts.tools.length > 0)
        args.push('--tools', opts.tools.join(','));
    if (opts.permissionMode === 'acceptEdits') {
        args.push('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '');
    }
    if (opts.model)
        args.push('--model', opts.model);
    if (resume) {
        validateAgentSessionResume(resume, 'claude');
        args.push('--resume', resume.sessionId);
    }
    return args;
}
/**
 * Build a headless `claude -p` agent runner. Prompt is fed via stdin (no shell, no argv length limit).
 * For unattended edits, prefer permissionMode: 'acceptEdits' with the bounded file/search tool list.
 */
export function makeClaudeHeadlessRunner(opts = {}) {
    const args = claudeRunnerArgs(opts);
    return async (prompt, ctx) => {
        const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const runArgs = ctx.resume ? claudeRunnerArgs(opts, ctx.resume) : args;
        try {
            const result = await spawnCapture('claude', runArgs, { cwd: ctx.cwd, timeoutMs, input: prompt, ...(ctx.env ? { env: ctx.env } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
            return classifyBasicRunnerResult('claude', result, timeoutMs, ctx.resume);
        }
        catch (e) {
            return spawnFailureResult(e);
        }
    };
}
/** Default agent runner: conservative `claude -p --output-format text` (no permission bypass; opt in via makeClaudeHeadlessRunner). */
export const claudeHeadlessRunner = makeClaudeHeadlessRunner();
// --- Codex runner (#66 multi-harness) ---
/**
 * Build the `codex exec` argv (pure). Verified live against codex-cli 0.144.6:
 *  - sandboxed default → `--ask-for-approval never exec --sandbox workspace-write`: edits the workspace
 *    without waiting for interactive approval. The wrapper's worktree + allowedRoots are the outer containment.
 *  - permission overrides fail closed: Codex has no per-tool allowlist, and a Git worktree does not contain
 *    danger-full-access host filesystem or network access.
 */
export function codexRunnerArgs(opts = {}) {
    if (opts.skipPermissions || opts.allowedTools !== undefined) {
        throw new UnsupportedCodexPermissionOptionsError();
    }
    const args = ['--ask-for-approval', 'never', 'exec'];
    args.push('--sandbox', 'workspace-write');
    args.push('--ephemeral');
    if (opts.model)
        args.push('--model', opts.model);
    return args;
}
/** Headless `codex exec` runner. Working root pinned with `--cd`; prompt is sent over stdin. */
export function makeCodexHeadlessRunner(opts = {}, spawnCaptureFn = spawnCapture) {
    const args = codexRunnerArgs(opts);
    return async (prompt, ctx) => {
        const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        try {
            const result = await spawnCaptureFn('codex', [...args, '--cd', ctx.cwd, '-'], { cwd: ctx.cwd, timeoutMs, input: prompt, ...(ctx.env ? { env: ctx.env } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
            return classifyBasicRunnerResult('codex', result, timeoutMs);
        }
        catch (e) {
            return spawnFailureResult(e);
        }
    };
}
const GEMINI_PERMISSION_DENIAL_RE = /agent execution blocked|permission denied|approval required|not approved|denied by (?:policy|user|admin)|tool (?:call )?(?:was )?denied/i;
const GEMINI_TERMINATION_WARNINGS = [
    { pattern: /^(?:[^:\r\n]{1,80}:\s*)?Agent execution stopped\b/i, error: 'gemini agent execution stopped' },
    { pattern: /^(?:[^:\r\n]{1,80}:\s*)?Loop detected\b/i, error: 'gemini loop detected' },
    { pattern: /^(?:[^:\r\n]{1,80}:\s*)?Maximum session turns exceeded\b/i, error: 'gemini maximum session turns exceeded' },
];
function geminiMessage(value) {
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object') {
        const record = value;
        const type = typeof record['type'] === 'string' ? record['type'] : '';
        const message = typeof record['message'] === 'string' ? record['message'] : '';
        return [type, message].filter(Boolean).join(': ');
    }
    return value === undefined ? '' : String(value);
}
function geminiWarnings(value) {
    return Array.isArray(value) ? value.map(geminiMessage).filter(Boolean) : [];
}
/** Accept only native-session-safe ids so Learning Ops never joins on garbage envelope fields. */
function geminiSessionId(value) {
    if (typeof value !== 'string')
        return undefined;
    const sessionId = value.trim();
    return NATIVE_SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}
function withGeminiSessionId(result, envelope) {
    const sessionId = geminiSessionId(envelope.session_id);
    return sessionId !== undefined ? { ...result, sessionId } : result;
}
/**
 * Gemini sometimes prints non-JSON diagnostics before the structured envelope.
 * Prefer pure JSON; otherwise accept the last top-level JSON object in stdout.
 */
function parseGeminiStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    }
    catch {
        // fall through to last-object recovery
    }
    for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
        try {
            const parsed = JSON.parse(trimmed.slice(index));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                return parsed;
        }
        catch {
            // keep scanning earlier braces
        }
    }
    return null;
}
/** Interpret one bounded Gemini subprocess result. Structured output and diagnostics require complete capture. */
export function classifyGeminiRunnerResult(result, timeoutMs) {
    if (result.termination === 'timeout') {
        return { ok: false, output: result.stdout, error: `gemini timed out after ${timeoutMs}ms`, failureKind: 'timeout', exitCode: result.code };
    }
    if (result.termination === 'cancelled') {
        return { ok: false, output: result.stdout, error: 'gemini execution cancelled', failureKind: 'cancelled', exitCode: result.code };
    }
    if (result.stdoutTruncated || result.stderrTruncated) {
        return {
            ok: false,
            output: result.stdout,
            error: 'gemini output exceeded the capture limit',
            failureKind: 'invalid_output',
            exitCode: result.code,
        };
    }
    const envelope = parseGeminiStdout(result.stdout);
    if (!envelope) {
        const error = result.stderr || (result.code === 0 ? 'gemini returned invalid JSON output' : `gemini exited with code ${String(result.code)}`);
        return { ok: false, output: result.stdout, error, failureKind: result.code === 0 ? 'invalid_output' : 'non_zero_exit', exitCode: result.code };
    }
    const structuredError = geminiMessage(envelope.error);
    const warnings = geminiWarnings(envelope.warnings);
    const terminationError = result.code === 0
        ? GEMINI_TERMINATION_WARNINGS.find(({ pattern }) => warnings.some((warning) => pattern.test(warning)))?.error
        : undefined;
    if (terminationError) {
        return withGeminiSessionId({ ok: false, output: geminiMessage(envelope.response), error: terminationError, failureKind: 'runtime_error', exitCode: result.code }, envelope);
    }
    const denial = [structuredError, ...warnings, result.stderr].find((message) => GEMINI_PERMISSION_DENIAL_RE.test(message));
    if (denial) {
        return withGeminiSessionId({ ok: false, output: geminiMessage(envelope.response), error: denial, failureKind: 'permission_denied', exitCode: result.code }, envelope);
    }
    if (result.code !== 0) {
        return withGeminiSessionId({ ok: false, output: geminiMessage(envelope.response), error: structuredError || result.stderr || `gemini exited with code ${String(result.code)}`, failureKind: 'non_zero_exit', exitCode: result.code }, envelope);
    }
    if (structuredError) {
        return withGeminiSessionId({ ok: false, output: geminiMessage(envelope.response), error: structuredError, failureKind: 'runtime_error', exitCode: result.code }, envelope);
    }
    return withGeminiSessionId({ ok: true, output: geminiMessage(envelope.response), exitCode: result.code }, envelope);
}
/** Build verified Gemini CLI argv. The prompt is appended separately as one argv element with shell:false. */
export function geminiRunnerArgs(opts = {}) {
    if (opts.skipPermissions || (opts.allowedTools?.length ?? 0) > 0)
        throw new UnsupportedGeminiPermissionOptionsError();
    const args = [
        '--output-format', 'json',
        '--approval-mode', 'auto_edit',
        '--skip-trust',
        '--extensions', 'none',
        '--allowed-mcp-server-names', '__evolver_no_mcp__',
    ];
    if (opts.model)
        args.push('--model', opts.model);
    return args;
}
const GEMINI_AUTH_FILE_MAX_BYTES = 1_048_576;
function copyGeminiAuthFile(sourceDir, targetDir, name) {
    const source = joinPath(sourceDir, name);
    try {
        const stat = lstatSync(source);
        if (!stat.isFile() || stat.size > GEMINI_AUTH_FILE_MAX_BYTES)
            return;
        const target = joinPath(targetDir, name);
        copyFileSync(source, target);
        chmodSync(target, 0o600);
    }
    catch {
        // Missing or unreadable optional auth state must fail closed in Gemini itself.
    }
}
function sanitizedGeminiAuthSettings(sourceDir) {
    try {
        const parsed = JSON.parse(readFileSync(joinPath(sourceDir, 'settings.json'), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const security = parsed['security'];
        if (!security || typeof security !== 'object' || Array.isArray(security))
            return {};
        const auth = security['auth'];
        if (!auth || typeof auth !== 'object' || Array.isArray(auth))
            return {};
        const selectedType = auth['selectedType'];
        return typeof selectedType === 'string' && selectedType.length <= 128
            ? { security: { auth: { selectedType } } }
            : {};
    }
    catch {
        return {};
    }
}
function isolatedGeminiEnv(env, removeTempDir) {
    const root = mkdtempSync(joinPath(tmpdir(), 'evolver-gemini-'));
    const globalDir = joinPath(root, '.gemini');
    mkdirSync(globalDir, { mode: 0o700 });
    const sourceHome = env['GEMINI_CLI_HOME'] || env['HOME'];
    const sourceDir = sourceHome ? joinPath(sourceHome, '.gemini') : undefined;
    if (sourceDir) {
        copyGeminiAuthFile(sourceDir, globalDir, 'oauth_creds.json');
        copyGeminiAuthFile(sourceDir, globalDir, 'google_accounts.json');
    }
    const authSettings = sourceDir ? sanitizedGeminiAuthSettings(sourceDir) : {};
    writeFileSync(joinPath(globalDir, 'settings.json'), `${JSON.stringify(authSettings)}\n`, { mode: 0o600 });
    const systemSettings = joinPath(root, 'system-settings.json');
    const systemDefaults = joinPath(root, 'system-defaults.json');
    writeFileSync(systemDefaults, '{}\n', { mode: 0o600 });
    writeFileSync(systemSettings, '{"hooksConfig":{"enabled":false},"admin":{"mcp":{"enabled":false}}}\n', { mode: 0o600 });
    const isolatedEnv = { ...env };
    for (const name of Object.keys(isolatedEnv)) {
        if (name.startsWith('GEMINI_CLI_') || name.startsWith('XDG_'))
            delete isolatedEnv[name];
    }
    return {
        env: {
            ...isolatedEnv,
            GEMINI_CLI_HOME: root,
            GEMINI_CLI_SYSTEM_DEFAULTS_PATH: systemDefaults,
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings,
        },
        cleanup: () => removeTempDir(root),
    };
}
/** Headless Gemini runner with structured failure classification; stdout text alone never proves execution success. */
export function makeGeminiHeadlessRunner(opts = {}, removeTempDir = (path) => rmSync(path, { recursive: true, force: true })) {
    const args = geminiRunnerArgs(opts);
    return async (prompt, ctx) => {
        let cleanup = () => { };
        try {
            const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const isolated = isolatedGeminiEnv({ ...(ctx.env ?? process.env) }, removeTempDir);
            cleanup = isolated.cleanup;
            const result = await spawnCapture('gemini', [...args, '--prompt', prompt], {
                cwd: ctx.cwd,
                timeoutMs,
                env: isolated.env,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            return classifyGeminiRunnerResult(result, timeoutMs);
        }
        catch (error) {
            return { ok: false, output: '', error: error instanceof Error ? error.message : String(error), failureKind: 'spawn_failed', exitCode: null };
        }
        finally {
            try {
                cleanup();
            }
            catch {
                // Cleanup is best-effort and must not replace the subprocess result.
            }
        }
    };
}
// --- Cursor runner (#66 multi-harness) ---
//
// Flags below are GROUND-TRUTH from `cursor-agent --help` (CLI 2026.06.15), not guesses. Confirmed surface:
//   - headless: `-p` / `--print` — "Has access to all tools, including write and shell". So `-p` ALONE can edit;
//     output via `--output-format text|json|stream-json` (text default, only with --print).
//   - autonomy flags: `-f`/`--force` (alias `--yolo`) = auto-allow commands unless explicitly denied; `--trust`
//     = trust the workspace without prompting (headless only). Together they make `-p` truly non-interactive —
//     WITHOUT them headless can block on a command-approval / workspace-trust prompt (the forum "-p hangs" reports).
//   - `--model <model>` exists (e.g. gpt-5, sonnet-4, sonnet-4-thinking); `--list-models` enumerates.
//   - auth: `CURSOR_API_KEY` or `--api-key` (the spec's envAllow prefix is CURSOR_).
//   - cursor has its OWN `--sandbox enabled|disabled` and `-w/--worktree`; we still wrap with our git worktree.
// Bundle and auth preflight verified on Windows with Cursor Agent 2026.06.15. The Windows launcher is a
// PowerShell shim and its own version regex rejects the current timestamped version-dir shape. resolveSpawnCommand
// therefore bypasses both scripts and runs the newest verified node.exe + index.js bundle directly, shell-free.
// If that known bundle layout cannot be found, the runner still fail-fasts.
//
// SAFETY: `--trust`, `--force`, permission bypass, and per-tool allowlists remain fail-closed. The worktree is a
// measurement/patch-containment boundary, not an OS/network sandbox.
/**
 * Build the `cursor-agent` argv (pure). Ground-truth from `cursor-agent --help` (#66): base `-p --output-format
 * text` (headless, write+shell access). `--model` is a real flag. skipPermissions is rejected until Cursor has a
 * verified per-run allowlist/sandbox mapping; allowedTools is not emitted because cursor has no per-tool allowlist.
 */
export function cursorRunnerArgs(opts = {}, resume, managedWorktreeName) {
    if (opts.skipPermissions)
        throw new UnsupportedCursorSkipPermissionsError();
    if (opts.workspaceTrust !== undefined)
        throw new UnsupportedCursorWorkspaceTrustError();
    if (opts.allowedTools !== undefined) {
        throw new UnsupportedCursorAllowedToolsError();
    }
    const args = ['-p', '--output-format', 'text'];
    if (opts.model)
        args.push('--model', opts.model);
    if (resume) {
        validateAgentSessionResume(resume, 'cursor');
        args.push('--resume', resume.sessionId);
    }
    if (managedWorktreeName) {
        if (!NATIVE_SESSION_ID_PATTERN.test(managedWorktreeName)) {
            throw new AgentSessionResumeError('invalid_session_id', 'managed worktree name is invalid');
        }
        args.push('--worktree', managedWorktreeName, '--skip-worktree-setup');
    }
    return args;
}
function cursorManagedWorktreePath(stdout) {
    const match = /^Using worktree: (.+)$/m.exec(stdout);
    return match?.[1]?.trim();
}
/**
 * Headless `cursor-agent` runner. Prompt passed as the trailing positional arg (shell:false, no injection risk;
 * docs show `cursor-agent -p "<prompt>"`). cwd is set via spawn. Workspace trust must be certified by the
 * bridge refuses built-in autonomous Cursor until host containment is verified.
 */
export function makeCursorHeadlessRunner(opts = {}, platform = process.platform) {
    const args = cursorRunnerArgs(opts);
    return async (prompt, ctx) => {
        const runArgs = ctx.resume || ctx.managedWorktreeName
            ? cursorRunnerArgs(opts, ctx.resume, ctx.managedWorktreeName)
            : args;
        assertCursorRunnerPlatformSupported(platform, ctx.env ?? process.env);
        const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        try {
            const result = await spawnCapture('cursor-agent', [...runArgs, prompt], {
                cwd: ctx.cwd,
                timeoutMs,
                resolvePlatform: platform,
                ...(ctx.env ? { env: ctx.env } : {}),
                ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            const classified = classifyBasicRunnerResult('cursor', result, timeoutMs, ctx.resume);
            const managedWorktreePath = cursorManagedWorktreePath(`${result.stdout}\n${result.stderr}`);
            return managedWorktreePath ? { ...classified, managedWorktreePath } : classified;
        }
        catch (e) {
            return spawnFailureResult(e);
        }
    };
}
const RUNNER_SPECS = {
    // AWS_ prefix is allowlisted so the claude CLI can authenticate against Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK=1
    // + AWS_REGION/AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY). This is a legitimate runner-auth channel,
    // symmetric to CURSOR_/OPENAI_ for the other runners; no other runner inherits it.
    claude: { name: 'claude', makeRunner: makeClaudeHeadlessRunner, envAllow: { prefixes: ['ANTHROPIC_', 'CLAUDE_', 'AWS_'] } },
    codex: { name: 'codex', makeRunner: makeCodexHeadlessRunner, envAllow: { prefixes: ['OPENAI_', 'CODEX_'] } },
    // cursor keeps only its OWN auth env (CURSOR_); like every runner it never inherits another's vendor key.
    cursor: { name: 'cursor', makeRunner: makeCursorHeadlessRunner, envAllow: { prefixes: ['CURSOR_'] } },
    gemini: {
        name: 'gemini',
        makeRunner: makeGeminiHeadlessRunner,
        envAllow: {
            prefixes: ['GEMINI_'],
            keys: ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI'],
        },
    },
};
/** Resolve a runner spec by name (default 'claude' — byte-identical to the pre-registry behavior). */
export function getRunnerSpec(name = 'claude') {
    return RUNNER_SPECS[name];
}