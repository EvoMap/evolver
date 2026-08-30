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
import { parseOverblockedAntiGenes, summarizeOverblockedAntiGenes } from './antiGeneImpact.js';
const ALL_ASSETS_LIMIT = Number.MAX_SAFE_INTEGER;
const ASSET_KINDS = ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'];
function buildProblem(task, now) {
    return {
        id: task.id,
        signature: `anti-gene-benchmark:${task.id}`,
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
async function copyAssets(source, dest, includeAntiGenes) {
    for (const kind of ASSET_KINDS) {
        if (kind === 'AntiGene' && !includeAntiGenes)
            continue;
        for (const asset of await source.list(kind, ALL_ASSETS_LIMIT))
            await dest.put(asset);
    }
}
function copyReview(source, dest) {
    for (const record of source?.records() ?? []) {
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
function executeFor(outcome) {
    return () => ({
        outcome: {
            status: outcome.status,
            score: outcome.score ?? (outcome.status === 'success' ? 0.9 : 0.2),
            ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
    });
}
async function runOneArm(arm, task, source, sourceReview, rootDir, now, disableSemanticIdf) {
    const armDir = join(rootDir, arm, task.id);
    const store = new LocalJsonlProvider(join(armDir, 'assets'));
    const review = new ReviewLedger(join(armDir, 'assets'), now);
    await copyAssets(source, store, arm === 'antiGene');
    copyReview(sourceReview, review);
    const eventPath = join(armDir, 'events.jsonl');
    const engine = new CycleEngine({
        ingestor: new Ingestor({ path: eventPath, now }),
        selection: makeGeneSelectionPoint(),
        store,
        now,
    });
    const spec = task.outcomes[arm];
    const opts = {
        cycleId: `${arm}-${task.id}`,
        problem: buildProblem(task, now()),
        signals: task.signals,
        category: task.category ?? 'repair',
        target: task.target ?? 't.ts',
        expectedEffect: task.expectedEffect ?? `anti-gene benchmark ${task.id}`,
        summary: task.summary ?? `anti-gene benchmark ${task.id}`,
        confidence: task.confidence ?? 0.9,
        execute: executeFor(spec),
        review,
        consumePendingSignals: false,
        ...(disableSemanticIdf ? { disableSemanticIdf: true } : {}),
    };
    const result = await runEvolutionCycle(engine, store, opts);
    const observed = observedWarningIds(result.decision);
    return {
        status: spec.status,
        score: spec.score ?? (spec.status === 'success' ? 0.9 : 0.2),
        repeatedFailure: spec.repeatedFailure === true,
        overblocked: spec.overblocked === true,
        observedAntiWarnings: observed,
        missingExpectedWarnings: arm === 'antiGene' ? missingExpected(task.expectedAntiWarnings, observed) : [],
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
function buildReport(suite, taskResults, minSamples, minFailureDelta) {
    const baseline = armMetrics('baseline', taskResults.map((r) => r.baseline));
    const antiGene = armMetrics('antiGene', taskResults.map((r) => r.antiGene));
    const partial = {
        suite: suite.name,
        tasks: suite.tasks.length,
        baseline,
        antiGene,
        missingExpectedWarnings: taskResults.reduce((sum, r) => sum + r.antiGene.missingExpectedWarnings.length, 0),
        overblocked: antiGene.overblocked,
        overblockedAntiGenes: summarizeOverblockedAntiGenes(taskResults),
        failureDelta: baseline.failureRate - antiGene.failureRate,
        taskResults,
    };
    return { ...partial, verdict: verdict(partial, minSamples, minFailureDelta) };
}
export async function runAntiGeneBenchmark(suite, deps, options = {}) {
    const now = options.now ?? Date.now;
    const sourceReview = deps.review ?? defaultReviewForStore(deps.store, now);
    if (!sourceReview)
        throw new Error('AntiGene benchmark requires a ReviewLedger or a LocalJsonlProvider-backed store so review state can be copied');
    const minSamples = options.minSamples ?? 30;
    const minFailureDelta = options.minFailureDelta ?? 0.05;
    const rootDir = mkdtempSync(join(tmpdir(), 'anti-gene-benchmark-'));
    try {
        const taskResults = [];
        for (const task of suite.tasks) {
            taskResults.push({
                taskId: task.id,
                baseline: await runOneArm('baseline', task, deps.store, sourceReview, rootDir, now, options.disableSemanticIdf === true),
                antiGene: await runOneArm('antiGene', task, deps.store, sourceReview, rootDir, now, options.disableSemanticIdf === true),
            });
        }
        const report = buildReport(suite, taskResults, minSamples, minFailureDelta);
        if (options.eventsPath)
            await writeAntiGeneBenchmarkResult(report, options.eventsPath, now);
        return report;
    }
    finally {
        rmSync(rootDir, { recursive: true, force: true });
    }
}
export async function writeAntiGeneBenchmarkResult(report, eventsPath, now = Date.now) {
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
        type: 'anti_gene.benchmark_result',
        human: { title: `anti-gene benchmark ${payload.suite}` },
        payload: payload,
        actor: { kind: 'machine', id: 'anti-gene-benchmark' },
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
function normalizeReportPayload(value) {
    const parsed = parseOverblockedAntiGenes(value.overblockedAntiGenes);
    const truncated = typeof value.taskResultsTruncated === 'number' && value.taskResultsTruncated > 0;
    return {
        ...value,
        overblockedAntiGenes: parsed ?? (truncated ? [] : summarizeOverblockedAntiGenes(value.taskResults ?? [])),
    };
}
export function antiGeneBenchmarkReportsFromEvents(events) {
    const out = [];
    for (const event of events) {
        if (event.type !== 'anti_gene.benchmark_result')
            continue;
        if (isReportPayload(event.payload))
            out.push(normalizeReportPayload(event.payload));
    }
    return out;
}
export function latestAntiGeneBenchmarkReport(events) {
    const reports = antiGeneBenchmarkReportsFromEvents(events);
    return reports[reports.length - 1] ?? null;
}