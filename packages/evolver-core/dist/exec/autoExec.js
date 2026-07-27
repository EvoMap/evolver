// Autonomous-exec task runner — the productized per-task kernel a resident daemon polls (the deployment form
// of the scratch autoexec daemon). One task → one fully-hardened evolution cycle, with a deny-by-default
// allowlist pre-check that yields a clean "refused" verdict WITHOUT running anything when the repo is not
// allowlisted. Secure by construction: the execute is built by makeSafeExecute (all six controls); callers
// cannot bypass the safety composition.
import { resolve as resolvePath, sep } from 'node:path';
import { normalizeForPut } from '../assetstore/provider.js';
import { ingestUntrusted } from '../assetstore/provenance.js';
import { mergePendingSignalsForStore } from '../assetstore/pendingSignals.js';
import { intakeGene } from '../algo/geneIntake.js';
import { runEvolutionCycle } from '../algo/orchestrator.js';
import { makeSafeExecute, makeTrustedGeneResolver } from './autonomousCycle.js';
import { findSignalHints } from './openPrRegistry.js';
import { AgentRunTraceRecorder, buildLearningPacketDraft } from '../trace/learningTrace.js';
/** Same path-containment as the bridge guard — used here to refuse before running anything (clean verdict). */
function withinAllowlist(repo, roots) {
    const c = resolvePath(repo);
    return roots.some((root) => { const r = resolvePath(root); return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep); });
}
function cleanForcedGeneId(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
export function canonicalForcedGeneId(task) {
    return cleanForcedGeneId(task.forcedGeneId)
        ?? cleanForcedGeneId(task.preferredGeneId)
        ?? cleanForcedGeneId(task.selected_gene_id)
        ?? cleanForcedGeneId(task.selectedGeneId);
}
export function normalizeAutoExecTask(task) {
    const forcedGeneId = canonicalForcedGeneId(task);
    const normalized = { ...task };
    if (forcedGeneId === undefined)
        delete normalized.forcedGeneId;
    else
        normalized.forcedGeneId = forcedGeneId;
    return normalized;
}
async function landHubAssetIfPresent(deps, candidate) {
    if (!candidate.hubAsset)
        return candidate;
    if (!deps.provenance)
        return null;
    let normalized;
    try {
        normalized = normalizeForPut(candidate.hubAsset).record;
    }
    catch {
        return null;
    }
    const existing = await deps.store.get(normalized.asset_id);
    if (!existing) {
        try {
            await ingestUntrusted(deps.store, deps.provenance, normalized, 'hub');
        }
        catch {
            return null;
        }
    }
    return candidate.assetId === normalized.asset_id ? candidate : { ...candidate, assetId: normalized.asset_id };
}
async function hasTrustedResolvedStrategy(deps, candidate) {
    if (!deps.provenance)
        return false;
    const resolveGene = makeTrustedGeneResolver(deps.store, deps.provenance, deps.review);
    const ids = candidate.hubAsset
        ? [candidate.assetId].filter((id) => typeof id === 'string' && id.length > 0)
        : [candidate.geneId, candidate.assetId].filter((id) => typeof id === 'string' && id.length > 0);
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) {
        const info = await resolveGene(id);
        if (info?.trusted === true && (info.strategy?.length ?? 0) > 0)
            return true;
    }
    return false;
}
async function executableHubCandidates(deps, candidates) {
    const out = [];
    for (const candidate of candidates) {
        const landed = await landHubAssetIfPresent(deps, candidate);
        if (!landed)
            continue;
        if (await hasTrustedResolvedStrategy(deps, landed))
            out.push(landed);
    }
    return out;
}
/**
 * Run one autonomous task end to end with every safety control composed (makeSafeExecute). Deny-by-default:
 * if task.repo is not within safety.allowedRoots, returns a 'refused' verdict and runs nothing. Otherwise seeds
 * the task's strategy as a local (trusted) gene, then drives a real evolution cycle and maps the result.
 */
export async function runAutoExecTask(deps, rawTask, safety) {
    const task = normalizeAutoExecTask(rawTask);
    if (!withinAllowlist(task.repo, safety.allowedRoots)) {
        return { taskId: task.id, status: 'refused', reason: `repo not in allowlist: ${task.repo}` };
    }
    // Open-PR dedup (opt-in): if an open PR already covers this task's signals, skip before spawning an agent
    // so the daemon doesn't re-implement in-flight work. Graceful — a lister that returns [] is a no-op.
    if (deps.prLister) {
        const hints = findSignalHints(task.signals, await deps.prLister(task.repo), { threshold: deps.dedupThreshold ?? 0.5 });
        const top = hints[0];
        if (top) {
            return { taskId: task.id, status: 'skipped', reason: `open-pr-dedup: signals overlap PR #${top.number} (${top.headRefName}) @ ${top.tokenOverlap.toFixed(2)}` };
        }
    }
    let cycleSignals = [...task.signals];
    try {
        const explicit = mergePendingSignalsForStore(deps.store, task.signals, { repoRoot: task.repo });
        cycleSignals = explicit.signals;
        if (explicit.injected > 0) {
            console.log(`[ExplicitSignals] Injected ${explicit.injected} user-declared signal(s) from pending_signals.json.`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ExplicitSignals] Failed to consume pending signals (non-fatal): ${message}`);
    }
    let seededStrategyGeneId;
    if (task.strategy && task.strategy.length > 0) {
        const gi = intakeGene({
            category: 'repair', signals_match: cycleSignals, strategy: [...task.strategy],
            summary: task.expectedEffect.slice(0, 80), ...(task.validationCmds ? { validation: [...task.validationCmds] } : {}),
            // A task's seeded strategy is an execution-entry seed (the operator/daemon supplied a learned strategy to
            // run/evolve), not a skill/session transcription → `evolved` per V1 #302 classifyProvenance.
            generation_meta: { source: 'evolved' },
        });
        if (gi.ok && gi.gene) {
            await deps.store.put(gi.gene);
            seededStrategyGeneId = cleanForcedGeneId(gi.gene.id);
        }
    }
    // Reuse-before-solve (#110): if the seam is wired, resolve hub candidates BEFORE the cycle so they compete
    // in the same selection pool as local genes. Reuse is an optimization, never a hard dependency — a seam
    // that throws degrades to solving fresh (no hub candidates) rather than failing the task.
    let hubCandidates = [];
    const cycleId = `autoexec-${task.id}`;
    // Learning trace (slice 2): one recorder per task run, traceId = cycleId so the trace joins the event log.
    // Purely observational — every recorder call and the packet submit are wrapped so they can never change
    // the verdict or fail the task.
    const traceRecorder = deps.learningTrace
        ? new AgentRunTraceRecorder({
            runId: cycleId,
            taskId: task.id,
            ...(deps.learningTrace.traceSink ? { sink: deps.learningTrace.traceSink } : {}),
        })
        : undefined;
    try {
        traceRecorder?.runStarted({ taskSummary: task.expectedEffect, signals: cycleSignals, metadata: { repo: task.repo, target: task.target } });
    }
    catch { /* observability only */ }
    if (deps.hubReuse) {
        try {
            hubCandidates = await executableHubCandidates(deps, await deps.hubReuse(cycleSignals, { cycleId }));
        }
        catch {
            hubCandidates = [];
        }
    }
    const execute = makeSafeExecute(task.repo, deps.store, safety, {
        ...(deps.provenance ? { provenance: deps.provenance } : {}),
        ...(deps.review ? { review: deps.review } : {}),
        ...(deps.includeProbation ? { includeProbation: true } : {}),
        ...(task.validationCmds ? { validationCmds: task.validationCmds } : {}),
        ...(deps.validate ? { validate: deps.validate(task) } : {}),
        ...(deps.personality ? { personality: deps.personality } : {}),
        ...(deps.agent ? { agent: deps.agent } : {}),
        ...(deps.git ? { git: deps.git } : {}),
        ...(traceRecorder ? { traceRecorder } : {}),
    });
    const strategyName = task.strategyName ?? deps.strategyName;
    // Intentional semantics (see #308 review M1): a task carrying `strategy` — even without an
    // explicit forcedGeneId — force-selects the gene seeded from that strategy above, rather than
    // letting it compete in normal ranking. Supplying a strategy is treated as "use this strategy".
    // The forced pick still passes every hard gate downstream (candidate pool, ban, epigenetic
    // suppression), so this never bypasses trust/review/inert filtering.
    const cycleForcedGeneId = task.forcedGeneId ?? seededStrategyGeneId;
    let memoryGraphAdvice;
    if (deps.memoryGraph) {
        try {
            memoryGraphAdvice = await deps.memoryGraph.query({ workspace: task.repo, signals: cycleSignals });
        }
        catch {
            memoryGraphAdvice = undefined;
        }
    }
    const res = await runEvolutionCycle(deps.engine, deps.store, {
        ...(deps.provenance ? { provenance: deps.provenance } : {}),
        ...(deps.review ? { review: deps.review } : {}),
        ...(deps.includeProbation ? { includeProbation: true } : {}),
        ...(hubCandidates.length > 0 ? { hubCandidates } : {}),
        ...(deps.solidifyPermit ? { solidifyPermit: deps.solidifyPermit } : {}),
        ...(deps.reuseOutcomes ? { reuseOutcomes: deps.reuseOutcomes } : {}),
        ...(deps.recallEvents ? { recallEvents: deps.recallEvents } : {}),
        ...(memoryGraphAdvice ? { memoryGraphAdvice } : {}),
        ...(strategyName !== undefined ? { strategyName } : {}),
        ...(cycleForcedGeneId !== undefined ? { forcedGeneId: cycleForcedGeneId } : {}),
        cycleId,
        problem: {
            id: task.id, signature: `sig:${task.id}`, signatureV: 1,
            firstSeenAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(),
            occurrences: 1, linkedSignals: cycleSignals, resolvedBy: null, status: 'open',
            value: { severity: 0.7, reach: 1, strategicFit: 0.9, novelty: 0, costEst: 0.2 },
            consecutiveFailures: 0, cooldownUntil: null, extensions: {},
        },
        signals: cycleSignals, category: 'repair', target: task.target, expectedEffect: task.expectedEffect,
        summary: `autonomous: ${task.id}`, confidence: 0.85, execute, consumePendingSignals: false,
    });
    const status = res.finalStage === 'solidified' ? 'solidified' : res.finalStage === 'failed' ? 'failed' : 'innovated';
    const cap = res.capsule;
    if (traceRecorder && deps.learningTrace) {
        try {
            traceRecorder.runCompleted({
                status: res.finalStage === 'solidified' ? 'success' : 'failed',
                ...(cap?.outcome?.score !== undefined ? { score: cap.outcome.score } : {}),
                ...(res.reasons.length > 0 ? { reason: res.reasons.join('; ') } : {}),
                ...(res.producedValue !== undefined ? { producedValue: res.producedValue } : {}),
                ...(res.failureKind !== undefined ? { failureKind: res.failureKind } : {}),
            });
            await deps.learningTrace.packetSink.submit(buildLearningPacketDraft(traceRecorder, {
                sourceRepo: deps.learningTrace.sourceRepo ?? 'evolver-v2',
                taskSummary: task.expectedEffect,
                signals: cycleSignals,
                environment: { repo: task.repo, runner: safety.runner ?? 'claude' },
            }));
        }
        catch { /* packet delivery is best-effort; never fail the task */ }
    }
    if (deps.memoryGraph && res.decision?.selectedGeneId && (res.finalStage === 'solidified' || res.finalStage === 'failed')) {
        const producedSuccess = res.finalStage === 'solidified' && res.producedValue === true;
        try {
            await deps.memoryGraph.recordOutcome({
                workspace: task.repo,
                signals: cycleSignals,
                geneId: res.decision.selectedGeneId,
                // MemoryGraph has no inert status yet, so record a no-op as conservative failed evidence instead of reward.
                status: producedSuccess ? 'success' : 'failed',
                score: res.finalStage === 'solidified' && !res.producedValue
                    ? 0
                    : cap?.outcome?.score ?? (producedSuccess ? 1 : 0),
                at: new Date().toISOString(),
            });
        }
        catch {
            // Memory persistence is advisory and must never fail the autonomous task.
        }
    }
    const hubAssetIds = new Set(hubCandidates.map((c) => c.assetId).filter((id) => typeof id === 'string' && id.length > 0));
    const selectedAssetId = res.decision?.selectedAssetId;
    const usedAssetIds = selectedAssetId && hubAssetIds.has(selectedAssetId) ? [selectedAssetId] : [];
    return {
        taskId: task.id, status, finalStage: res.finalStage,
        ...(res.reasons.length > 0 && status !== 'solidified' ? { reason: res.reasons.join('; ') } : {}),
        ...(cap?.outcome ? { outcome: cap.outcome } : {}),
        ...(cap?.proof_of_work ? { proofOfWork: cap.proof_of_work } : {}),
        ...(res.failureKind !== undefined ? { failureKind: res.failureKind } : {}),
        ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
        ...(usedAssetIds.length > 0 ? { usedAssetIds } : {}),
    };
}
/**
 * Single-flight re-entrancy guard for a poll-driven resident loop. A resident autoexec daemon polls on an
 * interval; if a pass outlives the poll period (a hung/slow agent), the next tick must NOT start a second
 * overlapping pass — that piled up runaway nested agents in an early scratch run. Wrap the pass: while one is
 * in flight, subsequent calls return { skipped: true } immediately instead of starting another.
 */
export function singleFlight(fn) {
    let inFlight = null;
    return () => {
        if (inFlight)
            return Promise.resolve({ skipped: true });
        const p = fn().finally(() => { inFlight = null; });
        inFlight = p;
        return p;
    };
}
/**
 * Process tasks strictly SEQUENTIALLY (one at a time, never overlapping) through `runOne`, collecting verdicts.
 * Sequential by construction — an autonomous agent edits a worktree and runs tools; concurrent passes would
 * contend. Combine with {@link singleFlight} so a poll tick that fires mid-drain is skipped, not stacked.
 */
export async function drainTasks(tasks, runOne) {
    const out = [];
    for (const t of tasks)
        out.push(await runOne(t));
    return out;
}