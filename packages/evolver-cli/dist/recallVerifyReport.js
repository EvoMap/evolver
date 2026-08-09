import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { events, mailbox } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const SUCCESS_THRESHOLD = 0.95;
const KNOWN_OUTCOMES = new Set(['ok', 'missing', 'mismatch', 'error', 'skipped']);
function parseSince(value, now) {
    const relative = /^(\d+)\s*(s|m|h|d)$/i.exec(value);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        const factor = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
        return now - amount * factor;
    }
    if (!/[-T]/.test(value))
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseArgs(argv, now) {
    let json = false;
    let help = false;
    let sinceMs = null;
    let namespace = 'default';
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') {
            json = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            help = true;
            continue;
        }
        const readValue = (flag) => {
            if (arg?.startsWith(`${flag}=`))
                return arg.slice(flag.length + 1);
            if (arg === flag) {
                index += 1;
                return argv[index];
            }
            return undefined;
        };
        const since = readValue('--since');
        if (since !== undefined) {
            const parsed = parseSince(since, now);
            if (parsed === undefined)
                return 'invalid --since (expected ISO-8601 or a duration such as 1h, 30m, or 2d)';
            sinceMs = parsed;
            continue;
        }
        const requestedNamespace = readValue('--namespace');
        if (requestedNamespace !== undefined) {
            if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestedNamespace))
                return 'invalid --namespace';
            namespace = requestedNamespace;
            continue;
        }
        return `unknown argument: ${arg ?? '(missing)'}`;
    }
    return { json, help, sinceMs, namespace };
}
function percentile(values, fraction) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}
function emptyRow(assetType) {
    return {
        assetType,
        total: 0,
        ok: 0,
        missing: 0,
        mismatch: 0,
        error: 0,
        skipped: 0,
        successRate: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        p50AgeMs: 0,
        p95AgeMs: 0,
        p99AgeMs: 0,
    };
}
export function aggregateRecallVerifyState(state, sinceMs) {
    const outcomes = (state?.outcomes ?? []).filter((outcome) => sinceMs === null || outcome.at >= sinceMs);
    const buckets = new Map();
    for (const outcome of outcomes) {
        const assetType = outcome.assetType ?? 'Unknown';
        const bucket = buckets.get(assetType) ?? { row: emptyRow(assetType), latencies: [], ages: [], blockingSkips: 0 };
        bucket.row.total += 1;
        bucket.row[outcome.outcome] += 1;
        // V1 state can contain terminal verifier failures as `skipped`. Only intentional sampling is non-blocking.
        if (outcome.outcome === 'skipped' && outcome.reason !== 'sampled_out')
            bucket.blockingSkips += 1;
        if (Number.isFinite(outcome.latencyMs) && outcome.latencyMs >= 0)
            bucket.latencies.push(outcome.latencyMs);
        if (Number.isFinite(outcome.ageMs) && outcome.ageMs >= 0)
            bucket.ages.push(outcome.ageMs);
        buckets.set(assetType, bucket);
    }
    const rows = [...buckets.values()].map(({ row, latencies, ages, blockingSkips }) => {
        const denominator = row.ok + row.missing + row.mismatch + row.error + blockingSkips;
        return {
            ...row,
            successRate: denominator > 0 ? row.ok / denominator : 0,
            p50LatencyMs: percentile(latencies, 0.5),
            p95LatencyMs: percentile(latencies, 0.95),
            p99LatencyMs: percentile(latencies, 0.99),
            p50AgeMs: percentile(ages, 0.5),
            p95AgeMs: percentile(ages, 0.95),
            p99AgeMs: percentile(ages, 0.99),
        };
    }).sort((left, right) => left.assetType.localeCompare(right.assetType));
    const totals = rows.reduce((total, row) => ({
        ...total,
        total: total.total + row.total,
        ok: total.ok + row.ok,
        missing: total.missing + row.missing,
        mismatch: total.mismatch + row.mismatch,
        error: total.error + row.error,
        skipped: total.skipped + row.skipped,
    }), emptyRow('TOTAL'));
    const blockingSkips = [...buckets.values()].reduce((total, bucket) => total + bucket.blockingSkips, 0);
    const denominator = totals.ok + totals.missing + totals.mismatch + totals.error + blockingSkips;
    totals.successRate = denominator > 0 ? totals.ok / denominator : 0;
    const totalLatencies = outcomes
        .map((outcome) => outcome.latencyMs)
        .filter((latency) => Number.isFinite(latency) && latency >= 0);
    totals.p50LatencyMs = percentile(totalLatencies, 0.5);
    totals.p95LatencyMs = percentile(totalLatencies, 0.95);
    totals.p99LatencyMs = percentile(totalLatencies, 0.99);
    const totalAges = outcomes
        .map((outcome) => outcome.ageMs)
        .filter((age) => age !== undefined && Number.isFinite(age) && age >= 0);
    totals.p50AgeMs = percentile(totalAges, 0.5);
    totals.p95AgeMs = percentile(totalAges, 0.95);
    totals.p99AgeMs = percentile(totalAges, 0.99);
    let gate = rows.length === 0 ? 'RED' : 'GREEN';
    for (const row of rows) {
        if (row.mismatch > 0 || row.successRate < 0.85) {
            gate = 'RED';
            break;
        }
        if (row.successRate < SUCCESS_THRESHOLD)
            gate = 'YELLOW';
    }
    return {
        since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
        retainedOutcomes: state?.outcomes.length ?? 0,
        queued: state?.queue.length ?? 0,
        rows,
        totals,
        gate,
        retentionNotice: 'This gate covers only outcomes retained in the bounded proxy state; it is not an all-time history.',
    };
}
function parseState(raw) {
    if (raw === undefined)
        return undefined;
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.queue) || !Array.isArray(parsed.outcomes)) {
        throw new Error('invalid_recall_verify_state');
    }
    const outcomes = parsed.outcomes.filter((outcome) => (outcome !== null
        && typeof outcome === 'object'
        && typeof outcome.assetId === 'string'
        && KNOWN_OUTCOMES.has(outcome.outcome)
        && Number.isFinite(outcome.at)
        && Number.isFinite(outcome.latencyMs)
        && (outcome.ageMs === undefined || (Number.isFinite(outcome.ageMs) && outcome.ageMs >= 0))));
    if (outcomes.length !== parsed.outcomes.length)
        throw new Error('invalid_recall_verify_state');
    return { version: 1, queue: parsed.queue, outcomes, counts: parsed.counts };
}
function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}
function printReport(report, log) {
    log(`# Publish Recall Report (since ${report.since ?? 'retained window'})`);
    log('');
    log(report.retentionNotice);
    log(`Retained outcomes: ${report.retainedOutcomes}; queued: ${report.queued}`);
    log('');
    if (report.rows.length === 0) {
        log('_No publish recall outcomes found._');
    }
    else {
        log('| asset_type | total | ok | missing | mismatch | error | skipped | success_rate | p50_latency_ms | p95_latency_ms | p99_latency_ms | p50_age_ms | p95_age_ms | p99_age_ms |');
        log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
        for (const row of [...report.rows, report.totals]) {
            log(`| ${row.assetType} | ${row.total} | ${row.ok} | ${row.missing} | ${row.mismatch} | ${row.error} | ${row.skipped} | ${formatPercent(row.successRate)} | ${row.p50LatencyMs} | ${row.p95LatencyMs} | ${row.p99LatencyMs} | ${row.p50AgeMs} | ${row.p95AgeMs} | ${row.p99AgeMs} |`);
        }
    }
    log('');
    log(`Ship gate: **${report.gate}** (${report.gate === 'GREEN' ? 'exit 0' : 'exit 2'})`);
}
export async function runRecallVerifyReport(argv, deps = {}) {
    const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
    const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
    const env = deps.env ?? process.env;
    const parsed = parseArgs(argv, (deps.now ?? Date.now)());
    if (typeof parsed === 'string') {
        err(`recall-verify-report: ${parsed}`);
        return 1;
    }
    if (parsed.help) {
        log('Usage: evolver recall-verify-report [--since <Nh|Nm|Nd|ISO>] [--namespace <name>] [--json]');
        return 0;
    }
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error) {
        err('recall-verify-report: env_file_unavailable');
        return 1;
    }
    const storePath = deps.storePath ?? env['EVOLVER_PROXY_STORE']?.trim() ?? join(events.evomapHome(env), 'proxy', 'mailbox.db');
    let store;
    try {
        const key = `publish_recall_verifier:${parsed.namespace}:v1`;
        let raw;
        if (deps.readState)
            raw = deps.readState(key);
        else if (existsSync(storePath)) {
            store = new mailbox.MailboxStore({ path: storePath });
            raw = store.getState(key);
        }
        const report = aggregateRecallVerifyState(parseState(raw), parsed.sinceMs);
        if (parsed.json)
            log(JSON.stringify(report, null, 2));
        else
            printReport(report, log);
        return report.gate === 'GREEN' ? 0 : 2;
    }
    catch {
        err('recall-verify-report: invalid_or_unavailable_state');
        return 1;
    }
    finally {
        store?.close();
    }
}
export const runRecallVerifyReportCommand = (argv) => runRecallVerifyReport(argv);