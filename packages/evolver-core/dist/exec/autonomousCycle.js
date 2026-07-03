import { makeClaudeExecBridge } from './claudeBridge.js';
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
// Claude's safe default: bypass the permission prompts but BOUND the agent to file edits (#38/#40).
const CLAUDE_DEFAULT_AGENT_OPTIONS = { skipPermissions: true, allowedTools: ['Read', 'Edit', 'Write'] };
// Codex's safe default is SANDBOXED (no skip): the autonomous-bypass flag is gated until verified (#66), so
// skipPermissions would throw at construction. `codex exec` still runs non-interactively under its own sandbox.
const CODEX_DEFAULT_AGENT_OPTIONS = {};
// Cursor's safe default keeps skip OFF (#66 SCAFFOLD). The runner is flag-confirmed via `cursor-agent --help`
// but not yet run-verified end to end (needs an authed cursor-agent). The `-p --force --trust` bypass would
// auto-approve shell+write, but Cursor has no verified per-run allowlist/sandbox mapping yet, so skipPermissions
// is refused outright. Use default cursor with worktree isolation until the CLI is run-verified.
const CURSOR_DEFAULT_AGENT_OPTIONS = {};
/** Per-runner safe default agent options — claude bypasses-with-bounds; codex + cursor stay non-bypassing (codex sandboxed; cursor skip refused, #66). */
function defaultAgentOptions(runner) {
    if (runner === 'codex')
        return CODEX_DEFAULT_AGENT_OPTIONS;
    if (runner === 'cursor')
        return CURSOR_DEFAULT_AGENT_OPTIONS;
    return CLAUDE_DEFAULT_AGENT_OPTIONS;
}
/**
 * Build the fully-hardened `execute` for an autonomous run against `repo`. Composes every exec-bridge control
 * with secure defaults so they can't be forgotten piecemeal: deny-by-default allowedRoots (#41) + worktree
 * isolation (#43) + env scrub (#42) + bounded skip-permissions agent (#38/#40) + trusted-gene gate fed by
 * provenance (#45/#30). Pass the result as runEvolutionCycle's `execute`.
 */
export function makeSafeExecute(repo, store, safety, opts = {}) {
    return makeClaudeExecBridge({
        cwd: repo,
        enabled: true,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.git ? { git: opts.git } : {}),
        allowedRoots: safety.allowedRoots,
        ...(safety.runner ? { runner: safety.runner } : {}),
        ...(safety.isolation === 'none' ? {} : { isolation: 'worktree' }),
        scrubEnv: safety.scrubEnv ?? true,
        requireTrustedGene: safety.requireTrustedGene ?? true,
        agentOptions: safety.agentOptions ?? defaultAgentOptions(safety.runner),
        ...(safety.timeoutMs !== undefined ? { timeoutMs: safety.timeoutMs } : {}),
        resolveGene: makeTrustedGeneResolver(store, opts.provenance, opts.review, opts.includeProbation ?? false),
        ...(opts.validate ? { validate: opts.validate } : {}),
        ...(opts.validationCmds ? { validationCmds: opts.validationCmds } : {}),
        ...(opts.personality ? { personality: opts.personality } : {}),
    });
}