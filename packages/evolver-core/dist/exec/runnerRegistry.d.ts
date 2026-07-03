export declare const DEFAULT_TIMEOUT_MS = 600000;
export interface AgentRunContext {
    cwd: string;
    timeoutMs?: number;
    /** Environment for the spawned agent. The bridge passes a scrubbed env here (see scrubAgentEnv); undefined → inherit. */
    env?: NodeJS.ProcessEnv;
}
export interface AgentRunResult {
    ok: boolean;
    output: string;
    error?: string;
}
/** Run a coding agent against a working directory with the given instruction. */
export type AgentRunner = (prompt: string, ctx: AgentRunContext) => Promise<AgentRunResult>;
/** Thrown when permission bypass is requested without bounding the agent's tools (would be an unbounded autonomous agent). */
export declare class UnboundedSkipPermissionsError extends Error {
    constructor();
}
/** Thrown when Cursor skipPermissions is requested before the runner can enforce per-run permissions. */
export declare class UnsupportedCursorSkipPermissionsError extends Error {
    constructor();
}
/** Thrown when Cursor's built-in runner is requested on Windows before its launcher path is run-verified. */
export declare class UnsupportedCursorWindowsRunnerError extends Error {
    constructor();
}
export declare function assertCursorRunnerPlatformSupported(platform?: NodeJS.Platform): void;
/**
 * Make a bare command name spawnable shell-free on Windows. `spawn(shell:false)` cannot execute an npm CLI
 * shim (a `.cmd`/`.bat`), and routing through a shell would expose the prompt arg to cmd.exe quoting
 * (injection). npm shims are node wrappers, so we resolve the bare name on PATH and, when it's a node shim,
 * run `node <entry.js>` directly (shell-free, args passed safely). A native `.exe` (claude) resolves to itself.
 * No-op on POSIX and for any command that is already a path or has an extension. Surfaced by codex on Windows
 * (codex is `codex.cmd`, while claude is `claude.exe`), #66.
 */
export declare function resolveSpawnCommand(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): {
    cmd: string;
    args: string[];
};
/**
 * Promise wrapper over spawn (shell:false). Optionally writes `input` to stdin; resolves with stdout/exit.
 * On timeout the WHOLE process group is killed, not just the direct child (finding #39.5): an agent spawns
 * tool subprocesses (grandchildren) that would otherwise orphan and leak. On POSIX we spawn detached (the
 * child becomes its own group leader) and SIGKILL the group via the negative pid; Windows falls back to a
 * direct kill (different process-group semantics).
 */
export declare function spawnCapture(cmd: string, args: readonly string[], opts: {
    cwd: string;
    timeoutMs: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
}>;
/** Options for a built-in headless runner (claude / codex share the shape and the skip⇒bounded invariant). */
export interface AgentRunnerOptions {
    /** Bypass permission prompts so the agent can edit autonomously (required for unattended use). Default off.
     *  MUST be paired with a non-empty allowedTools (enforced) — bypassing prompts without bounding tools
     *  would be an unbounded autonomous agent. */
    skipPermissions?: boolean;
    /** Constrain the agent to these tools (e.g. ['Read', 'Edit', 'Write']) — the safety counterpart to
     *  skipPermissions: bypass prompts but bound what the agent can do. */
    allowedTools?: readonly string[];
    /** Pin a model (e.g. 'claude-sonnet-4-6'). */
    model?: string;
}
/** @deprecated use AgentRunnerOptions — kept for back-compat (#91 item 6 rename). */
export type ClaudeRunnerOptions = AgentRunnerOptions;
/** @deprecated use AgentRunnerOptions — codex shares the exact option shape. */
export type CodexRunnerOptions = AgentRunnerOptions;
/**
 * Build the `claude -p` argv for the given options (pure — testable without spawning).
 * Safety invariant: skipPermissions (bypassing prompts) is only allowed together with a non-empty
 * allowedTools — otherwise it would be an unattended agent with full tools and no gate; refuse loudly.
 */
export declare function claudeRunnerArgs(opts?: AgentRunnerOptions): string[];
/**
 * Build a headless `claude -p` agent runner. Prompt fed via stdin (no shell, no argv length limit). For
 * unattended evolution set { skipPermissions: true, allowedTools: ['Read','Edit','Write'] } — bypass the
 * permission prompts but bound the agent to file edits. Validated end to end against a real agent.
 */
export declare function makeClaudeHeadlessRunner(opts?: AgentRunnerOptions): AgentRunner;
/** Default agent runner: conservative `claude -p --output-format text` (no permission bypass; opt in via makeClaudeHeadlessRunner). */
export declare const claudeHeadlessRunner: AgentRunner;
/**
 * Build the `codex exec` argv (pure). Verified live against codex-cli 0.137.0:
 *  - sandboxed default → `exec --sandbox workspace-write`: edits the workspace non-interactively (read-only,
 *    the codex default, cannot write). The wrapper's worktree + allowedRoots are the outer containment.
 *  - skipPermissions (bounded) → `exec --dangerously-bypass-approvals-and-sandbox`: full bypass, intended for
 *    an already-externally-sandboxed run (our throwaway worktree). The `skip⇒bounded` invariant is the explicit
 *    acknowledgement guard, same shape as claude.
 */
export declare function codexRunnerArgs(opts?: AgentRunnerOptions): string[];
/** Headless `codex exec` runner. Working root pinned with `--cd`; prompt is the trailing positional arg (shell:false). */
export declare function makeCodexHeadlessRunner(opts?: AgentRunnerOptions): AgentRunner;
/**
 * Build the `cursor-agent` argv (pure). Ground-truth from `cursor-agent --help` (#66): base `-p --output-format
 * text` (headless, write+shell access). `--model` is a real flag. skipPermissions is rejected until Cursor has a
 * verified per-run allowlist/sandbox mapping; allowedTools is not emitted because cursor has no per-tool allowlist.
 */
export declare function cursorRunnerArgs(opts?: AgentRunnerOptions): string[];
/**
 * Headless `cursor-agent` runner. Prompt passed as the trailing positional arg (shell:false, no injection risk;
 * docs show `cursor-agent -p "<prompt>"`). cwd is set via spawn. SCAFFOLD — run-verify against a real
 * cursor-agent before autonomous use (see the block comment above for what is doc-confirmed vs unverified).
 */
export declare function makeCursorHeadlessRunner(opts?: AgentRunnerOptions, platform?: NodeJS.Platform): AgentRunner;
/** A built-in coding-agent harness (#66). cursor is a SCAFFOLD — its runner is unverified (see cursorRunnerArgs). */
export type RunnerName = 'claude' | 'codex' | 'cursor';
/** A harness runner: how to launch it + which env auth prefixes it (and ONLY it) may keep (#66). */
export interface AgentRunnerSpec {
    name: RunnerName;
    makeRunner: (opts?: AgentRunnerOptions) => AgentRunner;
    /** Per-runner auth env — only this runner's keys reach it (claude never gets OPENAI_, codex never gets ANTHROPIC_). */
    envAllow: {
        prefixes: readonly string[];
        keys?: readonly string[];
    };
}
/** Resolve a runner spec by name (default 'claude' — byte-identical to the pre-registry behavior). */
export declare function getRunnerSpec(name?: RunnerName): AgentRunnerSpec;