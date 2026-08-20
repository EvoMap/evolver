import { spawn } from 'node:child_process';
export declare const DEFAULT_TIMEOUT_MS = 600000;
export declare const MAX_AGENT_SESSION_ID_CHARS = 128;
/** Per-stream stdout/stderr capture ceiling. A child can emit indefinitely without growing the parent heap. */
export declare const DEFAULT_MAX_CAPTURE_BYTES = 1048576;
export interface AgentRunContext {
    cwd: string;
    timeoutMs?: number;
    /** Cooperative cancellation. The runner kills the whole spawned process tree when aborted. */
    signal?: AbortSignal;
    /** Environment for the spawned agent. The bridge passes a scrubbed env here (see scrubAgentEnv); undefined → inherit. */
    env?: NodeJS.ProcessEnv;
    /** Explicit opt-in to continue one native harness session. Runner identity prevents cross-harness reuse. */
    resume?: AgentSessionResume;
    /** Request a runner-owned isolated worktree. Currently used only by native Cursor resume. */
    managedWorktreeName?: string;
}
/** Vendor-neutral native session target. The identifier remains opaque to Evolver. */
export interface AgentSessionResume {
    runner: RunnerName;
    sessionId: string;
}
export type AgentSessionResumeErrorCode = 'invalid_session_id' | 'runner_mismatch' | 'unsupported_runner';
export declare class AgentSessionResumeError extends Error {
    readonly code: AgentSessionResumeErrorCode;
    constructor(code: AgentSessionResumeErrorCode, message: string);
}
/** Validate before spawn so malformed or cross-harness session targets always fail closed. */
export declare function validateAgentSessionResume(resume: AgentSessionResume, expectedRunner: RunnerName): AgentSessionResume;
export interface AgentRunResult {
    ok: boolean;
    output: string;
    error?: string;
    failureKind?: 'spawn_failed' | 'timeout' | 'cancelled' | 'permission_denied' | 'non_zero_exit' | 'invalid_output' | 'runtime_error';
    exitCode?: number | null;
    /**
     * Native harness session id reported by the runner, when available.
     * Used as the Learning Ops exact-join key (`traceEvents[].sessionId`) when proxy llm_turn fold cannot supply one.
     */
    sessionId?: string;
    /** Runner-reported worktree used for the run; the bridge must verify it before reading or cleanup. */
    managedWorktreePath?: string;
}
/** Run a coding agent against a working directory with the given instruction. */
export type AgentRunner = (prompt: string, ctx: AgentRunContext) => Promise<AgentRunResult>;
/** Thrown when permission bypass is requested without bounding the agent's tools (would be an unbounded autonomous agent). */
export declare class UnboundedSkipPermissionsError extends Error {
    constructor();
}
/** Thrown when Codex permission options cannot be enforced by its CLI. */
export declare class UnsupportedCodexPermissionOptionsError extends Error {
    constructor();
}
/** Thrown when Cursor skipPermissions is requested before the runner can enforce per-run permissions. */
export declare class UnsupportedCursorSkipPermissionsError extends Error {
    constructor();
}
/** Thrown when Cursor workspace trust is requested without verified host containment. */
export declare class UnsupportedCursorWorkspaceTrustError extends Error {
    constructor();
}
/** Thrown when Gemini permission options cannot be mapped to a verified bounded CLI contract. */
export declare class UnsupportedGeminiPermissionOptionsError extends Error {
    constructor();
}
/** Thrown when Cursor's Windows installation cannot be reduced to a shell-free node.exe + index.js launch. */
export declare class UnsupportedCursorWindowsRunnerError extends Error {
    constructor();
}
export declare function assertCursorRunnerPlatformSupported(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): void;
/**
 * Make a bare command name spawnable shell-free on Windows. `spawn(shell:false)` cannot execute an npm CLI
 * shim (a `.cmd`/`.bat`), and routing through a shell would expose the prompt arg to cmd.exe quoting
 * (injection). npm shims are node wrappers, so we resolve the bare name on PATH and, when it's a node shim,
 * run `node <entry.js>` directly. Cursor's installer uses a PowerShell shim around a bundled
 * `versions/<version>/node.exe + index.js`; that known layout is resolved directly too, without invoking
 * cmd.exe or PowerShell. A native `.exe` (claude) resolves to itself. No-op on POSIX and for any command that
 * is already a path or has an extension. Surfaced by codex/cursor-agent on Windows (#66).
 */
export declare function resolveSpawnCommand(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): {
    cmd: string;
    args: string[];
};
export interface WindowsTreeKillCommand {
    command: 'taskkill.exe';
    args: ['/PID', string, '/T', '/F'];
}
export interface WindowsTreeKillChild {
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'close', listener: (code: number | null) => void): this;
    kill?(signal?: NodeJS.Signals | number): boolean;
}
export type WindowsTreeKillSpawn = (command: string, args: readonly string[], options: {
    shell: false;
    windowsHide: true;
    stdio: 'ignore';
}) => WindowsTreeKillChild;
type WindowsProcessTreeKiller = (pid: number) => Promise<boolean>;
/** Build the shell-free taskkill invocation used for Windows process-tree termination. */
export declare function windowsTreeKillCommand(pid: number): WindowsTreeKillCommand;
/** Run taskkill and report whether Windows accepted the process-tree termination request. */
export declare function killWindowsProcessTree(pid: number, spawnCommand?: WindowsTreeKillSpawn, timeoutMs?: number): Promise<boolean>;
export interface SpawnCaptureOptions {
    cwd: string;
    timeoutMs: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Cleanup subprocesses can shield themselves from repeated SIGINT/SIGTERM instead of cancelling. */
    processSignalMode?: 'cancel' | 'ignore';
    /** Maximum retained bytes for each of stdout and stderr. The original byte count is still reported. */
    maxOutputBytes?: number;
    /** Stream stdout directly to a file when the complete artifact must outlive the subprocess. */
    stdoutFile?: string;
    /** Ownership hook fired only after an exclusive redirected stdout artifact is opened successfully. */
    onStdoutFileOpened?: (path: string) => void;
    /** Test seam for redirected stdout finalization; production callers should use the filesystem defaults. */
    stdoutFileOps?: {
        size(fd: number): number;
        close(fd: number): void;
    };
    resolvePlatform?: NodeJS.Platform;
    /** Test seam for Windows process behavior; production callers should use the default. */
    processPlatform?: NodeJS.Platform;
    /** Test seam for the shell-free Windows taskkill invocation. */
    windowsProcessTreeKiller?: WindowsProcessTreeKiller;
    /** Test seam for deterministic child-process lifecycle tests. */
    spawnCommand?: typeof spawn;
}
/** Thrown when Cursor allowedTools are requested without a verified per-tool CLI allowlist. */
export declare class UnsupportedCursorAllowedToolsError extends Error {
    constructor();
}
export interface SpawnCaptureResult {
    code: number | null;
    stdout: string;
    stderr: string;
    termination: 'exit' | 'timeout' | 'cancelled';
    /** Present on real spawn results; optional so injected legacy test seams remain source-compatible. */
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    stdoutRedirected?: boolean;
}
/** A redirected stdout artifact could not be finalized; the subprocess outcome remains available for classification. */
export declare class SpawnCaptureFinalizeError extends Error {
    readonly result: SpawnCaptureResult;
    constructor(result: SpawnCaptureResult, cause?: unknown);
}
/**
 * Promise wrapper over spawn (shell:false). Optionally writes `input` to stdin; resolves with stdout/exit.
 * On timeout the WHOLE process group is killed, not just the direct child (finding #39.5): an agent spawns
 * tool subprocesses (grandchildren) that would otherwise orphan and leak. On POSIX we spawn detached (the
 * child becomes its own group leader) and SIGKILL the group via the negative pid. Windows runs
 * `taskkill.exe /PID <pid> /T /F` without a shell and waits for that command before resolving.
 */
export declare function spawnCapture(cmd: string, args: readonly string[], opts: SpawnCaptureOptions): Promise<SpawnCaptureResult>;
/** Map the shared process result into the failure taxonomy used by plain-text runners. */
export declare function classifyBasicRunnerResult(runner: 'claude' | 'codex' | 'cursor', result: SpawnCaptureResult, timeoutMs: number, resume?: AgentSessionResume): AgentRunResult;
/** Options shared by built-in headless runners. Runner-specific fields are ignored by other runners. */
type ClaudePermissionMode = 'acceptEdits';
type ClaudeSafeTool = 'Read' | 'Edit' | 'Write' | 'Glob' | 'Grep';
export declare const CLAUDE_SAFE_AUTONOMOUS_TOOLS: readonly ["Read", "Edit", "Write", "Glob", "Grep"];
export interface AgentRunnerOptions {
    /** Bypass permission prompts so the agent can edit autonomously. Default off.
     *  MUST be paired with a non-empty allowedTools (enforced); bypassing prompts without bounding tools
     *  would be an unbounded autonomous agent. */
    skipPermissions?: boolean;
    /** Constrain the agent to these tools (e.g. ['Read', 'Edit', 'Write']); the safety counterpart to
     *  skipPermissions: bypass prompts but bound what the agent can do. */
    allowedTools?: readonly string[];
    /** Trust the workspace only when the bridge provides an isolated worktree. */
    workspaceTrust?: 'isolated-worktree';
    /** Claude's bounded project-edit mode. Unlike skipPermissions, this keeps path permission checks enabled. */
    permissionMode?: ClaudePermissionMode;
    /** Claude tools exposed to the headless session. Autonomous cycles accept only file/search tools. */
    tools?: readonly ClaudeSafeTool[];
    /** Pin a model (e.g. 'claude-sonnet-4-6'). */
    model?: string;
}
export declare function hasBoundedClaudeFileAccess(opts: AgentRunnerOptions | undefined): boolean;
/** @deprecated use AgentRunnerOptions; kept for back-compat (#91 item 6 rename). */
export type ClaudeRunnerOptions = AgentRunnerOptions;
/** @deprecated use AgentRunnerOptions; Codex shares the exact option shape. */
export type CodexRunnerOptions = AgentRunnerOptions;
/**
 * Build the `claude -p` argv for the given options (pure and testable without spawning).
 * Safety invariant: skipPermissions (bypassing prompts) is only allowed together with a non-empty
 * allowedTools; otherwise it would be an unattended agent with full tools and no gate; refuse loudly.
 */
export declare function claudeRunnerArgs(opts?: AgentRunnerOptions, resume?: AgentSessionResume): string[];
/**
 * Build a headless `claude -p` agent runner. Prompt is fed via stdin (no shell, no argv length limit).
 * For unattended edits, prefer permissionMode: 'acceptEdits' with the bounded file/search tool list.
 */
export declare function makeClaudeHeadlessRunner(opts?: AgentRunnerOptions): AgentRunner;
/** Default agent runner: conservative `claude -p --output-format text` (no permission bypass; opt in via makeClaudeHeadlessRunner). */
export declare const claudeHeadlessRunner: AgentRunner;
/**
 * Build the `codex exec` argv (pure). Verified live against codex-cli 0.144.6:
 *  - sandboxed default → `--ask-for-approval never exec --sandbox workspace-write`: edits the workspace
 *    without waiting for interactive approval. The wrapper's worktree + allowedRoots are the outer containment.
 *  - permission overrides fail closed: Codex has no per-tool allowlist, and a Git worktree does not contain
 *    danger-full-access host filesystem or network access.
 */
export declare function codexRunnerArgs(opts?: AgentRunnerOptions): string[];
/** Headless `codex exec` runner. Working root pinned with `--cd`; prompt is sent over stdin. */
export declare function makeCodexHeadlessRunner(opts?: AgentRunnerOptions, spawnCaptureFn?: typeof spawnCapture): AgentRunner;
/** Interpret one bounded Gemini subprocess result. Structured output and diagnostics require complete capture. */
export declare function classifyGeminiRunnerResult(result: SpawnCaptureResult, timeoutMs: number): AgentRunResult;
/** Build verified Gemini CLI argv. The prompt is appended separately as one argv element with shell:false. */
export declare function geminiRunnerArgs(opts?: AgentRunnerOptions): string[];
/** Headless Gemini runner with structured failure classification; stdout text alone never proves execution success. */
export declare function makeGeminiHeadlessRunner(opts?: AgentRunnerOptions, removeTempDir?: (path: string) => void): AgentRunner;
/**
 * Build the `cursor-agent` argv (pure). Ground-truth from `cursor-agent --help` (#66): base `-p --output-format
 * text` (headless, write+shell access). `--model` is a real flag. skipPermissions is rejected until Cursor has a
 * verified per-run allowlist/sandbox mapping; allowedTools is not emitted because cursor has no per-tool allowlist.
 */
export declare function cursorRunnerArgs(opts?: AgentRunnerOptions, resume?: AgentSessionResume, managedWorktreeName?: string): string[];
/**
 * Headless `cursor-agent` runner. Prompt passed as the trailing positional arg (shell:false, no injection risk;
 * docs show `cursor-agent -p "<prompt>"`). cwd is set via spawn. Workspace trust must be certified by the
 * bridge refuses built-in autonomous Cursor until host containment is verified.
 */
export declare function makeCursorHeadlessRunner(opts?: AgentRunnerOptions, platform?: NodeJS.Platform): AgentRunner;
/** A built-in coding-agent harness (#66). */
export type RunnerName = 'claude' | 'codex' | 'cursor' | 'gemini';
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
export {};