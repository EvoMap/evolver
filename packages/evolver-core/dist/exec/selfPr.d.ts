import { type ReadManifest } from './selfPrObfuscation.js';
export interface SelfPrGates {
    /** Minimum outcome score. Default 0.9. */
    minScore: number;
    /** Minimum consecutive-success streak. Default 2. */
    minStreak: number;
    /** Maximum changed files. Default 5. */
    maxFiles: number;
    /** Maximum changed lines. Default 200. */
    maxLines: number;
    /** Cooldown between self-PRs (ms). Default 24h. */
    cooldownMs: number;
}
export declare const DEFAULT_SELF_PR_GATES: SelfPrGates;
export interface SelfPrEvalInput {
    /** Master opt-in. Default-off: when false/undefined the PR is never created. */
    enabled: boolean;
    /** Deny-by-default repo allowlist. Empty = deny everything (the safe default). */
    allowedRoots: readonly string[];
    repoRoot: string;
    outcome: {
        status: string;
        score: number;
    };
    successStreak?: number;
    changedFiles: readonly string[];
    blastLines?: number;
    /** Dedup/cooldown state (supplied from a SelfPrState store). */
    lastPrAt?: string | null;
    recentDiffHashes?: readonly string[];
    diffHash?: string;
    now?: number;
}
export interface SelfPrDecision {
    eligible: boolean;
    reason: string;
}
/**
 * Decide whether a self-PR may be created. Pure — combines every gate and returns the FIRST failing reason, so
 * the default (disabled, empty allowlist) is always a clean refusal that runs nothing.
 */
export declare function evaluateSelfPr(input: SelfPrEvalInput, gates?: SelfPrGates): SelfPrDecision;
/** Run a `gh`/`git` subcommand. Inject a fake in tests; the default would shell out (never invoked unless eligible). */
export type GhRunner = (args: readonly string[], cwd: string) => Promise<{
    ok: boolean;
    stdout: string;
    stderr?: string;
}>;
/** Scan text for secrets before any push. Return leaked:true to BLOCK. Inject e.g. the hub sanitize check. */
export type LeakScan = (text: string) => {
    leaked: boolean;
    detail?: string;
};
export interface CreateSelfPrDeps {
    gh: GhRunner;
    leakScan?: LeakScan;
    /**
     * Injectable reader for `public.manifest.json` (the obfuscate guard). Tests pass a fake so they don't depend
     * on a real manifest on disk. When omitted, defaults to reading `<repoRoot>/public.manifest.json`. A missing /
     * unreadable / invalid manifest is FAIL-CLOSED: every changed file is treated as obfuscated → the PR is blocked.
     */
    readManifest?: ReadManifest;
}
export interface CreateSelfPrContent {
    branch: string;
    title: string;
    body: string;
    /** The unified diff (scanned for leaks before pushing). */
    diff: string;
    base?: string;
}
export interface CreateSelfPrResult {
    created: boolean;
    reason: string;
    url?: string;
}
/**
 * Create a DRAFT pull request for an eligible self-mutation. Re-checks eligibility (so it can't be bypassed),
 * blocks any change touching an OBFUSCATED file (fail-closed manifest), leak-scans the diff + body, then stages
 * ONLY the agent's changed files (never `git add -A`), commits, pushes the branch and opens the PR with
 * `gh pr create --draft`. ALWAYS draft, NEVER merges. Any gh failure is returned, not thrown.
 */
export declare function createDraftSelfPr(evalInput: SelfPrEvalInput, content: CreateSelfPrContent, deps: CreateSelfPrDeps, gates?: SelfPrGates): Promise<CreateSelfPrResult>;