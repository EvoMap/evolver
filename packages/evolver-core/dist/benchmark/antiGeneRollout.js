import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalJsonlProvider } from '../assetstore/localJsonl.js';
import { ReviewLedger } from '../assetstore/reviewLedger.js';
import { Ingestor } from '../events/ingest.js';
import { LineTooLargeError } from '../events/eventStore.js';
import { CycleEngine } from '../algo/cycleEngine.js';
import { runEvolutionCycle } from '../algo/orchestrator.js';
import { makeGeneSelectionPoint } from '../algo/geneSelection.js';
const ALL_ASSETS_LIMIT = Number.MAX_SAFE_INTEGER;
const ASSET_KINDS = ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'];
function buildProblem(task, now) {
    return {
        id: task.id,
        signature: `anti-gene-rollout:${task.id}`,
        signatureV: 1,
        firstSeenAt: new Date(now - 1000).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        occurrences: 3,
        linkedSignals: task.signals,
        resolvedBy: null,
        status: 'open',
        value: { severity: 1, reach: 1, strategicFit: 1, novelty: 0, costEst: 0 },
        consecutiveFailures: 0,
        cooldownUntil: null,
        extensions: {},
    };
}
async function copyAssets(source, dest, includeApprovedAntiGenes, sourceReview) {
    for (const kind of ASSET_KINDS) {
        for (const asset of await source.list(kind, ALL_ASSETS_LIMIT)) {
            if (kind === 'AntiGene') {
                if (!includeApprovedAntiGenes)
                    continue;
                if (sourceReview.get(String(asset.asset_id))?.state !== 'approved')
                    continue;
            }
            await dest.put(asset);
        }
    }
}
function copyReview(source, dest) {
    for (const record of source.records()) {
        dest.mark({
            assetId: record.assetId,
            state: record.state,
            ...(record.by ? { by: record.by } : {}),
            ...(record.reason ? { reason: record.reason } : {}),
            at: record.at,
        });
    }
}
function defaultReviewForStore(store, now) {
    const baseDir = store.baseDir;
    return typeof baseDir === 'string' ? new ReviewLedger(baseDir, now) : null;
}
function observedWarningIds(decision) {
    if (!decision || typeof decision !== 'object')
        return [];
    const warnings = decision.antiWarnings;
    if (!Array.isArray(warnings))
        return [];
    return warnings
        .map((warning) => {
        if (!warning || typeof warning !== 'object' || Array.isArray(warning))
            return '';
        const row = warning;
        return String(row.antiGeneId ?? row.assetId ?? '');
    })
        .filter(Boolean);
}
function missingExpected(expected, observed) {
    const seen = new Set(observed);
    return (expected ?? []).filter((id) => !seen.has(id));
}
function statusFromResult(result) {
    return result.finalStage === 'solidified' ? 'success' : 'failed';
}
function scoreFromResult(result, status) {
    const score = result.capsule?.outcome?.score;
    return typeof score === 'number' && Number.isFinite(score) ? score : status === 'success' ? 0.9 : 0.2;
}
async function runOneArm(arm, task, source, sourceReview, makeExecute, rootDir, now) {
    const armDir = join(rootDir, arm, task.id);
    const store = new LocalJsonlProvider(join(armDir, 'assets'));
    const review = new ReviewLedger(join(armDir, 'assets'), now);
    await copyAssets(source, store, arm === 'antiGene', sourceReview);
    copyReview(sourceReview, review);
    const eventPath = join(armDir, 'events.jsonl');
    const engine = new CycleEngine({
        ingestor: new Ingestor({ path: eventPath, now }),
        selection: makeGeneSelectionPoint(),
        store,
        now,
    });
    const opts = {
        cycleId: `${arm}-${task.id}`,
        problem: buildProblem(task, now()),
        signals: task.signals,
        category: task.category ?? 'repair',
        target: task.target ?? 't.ts',
        expectedEffect: task.expectedEffect ?? `anti-gene rollout ${task.id}`,
        summary: task.summary ?? `anti-gene rollout ${task.id}`,
        confidence: task.confidence ?? 0.9,
        execute: makeExecute({ arm, task, store, review, armDir }),
        review,
        consumePendingSignals: false,
    };
    const result = await runEvolutionCycle(engine, store, opts);
    const status = statusFromResult(result);
    const observed = observedWarningIds(result.decision);
    return {
        status,
        score: scoreFromResult(result, status),
        repeatedFailure: status === 'failed' && (task.expectedAntiWarnings?.length ?? 0) > 0,
        overblocked: false,
        observedAntiWarnings: observed,
        missingExpectedWarnings: arm === 'antiGene' ? missingExpected(task.expectedAntiWarnings, observed) : [],
        selectedGeneId: result.decision?.selectedGeneId ?? null,
    };
}
function armMetrics(arm, results) {
    const n = results.length;
    const failures = results.filter((r) => r.status === 'failed').length;
    return {
        arm,
        n,
        failures,
        failureRate: n > 0 ? failures / n : 0,
        repeatedFailures: results.filter((r) => r.repeatedFailure).length,
        overblocked: results.filter((r) => r.overblocked).length,
        observedWarnings: results.reduce((sum, r) => sum + r.observedAntiWarnings.length, 0),
    };
}
function verdict(report, minSamples, minFailureDelta) {
    if (report.baseline.n < minSamples || report.antiGene.n < minSamples)
        return 'insufficient_samples';
    if (report.failureDelta >= minFailureDelta && report.antiGene.observedWarnings > 0 && report.missingExpectedWarnings === 0)
        return 'anti_gene_better';
    if (report.failureDelta < -minFailureDelta || (minFailureDelta === 0 && report.failureDelta < 0))
        return 'anti_gene_worse';
    return 'no_clear_improvement';
}
function normalizeTaskResults(taskResults) {
    return taskResults.map((task) => {
        const overblocked = task.baseline.status === 'success' && task.antiGene.status === 'failed';
        return {
            taskId: task.taskId,
            baseline: { ...task.baseline, overblocked: false },
            antiGene: { ...task.antiGene, overblocked, repeatedFailure: overblocked ? false : task.antiGene.repeatedFailure },
        };
    });
}
function buildReport(suite, rawTaskResults, minSamples, minFailureDelta) {
    const taskResults = normalizeTaskResults(rawTaskResults);
    const baseline = armMetrics('baseline', taskResults.map((r) => r.baseline));
    const antiGene = armMetrics('antiGene', taskResults.map((r) => r.antiGene));
    const partial = {
        suite: suite.name,
        tasks: suite.tasks.length,
        baseline,
        antiGene,
        missingExpectedWarnings: taskResults.reduce((sum, r) => sum + r.antiGene.missingExpectedWarnings.length, 0),
        overblocked: antiGene.overblocked,
        failureDelta: baseline.failureRate - antiGene.failureRate,
        taskResults,
    };
    return { ...partial, verdict: verdict(partial, minSamples, minFailureDelta) };
}
export async function runAntiGeneRollout(suite, deps, options = {}) {
    const now = options.now ?? Date.now;
    const sourceReview = deps.review ?? defaultReviewForStore(deps.store, now);
    if (!sourceReview)
        throw new Error('AntiGene rollout requires a ReviewLedger or a LocalJsonlProvider-backed store so review state can be copied');
    const minSamples = options.minSamples ?? 30;
    const minFailureDelta = options.minFailureDelta ?? 0.05;
    const rootDir = mkdtempSync(join(tmpdir(), 'anti-gene-rollout-'));
    try {
        const taskResults = [];
        for (const task of suite.tasks) {
            taskResults.push({
                taskId: task.id,
                baseline: await runOneArm('baseline', task, deps.store, sourceReview, deps.makeExecute, rootDir, now),
                antiGene: await runOneArm('antiGene', task, deps.store, sourceReview, deps.makeExecute, rootDir, now),
            });
        }
        const report = buildReport(suite, taskResults, minSamples, minFailureDelta);
        if (options.eventsPath)
            await writeAntiGeneRolloutResult(report, options.eventsPath, now);
        return report;
    }
    finally {
        rmSync(rootDir, { recursive: true, force: true });
    }
}
export async function writeAntiGeneRolloutResult(report, eventsPath, now = Date.now) {
    const ingestor = new Ingestor({ path: eventsPath, now });
    try {
        await ingestReportPayload(ingestor, report);
    }
    catch (error) {
        if (!(error instanceof LineTooLargeError))
            throw error;
        await ingestReportPayload(ingestor, compactReportPayload(report, 5));
    }
}
async function ingestReportPayload(ingestor, payload) {
    await ingestor.ingest({
        type: 'anti_gene.rollout_result',
        human: { title: `anti-gene rollout ${payload.suite}` },
        payload: payload,
        actor: { kind: 'machine', id: 'anti-gene-rollout' },
    });
}
function compactWarnings(items) {
    return items.slice(0, 3);
}
function compactRunResult(result) {
    return {
        ...result,
        observedAntiWarnings: compactWarnings(result.observedAntiWarnings),
        missingExpectedWarnings: compactWarnings(result.missingExpectedWarnings),
    };
}
function compactReportPayload(report, maxTasks) {
    return {
        ...report,
        taskResults: report.taskResults.slice(0, maxTasks).map((task) => ({
            taskId: task.taskId,
            baseline: compactRunResult(task.baseline),
            antiGene: compactRunResult(task.antiGene),
        })),
        taskResultsTruncated: Math.max(0, report.taskResults.length - maxTasks),
    };
}
function isReportPayload(value) {
    return !!value && typeof value === 'object'
        && typeof value.suite === 'string'
        && typeof value.tasks === 'number'
        && typeof value.verdict === 'string';
}
export function antiGeneRolloutReportsFromEvents(events) {
    const out = [];
    for (const event of events) {
        if (event.type !== 'anti_gene.rollout_result')
            continue;
        if (isReportPayload(event.payload))
            out.push(event.payload);
    }
    return out;
}
export function latestAntiGeneRolloutReport(events) {
    const reports = antiGeneRolloutReportsFromEvents(events);
    return reports[reports.length - 1] ?? null;
}