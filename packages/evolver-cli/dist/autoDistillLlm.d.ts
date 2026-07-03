import { algo, assetstore, events } from '@evomap/evolver-core';
export type AutoDistillLlmMode = 'off' | 'shadow' | 'enforce';
export interface AutoDistillLlmRecord {
    shadowed_at?: string | null;
    enforced_at?: string | null;
    enforced_gene_id?: string | null;
    failed_attempts?: number;
    last_attempt_at?: string | null;
}
export interface AutoDistillLlmState {
    version: 1;
    p3_llm: {
        by_hash: Record<string, AutoDistillLlmRecord>;
    };
}
export type AutoDistillLlmResult = {
    ok: true;
    mode: 'enforce';
    gene: assetstore.AssetRecord;
    dataHash: string;
    stored: boolean;
} | {
    ok: false;
    mode: AutoDistillLlmMode;
    reason: string;
    dataHash?: string;
    candidate?: algo.GeneCandidate;
};
export interface LlmDistillRunnerResult {
    exitCode: number | null;
    stdout: string;
    stderr?: string;
}
export type LlmDistillRunner = (prompt: string, ctx: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
}) => Promise<LlmDistillRunnerResult>;
export interface AutoDistillLlmOptions {
    mode?: AutoDistillLlmMode;
    env?: NodeJS.ProcessEnv;
    store: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    statePath?: string;
    cwd?: string;
    now?: () => number;
    runner?: LlmDistillRunner;
    validationTimeoutMs?: number;
    minCapsules?: number;
    maxCapsules?: number;
}
export interface AutoDistillLlmWiring {
    enabled: boolean;
    mode: AutoDistillLlmMode;
    reason?: 'off';
    tick: () => Promise<AutoDistillLlmResult>;
}
export declare function autoDistillLlmStatePath(home?: string): string;
export declare function p3Decide(mode: Exclude<AutoDistillLlmMode, 'off'>, rec: AutoDistillLlmRecord | null | undefined, nowMs: number, opts?: {
    cooldownMs?: number;
    maxAttempts?: number;
}): 'spawn' | 'enforced_idempotent_skip' | 'shadow_idempotent_skip' | 'failed_exhausted' | 'p3_cooldown';
export declare function parseDistillOutput(stdout: string): unknown | null;
export declare function asGeneCandidate(value: unknown): algo.GeneCandidate | null;
export declare function jaccardDuplicate(candidate: algo.GeneCandidate, existing: readonly algo.ExistingGeneRef[], threshold?: number): string | null;
export declare function normalizeValidation(candidate: algo.GeneCandidate, cwd?: string): {
    candidate: algo.GeneCandidate;
    dropped: string[];
    injected: boolean;
};
export declare function runClaudeDistill(prompt: string, ctx: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
}): Promise<LlmDistillRunnerResult>;
/** Build the read-only `codex exec` argv for a distill run (pure, testable). SAFETY INVARIANT: `--sandbox read-only`
 *  is ALWAYS present — a distiller only reads the transcript (carried in the prompt) and emits a gene; it must never
 *  edit files. `--skip-git-repo-check`: the distill cwd may not be a git repo (codex exec otherwise refuses).
 *  `--output-last-message <file>`: capture ONLY the final assistant message (the gene JSON), avoiding codex's stdout
 *  preamble/token-count noise. Prompt arrives via stdin (the trailing `-`). Verified live against codex-cli 0.137.0. */
export declare function codexDistillArgs(cwd: string, lastMessageFile: string, model?: string): string[];
/** Distill a prompt with `codex exec` (read-only). Reads the clean final message from --output-last-message so
 *  parseDistillOutput sees a bare gene JSON; falls back to raw stdout (pickGeneObject scans it) if the file is absent.
 *  Windows: codex is a `.cmd` npm shim, so route through resolveSpawnCommand (shell-free). */
export declare function runCodexDistill(prompt: string, ctx: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
}): Promise<LlmDistillRunnerResult>;
/** Pick the distill runner from EVOLVE_DISTILL_PROVIDER. Unknown/unset → claude (cursor is never a distill provider). */
export declare function resolveDistillRunner(env: NodeJS.ProcessEnv): LlmDistillRunner;
export declare function autoDistillLlm(options: AutoDistillLlmOptions): Promise<AutoDistillLlmResult>;
export declare function resolveAutoDistillLlm(env: NodeJS.ProcessEnv, opts: Omit<AutoDistillLlmOptions, 'env' | 'mode'>): AutoDistillLlmWiring;