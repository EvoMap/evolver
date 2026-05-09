'use strict';

const { getObserverPaths } = require('./paths');
const { readJsonSafe, readJsonl, paginate } = require('./jsonl');
const { redactValue } = require('./redact');
const { readPipelineEvents } = require('./pipelineEvents');

const PHASE_ORDER = [
  'detect_signals',
  'select_gene',
  'asset_search',
  'mutate_strategy',
  'validate',
  'solidify',
  'confirmation',
];

function listRuns(query = {}) {
  const runs = buildRuns().sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt));
  return paginate(runs, query);
}

function getRun(runId) {
  const runs = buildRuns();
  const run = runs.find((entry) => entry.runId === runId);
  if (!run) return null;
  const paths = getObserverPaths();
  const events = readJsonl(paths.eventsPath).map(redactValue).filter((e) => belongsToRun(e, runId));
  const assetCalls = readJsonl(paths.assetCallLogPath).map(redactValue).filter((e) => belongsToRun(e, runId));
  const pipelineEvents = readPipelineEvents().filter((e) => belongsToRun(e, runId));
  const detail = buildRunDetail(runId);
  return {
    ...run,
    detail,
    phases: buildPhases(run, pipelineEvents, events, assetCalls),
    evidence: events,
    assets: assetCalls,
    pipelineEvents,
  };
}

function buildRunDetail(runId) {
  const paths = getObserverPaths();
  const solidify = readJsonSafe(paths.solidifyStatePath, null);
  const last = solidify && solidify.last_run;
  if (!last || String(last.run_id) !== String(runId)) return null;
  const safe = redactValue(last);
  return {
    parentEventId: safe.parent_event_id || null,
    selectedCapsuleId: safe.selected_capsule_id || null,
    signals: safe.signals || [],
    initialUserPrompt: safe.initial_user_prompt || null,
    activeTaskId: safe.active_task_id || null,
    activeTaskTitle: safe.active_task_title || null,
    blastRadius: safe.blast_radius_estimate || null,
    selector: safe.selector || null,
    mutation: safe.mutation ? simplifyMutation(safe.mutation) : null,
    personalityState: safe.personality_state || null,
    drift: safe.drift || null,
    appliedLessons: safe.applied_lessons || [],
    hubLessons: safe.hub_lessons || [],
    sourceType: safe.source_type || null,
    reusedAssetId: safe.reused_asset_id || null,
    baselineGitHead: safe.baseline_git_head || null,
  };
}

function simplifyMutation(mutation) {
  if (!mutation || typeof mutation !== 'object') return null;
  return {
    id: mutation.id || null,
    category: mutation.category || null,
    triggerSignals: mutation.trigger_signals || [],
    targetType: mutation.target_type || null,
    summary: mutation.summary || null,
    strategySteps: Array.isArray(mutation.strategy) ? mutation.strategy.length : null,
    constraints: mutation.constraints || null,
  };
}

function buildRuns() {
  const paths = getObserverPaths();
  const cycle = readJsonSafe(paths.cycleProgressPath, null);
  const solidify = readJsonSafe(paths.solidifyStatePath, null);
  const events = readJsonl(paths.eventsPath).map(redactValue);
  const assetCalls = readJsonl(paths.assetCallLogPath).map(redactValue);
  const pipelineEvents = readPipelineEvents();
  const runs = new Map();

  addCycleRun(runs, cycle, solidify);
  for (const event of events) mergeRun(runs, summaryFromEvent(event));
  for (const call of assetCalls) mergeRun(runs, summaryFromAssetCall(call));
  for (const event of pipelineEvents) mergeRun(runs, summaryFromPipelineEvent(event));

  return Array.from(runs.values()).map((run) => ({
    ...run,
    requiresConfirmation: Boolean(run.requiresConfirmation),
  }));
}

function addCycleRun(runs, cycle, solidify) {
  if (!cycle && !(solidify && solidify.last_run)) return;
  const last = solidify && solidify.last_run || {};
  const lastSolidify = solidify && solidify.last_solidify || null;
  const pending = isPending(last, lastSolidify);
  const runId = String(cycle && (cycle.run_id || cycle.outer_cycle) || last.run_id || last.mutation_id || 'current');
  mergeRun(runs, {
    runId,
    cycleId: cycle && String(cycle.outer_cycle || cycle.cycle_id || last.cycleId || ''),
    status: deriveCycleStatus(cycle, last, lastSolidify, pending),
    startedAt: toIso(cycle && cycle.started_at || last.started_at || last.created_at),
    updatedAt: toIso(cycle && cycle.updated_at || lastSolidify && lastSolidify.timestamp || last.finished_at || last.created_at),
    finishedAt: toIso(last.finished_at || lastSolidify && lastSolidify.timestamp),
    activeTaskTitle: last.active_task_title || null,
    selectedGeneId: last.selected_gene_id || null,
    outcome: last.outcome || (lastSolidify && lastSolidify.rejected ? { status: 'failed', reason: lastSolidify.reason } : null),
    validationResult: validationResult(last),
    requiresConfirmation: pending,
  });
}

function isPending(lastRun, lastSolidify) {
  if (!lastRun || !lastRun.run_id) return false;
  if (!lastSolidify || !lastSolidify.run_id) return true;
  return String(lastSolidify.run_id) !== String(lastRun.run_id);
}

function deriveCycleStatus(cycle, lastRun, lastSolidify, pending) {
  if (cycle && cycle.phase && isCycleFresh(cycle)) return 'running';
  if (lastSolidify && String(lastSolidify.run_id) === String(lastRun.run_id)) {
    if (lastSolidify.rejected) return 'failed';
    if (lastSolidify.success || lastSolidify.solidified) return 'completed';
  }
  if (pending) return 'review_pending';
  if (lastRun.outcome) return inferOutcome(lastRun.outcome);
  if (lastRun.selected_gene_id) return 'selected';
  return 'unknown';
}

function isCycleFresh(cycle) {
  const t = Number(cycle && cycle.updated_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < 5 * 60 * 1000;
}

function summaryFromEvent(event) {
  const runId = event.run_id || event.mutation_id || event.id;
  if (!runId) return null;
  const eventTime = event.started_at || event.timestamp || event.created_at;
  return {
    runId: String(runId),
    status: inferOutcome(event.outcome),
    startedAt: toIso(eventTime),
    updatedAt: toIso(event.finished_at || eventTime),
    finishedAt: toIso(event.finished_at),
    selectedGeneId: firstGene(event.genes_used),
    outcome: event.outcome || null,
    validationResult: validationResult(event),
    requiresConfirmation: Boolean(event.requires_confirmation),
  };
}

function summaryFromAssetCall(call) {
  if (!call.run_id) return null;
  return {
    runId: String(call.run_id),
    status: 'running',
    updatedAt: toIso(call.timestamp),
    requiresConfirmation: isConfirmationAction(call.action),
  };
}

function summaryFromPipelineEvent(event) {
  const runId = event.run_id || event.cycle_id;
  if (!runId) return null;
  return {
    runId: String(runId),
    cycleId: event.cycle_id,
    status: phaseStatusToRunStatus(event.status),
    startedAt: toIso(event.started_at || event.timestamp),
    updatedAt: toIso(event.finished_at || event.timestamp),
    finishedAt: toIso(event.finished_at),
    requiresConfirmation: Boolean(event.requires_confirmation),
  };
}

function mergeRun(runs, next) {
  if (!next || !next.runId) return;
  const current = runs.get(next.runId) || { runId: next.runId, status: 'unknown' };
  runs.set(next.runId, {
    ...current,
    ...emptyFiltered(next),
    startedAt: earliest(current.startedAt, next.startedAt),
    updatedAt: latest(current.updatedAt, next.updatedAt),
    finishedAt: latest(current.finishedAt, next.finishedAt),
    requiresConfirmation: current.requiresConfirmation || next.requiresConfirmation,
  });
}

function buildPhases(run, pipelineEvents, events, assetCalls) {
  if (pipelineEvents.length > 0) return pipelineEvents.map(eventToPhase);
  return PHASE_ORDER.map((phase) => inferPhase(phase, run, events, assetCalls));
}

function eventToPhase(event) {
  return {
    phase: event.phase,
    status: event.status,
    startedAt: event.started_at,
    finishedAt: event.finished_at,
    summary: event.summary,
    evidenceRefs: event.evidence_refs || [],
    assetRefs: event.asset_refs || [],
    validationRefs: event.validation_refs || [],
    requiresConfirmation: Boolean(event.requires_confirmation),
  };
}

function inferPhase(phase, run, events, assetCalls) {
  const status = inferPhaseStatus(phase, run, events, assetCalls);
  return {
    phase,
    status,
    startedAt: run.startedAt || null,
    finishedAt: status === 'success' ? run.finishedAt || run.updatedAt || null : null,
    summary: summaryForPhase(phase, run, events, assetCalls),
    evidenceRefs: events.map((event) => ({ type: 'event', id: event.id })).filter((e) => e.id),
    assetRefs: assetCalls.map((call) => ({ type: call.asset_type || 'asset', id: call.asset_id, action: call.action })).filter((a) => a.id || a.action),
    validationRefs: validationRefs(events),
    requiresConfirmation: phase === 'confirmation' && run.requiresConfirmation,
  };
}

function inferPhaseStatus(phase, run, events, assetCalls) {
  if (phase === 'asset_search') return assetCalls.length ? 'success' : 'skipped';
  if (phase === 'confirmation') return run.requiresConfirmation ? 'blocked' : 'skipped';
  if (phase === 'validate') return run.validationResult === 'fail' ? 'failed' : run.validationResult === 'pass' ? 'success' : 'skipped';
  if (phase === 'solidify') {
    if (events.length) return 'success';
    if (run.status === 'review_pending') return 'blocked';
    if (run.status === 'running' || run.status === 'selected') return 'pending';
    return 'skipped';
  }
  if (phase === 'detect_signals' || phase === 'select_gene') {
    return run.selectedGeneId ? 'success' : run.status === 'running' ? 'running' : 'skipped';
  }
  if (phase === 'mutate_strategy') {
    return run.selectedGeneId ? 'success' : 'skipped';
  }
  return run.status === 'running' ? 'running' : 'success';
}

function summaryForPhase(phase, run, events, assetCalls) {
  if (phase === 'select_gene') return run.selectedGeneId ? `Selected ${run.selectedGeneId}` : 'No selected Gene recorded yet.';
  if (phase === 'asset_search') return assetCalls.length ? `${assetCalls.length} asset call(s) recorded.` : 'No asset calls recorded.';
  if (phase === 'solidify') return events.length ? `${events.length} EvolutionEvent record(s) found.` : 'No solidified event recorded.';
  if (phase === 'confirmation') return run.requiresConfirmation ? 'Human confirmation is required.' : 'No confirmation required.';
  return phase.replace(/_/g, ' ');
}

function belongsToRun(entry, runId) {
  if (!entry || runId == null || runId === '') return false;
  const target = String(runId);
  return [entry.run_id, entry.mutation_id, entry.id, entry.cycle_id]
    .filter((value) => value != null && value !== '')
    .map(String)
    .includes(target);
}

function validationRefs(events) {
  return events.flatMap((event) => event.validation || event.validation_results || []).filter(Boolean);
}

function validationResult(entry) {
  if (!entry) return 'unknown';
  if (entry.validation_result) return entry.validation_result;
  if (entry.validation && entry.validation.ok === true) return 'pass';
  if (entry.validation && entry.validation.ok === false) return 'fail';
  return 'unknown';
}

function phaseStatusToRunStatus(status) {
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'success') return 'completed';
  return 'running';
}

function inferOutcome(outcome) {
  const value = typeof outcome === 'string' ? outcome : outcome && outcome.status;
  if (value === 'success') return 'completed';
  if (value === 'failed') return 'failed';
  return 'unknown';
}

function firstGene(genes) {
  return Array.isArray(genes) && genes.length ? genes[0] : null;
}

function isConfirmationAction(action) {
  return ['asset_publish', 'asset_fetch', 'task_claim', 'validator_stake'].includes(action);
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const n = Number(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

function timestampOf(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function emptyFiltered(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function earliest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return timestampOf(a) <= timestampOf(b) ? a : b;
}

function latest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return timestampOf(a) >= timestampOf(b) ? a : b;
}

module.exports = {
  listRuns,
  getRun,
  buildRuns,
};
