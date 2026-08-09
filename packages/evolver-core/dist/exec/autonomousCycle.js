import { CLAUDE_SAFE_AUTONOMOUS_TOOLS, hasBoundedClaudeFileAccess, makeClaudeExecBridge, validateAgentSessionResume } from './claudeBridge.js';
const asStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
/**
 * Resolve a gene's strategy from the store and whether it is safe to EMBED into an autonomous agent's prompt —
 * the exec-side link from #30 (provenance ledger) and the review-state gate to #45 (requireTrustedGene gate). A
 * gene is embeddable only when BOTH axes pass: trusted ORIGIN (no provenance record → local/trusted; a hub one
 * is untrusted until promoted) AND review-APPROVED content (no review record → eligible; an auto-distilled draft
 * is quarantined until a human approves). Both default-open, so cycle-self-produced/local genes are unaffected;
 * only hub-ingested (untrusted) and auto-distilled (unreviewed) drafts are withheld. Looks up by id or asset_id.
 */
export function makeTrustedGeneResolver(store, provenance, review, includeProbation = false) {
    return async (geneId) => {
        const genes = await store.list('Gene', 1000);
        const g = genes.find((x) => String(x['id']) === geneId || String(x.asset_id) === geneId);
        if (!g)
            return null;
        const summary = g['summary'];
        const trustedOrigin = provenance ? provenance.isTrusted(String(g.asset_id)) : true;
        const reviewApproved = review ? review.isApproved(String(g.asset_id)) : true;
        // Probation (#306): when enabled, a QUARANTINED (auto-distilled, not yet approved — but not rejected) draft IS
        // embeddable, so its strategy actually drives the trial. That is what makes the trial's outcome real evidence
        // for auto-promote (without embedding, the gene would be selected but run as innovate — hollow evidence). The
        // strategy is unreviewed, so its containment rests on the proven exec gates: sanitizeInjection neutralizes
        // injected directives in the prompt, and the always-on hard gates + worktree isolation contain the agent's
        // ACTIONS regardless of the prompt (#309). A REJECTED draft and an untrusted-origin (hub) gene stay withheld.
        const probationOk = includeProbation && review?.get(String(g.asset_id))?.state === 'quarantined';
        const info = {
            strategy: asStrings(g['strategy']),
            preconditions: asStrings(g['preconditions']),
            ...(typeof summary === 'string' ? { summary } : {}),
            trusted: trustedOrigin && (reviewApproved || probationOk), // trusted ORIGIN + (approved OR on probation)
        };
        return info;
    };
}
// Keep Claude's project path checks enabled and expose only file/search tools.
// Bash, web, task, and MCP tools remain unavailable.
const CLAUDE_DEFAULT_AGENT_OPTIONS = {
    permissionMode: 'acceptEdits',
    tools: CLAUDE_SAFE_AUTONOMOUS_TOOLS,
};
// Codex workspace-write prevents host writes but does not contain host reads. It therefore remains explicit.
const CODEX_DEFAULT_AGENT_OPTIONS = {};
// Cursor has no verified host filesystem/network sandbox. Worktree isolation cannot safely authorize `--trust`.
const CURSOR_DEFAULT_AGENT_OPTIONS = {};
// Gemini's verified safe default is `--approval-mode auto_edit`; shell remains gated and --yolo is refused.
const GEMINI_DEFAULT_AGENT_OPTIONS = {};
/** Per-runner safe default agent options. Host permission bypass is never enabled by default. */
function defaultAgentOptions(runner) {
    if (runner === 'codex')
        return CODEX_DEFAULT_AGENT_OPTIONS;
    if (runner === 'cursor')
        return CURSOR_DEFAULT_AGENT_OPTIONS;
    if (runner === 'gemini')
        return GEMINI_DEFAULT_AGENT_OPTIONS;
    return CLAUDE_DEFAULT_AGENT_OPTIONS;
}
export class UnsupportedCursorAutonomousIsolationError extends Error {
    constructor() {
        super('Autonomous Cursor cannot use worktree isolation because --trust grants host filesystem and network access');
        this.name = 'UnsupportedCursorAutonomousIsolationError';
    }
}
export class UnsupportedAutonomousHostAccessError extends Error {
    constructor() {
        super('Autonomous Claude requires project-scoped acceptEdits with bounded file/search tools; host access bypass or unsupported tools are forbidden because a worktree is not a security boundary');
        this.name = 'UnsupportedAutonomousHostAccessError';
    }
}
export class UnsupportedAutonomousClaudeRunnerError extends Error {
    constructor() {
        super('Autonomous claude is disabled because its headless edit mode has no verified host filesystem sandbox; inject an externally sandboxed agent or explicitly select a runner after reviewing its host-access boundary');
        this.name = 'UnsupportedAutonomousClaudeRunnerError';
    }
}
export class UnsupportedAutonomousCodexRunnerError extends Error {
    constructor() {
        super('Autonomous codex is disabled because workspace-write does not restrict host filesystem reads; inject an externally sandboxed agent');
        this.name = 'UnsupportedAutonomousCodexRunnerError';
    }
}
export function resolveAutonomousAgentOptions(runner, isolation, overrides) {
    const options = {
        ...defaultAgentOptions(runner),
        ...(isolation !== 'none' ? { workspaceTrust: 'isolated-worktree' } : {}),
        ...(overrides ?? {}),
    };
    if (runner === 'cursor' && isolation !== 'none') {
        throw new UnsupportedCursorAutonomousIsolationError();
    }
    const effectiveRunner = runner ?? 'claude';
    const unsafeClaudeOptions = effectiveRunner === 'claude' && !hasBoundedClaudeFileAccess(options);
    if (unsafeClaudeOptions) {
        throw new UnsupportedAutonomousHostAccessError();
    }
    return options;
}
/**
 * Build the fully-hardened `execute` for an autonomous run against `repo`. Composes every exec-bridge control
 * with secure defaults so they can't be forgotten piecemeal: deny-by-default allowedRoots (#41) + worktree
 * isolation (#43) + env scrub (#42) + non-bypassing agent permissions (#38/#40) + trusted-gene gate fed by
 * provenance (#45/#30). Pass the result as runEvolutionCycle's `execute`.
 */
export function makeSafeExecute(repo, store, safety, opts = {}) {
    const runner = safety.runner ?? (opts.agent ? undefined : 'claude');
    if (safety.resume && runner)
        validateAgentSessionResume(safety.resume, runner);
    if (!opts.agent && runner === 'claude') {
        throw new UnsupportedAutonomousClaudeRunnerError();
    }
    if (!opts.agent && runner === 'codex') {
        throw new UnsupportedAutonomousCodexRunnerError();
    }
    return makeClaudeExecBridge({
        cwd: repo,
        enabled: true,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.git ? { git: opts.git } : {}),
        ...(opts.traceRecorder ? { traceRecorder: opts.traceRecorder } : {}),
        allowedRoots: safety.allowedRoots,
        ...(runner ? { runner } : {}),
        ...(safety.resume ? { resume: safety.resume } : {}),
        ...(safety.isolation === 'none' ? {} : { isolation: 'worktree' }),
        scrubEnv: safety.scrubEnv ?? true,
        requireTrustedGene: safety.requireTrustedGene ?? true,
        agentOptions: resolveAutonomousAgentOptions(runner, safety.isolation, safety.agentOptions),
        ...(safety.timeoutMs !== undefined ? { timeoutMs: safety.timeoutMs } : {}),
        ...(safety.signal ? { signal: safety.signal } : {}),
        resolveGene: makeTrustedGeneResolver(store, opts.provenance, opts.review, opts.includeProbation ?? false),
        ...(opts.validate ? { validate: opts.validate } : {}),
        ...(opts.validationCmds ? { validationCmds: opts.validationCmds } : {}),
        ...(opts.personality ? { personality: opts.personality } : {}),
    });
}