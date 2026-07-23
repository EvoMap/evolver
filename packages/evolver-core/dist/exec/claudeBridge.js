// The Claude Code execution bridge — the REAL implementation of CycleEngine's `execute` seam (ported from
// v1's exec bridge, EVOLVE_EXEC_BRIDGE-gated). It renders the mutation into an instruction, runs a coding
// agent against a working directory, measures proof-of-work from the git diff, and (optionally) runs a
// validation hook to decide success. Everything external (the agent, git, validation) is an injected seam,
// so the whole bridge is unit-testable with fakes and NEVER spawns a real agent in tests.
//
// The runner layer (how to spawn a CLI shell-free, the per-runner argv/factories, the runner registry) lives
// in ./runnerRegistry.ts (#91 item 6); this file is the bridge orchestration around it. Env scrubbing stays
// here — it is a bridge-side security control, not a runner concern.
//
// SAFETY: default-OFF. The factory throws ExecBridgeDisabledError unless explicitly enabled (opts.enabled)
// or EVOLVE_EXEC_BRIDGE === '1'. Wiring it in by accident must fail loudly rather than silently spawn an
// autonomous agent.
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath, sep, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { closeSync, lstatSync, mkdtempSync, openSync, realpathSync, rmdirSync, rmSync, writeFileSync, } from 'node:fs';
import { renderExecPrompt } from './prompt.js';
import { parseGitShortstat, gitDiffProof } from './proofOfWork.js';
// Policy enforcement core (#107): checkPolicy runs the always-on global guards (blast hard cap +
// protected paths + destructive deletes) on EVERY exec — gene or not — plus the per-gene constraints when a
// gene supplies them. It supersedes the old gene-gated `checkChangeConstraints` call (the no-gene-no-guard hole).
import { checkPolicy, summarizeViolations } from './policy/index.js';
import { spawnCapture, SpawnCaptureFinalizeError, getRunnerSpec, DEFAULT_TIMEOUT_MS } from './runnerRegistry.js';
// Re-export the runner layer so existing importers of ./claudeBridge.js (and the `exec` namespace) keep their
// surface after the #91-6 split — the registry simply has a clearer home now.
export { resolveSpawnCommand, spawnCapture, DEFAULT_MAX_CAPTURE_BYTES, UnboundedSkipPermissionsError, UnsupportedCursorSkipPermissionsError, UnsupportedGeminiPermissionOptionsError, claudeRunnerArgs, makeClaudeHeadlessRunner, claudeHeadlessRunner, codexRunnerArgs, makeCodexHeadlessRunner, cursorRunnerArgs, makeCursorHeadlessRunner, getRunnerSpec, geminiRunnerArgs, makeGeminiHeadlessRunner, classifyGeminiRunnerResult, } from './runnerRegistry.js';
export class ExecBridgeDisabledError extends Error {
    constructor() {
        super('exec bridge is disabled — set EVOLVE_EXEC_BRIDGE=1 or pass { enabled: true } to enable agent execution');
        this.name = 'ExecBridgeDisabledError';
    }
}
/** Thrown when the agent's working directory is outside the configured allowedRoots (deny-by-default guardrail). */
export class ExecBridgeForbiddenError extends Error {
    constructor(cwd) {
        super(`exec bridge refused: cwd ${cwd} is not within any allowedRoots — an autonomous agent may only edit allowlisted repos`);
        this.name = 'ExecBridgeForbiddenError';
    }
}
/**
 * Thrown when a FULL-ACCESS (or unverified) agent run is requested without worktree isolation. The throwaway
 * worktree is the containment WE control — allowedRoots gates the cwd but cannot stop an auto-approved or
 * unsandboxed process writing/running outside it. Gated runners:
 *  - codex with skipPermissions → `--sandbox danger-full-access` (no inner OS sandbox). Without skip it stays
 *    workspace-write, so only the skip path is gated.
 *  - cursor default → gated UNCONDITIONALLY. cursor-agent base `-p` already documents write+shell access, cursor
 *    skipPermissions is rejected by the runner layer, and the scaffold remains unverified (#66/#181) — so default
 *    cursor still needs the wrapper worktree rather than risk mutating the real tree.
 * claude is exempt: its skip is bounded by --allowedTools (finding #80).
 */
export class UnsandboxedFullAccessRequiresIsolationError extends Error {
    constructor() {
        super('a full-access or unverified agent run (codex --sandbox danger-full-access, or any cursor scaffold run) can auto-approve shell+write and requires isolation: "worktree" — refusing to run it against the real working tree');
        this.name = 'UnsandboxedFullAccessRequiresIsolationError';
    }
}
export class UnsafeWorktreePathError extends Error {
    constructor(reason) {
        super(`worktree isolation refused: ${reason}`);
        this.name = 'UnsafeWorktreePathError';
    }
}
function errorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}
function assertPathAbsent(path) {
    try {
        lstatSync(path);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return;
        throw error;
    }
    throw new UnsafeWorktreePathError('reserved destination already exists');
}
function reserveWorktreePath() {
    // The random 0700 container is atomically created by the OS. The git destination remains absent inside it,
    // so `git worktree add` cannot adopt an attacker-precreated path from the shared temp directory.
    const container = mkdtempSync(joinPath(tmpdir(), 'evolver-wt-'));
    const containerStat = lstatSync(container);
    if (containerStat.isSymbolicLink() || !containerStat.isDirectory()) {
        throw new UnsafeWorktreePathError('temporary reservation is not a real directory');
    }
    const workDir = joinPath(container, 'worktree');
    assertPathAbsent(workDir);
    return {
        container,
        containerDev: containerStat.dev,
        containerIno: containerStat.ino,
        workDir,
        expectedRealPath: joinPath(realpathSync(container), 'worktree'),
    };
}
function verifyWorktreePath(reservation) {
    const stat = lstatSync(reservation.workDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UnsafeWorktreePathError('git worktree destination is not a real directory');
    }
    if (realpathSync(reservation.workDir) !== reservation.expectedRealPath) {
        throw new UnsafeWorktreePathError('git worktree destination resolves outside its reservation');
    }
    return { dev: stat.dev, ino: stat.ino };
}
function worktreePathStillOwned(reservation, identity) {
    try {
        const stat = lstatSync(reservation.workDir);
        return !stat.isSymbolicLink()
            && stat.isDirectory()
            && stat.dev === identity.dev
            && stat.ino === identity.ino
            && realpathSync(reservation.workDir) === reservation.expectedRealPath;
    }
    catch {
        return false;
    }
}
function removeEmptyReservation(reservation) {
    try {
        const stat = lstatSync(reservation.container);
        if (stat.isSymbolicLink() || !stat.isDirectory()
            || stat.dev !== reservation.containerDev || stat.ino !== reservation.containerIno)
            return;
        rmdirSync(reservation.container);
    }
    catch (error) {
        // Never recurse through a path that may have been replaced. Empty, owned reservations are the only thing
        // removed directly; non-empty or already-gone containers are intentionally left for safe diagnosis.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? ''))
            throw error;
    }
}
async function cleanupWorktreeReservation(reservation, identity, git, repoCwd) {
    let cleanupIdentity = identity;
    if (!cleanupIdentity) {
        try {
            cleanupIdentity = verifyWorktreePath(reservation);
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
            // `git worktree add` may register metadata before failing without creating the destination. Give Git a
            // signal-shielded chance to prune that partial registration, then reclaim only the still-empty container.
            try {
                await git(['worktree', 'remove', '--force', reservation.workDir], repoCwd, undefined, { processSignalMode: 'ignore' });
            }
            catch { /* no child exists, so an unregistered cleanup failure is harmless */ }
            removeEmptyReservation(reservation);
            return;
        }
    }
    if (cleanupIdentity) {
        if (!worktreePathStillOwned(reservation, cleanupIdentity)) {
            throw new UnsafeWorktreePathError('verified worktree path changed before cleanup');
        }
        await git(['worktree', 'remove', '--force', reservation.workDir], repoCwd, undefined, { processSignalMode: 'ignore' });
        assertPathAbsent(reservation.workDir);
    }
    removeEmptyReservation(reservation);
}
/** Whether `child` is the same as, or nested under, `root` (both resolved to absolute paths). */
function isWithinRoot(child, root) {
    const c = resolvePath(child);
    const r = resolvePath(root);
    return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}
/**
 * Sensitive env keys to strip before spawning an agent/tool (finding #39.2): evolver/hub/cloud secrets must
 * not be inherited by an autonomous agent (it could exfiltrate them via its tools). The base keeps only NEUTRAL
 * system env — vendor auth is NOT in the base; each runner contributes its OWN via envAllow (#66), so one
 * runner's key (e.g. ANTHROPIC_) is never handed to another agent (e.g. codex).
 */
// WHITELIST, fail-safe (#39.2 / #46): default-DENY — only explicitly-allowed env vars reach the agent. A
// denylist of secret-shaped names can miss a future sensitive var; a whitelist can't. The base allow-set is
// ONLY NEUTRAL system env (no vendor auth) — per-runner auth (ANTHROPIC_/CLAUDE_ for claude, OPENAI_/CODEX_ for
// codex) is contributed by each runner's envAllow (#66), so one runner's key is never handed to another agent.
// Callers extend via opts.allowKeys / allowPrefixes when an agent legitimately needs more.
const ALLOW_ENV_PREFIXES = ['XDG_', 'LC_', 'NPM_CONFIG_'];
const ALLOW_ENV_KEYS = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'PWD', 'HOSTNAME',
    'TMPDIR', 'TMP', 'TEMP', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    // Windows OS essentials (absent on POSIX → no-op there): a process can't run, resolve PATHEXT shims, or find
    // its own per-user config/auth dir without these. They are OS runtime vars, NOT app secrets — the secret
    // env (NODE_SECRET/AWS_*/GH_TOKEN/vendor keys) is still denied by the whitelist. Their absence is why an
    // npm-installed agent (codex) failed on Windows while the native claude.exe happened to run (#66).
    'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
]);
/**
 * Whitelist-filter `env` for a spawned agent/tool: keep ONLY the minimal runtime env + the caller-declared
 * extras (the runner's own auth via allowPrefixes/allowKeys); drop everything else. Fail-safe by construction —
 * an unlisted var never leaks.
 */
export function scrubAgentEnv(env, opts = {}) {
    const allowKeys = new Set([...ALLOW_ENV_KEYS, ...(opts.allowKeys ?? [])]);
    const allowPrefixes = [...ALLOW_ENV_PREFIXES, ...(opts.allowPrefixes ?? [])];
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined)
            continue;
        // Windows treats env keys case-insensitively, but plain JS objects can contain both PATH and Path. Package
        // runners such as pnpm may prepend their bins to PATH while the inherited user executables remain in Path.
        // Canonicalize those aliases below so the whitelist does not silently discard either half.
        if (process.platform === 'win32' && k.toLowerCase() === 'path')
            continue;
        if (allowKeys.has(k) || allowPrefixes.some((p) => k.startsWith(p)))
            out[k] = v;
    }
    if (process.platform === 'win32') {
        const pathValues = Object.entries(env)
            .filter(([key, value]) => key.toLowerCase() === 'path' && value !== undefined)
            .sort(([a], [b]) => a === 'PATH' ? -1 : b === 'PATH' ? 1 : 0)
            .map(([, value]) => value);
        const seen = new Set();
        const merged = pathValues.flatMap((value) => value.split(';')).filter((entry) => {
            if (!entry)
                return false;
            const key = entry.toLowerCase();
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        if (merged.length > 0)
            out['PATH'] = merged.join(';');
    }
    return out;
}
class ExecBridgeRunCancelledError extends Error {
    constructor() {
        super('exec bridge run cancelled');
        this.name = 'ExecBridgeRunCancelledError';
    }
}
class GitProofError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GitProofError';
    }
}
class GitOutputTruncatedError extends GitProofError {
    constructor(bytes) {
        super(`git output exceeded the capture limit (${String(bytes ?? 'unknown')} bytes)`);
        this.name = 'GitOutputTruncatedError';
    }
}
function cancelledExecutionResult(run) {
    return {
        outcome: { status: 'failed', score: 0.1, reason: 'execution cancelled' },
        strongEvidence: false,
        failureKind: 'cancelled',
        exitCode: run?.exitCode ?? null,
        ...(run ? { sessionLog: run.error ? `${run.output}\n${run.error}` : run.output } : {}),
    };
}
function failedProofExecutionResult(run, error, proofOfWork) {
    return {
        outcome: { status: 'failed', score: 0.1, reason: `execution proof failed: ${error.message}` },
        ...(proofOfWork ? { proofOfWork } : {}),
        strongEvidence: false,
        failureKind: run.failureKind ?? 'runtime_error',
        exitCode: run.exitCode ?? null,
        sessionLog: run.error ? `${run.output}\n${run.error}` : run.output,
    };
}
/** Default git runner: every incomplete command result fails closed. */
export const defaultGitRunner = async (args, cwd, signal, options) => {
    let result;
    try {
        result = await spawnCapture('git', args, {
            cwd,
            timeoutMs: 30_000,
            env: scrubAgentEnv(process.env),
            ...(signal ? { signal } : {}),
            ...(options?.processSignalMode ? { processSignalMode: options.processSignalMode } : {}),
        });
    }
    catch {
        throw new GitProofError('git command failed to start or capture output');
    }
    if (result.termination === 'cancelled')
        throw new ExecBridgeRunCancelledError();
    if (result.termination === 'timeout')
        throw new GitProofError('git command timed out');
    if (result.stdoutTruncated)
        throw new GitOutputTruncatedError(result.stdoutBytes);
    if (result.code !== 0)
        throw new GitProofError(`git command exited with code ${result.code}`);
    return result.stdout;
};
/** Stream a complete git patch to disk so large diffs never need to be retained in the Node heap. */
async function writeDefaultGitPatch(args, cwd, destination, signal, onDestinationOpened) {
    const result = await spawnCapture('git', args, {
        cwd,
        timeoutMs: 30_000,
        env: scrubAgentEnv(process.env),
        stdoutFile: destination,
        ...(onDestinationOpened ? { onStdoutFileOpened: onDestinationOpened } : {}),
        ...(signal ? { signal } : {}),
    });
    if (result.termination === 'cancelled')
        throw new ExecBridgeRunCancelledError();
    if (result.termination === 'timeout')
        throw new GitProofError('git patch capture timed out');
    if (result.code !== 0)
        throw new GitProofError(`git patch capture exited with code ${result.code}`);
}
export const defaultGitPatchWriter = (args, cwd, destination, signal, onDestinationOpened) => (writeDefaultGitPatch(args, cwd, destination, signal, onDestinationOpened));
function writePrivatePatchFile(path, patch) {
    let fd;
    let ownsFile = false;
    try {
        fd = openSync(path, 'wx', 0o600);
        ownsFile = true;
        writeFileSync(fd, patch, { encoding: 'utf8' });
        closeSync(fd);
        fd = undefined;
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* best-effort close before removing our artifact */ }
        }
        if (ownsFile) {
            try {
                rmSync(path, { force: true });
            }
            catch { /* preserve the persistence failure */ }
        }
        throw error;
    }
}
/**
 * Build the `execute` function CycleEngine/runEvolutionCycle consume. Default-off: throws
 * ExecBridgeDisabledError on first call unless enabled.
 */
export function makeClaudeExecBridge(opts) {
    const enabled = opts.enabled ?? (process.env['EVOLVE_EXEC_BRIDGE'] === '1');
    const spec = getRunnerSpec(opts.runner); // #66: claude (default, byte-identical) | codex
    const agent = opts.agent ?? spec.makeRunner(opts.agentOptions);
    const git = opts.git ?? defaultGitRunner;
    const gitPatchWriter = opts.gitPatchWriter ?? (git === defaultGitRunner ? defaultGitPatchWriter : undefined);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // secure by default; only THIS runner's auth env reaches it (claude never gets OPENAI_, codex never ANTHROPIC_, #66)
    const agentEnv = opts.scrubEnv === false ? undefined : scrubAgentEnv(process.env, { allowPrefixes: spec.envAllow.prefixes, ...(spec.envAllow.keys ? { allowKeys: spec.envAllow.keys } : {}) });
    // Fail-fast when a run that can write/execute against the tree with no inner sandbox we control is requested
    // without the throwaway worktree as containment (allowedRoots gates the cwd but can't stop a write outside it).
    // Only when WE build the runner — an injected `agent` bypasses the built-in runner:
    //  - codex: only its skip path emits --sandbox danger-full-access; without skip it stays workspace-write.
    //  - cursor: gated UNCONDITIONALLY. cursor-agent base `-p` already has write+shell access, its skipPermissions
    //    path is refused by runnerRegistry, and the runner is an unverified scaffold (#66/#181), so we do not let
    //    default cursor touch the real tree until run-verified. (Bugbot High #181)
    // claude is exempt — its skip is bounded by --allowedTools (finding #80).
    const needsIsolation = opts.runner === 'cursor' || opts.runner === 'gemini'
        || (opts.runner === 'codex' && opts.agentOptions?.skipPermissions === true);
    if (!opts.agent && needsIsolation && opts.isolation !== 'worktree') {
        throw new UnsandboxedFullAccessRequiresIsolationError();
    }
    return async (mutation, decision) => {
        if (!enabled)
            throw new ExecBridgeDisabledError();
        // Deny-by-default guardrail: an autonomous agent may only edit allowlisted repos. Checked before the
        // agent is ever spawned, so a forbidden cwd never runs anything.
        if (opts.allowedRoots !== undefined && !opts.allowedRoots.some((root) => isWithinRoot(opts.cwd, root))) {
            throw new ExecBridgeForbiddenError(opts.cwd);
        }
        const resolveId = decision.selectedAssetId ?? decision.selectedGeneId;
        const resolved = resolveId && opts.resolveGene ? await opts.resolveGene(resolveId) : null;
        // Trust gate (finding #39.3): for unattended runs, only embed a gene we trust — an untrusted gene's strategy
        // is dropped so a poisoned strategy can't drive the autonomous agent (the run falls back to innovate).
        const gene = resolved && (!opts.requireTrustedGene || resolved.trusted === true) ? resolved : null;
        const prompt = renderExecPrompt({
            mutation,
            decision,
            ...(gene ? { gene } : {}),
            ...(opts.validationCmds ? { validationCmds: opts.validationCmds } : {}),
            // use-case ①: inject the personality style block from the state applySelectForRun just persisted.
            ...(opts.personality ? { personality: opts.personality.currentState() } : {}),
        });
        // Isolation: atomically reserve an unpredictable private temp container, then let git create the absent
        // worktree path inside it. Cleanup is armed only after git succeeds and the resulting directory is verified.
        const isolate = opts.isolation === 'worktree';
        if (opts.signal?.aborted)
            return cancelledExecutionResult(undefined);
        const reservation = isolate ? reserveWorktreePath() : undefined;
        const workDir = reservation?.workDir ?? opts.cwd;
        let worktreeIdentity;
        let result;
        let observedRun;
        let patchRef;
        let ownsPatchRef = false;
        let preservePatchRef = false;
        let failedProof;
        const proofGit = async (args, cwd, checkCancellationAfter = true) => {
            if (opts.signal?.aborted)
                throw new ExecBridgeRunCancelledError();
            try {
                const output = await git(args, cwd, opts.signal);
                if (checkCancellationAfter && opts.signal?.aborted)
                    throw new ExecBridgeRunCancelledError();
                return output;
            }
            catch (error) {
                if (error instanceof ExecBridgeRunCancelledError || opts.signal?.aborted)
                    throw error;
                if (error instanceof GitProofError)
                    throw error;
                throw new GitProofError('git state proof failed');
            }
        };
        try {
            if (reservation) {
                await proofGit(['worktree', 'add', '--detach', workDir, 'HEAD'], opts.cwd, false);
                worktreeIdentity = verifyWorktreePath(reservation);
                if (opts.signal?.aborted)
                    throw new ExecBridgeRunCancelledError();
            }
            const run = await agent(prompt, {
                cwd: workDir,
                timeoutMs,
                ...(agentEnv ? { env: agentEnv } : {}),
                ...(opts.signal ? { signal: opts.signal } : {}),
            });
            observedRun = run;
            if (run.failureKind === 'cancelled' || opts.signal?.aborted)
                throw new ExecBridgeRunCancelledError();
            // A worktree can contain three independent change surfaces after the agent exits: staged tracked changes,
            // unstaged tracked changes, and untracked files. `git diff` alone sees only the second. In an isolated
            // worktree it is safe to mark untracked files intent-to-add temporarily, which makes one `git diff HEAD`
            // snapshot cover all three without staging their contents or disturbing the agent's existing staged state.
            // Reset only those temporary index entries before validation so hooks observe the state the agent left.
            const untrackedFiles = isolate
                ? (await proofGit(['ls-files', '--others', '--exclude-standard', '-z'], workDir)).split('\0').filter(Boolean)
                : [];
            if (untrackedFiles.length > 0)
                await proofGit(['add', '--intent-to-add', '--', ...untrackedFiles], workDir);
            let stat;
            let changedFiles;
            let numstat;
            let patch = '';
            const resetIntentToAdd = async () => {
                if (untrackedFiles.length > 0) {
                    await git(['reset', '--quiet', '--', ...untrackedFiles], workDir);
                }
            };
            try {
                stat = parseGitShortstat(await proofGit(['diff', '--shortstat', 'HEAD'], workDir));
                changedFiles = (await proofGit(['diff', '--name-only', 'HEAD'], workDir)).split('\n').map((s) => s.trim()).filter(Boolean);
                numstat = await proofGit(['diff', '--numstat', 'HEAD'], workDir);
                if (isolate && stat.files > 0) {
                    if (gitPatchWriter) {
                        patchRef = joinPath(tmpdir(), `evolver-patch-${randomUUID()}.diff`);
                        try {
                            await gitPatchWriter(['diff', '--binary', '--full-index', 'HEAD'], workDir, patchRef, opts.signal, () => { ownsPatchRef = true; });
                            // A successful writer owns its result even when an older injected implementation ignores the
                            // optional callback. On rejection, only the callback can prove that a partial file is ours.
                            ownsPatchRef = true;
                        }
                        catch (error) {
                            if (error instanceof ExecBridgeRunCancelledError || opts.signal?.aborted)
                                throw error;
                            if (error instanceof SpawnCaptureFinalizeError) {
                                if (error.result.termination === 'cancelled')
                                    throw new ExecBridgeRunCancelledError();
                                if (error.result.termination === 'timeout')
                                    throw new GitProofError('git patch capture timed out');
                            }
                            if (error instanceof GitProofError)
                                throw error;
                            throw new GitProofError('git patch capture failed');
                        }
                    }
                    else {
                        patch = await proofGit(['diff', '--binary', '--full-index', 'HEAD'], workDir);
                    }
                }
            }
            catch (error) {
                try {
                    await resetIntentToAdd();
                }
                catch (cleanupError) {
                    if (cleanupError instanceof ExecBridgeRunCancelledError || opts.signal?.aborted) {
                        throw new ExecBridgeRunCancelledError();
                    }
                    // Preserve the primary proof failure for non-cancellation cleanup errors.
                }
                throw error;
            }
            try {
                await resetIntentToAdd();
            }
            catch (error) {
                if (error instanceof ExecBridgeRunCancelledError || opts.signal?.aborted)
                    throw error;
                if (patchRef && ownsPatchRef) {
                    failedProof = gitDiffProof(stat, patchRef);
                    preservePatchRef = true;
                }
                throw new GitProofError('git index cleanup failed');
            }
            if (opts.signal?.aborted)
                throw new ExecBridgeRunCancelledError();
            // ENFORCE policy against the ACTUAL diff (finding: prompt.ts only ADVISES the agent "touch at most N
            // file(s) / never modify X"; this is the hard gate). checkPolicy ALWAYS runs the global guards — the
            // system blast hard cap (EVOLVER_HARD_CAP_FILES/LINES), the critical-protected paths (.env, MEMORY.md,
            // package.json, the evolver skill, …), and destructive deletes of those paths — so a no-gene / no-
            // constraints run is no longer un-guarded. The gene's max_files/max_lines/forbidden_paths layer on top.
            // Any violation fails the cycle no matter what the agent did — even when validation would pass.
            const violations = checkPolicy({ stat, changedFiles, numstat, ...(gene?.constraints ? { constraints: gene.constraints } : {}) });
            if (isolate && stat.files > 0 && !patchRef) {
                // preserve the isolated edits as a patch (the worktree itself is removed); the real repo is untouched
                const destination = joinPath(tmpdir(), `evolver-patch-${randomUUID()}.diff`);
                try {
                    (opts.writePatchFile ?? writePrivatePatchFile)(destination, patch);
                    patchRef = destination;
                    ownsPatchRef = true;
                }
                catch (error) {
                    if (error instanceof GitProofError)
                        throw error;
                    throw new GitProofError('git patch persistence failed');
                }
            }
            const proof = gitDiffProof(stat, patchRef);
            // Success: prefer the authoritative validation hook; otherwise "agent succeeded AND produced a diff".
            let passed = run.ok && stat.files > 0;
            let score = passed ? 0.7 : run.ok ? 0.4 : 0.1; // ran-but-no-change is weak, not a clean failure
            // Only validate a change that already respects the constraints — a constraint-violating diff is never
            // a success regardless of what its tests say.
            if (run.ok && stat.files > 0 && opts.validate && violations.length === 0) {
                if (opts.signal?.aborted)
                    throw new ExecBridgeRunCancelledError();
                const v = await opts.validate(mutation, decision, workDir);
                if (opts.signal?.aborted)
                    throw new ExecBridgeRunCancelledError();
                passed = v.passed;
                score = v.score ?? (v.passed ? 0.9 : 0.2);
            }
            let reason;
            if (violations.length > 0) {
                passed = false;
                score = Math.min(score, 0.1);
                reason = summarizeViolations(violations);
            }
            preservePatchRef = patchRef !== undefined && ownsPatchRef;
            result = {
                outcome: { status: passed ? 'success' : 'failed', score, ...(reason ? { reason } : {}) },
                proofOfWork: proof,
                strongEvidence: passed && stat.files > 0,
                ...(run.failureKind !== undefined ? { failureKind: run.failureKind } : {}),
                ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
                // On a FAILED outcome, hand the agent transcript (stdout + stderr) to the cycle engine as host-side
                // triage context (#279): an empty transcript -> host_no_transcript, a provider-error string ->
                // host_provider_error. Omitted on success (failure-only context; never persisted).
                ...(passed ? {} : { sessionLog: run.error ? `${run.output}\n${run.error}` : run.output }),
            };
        }
        catch (error) {
            if (error instanceof ExecBridgeRunCancelledError || opts.signal?.aborted) {
                result = cancelledExecutionResult(observedRun);
            }
            else if (error instanceof GitProofError && observedRun) {
                result = failedProofExecutionResult(observedRun, error, failedProof);
            }
            else {
                if (reservation) {
                    try {
                        await cleanupWorktreeReservation(reservation, worktreeIdentity, git, opts.cwd);
                    }
                    catch {
                        // Preserve the primary execution error. The abandoned reservation remains private and diagnosable.
                    }
                }
                throw error;
            }
        }
        finally {
            if (!preservePatchRef && ownsPatchRef && patchRef) {
                try {
                    (opts.removePatchFile ?? ((path) => rmSync(path, { force: true })))(patchRef);
                }
                catch { /* best-effort cleanup must not replace the execution result or its primary failure */ }
            }
        }
        if (reservation) {
            try {
                await cleanupWorktreeReservation(reservation, worktreeIdentity, git, opts.cwd);
            }
            catch (error) {
                // A successful run must not hide abandoned edits/resources. Failed and cancelled results retain their
                // primary classification; the private reservation remains available for diagnosis.
                if (result.outcome.status === 'success')
                    throw error;
            }
        }
        return result;
    };
}