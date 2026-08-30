import { normalizeForPut } from '../assetstore/provider.js';
import { ingestUntrusted } from '../assetstore/provenance.js';
import { mergePendingSignalsForStore } from '../assetstore/pendingSignals.js';
import { intakeGene } from '../algo/geneIntake.js';
import { runEvolutionCycle } from '../algo/orchestrator.js';
import { makeSafeExecute, makeTrustedGeneResolver } from './autonomousCycle.js';
import { defaultGitRunner, isWithinRoot } from './claudeBridge.js';
import { findSignalHints } from './openPrRegistry.js';
import { AgentRunTraceRecorder, buildLearningPacketDraft } from '../trace/learningTrace.js';
import { collectRunLlmTurns } from '../trace/proxyTurns.js';
import { uniqueSessionId } from '../trace/trajectory.js';
import { ExecutionBindingError, ExecutionBindingJournal, freezeExecutionBinding, preflightExecutionBinding, } from './executionBinding.js';
/** Same path-containment as the bridge guard — used here to refuse before running anything (clean verdict). */
function withinAllowlist(repo, roots) {
    return roots.some((root) => isWithinRoot(repo, root));
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
    const cycleId = `autoexec-${task.id}`;
    let binding;
    let bindingClaimed = false;
    let baseValidate;
    if (task.execution_binding !== undefined) {
        try {
            binding = freezeExecutionBinding(task.execution_binding);
            if (!deps.executionBinding)
                throw new ExecutionBindingError('binding_missing', 'execution binding journal and authority checks are required');
            const recovery = deps.executionBinding.journal.recover(task.id, binding.binding_digest);
            if (recovery.kind === 'terminal') {
                const recoveredStatus = recovery.terminal.disposition === 'unsafe_to_replay'
                    ? 'unsafe_to_replay'
                    : recovery.terminal.disposition === 'completed' && recovery.terminal.final_stage === 'solidified'
                        ? 'solidified'
                        : recovery.terminal.disposition === 'completed' && recovery.terminal.final_stage === 'innovated'
                            ? 'innovated'
                            : recovery.terminal.disposition === 'denied'
                                ? 'refused'
                                : 'failed';
                return {
                    taskId: task.id,
                    status: recoveredStatus,
                    binding_digest: recovery.binding_digest,
                    run_id: binding.correlation.run_id,
                    execution_terminal: {
                        status: recovery.terminal.outcome?.status === 'success' ? 'success' : 'failed',
                        disposition: recovery.terminal.disposition,
                    },
                    hub_lifecycle: { state: 'not_submitted' },
                    ...(recovery.terminal.outcome ? { outcome: recovery.terminal.outcome } : {}),
                };
            }
            if (recovery.kind === 'unsafe_to_replay' || recovery.kind === 'mismatched') {
                return { taskId: task.id, status: 'unsafe_to_replay', binding_digest: recovery.binding_digest, run_id: binding.correlation.run_id, reason: recovery.reason };
            }
            await preflightExecutionBinding(binding, {
                taskId: task.id,
                runId: binding.correlation.run_id,
                cycleId,
                repoPath: task.repo,
                target: task.target,
                expectedEffect: task.expectedEffect,
                allowedRoots: safety.allowedRoots,
                now: deps.executionBinding.now ?? Date.now,
                currentRevision: binding.target_descriptor.base_revision === null
                    ? null
                    : (deps.git ?? defaultGitRunner)(['rev-parse', 'HEAD'], task.repo).then((revision) => revision.trim() || null),
                maxRuntimeMs: deps.executionBinding.maxRuntimeMs ?? safety.timeoutMs,
                maxFiles: deps.executionBinding.maxFiles,
                maxLines: deps.executionBinding.maxLines,
                requiredConsentScope: 'execution',
                authoritative: deps.executionBinding.authority,
            });
            if (!deps.validate && binding.resource_grant.validation_commands.length > 0) {
                throw new ExecutionBindingError('binding_acceptance_invalid', 'bound execution requires the declared validation plan to be wired to a validator');
            }
            baseValidate = deps.validate?.({ ...task, validationCmds: binding.resource_grant.validation_commands });
            if (baseValidate && baseValidate.length < 4) {
                throw new ExecutionBindingError('binding_acceptance_invalid', 'bound execution validator must accept AbortSignal');
            }
            if (recovery.kind === 'new')
                await deps.executionBinding.journal.recordCreated(binding);
            if (recovery.kind === 'claimed')
                bindingClaimed = true;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const unsafe = error instanceof ExecutionBindingError && error.unsafeToReplay;
            return { taskId: task.id, status: unsafe ? 'unsafe_to_replay' : 'refused', ...(binding ? { binding_digest: binding.binding_digest, run_id: binding.correlation.run_id } : {}), reason: detail };
        }
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
    // Wall-clock window of this run, used to correlate the proxy's llm_turn records (slice 5). Captured
    // unconditionally-cheaply only when the fold is configured.
    const proxyTraceClock = deps.learningTrace?.proxyTraces?.now ?? Date.now;
    let runStartMs = 0;
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
    runStartMs = deps.learningTrace?.proxyTraces ? proxyTraceClock() : 0;
    // evaluation fill-in (slice 6): the validate hook is the run's external verifier (sandboxed validation
    // commands), so its result — when it actually RAN — becomes the packet's evaluation.verification
    // (verifier 'automated_test'). Observation is a pass-through wrapper: the hook's result reaches the
    // bridge unchanged, and a run where validation never fired keeps the evaluation placeholder.
    let observedVerification;
    baseValidate ??= deps.validate?.(task);
    const observingValidate = baseValidate
        ? async (mutation, decision, cwd, signal) => {
            const v = await baseValidate(mutation, decision, cwd, signal);
            observedVerification = { verifier: 'automated_test', passed: v.passed, ...(v.score !== undefined ? { score: v.score } : {}) };
            return v;
        }
        : undefined;
    const observedProvenance = {
        gene_ids: [], capsule_ids: [], tool_decisions: [],
        policy_decisions: [], validator: null,
        result_asset_refs: [], proof_refs: [], terminal_disposition: 'crashed',
    };
    const executionObserver = binding ? {
        onToolDecision: (decision) => { observedProvenance.tool_decisions.push(decision); },
        onPolicyDecision: (decision) => { observedProvenance.policy_decisions.push(decision); },
        onValidatorDecision: (decision) => { observedProvenance.validator = decision; },
        onProofReference: (reference) => { observedProvenance.proof_refs.push(reference); },
    } : undefined;
    const safeExecute = makeSafeExecute(task.repo, deps.store, safety, {
        ...(deps.provenance ? { provenance: deps.provenance } : {}),
        ...(deps.review ? { review: deps.review } : {}),
        ...(deps.includeProbation ? { includeProbation: true } : {}),
        ...(task.validationCmds ? { validationCmds: task.validationCmds } : {}),
        ...(observingValidate ? { validate: observingValidate } : {}),
        ...(deps.personality ? { personality: deps.personality } : {}),
        ...(deps.agent ? { agent: deps.agent } : {}),
        ...(deps.git ? { git: deps.git } : {}),
        ...(traceRecorder ? { traceRecorder } : {}),
        ...(executionObserver ? { executionObserver } : {}),
        ...(binding ? { executionLimits: {
                maxRuntimeMs: binding.resource_grant.max_runtime_ms,
                maxFiles: binding.resource_grant.max_files,
                maxLines: binding.resource_grant.max_lines,
            } } : {}),
    });
    const execute = binding && deps.executionBinding
        ? async (mutation, decision) => {
            const selectedContext = binding.selected_context;
            try {
                if (selectedContext.capsule_id !== null || selectedContext.capsule_asset_id !== null) {
                    throw new ExecutionBindingError('binding_mismatched', 'preselected capsule context is not supported by the CycleEngine execution seam');
                }
                if (selectedContext.gene_id !== null && decision.selectedGeneId !== selectedContext.gene_id) {
                    throw new ExecutionBindingError('binding_mismatched', 'selected gene_id does not match frozen binding context');
                }
                if (selectedContext.gene_asset_id !== null && decision.selectedAssetId !== selectedContext.gene_asset_id) {
                    throw new ExecutionBindingError('binding_mismatched', 'selected gene_asset_id does not match frozen binding context');
                }
                if (!bindingClaimed) {
                    await preflightExecutionBinding(binding, {
                        taskId: task.id,
                        runId: binding.correlation.run_id,
                        cycleId,
                        repoPath: task.repo,
                        target: task.target,
                        expectedEffect: task.expectedEffect,
                        allowedRoots: safety.allowedRoots,
                        now: deps.executionBinding.now ?? Date.now,
                        currentRevision: binding.target_descriptor.base_revision === null
                            ? null
                            : (deps.git ?? defaultGitRunner)(['rev-parse', 'HEAD'], task.repo).then((revision) => revision.trim() || null),
                        maxRuntimeMs: deps.executionBinding.maxRuntimeMs ?? safety.timeoutMs,
                        maxFiles: deps.executionBinding.maxFiles,
                        maxLines: deps.executionBinding.maxLines,
                        requiredConsentScope: 'execution',
                        authoritative: deps.executionBinding.authority,
                    });
                    const started = await deps.executionBinding.journal.claim(binding);
                    if (started.kind !== 'claimed')
                        throw new ExecutionBindingError('binding_replay_unsafe', `binding execution claim ended in ${started.kind}`, true);
                    bindingClaimed = true;
                }
                const result = await safeExecute(mutation, decision);
                const policyDenied = observedProvenance.policy_decisions.some((policy) => !policy.allowed);
                const disposition = result.outcome.status === 'success'
                    ? 'completed'
                    : result.failureKind === 'timeout'
                        ? 'timed_out'
                        : result.failureKind === 'cancelled'
                            ? 'cancelled'
                            : policyDenied ? 'denied' : 'rejected';
                observedProvenance.terminal_disposition = disposition;
                return {
                    ...result,
                    provenance: { ...observedProvenance, terminal_disposition: disposition },
                    bindingCorrelation: { bindingDigest: binding.binding_digest, runId: binding.correlation.run_id },
                    executionTerminal: { status: result.outcome.status, disposition },
                    hubLifecycle: { state: 'not_submitted' },
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const disposition = error instanceof ExecutionBindingError
                    ? error.unsafeToReplay ? 'unsafe_to_replay' : 'denied'
                    : 'crashed';
                observedProvenance.terminal_disposition = disposition;
                return {
                    outcome: { status: 'failed', score: 0, reason: message },
                    bindingCorrelation: { bindingDigest: binding.binding_digest, runId: binding.correlation.run_id },
                    executionTerminal: { status: 'failed', disposition },
                    provenance: { ...observedProvenance, terminal_disposition: disposition },
                    hubLifecycle: { state: 'not_submitted' },
                };
            }
        }
        : safeExecute;
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
    let res;
    try {
        res = await runEvolutionCycle(deps.engine, deps.store, {
            ...(deps.provenance ? { provenance: deps.provenance } : {}),
            ...(deps.review ? { review: deps.review } : {}),
            ...(deps.includeProbation ? { includeProbation: true } : {}),
            ...(hubCandidates.length > 0 ? { hubCandidates } : {}),
            ...(deps.solidifyPermit ? { solidifyPermit: deps.solidifyPermit } : {}),
            ...(binding ? { executionBinding: binding } : {}),
            ...(deps.reuseOutcomes ? { reuseOutcomes: deps.reuseOutcomes } : {}),
            ...(deps.recallEvents ? { recallEvents: deps.recallEvents } : {}),
            ...(memoryGraphAdvice ? { memoryGraphAdvice } : {}),
            ...(strategyName !== undefined ? { strategyName } : {}),
            ...(deps.disableSemanticIdf ? { disableSemanticIdf: true } : {}),
            ...(deps.selectionPolicy ? { selectionPolicy: deps.selectionPolicy } : {}),
            ...(deps.selectionGuard ? { selectionGuard: deps.selectionGuard } : {}),
            ...(deps.selectionFloor !== undefined ? { selectionFloor: deps.selectionFloor } : {}),
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
    }
    catch (error) {
        if (binding && deps.executionBinding) {
            const recovery = deps.executionBinding.journal.recover(task.id, binding.binding_digest);
            if (recovery.kind === 'unsafe_to_replay') {
                try {
                    await deps.executionBinding.journal.recordTerminal({
                        binding_digest: binding.binding_digest,
                        task_id: task.id,
                        run_id: binding.correlation.run_id,
                        disposition: 'unsafe_to_replay',
                        outcome: { status: 'failed', score: 0, reason: recovery.reason },
                        provenance: { ...observedProvenance, terminal_disposition: 'unsafe_to_replay' },
                    });
                }
                catch { /* the existing started marker remains fail-closed on recovery */ }
                return { taskId: task.id, status: 'unsafe_to_replay', binding_digest: binding.binding_digest, run_id: binding.correlation.run_id, reason: `binding_replay_unsafe: ${recovery.reason}` };
            }
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { taskId: task.id, status: 'failed', ...(binding ? { binding_digest: binding.binding_digest, run_id: binding.correlation.run_id } : {}), reason: detail };
    }
    if (binding && deps.executionBinding) {
        const execution = res.execution;
        if (!execution?.provenance || !execution.executionTerminal) {
            const deniedReason = res.reasons.join('; ') || `cycle ended at ${res.finalStage} before execution`;
            try {
                await deps.executionBinding.journal.recordTerminal({
                    binding_digest: binding.binding_digest,
                    task_id: task.id,
                    run_id: binding.correlation.run_id,
                    disposition: 'denied',
                    final_stage: res.finalStage,
                    outcome: { status: 'failed', score: 0, reason: deniedReason },
                    provenance: { ...observedProvenance, terminal_disposition: 'denied' },
                });
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return { taskId: task.id, status: 'failed', binding_digest: binding.binding_digest, run_id: binding.correlation.run_id, reason: `binding_provenance_unavailable: ${detail}` };
            }
            return {
                taskId: task.id,
                status: 'refused',
                binding_digest: binding.binding_digest,
                run_id: binding.correlation.run_id,
                execution_terminal: { status: 'failed', disposition: 'denied' },
                hub_lifecycle: { state: 'not_submitted' },
                reason: deniedReason,
            };
        }
        const terminal = {
            binding_digest: binding.binding_digest,
            task_id: task.id,
            run_id: binding.correlation.run_id,
            disposition: execution.executionTerminal.disposition,
            final_stage: res.finalStage,
            outcome: execution.outcome,
            ...(execution.proofOfWork ? { proof_of_work: execution.proofOfWork } : {}),
            provenance: {
                ...execution.provenance,
                gene_ids: res.decision?.selectedGeneId ? [res.decision.selectedGeneId] : [],
                capsule_ids: res.capsule?.asset_id ? [res.capsule.asset_id] : [],
                result_asset_refs: res.capsule?.asset_id ? [res.capsule.asset_id] : [],
                proof_refs: execution.provenance.proof_refs.length > 0
                    ? execution.provenance.proof_refs
                    : execution.proofOfWork?.kind === 'git_diff' && execution.proofOfWork.git_diff?.patch_ref
                        ? [{ kind: 'git_diff', ref: execution.proofOfWork.git_diff.patch_ref }]
                        : execution.provenance.proof_refs,
            },
        };
        try {
            await deps.executionBinding.journal.recordTerminal(terminal);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { taskId: task.id, status: 'failed', binding_digest: binding.binding_digest, run_id: binding.correlation.run_id, reason: `binding_provenance_unavailable: ${detail}` };
        }
    }
    const status = res.execution?.executionTerminal?.disposition === 'unsafe_to_replay'
        ? 'unsafe_to_replay'
        : res.execution?.executionTerminal?.disposition === 'denied'
            ? 'refused'
            : res.finalStage === 'solidified' ? 'solidified' : res.finalStage === 'failed' ? 'failed' : res.finalStage === 'aborted' ? 'refused' : 'innovated';
    const cap = res.capsule;
    if (traceRecorder && deps.learningTrace) {
        // Proxy llm_turn fold (slice 5): fold the run window's per-request turns BEFORE run.completed so the
        // trajectory stays sequence-ordered (model/tool detail inside the run, completion last). Own try — a
        // throwing sink mid-fold must not cost the run its completion event or packet draft.
        try {
            const proxyTraces = deps.learningTrace.proxyTraces;
            if (proxyTraces) {
                const turns = collectRunLlmTurns(proxyTraces.dir, { startMs: runStartMs, endMs: proxyTraceClock() }, proxyTraces.readOptions ? { readOptions: proxyTraces.readOptions } : {});
                // Exact-join key for Darwin: bind the unique proxy session before folding turns so
                // every subsequent event (and backfilled earlier ones) carries the same sessionId.
                // Fail closed when 0 or >1 sessions appear — never invent a correlation key.
                const sid = uniqueSessionId(turns);
                if (sid !== null) {
                    try {
                        traceRecorder.bindSessionId(sid);
                    }
                    catch { /* observability only */ }
                }
                for (const turn of turns)
                    traceRecorder.recordLlmTurn(turn);
            }
        }
        catch { /* observability only */ }
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
                environment: {
                    repo: task.repo,
                    runner: safety.runner ?? (deps.agent ? 'claude' : 'codex'),
                },
                ...(observedVerification !== undefined ? { verification: observedVerification } : {}),
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
        ...(res.bindingDigest ? { binding_digest: res.bindingDigest } : {}),
        ...(res.runId ? { run_id: res.runId } : {}),
        ...(res.execution ? { execution_terminal: res.execution.executionTerminal } : {}),
        ...(res.execution?.hubLifecycle ? { hub_lifecycle: res.execution.hubLifecycle } : {}),
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