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
import { resolve as resolvePath, sep, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { renderExecPrompt } from './prompt.js';
import { parseGitShortstat, gitDiffProof } from './proofOfWork.js';
// Policy enforcement core (#107): checkPolicy runs the always-on global guards (blast hard cap +
// protected paths + destructive deletes) on EVERY exec — gene or not — plus the per-gene constraints when a
// gene supplies them. It supersedes the old gene-gated `checkChangeConstraints` call (the no-gene-no-guard hole).
import { checkPolicy, summarizeViolations } from './policy/index.js';
import { spawnCapture, getRunnerSpec, DEFAULT_TIMEOUT_MS } from './runnerRegistry.js';
// Re-export the runner layer so existing importers of ./claudeBridge.js (and the `exec` namespace) keep their
// surface after the #91-6 split — the registry simply has a clearer home now.
export { resolveSpawnCommand, spawnCapture, UnboundedSkipPermissionsError, UnsupportedCursorSkipPermissionsError, claudeRunnerArgs, makeClaudeHeadlessRunner, claudeHeadlessRunner, codexRunnerArgs, makeCodexHeadlessRunner, cursorRunnerArgs, makeCursorHeadlessRunner, getRunnerSpec, } from './runnerRegistry.js';
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
        if (allowKeys.has(k) || allowPrefixes.some((p) => k.startsWith(p)))
            out[k] = v;
    }
    return out;
}
/** Default git runner: spawn `git <args>` in cwd, return stdout (empty string on error). Env scrubbed — git never needs evolver/hub secrets. */
export const defaultGitRunner = async (args, cwd) => {
    try {
        const r = await spawnCapture('git', args, { cwd, timeoutMs: 30_000, env: scrubAgentEnv(process.env) });
        return r.stdout;
    }
    catch {
        return '';
    }
};
/**
 * Build the `execute` function CycleEngine/runEvolutionCycle consume. Default-off: throws
 * ExecBridgeDisabledError on first call unless enabled.
 */
export function makeClaudeExecBridge(opts) {
    const enabled = opts.enabled ?? (process.env['EVOLVE_EXEC_BRIDGE'] === '1');
    const spec = getRunnerSpec(opts.runner); // #66: claude (default, byte-identical) | codex
    const agent = opts.agent ?? spec.makeRunner(opts.agentOptions);
    const git = opts.git ?? defaultGitRunner;
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
    const needsIsolation = opts.runner === 'cursor'
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
        // Isolation: run in a throwaway git worktree so the agent's edits never touch the real working tree.
        const isolate = opts.isolation === 'worktree';
        const workDir = isolate ? joinPath(tmpdir(), `evolver-wt-${mutation.id}`) : opts.cwd;
        if (isolate)
            await git(['worktree', 'add', '--detach', workDir, 'HEAD'], opts.cwd);
        try {
            const run = await agent(prompt, { cwd: workDir, timeoutMs, ...(agentEnv ? { env: agentEnv } : {}) });
            const stat = parseGitShortstat(await git(['diff', '--shortstat'], workDir));
            // ENFORCE policy against the ACTUAL diff (finding: prompt.ts only ADVISES the agent "touch at most N
            // file(s) / never modify X"; this is the hard gate). checkPolicy ALWAYS runs the global guards — the
            // system blast hard cap (EVOLVER_HARD_CAP_FILES/LINES), the critical-protected paths (.env, MEMORY.md,
            // package.json, the evolver skill, …), and destructive deletes of those paths — so a no-gene / no-
            // constraints run is no longer un-guarded. The gene's max_files/max_lines/forbidden_paths layer on top.
            // Any violation fails the cycle no matter what the agent did — even when validation would pass.
            const changedFiles = (await git(['diff', '--name-only'], workDir)).split('\n').map((s) => s.trim()).filter(Boolean);
            const numstat = await git(['diff', '--numstat'], workDir);
            const violations = checkPolicy({ stat, changedFiles, numstat, ...(gene?.constraints ? { constraints: gene.constraints } : {}) });
            let patchRef;
            if (isolate && stat.files > 0) {
                // preserve the isolated edits as a patch (the worktree itself is removed); the real repo is untouched
                patchRef = joinPath(tmpdir(), `evolver-patch-${mutation.id}.diff`);
                writeFileSync(patchRef, await git(['diff'], workDir));
            }
            const proof = gitDiffProof(stat, patchRef);
            // Success: prefer the authoritative validation hook; otherwise "agent succeeded AND produced a diff".
            let passed = run.ok && stat.files > 0;
            let score = passed ? 0.7 : run.ok ? 0.4 : 0.1; // ran-but-no-change is weak, not a clean failure
            // Only validate a change that already respects the constraints — a constraint-violating diff is never
            // a success regardless of what its tests say.
            if (run.ok && opts.validate && violations.length === 0) {
                const v = await opts.validate(mutation, decision, workDir);
                passed = v.passed;
                score = v.score ?? (v.passed ? 0.9 : 0.2);
            }
            let reason;
            if (violations.length > 0) {
                passed = false;
                score = Math.min(score, 0.1);
                reason = summarizeViolations(violations);
            }
            return {
                outcome: { status: passed ? 'success' : 'failed', score, ...(reason ? { reason } : {}) },
                proofOfWork: proof,
                strongEvidence: passed && stat.files > 0,
                // On a FAILED outcome, hand the agent transcript (stdout + stderr) to the cycle engine as host-side
                // triage context (#279): an empty transcript -> host_no_transcript, a provider-error string ->
                // host_provider_error. Omitted on success (failure-only context; never persisted).
                ...(passed ? {} : { sessionLog: run.error ? `${run.output}\n${run.error}` : run.output }),
            };
        }
        finally {
            if (isolate) {
                try {
                    await git(['worktree', 'remove', '--force', workDir], opts.cwd);
                }
                catch { /* best-effort cleanup */ }
            }
        }
    };
}