import { LineTooLargeError } from '../events/eventStore.js';
import { TERMINAL, canTransition, stageForEventType } from '../cycle/stateMachine.js';
import {} from './geneSelection.js';
import { detectPlateau } from './exploration.js';
import { epigeneticPenaltyForIds } from './epigenetics.js';
import { deriveConfidenceEdges, confidenceFor, signalFingerprint, inertBannedGeneIds, INERT_BAN_OBSERVATION_WINDOW, } from './confidence.js';
import { captureEnvFingerprint, envFingerprintKey } from '../bootstrap/envFingerprint.js';
import { buildMutation } from './mutation.js';
import { gatePersonalityRisk } from '../personality/riskGate.js';
import { emitPersonalityRiskGated, emitPersonalitySelected } from '../personality/events.js';
import { applySelectForRun, applyStatsUpdate, applyForcePivot } from '../personality/evolveOps.js';
import { solidify } from './solidify.js';
import { buildEvolutionEvent } from './evolutionEvent.js';
import { cycleRecordsFromEvents } from '../signals/cycleHistoryFromEvents.js';
import { withoutTaskDomainSignals } from '../signals/taskDomain.js';
import { computeMetaSignals, deriveCycleHistory } from '../signals/metaSignals.js';
import { capabilityGapsFromSignals, curriculumOutcomesFromEvents, generateCurriculumSignals, normalizeCapabilityGaps, } from '../signals/curriculum.js';
import { resolveStrategy } from './strategyPresets.js';
import { classifyCycleFailure, } from './cycleFailureClassifier.js';
import { isDistilledGeneId } from './geneIntake.js';
import { deriveUcb1History } from './ucb1.js';
function persistedTerminalAfterLatestSelection(ingestor, cycleId, attemptStartedSeq) {
    const events = ingestor.readAll();
    let selectedSeq = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.seq <= attemptStartedSeq)
            break;
        if (event.type === 'decision.gene_selected' && event.payload['cycleId'] === cycleId) {
            selectedSeq = event.seq;
            break;
        }
    }
    if (selectedSeq < 0)
        return null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.seq <= selectedSeq)
            break;
        if (event.payload['cycleId'] !== cycleId)
            continue;
        const terminal = stageForEventType(event.type);
        if (terminal && TERMINAL.has(terminal))
            return terminal;
    }
    return null;
}
function selectionPolicyEventProjection(trace) {
    return {
        requested: trace.requested,
        effective: trace.effective,
        version: trace.selectionPolicyVersion,
        rewardVersion: trace.rewardPolicyVersion,
        ...(trace.arm ? {
            arm: {
                id: trace.arm.armId,
                pulls: trace.arm.pulls,
                completed: trace.arm.completedPulls,
                total: trace.arm.totalPulls,
                mean: trace.arm.meanReward,
                index: trace.arm.index,
            },
        } : {}),
        ...(trace.shadowDisagrees !== undefined ? { disagrees: trace.shadowDisagrees } : {}),
        ...(trace.fallbackReason ? { fallback: trace.fallbackReason } : {}),
    };
}
function minimalSelectionPolicyEventProjection(trace) {
    return {
        requested: trace.requested,
        effective: trace.effective,
        version: trace.selectionPolicyVersion,
        rewardVersion: trace.rewardPolicyVersion,
    };
}
function selectionGuardEventProjection(trace) {
    return {
        mode: trace.mode,
        version: trace.version,
        status: trace.status,
        ...(trace.reason ? { reason: trace.reason } : {}),
        ...(trace.maxMatch !== undefined ? { maxMatch: trace.maxMatch } : {}),
        ...(trace.matchSpread !== undefined ? { spread: trace.matchSpread } : {}),
    };
}
function minimalSelectionGuardEventProjection(trace) {
    return {
        mode: trace.mode,
        version: trace.version,
        status: trace.status,
        ...(trace.reason ? { reason: trace.reason } : {}),
    };
}
function selectionCandidateEventProjection(candidate) {
    // matchScore and scoring diagnostics stay off decision.gene_selected payloads so
    // UCB1/plateau telemetry retains the 4096B root-event line budget.
    const { matchScore: _matchScore, scoreBase: _scoreBase, kautoContribution: _kautoContribution, ...persisted } = candidate;
    return persisted;
}
async function ingestGeneSelectedWithTraceBudget(ingestor, event, policyTrace, guardTrace) {
    const guard = guardTrace ? selectionGuardEventProjection(guardTrace) : undefined;
    const minimalGuard = guardTrace ? minimalSelectionGuardEventProjection(guardTrace) : undefined;
    const projections = [];
    if (policyTrace) {
        projections.push({ selectionPolicy: selectionPolicyEventProjection(policyTrace), ...(guard ? { selectionGuard: guard } : {}) });
        projections.push({ selectionPolicy: minimalSelectionPolicyEventProjection(policyTrace), ...(guard ? { selectionGuard: guard } : {}) });
        if (minimalGuard) {
            projections.push({ selectionPolicy: minimalSelectionPolicyEventProjection(policyTrace), selectionGuard: minimalGuard });
            projections.push({ selectionGuard: minimalGuard });
        }
        projections.push({ selectionPolicy: minimalSelectionPolicyEventProjection(policyTrace) });
    }
    else if (guard) {
        projections.push({ selectionGuard: guard });
        if (minimalGuard)
            projections.push({ selectionGuard: minimalGuard });
    }
    projections.push({});
    for (let index = 0; index < projections.length; index += 1) {
        const projection = projections[index];
        try {
            await ingestor.ingest({
                type: event.type,
                human: event.human,
                payload: { ...event.payload, ...projection },
            });
            return;
        }
        catch (error) {
            if (!(error instanceof LineTooLargeError) || index === projections.length - 1)
                throw error;
        }
    }
}
/** Read the trailing run of cycle outcomes (newest last) from the event log, for plateau detection. */
function recentCycleOutcomes(ingestor, window) {
    let events;
    try {
        events = ingestor.tail(window);
    }
    catch {
        return [];
    }
    const out = [];
    for (const e of events) {
        if (e.type === 'cycle.solidified')
            out.push('success');
        else if (e.type === 'cycle.failed')
            out.push('failed');
    }
    return out;
}
/** Read recent per-(gene, env) cycle outcomes from the event log, for epigenetic per-environment suppression. */
function recentGeneOutcomes(ingestor, window) {
    let events;
    try {
        events = ingestor.tail(window);
    }
    catch {
        return [];
    }
    const out = [];
    for (const e of events) {
        if (e.type !== 'cycle.solidified' && e.type !== 'cycle.failed')
            continue;
        const p = e.payload;
        const gene = typeof p?.gene === 'string' ? p.gene : undefined;
        const env = typeof p?.env === 'string' ? p.env : undefined;
        if (!gene || !env)
            continue; // pre-epigenetic events lack the tags; skip
        out.push({ geneId: gene, envKey: env, status: e.type === 'cycle.solidified' ? 'success' : 'failed' });
    }
    return out;
}
function historyMetaSignals(ingestor, window) {
    try {
        return computeMetaSignals(deriveCycleHistory(cycleRecordsFromEvents(ingestor.tail(window))));
    }
    catch {
        return [];
    }
}
function historyCycleCount(ingestor, window, currentCycleId) {
    let events;
    try {
        events = ingestor.tail(window);
    }
    catch {
        return 1;
    }
    const cycleIds = new Set();
    for (const e of events) {
        if (e.type !== 'cycle.started' && e.type !== 'cycle.solidified' && e.type !== 'cycle.failed' && e.type !== 'cycle.aborted')
            continue;
        const p = e.payload;
        if (typeof p?.cycleId === 'string')
            cycleIds.add(p.cycleId);
    }
    cycleIds.add(currentCycleId);
    return cycleIds.size;
}
function mergeSignals(signals, metaSignals) {
    return [...new Set([...signals, ...metaSignals])];
}
function candidateIds(c) {
    return [...new Set([c.geneId, c.assetId].filter((id) => typeof id === 'string' && id.length > 0))];
}
function isCandidateInSet(c, ids) {
    return candidateIds(c).some((id) => ids.has(id));
}
function categoryForStrategy(category, strategy) {
    if (strategy.name === 'innovate')
        return 'innovate';
    if (strategy.name === 'steady-state')
        return 'optimize';
    return category;
}
/**
 * Derive preferred-gene confidence observations from the event log (positive cross-cycle learning).
 * Each terminal cycle (cycle.solidified / cycle.failed) carries the gene that ran and the outcome; the signals
 * that drove it are carried by the cycle.signals_collected event of the SAME cycleId. We join the two on
 * cycleId, fingerprint the signals, and emit one (signalFingerprint, geneId, status, at) observation per cycle.
 * Reading from the same append-only log makes this fully replayable. ad-hoc (innovate) cycles have no gene to
 * credit and are skipped.
 */
function recentConfidenceObservations(ingestor, window, opts = {}) {
    let events;
    try {
        events = ingestor.tail(window);
    }
    catch {
        return [];
    }
    // First pass: map cycleId → its collected signals.
    const signalsByCycle = new Map();
    for (const e of events) {
        if (e.type !== 'cycle.signals_collected')
            continue;
        const p = e.payload;
        const cycleId = typeof p?.cycleId === 'string' ? p.cycleId : undefined;
        const signalSource = Array.isArray(p?.baseSignals) ? p.baseSignals : p?.signals;
        const signals = Array.isArray(signalSource) ? signalSource.map(String) : undefined;
        if (!cycleId || !signals)
            continue;
        signalsByCycle.set(cycleId, signals);
    }
    // Second pass: for each terminal cycle with a real gene, emit an observation under its signal fingerprint.
    const out = [];
    for (const e of events) {
        if (e.type !== 'cycle.solidified' && e.type !== 'cycle.failed')
            continue;
        const p = e.payload;
        const cycleId = typeof p?.cycleId === 'string' ? p.cycleId : undefined;
        const gene = typeof p?.gene === 'string' ? p.gene : undefined;
        if (!cycleId || !gene || gene === 'ad-hoc')
            continue; // innovate cycles credit no existing gene
        const signals = signalsByCycle.get(cycleId);
        if (!signals)
            continue; // cannot fingerprint without the cycle's signals
        const at = Date.parse(e.ts);
        // #195: a solidified cycle that produced no measurable value (producedValue === false) is INERT, not a
        // success — it must build no confidence and instead feeds the inert-streak ban. Failures stay 'failed'.
        // Older events predate the producedValue tag; when it is absent we treat the cycle as a real success, so we
        // never retroactively reclassify history into a surprise ban.
        const status = e.type === 'cycle.failed' ? 'failed' : p?.producedValue === false ? 'inert' : 'success';
        const fingerprintSignals = opts.ignoreTaskDomain ? withoutTaskDomainSignals(signals) : signals;
        out.push({
            signalFingerprint: signalFingerprint(fingerprintSignals),
            geneId: gene,
            status,
            at: Number.isFinite(at) ? at : 0,
        });
    }
    return out;
}
/**
 * cycle engine(M4A-1d): signals → trigger → 选 gene → mutation → 执行 → solidify → Capsule + EvolutionEvent.
 * 每阶段 emit root_events 并校验状态机迁移; 写入序列守硬化 A4(capsule asset_id 先 → 填 capsule_id → event asset_id).
 */
export class CycleEngine {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Add V1-compatible curriculum targets from V2's replayable event history. Public so the orchestrator can run
     * it before candidate assembly; runCycle calls it again for direct callers. Set merging makes that idempotent.
     */
    prepareCurriculumSignals(signals) {
        let externalCapabilityGaps = [];
        try {
            externalCapabilityGaps = normalizeCapabilityGaps(this.deps.capabilityGaps?.() ?? []);
        }
        catch {
            // An optional lifecycle-state reader must never suppress local curriculum generation.
        }
        try {
            const localCapabilityGaps = capabilityGapsFromSignals(signals);
            const curriculumSignals = generateCurriculumSignals({
                outcomes: curriculumOutcomesFromEvents(this.deps.ingestor.readAll()),
                // Preserve existing explicit local-signal precedence; Hub gaps fill the otherwise-missing V1 source.
                capabilityGaps: normalizeCapabilityGaps([...localCapabilityGaps, ...externalCapabilityGaps]),
            });
            return { signals: mergeSignals(signals, curriculumSignals), curriculumSignals };
        }
        catch {
            return { signals: [...signals], curriculumSignals: [] };
        }
    }
    async runCycle(input) {
        const { ingestor, store } = this.deps;
        const now = this.deps.now();
        const envKey = envFingerprintKey((this.deps.envFingerprint ?? captureEnvFingerprint)());
        const reasons = [];
        const baseSignals = [...input.signals];
        const preparedSignals = input.curriculumSignals === undefined
            ? this.prepareCurriculumSignals(input.signals)
            : { signals: mergeSignals(input.signals, input.curriculumSignals), curriculumSignals: [...input.curriculumSignals] };
        const selectionSignals = preparedSignals.signals;
        const curriculumSignals = preparedSignals.curriculumSignals;
        const metaSignals = historyMetaSignals(ingestor, 100);
        const cycleSignals = mergeSignals(selectionSignals, metaSignals);
        // PORT v1 #279 issue-reporter: classify cycle.failed payloads when the caller supplies host context. The
        // post-solidify failed path adds V2-local context (current gene + blast radius) so hard-filtered local no-op
        // genes are reachable without re-emitting the old ban_gene soft signal.
        const failureClassPayload = (current, execSessionLog) => {
            // The agent transcript (#279 production wiring) comes from the execution layer on a failed outcome; the
            // explicit failureContext.sessionLog (tests / external callers) is the fallback. EITHER one lets the
            // host_* buckets fire on the real path.
            const sessionLog = execSessionLog ?? input.failureContext?.sessionLog;
            // Locality must recognise V2's real gene prefix `gene_distilled_` (isDistilledGeneId), not just the
            // V1-only `gene_auto_` / content-hash `sha256:` forms — otherwise this gate stays shut for every real V2
            // gene and classifyCycleFailure never runs (mirror of isLocalGeneratedGene in cycleFailureClassifier.ts).
            // NB the prefix is now a NAMESPACE marker, not a provenance tag (the authoritative source is generation_meta,
            // V1 #302); this call site only has a gene id, so it falls back to the prefix.
            const localCurrentGene = current?.geneId !== undefined && (isDistilledGeneId(current.geneId) || /^sha256:/.test(current.geneId) || /^gene_auto_/.test(current.geneId));
            // Run classification when we have ANY host context (an exec transcript or an injected failureContext) OR a
            // local-gene blast to judge; otherwise stay default-open (unclassified, no payload).
            const hasHostContext = sessionLog !== undefined || input.failureContext !== undefined;
            if (!hasHostContext && (current?.blastRadius === undefined || !localCurrentGene))
                return {};
            const r = classifyCycleFailure({
                signals: cycleSignals,
                ...(sessionLog !== undefined ? { sessionLog } : {}),
                ...(input.failureContext?.recentFailedEvents !== undefined ? { recentEvents: input.failureContext.recentFailedEvents } : {}),
                ...(current?.geneId !== undefined ? { geneId: current.geneId } : {}),
                ...(current?.blastRadius !== undefined ? { blastRadius: current.blastRadius } : {}),
            });
            return r.reason ? { failure_class: r.failureClass, failure_class_reason: r.reason } : { failure_class: r.failureClass };
        };
        const executionMetadata = (exec) => ({
            ...(exec.failureKind !== undefined ? { failureKind: exec.failureKind } : {}),
            ...(exec.exitCode !== undefined ? { exitCode: exec.exitCode } : {}),
            ...(exec.bindingCorrelation ? { bindingDigest: exec.bindingCorrelation.bindingDigest, runId: exec.bindingCorrelation.runId } : {}),
            ...(exec.executionTerminal ? { terminalDisposition: exec.executionTerminal.disposition } : {}),
            ...(exec.hubLifecycle ? { hubLifecycle: exec.hubLifecycle } : {}),
            ...(exec.provenance ? {
                provenance: {
                    geneIds: exec.provenance.gene_ids,
                    capsuleIds: exec.provenance.capsule_ids,
                    resultAssetRefs: exec.provenance.result_asset_refs,
                    proofRefs: exec.provenance.proof_refs,
                    terminalDisposition: exec.provenance.terminal_disposition,
                },
            } : {}),
        });
        const strategy = resolveStrategy({ name: input.strategyName, signals: cycleSignals, cycleCount: historyCycleCount(ingestor, 1000, input.cycleId) });
        const cycleCategory = categoryForStrategy(input.category, strategy);
        let stage = 'none';
        const advance = (to) => {
            if (!canTransition(stage, to))
                throw new Error(`非法 cycle 迁移 ${stage}→${to}`);
            stage = to;
        };
        const cycleStarted = await ingestor.ingest({ type: 'cycle.started', human: { title: `cycle ${input.cycleId} 启动` }, payload: { cycleId: input.cycleId, problemId: input.problem.id } });
        advance('started');
        await ingestor.ingest({
            type: 'cycle.signals_collected',
            human: { title: `采集 ${cycleSignals.length} 信号` },
            payload: {
                cycleId: input.cycleId,
                signals: cycleSignals,
                baseSignals,
                ...(curriculumSignals.length > 0 ? { curriculumSignals } : {}),
                ...(metaSignals.length > 0 ? { metaSignals, strategy: strategy.name } : {}),
            },
        });
        advance('signals_collected');
        // 触发闸
        const trig = this.deps.trigger ? await this.deps.trigger(input.problem, now) : { trigger: true, reasons: ['无 trigger 注入, 直接触发'], valueScore: 0 };
        if (!trig.trigger) {
            await ingestor.ingest({ type: 'cycle.aborted', human: { title: `cycle ${input.cycleId} 抑制` }, payload: { cycleId: input.cycleId, reasons: trig.reasons } });
            advance('aborted');
            return { cycleId: input.cycleId, triggered: false, finalStage: stage, producedValue: false, reasons: trig.reasons };
        }
        // 选 gene(可解释决策). Exploration: when recent cycles plateau, enable drift to escape local optima.
        const recentOutcomes = recentCycleOutcomes(ingestor, 100);
        const plateau = detectPlateau(recentOutcomes);
        // 可进化人格(可选). 未注入 ⇒ personalityForRun 留 undefined, 整段跳过, 后续行为逐字不变.
        // 顺序: ③平台期先强制转向(拉高 creativity/risk 进探索) → ①自然选择朝最佳桶靠拢 + 规则触发变异.
        // 选出的状态落盘(applySelectForRun 内 save), exec bridge 之后读回注入 prompt(用途①); 也喂本轮风险闸.
        let personalityForRun;
        let personalityKnown = false;
        if (this.deps.personality) {
            const personalityDeps = { store: this.deps.personality, ingestor, cycleId: input.cycleId };
            // ③ plateau pivot: 在 select 之前, 让 select 从 pivot 后的 current 起步(personality.pivoted).
            if (plateau.active) {
                await applyForcePivot(personalityDeps, { severity: plateau.severity, evalsSinceImprovement: plateau.count });
            }
            // ① 自然选择 + 触发变异(真变异才发 personality.mutated). driftEnabled 跟随 plateau;
            //    recentEvents 由事件日志的近期 outcome 派生, 让"失败连击触发变异"在环内真正生效.
            const sel = await applySelectForRun(personalityDeps, {
                driftEnabled: plateau.active,
                signals: selectionSignals,
                recentEvents: recentOutcomes.map((status) => ({ outcome: { status } })),
            });
            personalityForRun = sel.state;
            personalityKnown = sel.known;
        }
        // 每轮结束把 outcome/score 回写到当轮所用人格桶(applyStatsUpdate: 只动 stats/history, 不挪 current).
        // 在每个终止点调用, 使下一轮 applySelectForRun 的自然选择能朝这个桶靠拢. 未注入 ⇒ no-op.
        const recordPersonalityOutcome = async (outcome, score) => {
            if (!this.deps.personality || !personalityForRun)
                return;
            await applyStatsUpdate({ store: this.deps.personality, ingestor, cycleId: input.cycleId }, { personality: personalityForRun, outcome, score });
        };
        let ucb1History;
        if (plateau.active && input.selectionPolicy && input.selectionPolicy !== 'engine-health') {
            try {
                ucb1History = deriveUcb1History(ingestor.readAllStrict());
            }
            catch {
                // Active UCB1 fails safe to legacy drift; shadow records missing_history in its compact policy trace.
                ucb1History = undefined;
            }
        }
        const exploration = plateau.active
            ? {
                plateau,
                driftEnabled: true,
                totalAttempts: input.candidates.reduce((s, c) => s + (c.view?.total ?? 0), 0),
                ...(input.selectionPolicy ? { policy: input.selectionPolicy } : {}),
                ...(ucb1History ? { ucb1History } : {}),
            }
            : undefined;
        // Epigenetic: penalize candidates that fail in THIS environment class (derived from per-env outcome history).
        const geneOutcomes = recentGeneOutcomes(ingestor, 200);
        // Confidence (positive cross-cycle learning): reward candidates that keep succeeding under the CURRENT
        // signal fingerprint. Derived from the same event log, applied as a soft fourth factor in selection.
        const confidenceObs = recentConfidenceObservations(ingestor, 200);
        const confidenceEdges = deriveConfidenceEdges(confidenceObs);
        const currentConfidenceFingerprint = signalFingerprint(baseSignals);
        // #195: drop genes stuck producing only inert (zero-work) cycles on THIS signal. A sole-matching do-nothing
        // gene is otherwise re-selected every cycle (drift can't diversify a single candidate) and the failure-streak
        // ban never fires because nothing "fails" — so it dominates --loop forever while producing no artifacts.
        // Removing it makes selection fall through to mutation (selected:null → fresh gene), restoring diversity.
        // The ban is derived from a SEPARATE, much wider window than confidence scoring above: a banned gene runs as
        // ad-hoc and emits no observation for itself, so a 200-event (~28-cycle) window would let intervening innovate
        // cycles evict its inert run (or the earlier real success that exempts it) and the ban would flap. Recomputing
        // it over INERT_BAN_OBSERVATION_WINDOW events (mirroring v1's memory-graph read horizon) keeps the trailing run
        // and the successCount exemption alive across intervening cycles. tail() reads the full log either way (no I/O cost).
        const inertBanObs = recentConfidenceObservations(ingestor, INERT_BAN_OBSERVATION_WINDOW, { ignoreTaskDomain: true });
        const inertBanFingerprint = signalFingerprint(withoutTaskDomainSignals(baseSignals));
        const inertBanned = inertBannedGeneIds(deriveConfidenceEdges(inertBanObs), inertBanObs, inertBanFingerprint);
        const candidates = input.candidates
            .filter((c) => !isCandidateInSet(c, inertBanned))
            .map((c) => {
            const epi = epigeneticPenaltyForIds(candidateIds(c), envKey, geneOutcomes);
            const conf = confidenceFor(confidenceEdges, currentConfidenceFingerprint, c.geneId, now);
            const withEpi = epi > 0 ? { ...c, epigeneticPenalty: epi } : c;
            return conf > 0 ? { ...withEpi, confidence: conf } : withEpi;
        });
        // #97 distilled-gene fallback pool: attach the env-scoped epigenetic penalty (so selection can hard-skip a
        // suppressed fallback, v1 parity) and drop any inert-banned id (composes with #195). Selection uses these only
        // when normal selection has no reusable positive choice.
        const distilledFallback = (input.distilledFallback ?? [])
            .filter((c) => !isCandidateInSet(c, inertBanned))
            .map((c) => {
            const epi = epigeneticPenaltyForIds(candidateIds(c), envKey, geneOutcomes);
            return epi > 0 ? { ...c, epigeneticPenalty: epi } : c;
        });
        const semanticCorpus = input.semanticCorpus?.filter((c) => !isCandidateInSet(c, inertBanned));
        const decision = (await this.deps.selection.run({ signals: selectionSignals, candidates, ...(semanticCorpus ? { semanticCorpus } : {}), ...(input.disableSemanticIdf ? { disableSemanticIdf: true } : {}), floor: input.selectionFloor, ...(input.selectionGuard ? { selectionGuard: input.selectionGuard } : {}), ...(input.forcedGeneId !== undefined ? { forcedGeneId: input.forcedGeneId } : {}), ...(exploration ? { exploration } : {}), ...(distilledFallback.length > 0 ? { distilledFallback } : {}), ...(input.antiWarnings && input.antiWarnings.length > 0 ? { antiWarnings: input.antiWarnings } : {}), ...(input.memoryEvidence && input.memoryEvidence.length > 0 ? { memoryEvidence: input.memoryEvidence } : {}) }, { now, cycleId: input.cycleId, ...(this.deps.rng ? { rng: this.deps.rng } : {}) }));
        const geneId = decision.selectedGeneId ?? 'ad-hoc';
        const runPostSelectionStep = async (phase, step) => {
            try {
                return await step();
            }
            catch (error) {
                let persistedTerminal = null;
                try {
                    persistedTerminal = persistedTerminalAfterLatestSelection(ingestor, input.cycleId, cycleStarted.seq);
                }
                catch {
                    // Readback is best-effort; compensation below remains the fallback when the log is unavailable.
                }
                if (persistedTerminal && !TERMINAL.has(stage) && canTransition(stage, persistedTerminal)) {
                    advance(persistedTerminal);
                }
                if (!persistedTerminal && !TERMINAL.has(stage)) {
                    try {
                        await ingestor.ingest({
                            type: 'cycle.failed',
                            human: { title: `cycle ${input.cycleId} selection 后异常` },
                            payload: { cycleId: input.cycleId, reason: 'post_selection_error', phase, gene: geneId, env: envKey },
                        });
                        advance('failed');
                        try {
                            await recordPersonalityOutcome('failed', null);
                        }
                        catch {
                            // Personality is soft state; never let its writeback replace the original failure.
                        }
                    }
                    catch {
                        // The event store itself may be unavailable. Preserve and rethrow the original step failure.
                    }
                }
                throw error;
            }
        };
        await runPostSelectionStep('decision_event', () => ingestGeneSelectedWithTraceBudget(ingestor, {
            type: 'decision.gene_selected',
            human: { title: `选 gene ${decision.selectedGeneId ?? '(innovate)'}`, why: decision.candidates.map((c) => `${c.geneId}:${c.score.toFixed(3)}`).join(', ') || '无候选→innovate' },
            payload: { cycleId: input.cycleId, selectedGeneId: decision.selectedGeneId, ...(decision.selectedAssetId ? { selectedAssetId: decision.selectedAssetId } : {}), ...(decision.selectedReason ? { selectedReason: decision.selectedReason } : {}), candidates: decision.candidates.map(selectionCandidateEventProjection), ...(decision.antiWarnings && decision.antiWarnings.length > 0 ? { antiWarnings: decision.antiWarnings } : {}), ...(decision.memoryEvidence && decision.memoryEvidence.length > 0 ? { memoryEvidence: decision.memoryEvidence } : {}), weightsVersion: decision.weightsVersion, ...(decision.semanticProfileVersion ? { semanticProfileVersion: decision.semanticProfileVersion } : {}), ...(decision.semanticDocumentCount !== undefined ? { semanticDocumentCount: decision.semanticDocumentCount } : {}), strategy: decision.strategyName, strategyPreset: strategy.name, ...(plateau.active ? { plateau } : {}), ...(inertBanned.size > 0 ? { inertBanned: [...inertBanned] } : {}) },
        }, decision.selectionPolicy, decision.selectionGuard));
        advance('gene_selected');
        // 变异
        const builtMutation = await runPostSelectionStep('mutation_build', () => buildMutation({ decision, category: cycleCategory, signals: cycleSignals, target: input.target, expectedEffect: input.expectedEffect }));
        // 人格风险闸(用途②): 高危人格禁 innovate / 未达阈值的 high-risk 降级. 未注入人格 ⇒ 原样放行.
        // 用本轮 applySelectForRun 选出的状态(personalityForRun), 而非再读一次 store.currentState() ——
        // 保证"喂 prompt 的风格 / 过风险闸 / 回写统计"三者用的是同一个当轮人格.
        let mutation = builtMutation;
        if (this.deps.personality && personalityForRun) {
            await runPostSelectionStep('personality_selected', () => emitPersonalitySelected(ingestor, { cycleId: input.cycleId, personality: personalityForRun, known: personalityKnown }));
            const gate = await runPostSelectionStep('personality_risk_gate', () => gatePersonalityRisk(builtMutation, personalityForRun));
            mutation = gate.mutation;
            await runPostSelectionStep('personality_risk_gate', () => emitPersonalityRiskGated(ingestor, { cycleId: input.cycleId, personality: personalityForRun, gate }));
        }
        await runPostSelectionStep('mutation_event', () => ingestor.ingest({ type: 'mutation.built', human: { title: `变异 ${mutation.category} → ${mutation.target}` }, payload: { cycleId: input.cycleId, mutationId: mutation.id, risk: mutation.risk_level, category: mutation.category, strategyPreset: strategy.name } }));
        advance('mutation_built');
        // 执行(agent/runtime)
        let exec;
        try {
            exec = await input.execute(mutation, decision);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // execute threw before returning a transcript; the error text IS the host context (a provider error that
            // surfaces as a thrown exception still classifies as host_provider_error). Pass it as the sessionLog.
            await runPostSelectionStep('terminal_event', () => ingestor.ingest({ type: 'cycle.failed', human: { title: `cycle ${input.cycleId} 执行抛错` }, payload: { cycleId: input.cycleId, error: msg, gene: geneId, env: envKey, ...failureClassPayload({ geneId }, msg) } }));
            advance('failed');
            await recordPersonalityOutcome('failed', null);
            return { cycleId: input.cycleId, triggered: true, finalStage: stage, producedValue: false, decision, mutation, reasons: [...reasons, `执行异常: ${msg}`] };
        }
        if (input.solidifyPermit) {
            let permit;
            try {
                permit = await input.solidifyPermit({
                    cycleId: input.cycleId,
                    ...(input.executionBinding ? { bindingDigest: input.executionBinding.binding_digest, runId: input.executionBinding.correlation.run_id } : {}),
                    ...(exec.executionTerminal ? { executionTerminal: exec.executionTerminal } : {}),
                    ...(exec.provenance ? { provenance: exec.provenance } : {}),
                    geneId,
                    signals: cycleSignals,
                    mutation,
                    decision,
                    outcome: exec.outcome,
                    ...(exec.proofOfWork ? { proofOfWork: exec.proofOfWork } : {}),
                    ...(exec.strongEvidence !== undefined ? { strongEvidence: exec.strongEvidence } : {}),
                });
            }
            catch {
                permit = { ok: false, reason: 'solidify_permit_error' };
            }
            if (!permit.ok) {
                const reason = `solidify permit denied: ${permit.reason}`;
                exec = {
                    ...exec,
                    outcome: { ...exec.outcome, status: 'failed', reason },
                    executionTerminal: { status: 'failed', disposition: 'denied' },
                    provenance: exec.provenance
                        ? { ...exec.provenance, permit, terminal_disposition: 'denied' }
                        : undefined,
                };
                await runPostSelectionStep('terminal_event', () => ingestor.ingest({
                    type: 'cycle.failed',
                    human: { title: `cycle ${input.cycleId} permit denied` },
                    payload: {
                        cycleId: input.cycleId,
                        reason: permit.reason,
                        gene: geneId,
                        env: envKey,
                        ...executionMetadata(exec),
                        ...failureClassPayload({ geneId }),
                    },
                }));
                advance('failed');
                await recordPersonalityOutcome('failed', null);
                return {
                    cycleId: input.cycleId,
                    triggered: true,
                    finalStage: stage,
                    producedValue: false,
                    decision,
                    mutation,
                    execution: exec,
                    ...(exec.bindingCorrelation ? { bindingDigest: exec.bindingCorrelation.bindingDigest, runId: exec.bindingCorrelation.runId } : {}),
                    ...(exec.executionTerminal ? { terminalDisposition: exec.executionTerminal.disposition } : {}),
                    ...executionMetadata(exec),
                    reasons: [...reasons, reason],
                };
            }
        }
        // solidify → Capsule
        const sol = await runPostSelectionStep('solidify', () => solidify({
            geneId, trigger: cycleSignals, summary: input.summary, confidence: input.confidence,
            outcome: exec.outcome, proofOfWork: exec.proofOfWork, strongEvidence: exec.strongEvidence,
            ...(exec.failureIdentity ? { failureIdentity: exec.failureIdentity } : {}),
        }));
        reasons.push(...sol.reasons);
        await runPostSelectionStep('capsule_store', () => store.put(sol.capsule));
        await runPostSelectionStep('capsule_event', () => ingestor.ingest({ type: 'capsule.produced', human: { title: `Capsule ${sol.resolutionStatus}` }, payload: { cycleId: input.cycleId, capsuleId: sol.capsule.asset_id, resolutionStatus: sol.resolutionStatus, producedValue: sol.producedValue, blastRadius: sol.capsule.blast_radius } }));
        // EvolutionEvent(capsule_id 引 Capsule; outcome 真值在此).
        // Selection stamp: selected_asset_id / kauto_member / evolver_version / selection_stage=applied
        // live in event.meta so production cohort collection can separate writer membership from
        // selected/applied member share. Only true kauto membership is stamped (omit-not-null).
        const selectedCandidate = decision.selectedGeneId
            ? input.candidates.find((c) => (c.geneId === decision.selectedGeneId
                && (decision.selectedAssetId === undefined || c.assetId === decision.selectedAssetId)))
                ?? input.candidates.find((c) => c.geneId === decision.selectedGeneId)
                ?? (input.distilledFallback ?? []).find((c) => (c.geneId === decision.selectedGeneId
                    && (decision.selectedAssetId === undefined || c.assetId === decision.selectedAssetId)))
            : undefined;
        const envFp = (this.deps.envFingerprint ?? captureEnvFingerprint)();
        const event = await runPostSelectionStep('evolution_event_build', () => buildEvolutionEvent({
            intent: cycleCategory, signals: cycleSignals, genesUsed: decision.selectedGeneId ? [decision.selectedGeneId] : [],
            mutationId: mutation.id, blastRadius: sol.capsule.blast_radius, outcome: exec.outcome,
            capsuleId: sol.capsule.asset_id, sourceType: decision.selectedGeneId ? 'reused' : 'generated',
            selection: {
                selectionStage: 'applied',
                ...(decision.selectedAssetId ? { selectedAssetId: decision.selectedAssetId } : {}),
                ...(selectedCandidate?.kautoMember === true ? { kautoMember: true } : {}),
                ...(envFp.evolver_version ? { evolverVersion: envFp.evolver_version } : {}),
            },
        }));
        await runPostSelectionStep('evolution_event_store', () => store.put(event));
        await runPostSelectionStep('evolution_event_projection', () => ingestor.ingest({ type: 'evolution_event.projected', human: { title: `世代记录 ${exec.outcome.status}` }, payload: { cycleId: input.cycleId, eventId: event.asset_id, capsuleId: sol.capsule.asset_id, outcome: exec.outcome } }));
        if (exec.outcome.status === 'failed') {
            await runPostSelectionStep('terminal_event', () => ingestor.ingest({
                type: 'cycle.failed',
                human: { title: `cycle ${input.cycleId} 失败` },
                payload: {
                    cycleId: input.cycleId,
                    resolutionStatus: sol.resolutionStatus,
                    outcome: exec.outcome,
                    gene: geneId,
                    env: envKey,
                    ...executionMetadata(exec),
                    // Only forward blast radius as a no-op signal when it was measured from a git_diff proof. solidify.ts
                    // forces blast to {0,0} for non-git_diff proofs (artifact_hash/external_receipt/tool_call_trace),
                    // where {0,0} means "blast unknown", NOT "no change" — forwarding it would mis-classify a productive
                    // run as local_gene_no_blast. Undefined here falls through to default-open unclassified.
                    ...failureClassPayload({
                        geneId,
                        ...((exec.proofOfWork === undefined || exec.proofOfWork.kind === 'git_diff')
                            ? { blastRadius: sol.capsule.blast_radius }
                            : {}),
                    }, exec.sessionLog),
                },
            }));
            advance('failed');
        }
        else {
            await runPostSelectionStep('terminal_event', () => ingestor.ingest({ type: 'cycle.solidified', human: { title: `cycle ${input.cycleId} 固化` }, payload: { cycleId: input.cycleId, capsuleId: sol.capsule.asset_id, outcome: exec.outcome, gene: geneId, env: envKey, producedValue: sol.producedValue } }));
            advance('solidified');
        }
        // 人格统计回写(用途②): 用本轮真实 outcome/score 回写当轮人格桶, 供下一轮自然选择靠拢. 未注入 ⇒ no-op.
        await recordPersonalityOutcome(exec.outcome.status, exec.outcome.score);
        return {
            cycleId: input.cycleId,
            triggered: true,
            finalStage: stage,
            producedValue: sol.producedValue,
            decision,
            mutation,
            capsule: sol.capsule,
            event,
            resolutionStatus: sol.resolutionStatus,
            execution: exec,
            ...(exec.bindingCorrelation ? { bindingDigest: exec.bindingCorrelation.bindingDigest, runId: exec.bindingCorrelation.runId } : {}),
            ...(exec.executionTerminal ? { terminalDisposition: exec.executionTerminal.disposition } : {}),
            ...executionMetadata(exec),
            reasons,
        };
    }
}