import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assetstore, benchmark, events } from '@evomap/evolver-core';
const usage = '用法: evolver anti-gene-benchmark --suite <file> [--assets <dir>] [--review-dir <dir>] [--events <file>] [--json] [--min-samples N] [--min-failure-delta D]\n'
    + '   或: evolver anti-gene-benchmark --report <events-file> [--json]\n';
function parseFlags(argv) {
    const out = { json: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json')
            out.json = true;
        else if (arg === '--suite')
            out.suite = valueAfter(argv, ++i);
        else if (arg === '--assets')
            out.assets = valueAfter(argv, ++i);
        else if (arg === '--review-dir')
            out.reviewDir = valueAfter(argv, ++i);
        else if (arg === '--events')
            out.events = valueAfter(argv, ++i);
        else if (arg === '--report')
            out.report = valueAfter(argv, ++i);
        else if (arg === '--min-samples')
            out.minSamples = Number(argv[++i]);
        else if (arg === '--min-failure-delta')
            out.minFailureDelta = Number(argv[++i]);
    }
    return out;
}
function valueAfter(argv, index) {
    const value = argv[index];
    return value !== undefined && !value.startsWith('--') ? value : undefined;
}
function strings(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}
function outcome(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    if (row['status'] !== 'success' && row['status'] !== 'failed')
        return null;
    const out = { status: row['status'] };
    if (typeof row['repeatedFailure'] === 'boolean')
        out.repeatedFailure = row['repeatedFailure'];
    if (typeof row['overblocked'] === 'boolean')
        out.overblocked = row['overblocked'];
    if (typeof row['score'] === 'number' && Number.isFinite(row['score']))
        out.score = row['score'];
    if (typeof row['reason'] === 'string')
        out.reason = row['reason'];
    return out;
}
function parseSuite(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('suite must be an object');
    const row = value;
    if (typeof row['name'] !== 'string' || row['name'].trim().length === 0)
        throw new Error('suite.name must be a non-empty string');
    if (!Array.isArray(row['tasks']) || row['tasks'].length === 0)
        throw new Error('suite.tasks must be a non-empty array');
    return {
        name: row['name'],
        tasks: row['tasks'].map((task, index) => {
            if (!task || typeof task !== 'object' || Array.isArray(task))
                throw new Error(`tasks[${index}] must be an object`);
            const t = task;
            if (typeof t['id'] !== 'string' || t['id'].trim().length === 0)
                throw new Error(`tasks[${index}].id must be a non-empty string`);
            const signals = strings(t['signals']);
            if (!signals || signals.length === 0)
                throw new Error(`tasks[${index}].signals must be a non-empty string array`);
            const outcomes = t['outcomes'];
            if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes))
                throw new Error(`tasks[${index}].outcomes must be an object`);
            const outcomeRow = outcomes;
            const baseline = outcome(outcomeRow['baseline']);
            const antiGene = outcome(outcomeRow['antiGene']);
            if (!baseline)
                throw new Error(`tasks[${index}].outcomes.baseline must have status success|failed`);
            if (!antiGene)
                throw new Error(`tasks[${index}].outcomes.antiGene must have status success|failed`);
            const expectedAntiWarnings = strings(t['expectedAntiWarnings']);
            return {
                id: t['id'],
                signals,
                ...(typeof t['target'] === 'string' ? { target: t['target'] } : {}),
                ...(typeof t['expectedEffect'] === 'string' ? { expectedEffect: t['expectedEffect'] } : {}),
                ...(typeof t['category'] === 'string' ? { category: t['category'] } : {}),
                ...(typeof t['summary'] === 'string' ? { summary: t['summary'] } : {}),
                ...(typeof t['confidence'] === 'number' && Number.isFinite(t['confidence']) ? { confidence: t['confidence'] } : {}),
                ...(expectedAntiWarnings ? { expectedAntiWarnings } : {}),
                outcomes: { baseline, antiGene },
            };
        }),
    };
}
function readSuite(path) {
    return parseSuite(JSON.parse(readFileSync(resolve(path), 'utf8')));
}
function pct(value) {
    return `${(value * 100).toFixed(0)}%`;
}
function printReport(report, log) {
    log(`anti-gene-benchmark [${report.suite}]: ${report.tasks} task(s) -> ${report.verdict}`);
    log(`  baseline  failures=${report.baseline.failures}/${report.baseline.n} (${pct(report.baseline.failureRate)}) repeated=${report.baseline.repeatedFailures}`);
    log(`  antiGene  failures=${report.antiGene.failures}/${report.antiGene.n} (${pct(report.antiGene.failureRate)}) repeated=${report.antiGene.repeatedFailures} warnings=${report.antiGene.observedWarnings}`);
    log(`  delta failure=${(report.failureDelta * 100).toFixed(1)}pt missingWarnings=${report.missingExpectedWarnings} overblocked=${report.overblocked}`);
}
function jsonReplacer(_key, value) {
    return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}
async function runReportMode(flags, deps, log) {
    if (!flags.report) {
        process.stderr.write(usage);
        return 1;
    }
    const evts = (deps.readEvents ?? events.readEvents)(resolve(flags.report));
    const report = benchmark.latestAntiGeneBenchmarkReport(evts);
    if (!report) {
        process.stderr.write('anti-gene-benchmark: no anti_gene.benchmark_result event found\n');
        return 1;
    }
    if (flags.json)
        log(JSON.stringify(report, jsonReplacer));
    else
        printReport(report, log);
    return 0;
}
export async function runAntiGeneBenchmarkCommand(argv, deps = {}) {
    const flags = parseFlags(argv);
    const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
    if (flags.report !== undefined)
        return runReportMode(flags, deps, log);
    if (!flags.suite) {
        process.stderr.write(usage);
        return 1;
    }
    if (flags.minSamples !== undefined && (!Number.isFinite(flags.minSamples) || flags.minSamples < 1)) {
        process.stderr.write('anti-gene-benchmark: --min-samples must be >= 1\n');
        return 1;
    }
    if (flags.minFailureDelta !== undefined && (!Number.isFinite(flags.minFailureDelta) || flags.minFailureDelta < 0)) {
        process.stderr.write('anti-gene-benchmark: --min-failure-delta must be >= 0\n');
        return 1;
    }
    let suite;
    try {
        suite = readSuite(flags.suite);
    }
    catch (error) {
        process.stderr.write(`anti-gene-benchmark: cannot read --suite (${error instanceof Error ? error.message : String(error)})\n`);
        return 1;
    }
    const assetsDir = flags.assets ? resolve(flags.assets) : events.assetsDir();
    const reviewDir = flags.reviewDir ? resolve(flags.reviewDir) : assetsDir;
    const store = deps.store ?? new assetstore.LocalJsonlProvider(assetsDir);
    const review = deps.review ?? new assetstore.ReviewLedger(reviewDir, deps.now);
    const eventsPath = flags.events ? resolve(flags.events) : join(mkdtempSync(join(tmpdir(), 'anti-gene-benchmark-events-')), 'root_events.jsonl');
    const report = await benchmark.runAntiGeneBenchmark(suite, { store, review }, {
        eventsPath,
        now: deps.now,
        ...(flags.minSamples !== undefined ? { minSamples: flags.minSamples } : {}),
        ...(flags.minFailureDelta !== undefined ? { minFailureDelta: flags.minFailureDelta } : {}),
    });
    if (flags.json)
        log(JSON.stringify({ ...report, eventsPath }, jsonReplacer));
    else {
        printReport(report, log);
        log(`  events: ${eventsPath}`);
    }
    return 0;
}