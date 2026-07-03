// `evolver thesis` (value-measurement slice 2) — the CONTROLLED A/B for the product thesis: does reusing a learned
// gene make the agent measurably better? Runs the same task suite twice through the REAL cycle engine — once with
// the learned-gene pool (evolver arm), once against an empty store (baseline arm) — and reports the objective
// pass-rate delta + verdict. `passed` comes from an external verifier (the suite's validation commands run in the
// throwaway worktree), never self-report. The agent work is `makeSafeExecute` (6 safety controls, deny-by-default),
// so a live run only touches the repo the operator explicitly allowlists via `--repo`. Distinct from `gene-value`
// (slice 1), which only OBSERVES production history; this is a controlled experiment.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { events, assetstore, algo, exec, benchmark } from '@evomap/evolver-core';
const NOW_FALLBACK = () => Date.now();
/** Build a minimal ProblemPattern from a task's signals (the cycle needs a problem to evolve against). */
function buildProblem(id, signals, now) {
    return {
        id, signature: `thesis:${id}`, signatureV: 1,
        firstSeenAt: new Date(now - 1000).toISOString(), lastSeenAt: new Date(now).toISOString(),
        occurrences: 3, linkedSignals: [...signals], resolvedBy: null, status: 'open',
        value: { severity: 1, reach: 1, strategicFit: 1, novelty: 0, costEst: 0 },
        consecutiveFailures: 0, cooldownUntil: null, extensions: {},
    };
}
const sh = (cmd, args, cwd) => new Promise((res) => { const c = spawn(cmd, [...args], { cwd, shell: false }); c.on('close', (code) => res(code ?? -1)); c.on('error', () => res(-1)); });
const parseFlags = (argv) => {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a?.startsWith('--')) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                out[a.slice(2)] = next;
                i++;
            }
            else
                out[a.slice(2)] = '';
        }
    }
    return out;
};
const pct = (r) => `${(r * 100).toFixed(0)}%`;
/**
 * `evolver thesis --suite <file> [--repo <allowlisted>] [--min-samples N] [--min-delta D] [--interleave] [--json]`.
 * Runs the controlled A/B and prints baseline-vs-evolver pass rates + the verdict. A LIVE run needs `--repo` (the
 * single allowlisted root the agent may touch); tests inject `deps.execute` instead.
 */
export async function runThesisCommand(argv, deps = {}) {
    const flags = parseFlags(argv);
    if (!flags['suite']) {
        process.stderr.write('用法: evolver thesis --suite <file> [--repo <allowlisted>] [--min-samples N] [--min-delta D] [--alpha A] [--target-power P] [--interleave] [--json]\n');
        return 1;
    }
    let suite;
    try {
        const parsed = JSON.parse(readFileSync(resolve(flags['suite']), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks))
            throw new Error('suite must be an object with a tasks[] array');
        suite = parsed;
    }
    catch (e) {
        process.stderr.write(`thesis: cannot read --suite (${e instanceof Error ? e.message : String(e)})\n`);
        return 1;
    }
    if (suite.tasks.length === 0) {
        process.stderr.write('thesis: suite has no tasks\n');
        return 1;
    }
    const now = deps.now ?? NOW_FALLBACK;
    // Live run needs an external verifier — empty suite.validation would let the agent's own success solidify a
    // Capsule (contrary to the pass/fail contract). Refuse early (Bugbot #168). Injected execute (tests) is exempt.
    if (!deps.execute && !flags['repo']) {
        process.stderr.write('thesis: a live A/B needs --repo <allowlisted> (the only repo the agent may touch). Refusing to run without it.\n');
        return 1;
    }
    if (!deps.execute && (!Array.isArray(suite.validation) || suite.validation.length === 0)) {
        process.stderr.write('thesis: a controlled A/B needs an external verifier — add a non-empty "validation" array to the suite. Refusing (passed must not come from agent self-report).\n');
        return 1;
    }
    // HERMETIC experiment (Bugbot #168): the evolver arm READS genes from the pool but its cycle WRITES (capsules,
    // evolution events) must NOT land in production — that would pollute real selection + bans. So seed a THROWAWAY
    // evolver store with a copy of the pool's genes; both arms write only into temp stores that are discarded after.
    const readPool = deps.pool ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const expDir = mkdtempSync(join(tmpdir(), 'thesis-exp-'));
    const evolverStore = new assetstore.LocalJsonlProvider(join(expDir, 'evolver'));
    const baseline = new assetstore.LocalJsonlProvider(join(expDir, 'baseline'));
    for (const g of await readPool.list('Gene', 100_000))
        await evolverStore.put(g); // read prod genes, write experiment capsules to temp
    // The agent: injected fake (tests) OR makeSafeExecute over the operator-allowlisted repo (live). The resolver
    // store is the temp evolverStore (baseline selects no gene, so it embeds none — no cross-arm contamination).
    let execute = deps.execute;
    if (!execute) {
        const repo = resolve(flags['repo']);
        const validate = async (_m, _d, cwd) => {
            for (const cmd of suite.validation) {
                const [c, ...a] = cmd.split(' ');
                if (await sh(c, a, cwd) !== 0)
                    return { passed: false, score: 0.2 };
            }
            return { passed: true, score: 0.95 };
        };
        execute = exec.makeSafeExecute(repo, evolverStore, { allowedRoots: [repo] }, { validate });
    }
    const agent = execute;
    const solver = benchmark.makeEvolutionThesisSolver({
        pool: evolverStore, baseline, now, execute: agent,
        toCycleOpts: (t) => ({
            problem: buildProblem(t.id, t.input.signals, now()),
            signals: t.input.signals,
            category: t.input.category ?? 'repair',
            target: t.input.target ?? 't.ts',
            expectedEffect: t.input.expectedEffect ?? 'fix',
            summary: t.input.summary ?? `thesis ${t.id}`,
            confidence: t.input.confidence ?? 0.9,
        }),
    });
    const tasks = suite.tasks.map((s) => ({
        id: s.id,
        input: {
            signals: s.signals,
            ...(s.category ? { category: s.category } : {}),
            ...(s.target ? { target: s.target } : {}),
            ...(s.expectedEffect ? { expectedEffect: s.expectedEffect } : {}),
            ...(s.summary ? { summary: s.summary } : {}),
            ...(s.confidence != null ? { confidence: s.confidence } : {}),
        },
    }));
    const opts = { interleave: 'interleave' in flags };
    if (flags['min-samples'])
        opts.minSamples = Number(flags['min-samples']);
    if (flags['min-delta'])
        opts.minPassRateDelta = Number(flags['min-delta']);
    if (flags['alpha'])
        opts.alpha = Number(flags['alpha']);
    if (flags['target-power'])
        opts.targetPower = Number(flags['target-power']);
    let report;
    try {
        report = await benchmark.runThesis({ name: suite.name || 'thesis', tasks }, solver, opts);
    }
    finally {
        rmSync(expDir, { recursive: true, force: true });
    }
    if ('json' in flags) {
        // requiredN is Infinity when minPassRateDelta is 0; plain JSON.stringify would turn it into null, which a
        // consumer can't tell apart from a missing/invalid value. Serialize non-finite numbers as explicit strings.
        const replacer = (_k, v) => typeof v === 'number' && !Number.isFinite(v) ? (v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN') : v;
        process.stdout.write(JSON.stringify(report, replacer) + '\n');
        return 0;
    }
    const a = report.evolver;
    const b = report.baseline;
    process.stdout.write(`thesis [${report.suite}] controlled A/B (verdict = practical delta AND statistical significance):\n`);
    process.stdout.write(`  baseline  n=${b.n} pass=${pct(b.passRate)} avgCost=${b.avgCost.toFixed(2)} reuse=${pct(b.reuseRate)}\n`);
    process.stdout.write(`  evolver   n=${a.n} pass=${pct(a.passRate)} avgCost=${a.avgCost.toFixed(2)} reuse=${pct(a.reuseRate)}\n`);
    process.stdout.write(`  Δpass=${(report.passRateDelta * 100).toFixed(1)}pt  Δcost=${report.costDelta.toFixed(2)}  → ${report.verdict}\n`);
    process.stdout.write(`  significance: p=${report.pValue.toFixed(3)} (z=${report.z.toFixed(2)}), 95% CI Δpass=[${(report.ciLow * 100).toFixed(1)}, ${(report.ciHigh * 100).toFixed(1)}]pt → ${report.significant ? 'significant' : 'not significant'}\n`);
    const minDelta = opts.minPassRateDelta ?? 0.05;
    const targetPower = opts.targetPower ?? 0.8;
    const finiteReq = Number.isFinite(report.requiredN);
    const reqN = finiteReq ? `${report.requiredN}` : '∞';
    const ptStr = (minDelta * 100).toFixed(0);
    process.stdout.write(`  power: ${pct(report.power)} to detect a ${ptStr}pt effect; need ~${reqN}/arm for ${pct(targetPower)} power\n`);
    if (report.verdict === 'insufficient_samples') {
        process.stdout.write(`  (need ≥${opts.minSamples ?? 30} samples per arm for a verdict — add tasks or lower --min-samples)\n`);
    }
    else if (!report.significant && !finiteReq) {
        // requiredN is Infinity: no achievable effect to power for (minDelta is 0, or the baseline is already at the
        // ceiling so a lift has no headroom). MORE SAMPLES WON'T HELP — don't mislabel it underpowered (Bugbot #286).
        process.stdout.write(`  (power undefined: no achievable ${ptStr}pt effect — set --min-delta > 0 and check the baseline isn't already at the ceiling; more samples won't help)\n`);
    }
    else if (!report.significant && Math.abs(report.passRateDelta) >= minDelta) {
        process.stdout.write(`  (delta clears the practical bar but is not statistically significant — more samples needed to confirm)\n`);
    }
    else if (report.verdict === 'no_significant_diff' && report.power < targetPower) {
        // A null behind low power is UNDERPOWERED, not "no effect" — and here requiredN is finite, so more tasks fix it.
        process.stdout.write(`  (underpowered: this n could not reliably detect a ${ptStr}pt effect — 'no difference' is unconfirmed, not proven; run ~${reqN}/arm)\n`);
    }
    return 0;
}