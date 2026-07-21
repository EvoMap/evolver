import type { Mutation } from '../wire/index.js';
import type { GeneDecision } from '../algo/geneSelection.js';
import type { ExecutionResult } from '../algo/cycleEngine.js';
import { type GeneStrategyInfo } from './prompt.js';
import type { PersonalityStore } from '../personality/store.js';
import { type AgentRunner, type AgentRunnerOptions, type RunnerName } from './runnerRegistry.js';
export { resolveSpawnCommand, spawnCapture, UnboundedSkipPermissionsError, UnsupportedCursorSkipPermissionsError, UnsupportedGeminiPermissionOptionsError, claudeRunnerArgs, makeClaudeHeadlessRunner, claudeHeadlessRunner, codexRunnerArgs, makeCodexHeadlessRunner, cursorRunnerArgs, makeCursorHeadlessRunner, getRunnerSpec, geminiRunnerArgs, makeGeminiHeadlessRunner, } from './runnerRegistry.js';
export type { AgentRunContext, AgentRunResult, AgentRunner, RunnerName, AgentRunnerOptions, ClaudeRunnerOptions, CodexRunnerOptions, AgentRunnerSpec, } from './runnerRegistry.js';
export interface GitRunnerOptions {
    processSignalMode?: 'cancel' | 'ignore';
}
/** Run a git subcommand in cwd and return its stdout. */
export type GitRunner = (args: readonly string[], cwd: string, signal?: AbortSignal, options?: GitRunnerOptions) => Promise<string>;
/** Resolve the selected gene's learned strategy (for prompt enrichment). */
export type GeneResolver = (geneId: string) => Promise<GeneStrategyInfo | null> | GeneStrategyInfo | null;
/** Decide success from the post-run working tree (e.g. run the gene's validation plan). */
export type ValidateHook = (mutation: Mutation, decision: GeneDecision, cwd: string) => Promise<{
    passed: boolean;
    score?: number;
}> | {
    passed: boolean;
    score?: number;
};
export interface ExecBridgeOptions {
    /** Working directory the agent edits and git is measured in. */
    cwd: string;
    /** Default: headless `claude` runner. Inject a fake in tests. */
    agent?: AgentRunner;
    /** Which built-in runner to use when `agent` is not injected (#66). Default 'claude' (byte-identical). cursor is a scaffold (unverified runner). */
    runner?: RunnerName;
    /** When `agent` is not injected, options for the built-in headless runner (permission bypass / allowed tools / model). */
    agentOptions?: AgentRunnerOptions;
    /** Default: spawns `git`. Inject a fake in tests. */
    git?: GitRunner;
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
     * there, captured as a patch (proof.gitDiff.patchRef), and the worktree is removed. `cwd` must be a git repo.
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
    /** Optional: enrich the prompt with the selected gene's strategy. */
    resolveGene?: GeneResolver;
    /** Optional: validation commands surfaced in the prompt's done-criteria. */
    validationCmds?: readonly string[];
    /** Optional: authoritative success decision after the agent runs. Falls back to "agent ok + produced a diff". */
    validate?: ValidateHook;
    /**
     * Optional evolvable personality (use-case ①): when set, the agent prompt gets a behavioral-style block
     * rendered from the store's CURRENT persisted state. CycleEngine's applySelectForRun has already run and
     * saved the per-run state to this same store before execute() is invoked, so reading currentState() here
     * injects exactly the personality this cycle selected. Pass the SAME PersonalityStore given to CycleEngine.
     * Absent ⇒ no style block (byte-identical to today). Reading is best-effort — a load failure falls back to
     * the store's default state (store.load never throws), it never fails the run.
     */
    personality?: PersonalityStore;
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
 *  - codex with skipPermissions → `--sandbox danger-full-access` (no inner OS sandbox). Without skip it stays
 *    workspace-write, so only the skip path is gated.
 *  - cursor default → gated UNCONDITIONALLY. cursor-agent base `-p` already documents write+shell access, cursor
 *    skipPermissions is rejected by the runner layer, and the scaffold remains unverified (#66/#181) — so default
 *    cursor still needs the wrapper worktree rather than risk mutating the real tree.
 * claude is exempt: its skip is bounded by --allowedTools (finding #80).
 */
export declare class UnsandboxedFullAccessRequiresIsolationError extends Error {
    constructor();
}
/**
 * Whitelist-filter `env` for a spawned agent/tool: keep ONLY the minimal runtime env + the caller-declared
 * extras (the runner's own auth via allowPrefixes/allowKeys); drop everything else. Fail-safe by construction —
 * an unlisted var never leaks.
 */
export declare function scrubAgentEnv(env: NodeJS.ProcessEnv, opts?: {
    allowKeys?: readonly string[];
    allowPrefixes?: readonly string[];
}): NodeJS.ProcessEnv;
/** Default git runner: spawn `git <args>` in cwd, return stdout (empty string on error). Env scrubbed — git never needs evolver/hub secrets. */
export declare const defaultGitRunner: GitRunner;
/**
 * Build the `execute` function CycleEngine/runEvolutionCycle consume. Default-off: throws
 * ExecBridgeDisabledError on first call unless enabled.
 */
export declare function makeClaudeExecBridge(opts: ExecBridgeOptions): (mutation: Mutation, decision: GeneDecision) => Promise<ExecutionResult>;