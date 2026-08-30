import type { Mutation } from '../wire/index.js';
import type { GeneDecision } from '../algo/geneSelection.js';
import type { ExecutionResult } from '../algo/cycleEngine.js';
import { type GeneStrategyInfo } from './prompt.js';
import type { PersonalityStore } from '../personality/store.js';
import type { AgentRunTraceRecorder } from '../trace/learningTrace.js';
import type { PolicyDecision, ProofReference, ToolDecision, ValidatorEvidence } from './executionBinding.js';
import { type AgentRunner, type AgentRunnerOptions, type AgentSessionResume, type RunnerName } from './runnerRegistry.js';
export { resolveSpawnCommand, spawnCapture, DEFAULT_MAX_CAPTURE_BYTES, MAX_AGENT_SESSION_ID_CHARS, AgentSessionResumeError, validateAgentSessionResume, UnboundedSkipPermissionsError, UnsupportedCodexPermissionOptionsError, UnsupportedCursorAllowedToolsError, UnsupportedCursorSkipPermissionsError, UnsupportedCursorWorkspaceTrustError, UnsupportedGeminiPermissionOptionsError, claudeRunnerArgs, makeClaudeHeadlessRunner, claudeHeadlessRunner, codexRunnerArgs, makeCodexHeadlessRunner, cursorRunnerArgs, makeCursorHeadlessRunner, getRunnerSpec, hasBoundedClaudeFileAccess, CLAUDE_SAFE_AUTONOMOUS_TOOLS, geminiRunnerArgs, makeGeminiHeadlessRunner, classifyGeminiRunnerResult, } from './runnerRegistry.js';
export type { AgentRunContext, AgentRunResult, AgentRunner, RunnerName, AgentRunnerOptions, ClaudeRunnerOptions, CodexRunnerOptions, AgentRunnerSpec, AgentSessionResume, } from './runnerRegistry.js';
export interface GitRunnerOptions {
    processSignalMode?: 'cancel' | 'ignore';
}
/** Run a git subcommand in cwd and return its stdout. */
export type GitRunner = (args: readonly string[], cwd: string, signal?: AbortSignal, options?: GitRunnerOptions) => Promise<string>;
export type GitPatchWriter = (args: readonly string[], cwd: string, destination: string, signal?: AbortSignal, 
/** Call immediately after this writer exclusively creates `destination`. */
onDestinationOpened?: () => void) => Promise<void>;
/** Resolve the selected gene's learned strategy (for prompt enrichment). */
export type GeneResolver = (geneId: string) => Promise<GeneStrategyInfo | null> | GeneStrategyInfo | null;
/** Decide success from the post-run working tree (e.g. run the gene's validation plan). */
export interface ValidateHookResult {
    passed: boolean;
    score?: number;
    validator?: ValidatorEvidence;
}
export type ValidateHook = (mutation: Mutation, decision: GeneDecision, cwd: string, signal: AbortSignal) => Promise<ValidateHookResult> | ValidateHookResult;
export interface ExecutionObserver {
    onToolDecision?(decision: ToolDecision, signal?: AbortSignal): Promise<void> | void;
    onPolicyDecision?(decision: PolicyDecision, signal?: AbortSignal): Promise<void> | void;
    onValidatorDecision?(decision: ValidatorEvidence, signal?: AbortSignal): Promise<void> | void;
    onProofReference?(reference: ProofReference, signal?: AbortSignal): Promise<void> | void;
}
export interface ExecBridgeOptions {
    /** Working directory the agent edits and git is measured in. */
    cwd: string;
    /** Default: headless `claude` runner. Inject a fake in tests. */
    agent?: AgentRunner;
    /** Which built-in runner to use when `agent` is not injected (#66). Default 'claude' (byte-identical). cursor is a scaffold (unverified runner). */
    runner?: RunnerName;
    /** Explicit native session continuation. Must name the same runner selected above. */
    resume?: AgentSessionResume;
    /** When `agent` is not injected, options for the built-in headless runner (permission bypass / allowed tools / model). */
    agentOptions?: AgentRunnerOptions;
    /** Default: spawns `git`. Inject a fake in tests. */
    git?: GitRunner;
    /** Optional complete-patch sink. The default streams built-in git output directly to disk. */
    gitPatchWriter?: GitPatchWriter;
    /** Test seam for fallback patch persistence; production callers should use the exclusive private writer. */
    writePatchFile?: (path: string, patch: string) => void;
    /** Test seam for temporary patch cleanup; production callers should use the filesystem default. */
    removePatchFile?: (path: string) => void;
    /** Default: EVOLVE_EXEC_BRIDGE === '1'. Set true to force-enable (e.g. integration tests). */
    enabled?: boolean;
    /**
     * Deny-by-default repo guardrail for autonomous use: when set, the agent may only run in a `cwd` that is
     * within one of these roots. An empty array denies everything (the safe default for a resident loop until
     * repos are explicitly allowlisted). When undefined, no path restriction (caller's responsibility — e.g.
     * tests with fake agents). Autonomous deployments MUST set this.
     */
    allowedRoots?: readonly string[];
    /** Strip evolver/hub/cloud secrets from the agent's environment before spawning (finding #39.2). Default true
     *  (secure by default); the agent keeps ONLY its own runner's auth (claude: ANTHROPIC_/CLAUDE_, codex: OPENAI_/
     *  CODEX_ — #66). Set false only to inherit the full env. */
    scrubEnv?: boolean;
    /**
     * Run the agent in a throwaway git worktree of `cwd` instead of the repo's real working tree (finding #39.4):
     * the agent's edits land in an isolated checkout, never touching the user's working tree. The diff is measured
     * there, captured as a patch (proof.git_diff.patch_ref), and the worktree is removed. `cwd` must be a git repo.
     */
    isolation?: 'worktree';
    /**
     * Only embed a selected gene's strategy into the agent prompt when it is trusted (gene.trusted === true)
     * (finding #39.3): a poisoned/hub-ingested gene's strategy is the injection blast end for an autonomous agent.
     * When true, an untrusted gene is dropped (the run proceeds as innovate, without its strategy). Recommended
     * for unattended runs. Default false (back-compat; local genes are trusted by their author).
     */
    requireTrustedGene?: boolean;
    /** Per-run agent timeout. Default 600_000ms (10 min). */
    timeoutMs?: number;
    /** Cooperative cancellation propagated to the runner process tree. */
    signal?: AbortSignal;
    /** Binding hard limits are intersected with the existing policy/runner controls; never widen local safety. */
    executionLimits?: {
        maxRuntimeMs: number;
        maxFiles: number;
        maxLines: number;
    };
    /** Optional: enrich the prompt with the selected gene's strategy. */
    resolveGene?: GeneResolver;
    /** Optional: validation commands surfaced in the prompt's done-criteria. */
    validationCmds?: readonly string[];
    /** Optional: authoritative success decision after the agent runs. Falls back to "agent ok + produced a diff". */
    validate?: ValidateHook;
    /** Bound execution provenance observer. Failures are authoritative and fail the execution closed. */
    executionObserver?: ExecutionObserver;
    /**
     * Optional evolvable personality (use-case ①): when set, the agent prompt gets a behavioral-style block
     * rendered from the store's CURRENT persisted state. CycleEngine's applySelectForRun has already run and
     * saved the per-run state to this same store before execute() is invoked, so reading currentState() here
     * injects exactly the personality this cycle selected. Pass the SAME PersonalityStore given to CycleEngine.
     * Absent ⇒ no style block (byte-identical to today). Reading is best-effort — a load failure falls back to
     * the store's default state (store.load never throws), it never fails the run.
     */
    personality?: PersonalityStore;
    /**
     * Optional learning-trace recorder (Learning Ops slice 2): when set, the bridge emits `model.called` around
     * each agent spawn and `tool.failed`/`retry.attempted` metadata on failures. Best-effort observability — a
     * recorder/sink failure must never affect the execution result, so every emission is wrapped defensively.
     */
    traceRecorder?: AgentRunTraceRecorder;
}
export declare class ExecBridgeDisabledError extends Error {
    constructor();
}
/** Thrown when the agent's working directory is outside the configured allowedRoots (deny-by-default guardrail). */
export declare class ExecBridgeForbiddenError extends Error {
    constructor(cwd: string);
}
/**
 * Thrown when a FULL-ACCESS (or unverified) agent run is requested without worktree isolation. The throwaway
 * worktree is the containment WE control — allowedRoots gates the cwd but cannot stop an auto-approved or
 * unsandboxed process writing/running outside it. Gated runners:
 *  - codex permission overrides are refused by the runner because it has no enforceable per-tool allowlist.
 *  - cursor default → gated UNCONDITIONALLY. cursor-agent base `-p` already documents write+shell access, cursor
 *    skipPermissions is rejected by the runner layer, and the scaffold remains unverified (#66/#181) — so default
 *    cursor still needs the wrapper worktree rather than risk mutating the real tree.
 * Claude is fail-closed below because a tool-name allowlist does not constrain absolute filesystem paths.
 */
export declare class UnsandboxedFullAccessRequiresIsolationError extends Error {
    constructor();
}
export declare class WorkspaceTrustRequiresIsolationError extends Error {
    readonly code = "WORKSPACE_TRUST_REQUIRES_ISOLATION";
    constructor();
}
export declare class UnsupportedCursorBuiltInRunnerError extends Error {
    constructor();
}
export declare class UnsupportedClaudeBuiltInRunnerError extends Error {
    constructor();
}
export declare class UnsupportedCodexBuiltInRunnerError extends Error {
    constructor();
}
export declare class UnsafeWorktreePathError extends Error {
    constructor(reason: string);
}
/** Whether `child` is the same as, or nested under, `root`, including filesystem symlink resolution. */
export declare function isWithinRoot(child: string, root: string): boolean;
/**
 * Whitelist-filter `env` for a spawned agent/tool: keep ONLY the minimal runtime env + the caller-declared
 * extras (the runner's own auth via allowPrefixes/allowKeys); drop everything else. Fail-safe by construction —
 * an unlisted var never leaks.
 */
export declare function scrubAgentEnv(env: NodeJS.ProcessEnv, opts?: {
    allowKeys?: readonly string[];
    allowPrefixes?: readonly string[];
}): NodeJS.ProcessEnv;
/**
 * 绑定执行不能接受无法收到权威截止时间取消信号的旧验证器或写入器。
 * AbortSignal 本身是协作式的；先拒绝不暴露该信号的回调，避免旧 hook
 * 被静默地当作无界工作运行。
 */
export declare class ExecBridgeCancellationContractError extends Error {
    constructor(hook: 'validate' | 'gitPatchWriter');
}
/** Default git runner: every incomplete command result fails closed. */
export declare const defaultGitRunner: GitRunner;
export declare const defaultGitPatchWriter: GitPatchWriter;
/**
 * Build the `execute` function CycleEngine/runEvolutionCycle consume. Default-off: throws
 * ExecBridgeDisabledError on first call unless enabled.
 */
export declare function makeClaudeExecBridge(opts: ExecBridgeOptions, internal?: {
    cursorWorktreeRoot?: string;
}): (mutation: Mutation, decision: GeneDecision) => Promise<ExecutionResult>;