// Self-PR (ported + hardened from v1 gep/selfPR.js). Turns a high-confidence self-mutation into a DRAFT pull
// request on an allowlisted repo, so a human reviews and merges. This touches a REAL repo, so it is wrapped in
// the same deny-by-default discipline as the exec bridge and is OFF unless explicitly opted in:
//   1. enabled === true (default off)              4. always --draft, NEVER auto-merge
//   2. repo within allowedRoots (empty = deny all)  5. confidence gates (score/streak/blast)
//   3. leak scan of the diff before any push        6. cooldown + diff dedup
// evaluateSelfPr is PURE (decision only); the `gh` call is an injected GhRunner seam so a test never creates a
// real PR. Nothing here runs unless the caller has wired enabled:true AND a non-empty allowedRoots.
import { isWithinRoot } from './claudeBridge.js';
import { defaultReadManifest, isObfuscatedFile } from './selfPrObfuscation.js';
export const DEFAULT_SELF_PR_GATES = { minScore: 0.9, minStreak: 2, maxFiles: 5, maxLines: 200, cooldownMs: 24 * 60 * 60 * 1000 };
/**
 * Decide whether a self-PR may be created. Pure — combines every gate and returns the FIRST failing reason, so
 * the default (disabled, empty allowlist) is always a clean refusal that runs nothing.
 */
export function evaluateSelfPr(input, gates = DEFAULT_SELF_PR_GATES) {
    if (input.enabled !== true)
        return { eligible: false, reason: 'disabled' };
    if (!input.allowedRoots || input.allowedRoots.length === 0)
        return { eligible: false, reason: 'no_allowed_roots' };
    if (!input.allowedRoots.some((root) => isWithinRoot(input.repoRoot, root)))
        return { eligible: false, reason: 'repo_not_allowlisted' };
    if (input.outcome?.status !== 'success')
        return { eligible: false, reason: 'not_successful' };
    if ((Number(input.outcome.score) || 0) < gates.minScore)
        return { eligible: false, reason: 'score_below_min' };
    if ((input.successStreak ?? 0) < gates.minStreak)
        return { eligible: false, reason: 'streak_below_min' };
    const files = (input.changedFiles ?? []).filter(Boolean);
    if (files.length === 0)
        return { eligible: false, reason: 'no_changes' };
    if (files.length > gates.maxFiles)
        return { eligible: false, reason: 'too_many_files' };
    if ((input.blastLines ?? 0) > gates.maxLines)
        return { eligible: false, reason: 'too_many_lines' };
    if (input.lastPrAt) {
        const elapsed = (input.now ?? Date.now()) - new Date(input.lastPrAt).getTime();
        if (Number.isFinite(elapsed) && elapsed < gates.cooldownMs)
            return { eligible: false, reason: 'cooldown' };
    }
    if (input.diffHash && (input.recentDiffHashes ?? []).includes(input.diffHash))
        return { eligible: false, reason: 'duplicate_diff' };
    return { eligible: true, reason: 'eligible' };
}
/**
 * Create a DRAFT pull request for an eligible self-mutation. Re-checks eligibility (so it can't be bypassed),
 * blocks any change touching an OBFUSCATED file (fail-closed manifest), leak-scans the diff + body, then stages
 * ONLY the agent's changed files (never `git add -A`), commits, pushes the branch and opens the PR with
 * `gh pr create --draft`. ALWAYS draft, NEVER merges. Any gh failure is returned, not thrown.
 */
export async function createDraftSelfPr(evalInput, content, deps, gates = DEFAULT_SELF_PR_GATES) {
    const decision = evaluateSelfPr(evalInput, gates);
    if (!decision.eligible)
        return { created: false, reason: decision.reason };
    // The set of files the agent actually changed this cycle (from the exec `git diff --name-only`). We stage
    // EXACTLY these, never `git add -A` (which would sweep every stray/uncommitted change in the working tree
    // into the self-PR). evaluateSelfPr already guarantees this is non-empty (the `no_changes` gate), but re-guard
    // here so an empty list is an explicit no-op self-PR rather than a tree-sweeping commit.
    const changedFiles = (evalInput.changedFiles ?? []).filter(Boolean);
    if (changedFiles.length === 0)
        return { created: false, reason: 'no_changes' };
    // Obfuscation-leak guard: any changed file that ships OBFUSCATED on the public repo (per public.manifest.json)
    // would land as raw source there. Block before we create anything. FAIL-CLOSED: a missing/unreadable/invalid
    // manifest treats every file as obfuscated, so the guard never silently lets a leaking file through.
    const readManifest = deps.readManifest ?? defaultReadManifest(evalInput.repoRoot);
    for (const file of changedFiles) {
        if (isObfuscatedFile(file, readManifest))
            return { created: false, reason: `obfuscated_file_blocked: ${file}` };
    }
    if (deps.leakScan) {
        for (const text of [content.diff, content.body]) {
            const scan = deps.leakScan(text);
            if (scan.leaked)
                return { created: false, reason: `leak_blocked${scan.detail ? `: ${scan.detail}` : ''}` };
        }
    }
    const cwd = evalInput.repoRoot;
    const run = async (args) => deps.gh(args, cwd);
    const checkout = await run(['checkout', '-b', content.branch]);
    if (!checkout.ok)
        return { created: false, reason: `git_checkout_failed: ${checkout.stderr ?? ''}`.trim() };
    // Stage ONLY the agent's changed files (the `--` terminator stops any path being read as an option). NOT -A.
    const add = await run(['add', '--', ...changedFiles]);
    if (!add.ok)
        return { created: false, reason: 'git_add_failed' };
    const commit = await run(['commit', '-m', content.title]);
    if (!commit.ok)
        return { created: false, reason: 'git_commit_failed' };
    const push = await run(['push', '-u', 'origin', content.branch]);
    if (!push.ok)
        return { created: false, reason: `git_push_failed: ${push.stderr ?? ''}`.trim() };
    // ALWAYS --draft; never any merge/auto-merge flag.
    const prArgs = ['pr', 'create', '--draft', '--title', content.title, '--body', content.body, ...(content.base ? ['--base', content.base] : [])];
    const pr = await run(prArgs);
    if (!pr.ok)
        return { created: false, reason: `gh_pr_create_failed: ${pr.stderr ?? ''}`.trim() };
    return { created: true, reason: 'created', url: pr.stdout.trim() };
}