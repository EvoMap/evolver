import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { assetstore, benchmark, events, exec } from '@evomap/evolver-core';
import { semanticIdfEnabled } from './semanticIdfConfig.js';
const usage = '用法: evolver anti-gene-rollout --suite <file> --repo <path> [--assets <dir>] [--review-dir <dir>] [--events <file>] [--runner claude|codex|gemini] [--json] [--min-samples N] [--min-failure-delta D]\n'
    + '   或: evolver anti-gene-rollout --report <events-file> [--json]\n';
function parseFlags(argv) {
    const out = { json: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json')
            out.json = true;
        else if (arg === '--suite')
            out.suite = valueAfter(argv, ++i);
        else if (arg === '--repo')
            out.repo = valueAfter(argv, ++i);
        else if (arg === '--assets')
            out.assets = valueAfter(argv, ++i);
        else if (arg === '--review-dir')
            out.reviewDir = valueAfter(argv, ++i);
        else if (arg === '--events')
            out.events = valueAfter(argv, ++i);
        else if (arg === '--report')
            out.report = valueAfter(argv, ++i);
        else if (arg === '--runner')
            out.runner = valueAfter(argv, ++i);
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
function parseSuite(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('suite must be an object');
    const row = value;
    if (typeof row['name'] !== 'string' || row['name'].trim().length === 0)
        throw new Error('suite.name must be a non-empty string');
    const validation = row['validation'] === undefined ? undefined : strings(row['validation']);
    if (row['validation'] !== undefined && !validation)
        throw new Error('suite.validation must be a string array when present');
    if (!Array.isArray(row['tasks']) || row['tasks'].length === 0)
        throw new Error('suite.tasks must be a non-empty array');
    return {
        name: row['name'],
        ...(validation ? { validation } : {}),
        tasks: row['tasks'].map((task, index) => {
            if (!task || typeof task !== 'object' || Array.isArray(task))
                throw new Error(`tasks[${index}] must be an object`);
            const t = task;
            if (typeof t['id'] !== 'string' || t['id'].trim().length === 0)
                throw new Error(`tasks[${index}].id must be a non-empty string`);
            const signals = strings(t['signals']);
            if (!signals || signals.length === 0)
                throw new Error(`tasks[${index}].signals must be a non-empty string array`);
            const expectedAntiWarnings = strings(t['expectedAntiWarnings']);
            if (t['expectedAntiWarnings'] !== undefined && !expectedAntiWarnings)
                throw new Error(`tasks[${index}].expectedAntiWarnings must be a string array when present`);
            return {
                id: t['id'],
                signals,
                ...(typeof t['target'] === 'string' ? { target: t['target'] } : {}),
                ...(typeof t['expectedEffect'] === 'string' ? { expectedEffect: t['expectedEffect'] } : {}),
                ...(typeof t['category'] === 'string' ? { category: t['category'] } : {}),
                ...(typeof t['summary'] === 'string' ? { summary: t['summary'] } : {}),
                ...(typeof t['confidence'] === 'number' && Number.isFinite(t['confidence']) ? { confidence: t['confidence'] } : {}),
                ...(expectedAntiWarnings ? { expectedAntiWarnings } : {}),
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
function overblockSuspects(report) {
    return report.overblockedAntiGenes
        .map((row) => `${row.antiGeneId} count=${row.count} tasks=${row.taskIds.join(',')}`)
        .join('; ');
}
function printReport(report, log) {
    log(`anti-gene-rollout [${report.suite}]: ${report.tasks} task(s) -> ${report.verdict}`);
    log(`  baseline  failures=${report.baseline.failures}/${report.baseline.n} (${pct(report.baseline.failureRate)}) repeated=${report.baseline.repeatedFailures}`);
    log(`  antiGene  failures=${report.antiGene.failures}/${report.antiGene.n} (${pct(report.antiGene.failureRate)}) repeated=${report.antiGene.repeatedFailures} warnings=${report.antiGene.observedWarnings}`);
    log(`  delta failure=${(report.failureDelta * 100).toFixed(1)}pt missingWarnings=${report.missingExpectedWarnings} overblocked=${report.overblocked}`);
    if (report.overblockedAntiGenes.length > 0) {
        log(`  overblock suspects: ${overblockSuspects(report)}`);
        log('  note: review these AntiGenes before broader rollout; downgrade or reject manually if overblock repeats.');
    }
    if (report.missingExpectedWarnings > 0) {
        log('  note: expected AntiGene warnings are missing; check approved AntiGene review state, --assets/--review-dir, expectedAntiWarnings, and signal triggers.');
    }
}
function jsonReplacer(_key, value) {
    return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}
export function parseAntiGeneRolloutValidationCommand(commandLine) {
    const raw = commandLine.trim();
    if (!raw)
        return null;
    const parsed = repairUnquotedWindowsExePath(raw, parseCommandLine(raw));
    const cmd = parsed[0];
    return cmd ? { cmd, args: parsed.slice(1) } : null;
}
function repairUnquotedWindowsExePath(value, parsed) {
    if (process.platform !== 'win32' || parsed.length === 0)
        return parsed;
    const first = parsed[0];
    if (/\.exe$/i.test(first))
        return parsed;
    const exeEnd = value.toLowerCase().indexOf('.exe');
    if (exeEnd < 0)
        return parsed;
    const command = value.slice(0, exeEnd + 4).trim();
    if (!/^[A-Za-z]:\\/.test(command) && !command.startsWith('\\\\'))
        return parsed;
    if (!existsSync(command))
        return parsed;
    const rest = value.slice(exeEnd + 4).trim();
    return rest ? [command, ...parseCommandLine(rest)] : [command];
}
function parseCommandLine(value) {
    const out = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            const next = value[i + 1];
            if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
                escaped = true;
                continue;
            }
            current += ch;
            continue;
        }
        if ((ch === '"' || ch === "'") && quote === null) {
            quote = ch;
            continue;
        }
        if (ch === quote) {
            quote = null;
            continue;
        }
        if (/\s/.test(ch) && quote === null) {
            if (current) {
                out.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (quote !== null)
        throw new Error('unterminated quote in suite.validation command');
    if (escaped)
        current += '\\';
    if (current)
        out.push(current);
    return out;
}
function validationCommand(commandLine, cwd) {
    let parsed;
    try {
        parsed = parseAntiGeneRolloutValidationCommand(commandLine);
    }
    catch {
        return Promise.resolve(1);
    }
    if (!parsed)
        return Promise.resolve(1);
    return new Promise((resolveCode) => {
        const child = spawn(parsed.cmd, parsed.args, { cwd, shell: false });
        child.on('close', (code) => resolveCode(code ?? -1));
        child.on('error', () => resolveCode(-1));
    });
}
function liveMakeExecute(repo, runner, validation, deps = {}) {
    return ({ store, review }) => {
        const validate = async (_mutation, _decision, cwd) => {
            for (const command of validation) {
                if (await validationCommand(command, cwd) !== 0)
                    return { passed: false, score: 0.2 };
            }
            return { passed: true, score: 0.95 };
        };
        return exec.makeSafeExecute(repo, store, {
            allowedRoots: [repo],
            ...(runner ? { runner } : {}),
        }, {
            review,
            validate,
            validationCmds: validation,
            ...(deps.agent ? { agent: deps.agent } : {}),
            ...(deps.git ? { git: deps.git } : {}),
        });
    };
}
async function runReportMode(flags, deps, log) {
    if (!flags.report) {
        process.stderr.write(usage);
        return 1;
    }
    const evts = (deps.readEvents ?? events.readEvents)(resolve(flags.report));
    const report = benchmark.latestAntiGeneRolloutReport(evts);
    if (!report) {
        process.stderr.write('anti-gene-rollout: no anti_gene.rollout_result event found\n');
        return 1;
    }
    if (flags.json)
        log(JSON.stringify(report, jsonReplacer));
    else
        printReport(report, log);
    return 0;
}
export async function runAntiGeneRolloutCommand(argv, deps = {}) {
    const flags = parseFlags(argv);
    const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
    if (flags.report !== undefined)
        return runReportMode(flags, deps, log);
    if (!flags.suite) {
        process.stderr.write(usage);
        return 1;
    }
    if (flags.minSamples !== undefined && (!Number.isFinite(flags.minSamples) || flags.minSamples < 1)) {
        process.stderr.write('anti-gene-rollout: --min-samples must be >= 1\n');
        return 1;
    }
    if (flags.minFailureDelta !== undefined && (!Number.isFinite(flags.minFailureDelta) || flags.minFailureDelta < 0)) {
        process.stderr.write('anti-gene-rollout: --min-failure-delta must be >= 0\n');
        return 1;
    }
    if (flags.runner !== undefined && flags.runner !== 'claude' && flags.runner !== 'codex' && flags.runner !== 'gemini') {
        process.stderr.write('anti-gene-rollout: --runner must be claude, codex, or gemini\n');
        return 1;
    }
    let suite;
    try {
        suite = readSuite(flags.suite);
    }
    catch (error) {
        process.stderr.write(`anti-gene-rollout: cannot read --suite (${error instanceof Error ? error.message : String(error)})\n`);
        return 1;
    }
    const injected = deps.makeExecute !== undefined;
    if (!injected && !flags.repo) {
        process.stderr.write('anti-gene-rollout: live rollout requires --repo <allowlisted> so the exec bridge has an explicit allowed root\n');
        return 1;
    }
    if (!injected && (!Array.isArray(suite.validation) || suite.validation.length === 0)) {
        process.stderr.write('anti-gene-rollout: live rollout requires a non-empty suite.validation[] external verifier; refusing to trust agent self-report\n');
        return 1;
    }
    if (!injected && !deps.agent && flags.runner !== 'gemini') {
        process.stderr.write('anti-gene-rollout: execute capability is unsupported for built-in Claude/Codex; select --runner gemini or inject an externally sandboxed agent\n');
        return 1;
    }
    const assetsDir = flags.assets ? resolve(flags.assets) : events.assetsDir();
    const reviewDir = flags.reviewDir ? resolve(flags.reviewDir) : assetsDir;
    const store = deps.store ?? new assetstore.LocalJsonlProvider(assetsDir);
    const review = deps.review ?? new assetstore.ReviewLedger(reviewDir, deps.now);
    const eventsPath = flags.events ? resolve(flags.events) : join(mkdtempSync(join(tmpdir(), 'anti-gene-rollout-events-')), 'root_events.jsonl');
    const makeExecute = deps.makeExecute ?? liveMakeExecute(resolve(flags.repo), flags.runner, suite.validation, deps);
    const report = await benchmark.runAntiGeneRollout(suite, { store, review, makeExecute }, {
        eventsPath,
        now: deps.now,
        ...(!semanticIdfEnabled() ? { disableSemanticIdf: true } : {}),
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