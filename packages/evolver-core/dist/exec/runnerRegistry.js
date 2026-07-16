// The runner layer of the exec bridge (#66, split out per #91 item 6): how to spawn a coding-agent CLI
// shell-free, the per-runner argv builders + headless factories, and the runner registry that maps a runner
// name → { factory, env-auth allowlist }. claudeBridge.ts (the bridge orchestration) imports from here; this
// module never imports back from claudeBridge, so the dependency is one-directional (no cycle). Pure/seam-able:
// nothing here spawns a real agent in tests except through spawnCapture, which the bridge injects fakes around.
import { spawn } from 'node:child_process';
import { join as joinPath, delimiter as pathDelimiter } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Thrown when permission bypass is requested without bounding the agent's tools (would be an unbounded autonomous agent). */
export class UnboundedSkipPermissionsError extends Error {
    constructor() {
        super("skipPermissions requires a non-empty allowedTools — refusing to bypass permission prompts without bounding the agent (e.g. allowedTools: ['Read','Edit','Write'])");
        this.name = 'UnboundedSkipPermissionsError';
    }
}
/** Thrown when Cursor skipPermissions is requested before the runner can enforce per-run permissions. */
export class UnsupportedCursorSkipPermissionsError extends Error {
    constructor() {
        super('cursor runner does not support skipPermissions yet: cursor-agent has no verified per-run allowlist or sandbox mapping, so --force --trust is refused');
        this.name = 'UnsupportedCursorSkipPermissionsError';
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
/**
 * Promise wrapper over spawn (shell:false). Optionally writes `input` to stdin; resolves with stdout/exit.
 * On timeout the WHOLE process group is killed, not just the direct child (finding #39.5): an agent spawns
 * tool subprocesses (grandchildren) that would otherwise orphan and leak. On POSIX we spawn detached (the
 * child becomes its own group leader) and SIGKILL the group via the negative pid; Windows falls back to a
 * direct kill (different process-group semantics).
 */
export function spawnCapture(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const detached = process.platform !== 'win32';
        const r = resolveSpawnCommand(cmd, args, opts.env, opts.resolvePlatform ?? process.platform);
        const child = spawn(r.cmd, r.args, { cwd: opts.cwd, shell: false, detached, ...(opts.env ? { env: opts.env } : {}) });
        let stdout = '';
        let stderr = '';
        const killTree = () => {
            if (detached && typeof child.pid === 'number') {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                    return;
                }
                catch { /* group gone; fall back */ }
            }
            child.kill('SIGKILL');
        };
        const timer = setTimeout(killTree, opts.timeoutMs);
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        if (opts.input !== undefined) {
            child.stdin?.write(opts.input);
            child.stdin?.end();
        }
    });
}
/**
 * Build the `claude -p` argv for the given options (pure — testable without spawning).
 * Safety invariant: skipPermissions (bypassing prompts) is only allowed together with a non-empty
 * allowedTools — otherwise it would be an unattended agent with full tools and no gate; refuse loudly.
 */
export function claudeRunnerArgs(opts = {}) {
    const bounded = !!(opts.allowedTools && opts.allowedTools.length > 0);
    if (opts.skipPermissions && !bounded)
        throw new UnboundedSkipPermissionsError();
    const args = ['-p', '--output-format', 'text'];
    if (opts.skipPermissions)
        args.push('--dangerously-skip-permissions');
    if (opts.allowedTools && opts.allowedTools.length > 0)
        args.push('--allowedTools', ...opts.allowedTools);
    if (opts.model)
        args.push('--model', opts.model);
    return args;
}
/**
 * Build a headless `claude -p` agent runner. Prompt fed via stdin (no shell, no argv length limit). For
 * unattended evolution set { skipPermissions: true, allowedTools: ['Read','Edit','Write'] } — bypass the
 * permission prompts but bound the agent to file edits. Validated end to end against a real agent.
 */
export function makeClaudeHeadlessRunner(opts = {}) {
    const args = claudeRunnerArgs(opts);
    return async (prompt, ctx) => {
        try {
            const r = await spawnCapture('claude', args, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS, input: prompt, ...(ctx.env ? { env: ctx.env } : {}) });
            return r.code === 0 ? { ok: true, output: r.stdout } : { ok: false, output: r.stdout, error: r.stderr || `exit ${r.code}` };
        }
        catch (e) {
            return { ok: false, output: '', error: e instanceof Error ? e.message : String(e) };
        }
    };
}
/** Default agent runner: conservative `claude -p --output-format text` (no permission bypass; opt in via makeClaudeHeadlessRunner). */
export const claudeHeadlessRunner = makeClaudeHeadlessRunner();
// --- Codex runner (#66 multi-harness) ---
/**
 * Build the `codex exec` argv (pure). Verified live against codex-cli 0.137.0:
 *  - sandboxed default → `exec --sandbox workspace-write`: edits the workspace non-interactively (read-only,
 *    the codex default, cannot write). The wrapper's worktree + allowedRoots are the outer containment.
 *  - skipPermissions (bounded) → `exec --dangerously-bypass-approvals-and-sandbox`: full bypass, intended for
 *    an already-externally-sandboxed run (our throwaway worktree). The `skip⇒bounded` invariant is the explicit
 *    acknowledgement guard, same shape as claude.
 */
export function codexRunnerArgs(opts = {}) {
    const bounded = !!(opts.allowedTools && opts.allowedTools.length > 0);
    if (opts.skipPermissions && !bounded)
        throw new UnboundedSkipPermissionsError(); // same invariant as claude skip⇒allowedTools
    const args = ['exec'];
    // codex bounds via sandbox mode (not a per-tool allowlist): workspace-write is the safe autonomous default;
    // the explicit bypass removes the inner sandbox for a run the wrapper already isolates.
    args.push('--sandbox', opts.skipPermissions ? 'danger-full-access' : 'workspace-write');
    if (opts.skipPermissions)
        args.push('--dangerously-bypass-approvals-and-sandbox');
    if (opts.model)
        args.push('--model', opts.model);
    return args;
}
/** Headless `codex exec` runner. Working root pinned with `--cd`; prompt is the trailing positional arg (shell:false). */
export function makeCodexHeadlessRunner(opts = {}) {
    const args = codexRunnerArgs(opts);
    return async (prompt, ctx) => {
        try {
            const r = await spawnCapture('codex', [...args, '--cd', ctx.cwd, prompt], { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(ctx.env ? { env: ctx.env } : {}) });
            return r.code === 0 ? { ok: true, output: r.stdout } : { ok: false, output: r.stdout, error: r.stderr || `exit ${r.code}` };
        }
        catch (e) {
            return { ok: false, output: '', error: e instanceof Error ? e.message : String(e) };
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
// STILL NOT run-verified end to end (needs an authed cursor-agent; claude/codex were each run-verified). The
// Windows launcher is a PowerShell shim and its own version regex rejects the current timestamped version-dir
// shape. resolveSpawnCommand therefore bypasses both scripts and runs the newest verified node.exe + index.js
// bundle directly, shell-free. If that known bundle layout cannot be found, the runner still fail-fasts.
//
// SAFETY: `-p --force --trust` auto-approves shell+write with no verified per-run allowlist/sandbox mapping.
// Until Cursor can really map agentOptions into per-run permissions, skipPermissions is refused outright. The
// wrapper worktree still contains default cursor runs, but it is not a permissions/sandbox substitute for skip.
// Safe default keeps skip OFF (CURSOR_DEFAULT_AGENT_OPTIONS), so the wiring is exercised by tests with fakes.
/**
 * Build the `cursor-agent` argv (pure). Ground-truth from `cursor-agent --help` (#66): base `-p --output-format
 * text` (headless, write+shell access). `--model` is a real flag. skipPermissions is rejected until Cursor has a
 * verified per-run allowlist/sandbox mapping; allowedTools is not emitted because cursor has no per-tool allowlist.
 */
export function cursorRunnerArgs(opts = {}) {
    if (opts.skipPermissions)
        throw new UnsupportedCursorSkipPermissionsError();
    const args = ['-p', '--output-format', 'text'];
    if (opts.model)
        args.push('--model', opts.model);
    return args;
}
/**
 * Headless `cursor-agent` runner. Prompt passed as the trailing positional arg (shell:false, no injection risk;
 * docs show `cursor-agent -p "<prompt>"`). cwd is set via spawn. SCAFFOLD — run-verify against a real
 * cursor-agent before autonomous use (see the block comment above for what is doc-confirmed vs unverified).
 */
export function makeCursorHeadlessRunner(opts = {}, platform = process.platform) {
    const args = cursorRunnerArgs(opts);
    return async (prompt, ctx) => {
        assertCursorRunnerPlatformSupported(platform, ctx.env ?? process.env);
        try {
            const r = await spawnCapture('cursor-agent', [...args, prompt], {
                cwd: ctx.cwd,
                timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                resolvePlatform: platform,
                ...(ctx.env ? { env: ctx.env } : {}),
            });
            return r.code === 0 ? { ok: true, output: r.stdout } : { ok: false, output: r.stdout, error: r.stderr || `exit ${r.code}` };
        }
        catch (e) {
            return { ok: false, output: '', error: e instanceof Error ? e.message : String(e) };
        }
    };
}
const RUNNER_SPECS = {
    claude: { name: 'claude', makeRunner: makeClaudeHeadlessRunner, envAllow: { prefixes: ['ANTHROPIC_', 'CLAUDE_'] } },
    codex: { name: 'codex', makeRunner: makeCodexHeadlessRunner, envAllow: { prefixes: ['OPENAI_', 'CODEX_'] } },
    // cursor keeps only its OWN auth env (CURSOR_); like every runner it never inherits another's vendor key.
    cursor: { name: 'cursor', makeRunner: makeCursorHeadlessRunner, envAllow: { prefixes: ['CURSOR_'] } },
};
/** Resolve a runner spec by name (default 'claude' — byte-identical to the pre-registry behavior). */
export function getRunnerSpec(name = 'claude') {
    return RUNNER_SPECS[name];
}