function summarize(arm, samples) {
    const n = samples.length;
    if (n === 0)
        return { arm, n: 0, passes: 0, passRate: 0, avgCost: 0, reuseRate: 0 };
    const passes = samples.filter((s) => s.passed).length;
    return {
        arm,
        n,
        passes,
        passRate: passes / n,
        reuseRate: samples.filter((s) => s.reusedGene).length / n,
        avgCost: samples.reduce((a, s) => a + s.cost, 0) / n,
    };
}
/** Normal CDF via an Abramowitz-Stegun erf approximation — deterministic, no stats dependency, ample precision
 *  for a p-value gate (|error| < 1.5e-7). Used for the two-sided p-value of the two-proportion z test. */
function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
}
/** Inverse normal CDF (Acklam's rational approximation) — for the (1 − alpha) CI's critical value, so alpha is
 *  honoured rather than hard-coding z=1.96. Domain (0,1); deterministic. */
function normalQuantile(p) {
    if (p <= 0)
        return -Infinity;
    if (p >= 1)
        return Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pLow = 0.02425;
    if (p < pLow) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - pLow) {
        const q = p - 0.5;
        const r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
/** Two-proportion test of (evolver − baseline) pass rates. Significance uses the POOLED-variance z test (the
 *  standard test of H0: p1 = p2); the reported CI uses the UNPOOLED (Wald) standard error (the standard interval
 *  for the difference). Zero pooled variance (both arms all-pass or all-fail) → no testable difference. */
function twoProportionTest(x1, n1, x2, n2, alpha) {
    const p1 = x1 / n1;
    const p2 = x2 / n2;
    const delta = p1 - p2;
    const pooled = (x1 + x2) / (n1 + n2);
    const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    const z = sePooled > 0 ? delta / sePooled : 0;
    const pValue = sePooled > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
    const zCrit = normalQuantile(1 - alpha / 2);
    const seWald = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
    return { z, pValue, significant: pValue <= alpha, ciLow: delta - zCrit * seWald, ciHigh: delta + zCrit * seWald };
}
/**
 * Achieved power + the per-arm sample size needed to call the experiment "powered". Answers what a bare
 * `no_significant_diff` cannot: was an effect of the minimum interesting size (minDelta) likely to be DETECTED at
 * this n, or is the null just underpowered? Plans around the OBSERVED baseline rate using the two-proportion
 * normal approximation; equal-n via the harmonic mean of the two arms (so unequal arms degrade gracefully).
 */
function powerAnalysis(baselineRate, minDelta, n1, n2, alpha, targetPower) {
    const delta = Math.abs(minDelta);
    if (delta <= 0)
        return { power: 0, requiredN: Infinity }; // no effect size to power for
    const p2 = Math.min(1, Math.max(0, baselineRate));
    const p1 = Math.min(1, Math.max(0, p2 + delta));
    // EFFECTIVE effect size after clamping to [0,1]: a minDelta lift off a near-ceiling baseline isn't fully
    // achievable (p1 caps at 1), so the realizable effect is p1 - p2 <= minDelta. Using the raw minDelta here would
    // overstate power and understate requiredN (Bugbot #286). At the ceiling (p2=1) there is no headroom at all.
    const effDelta = p1 - p2;
    if (effDelta <= 0)
        return { power: 0, requiredN: Infinity };
    const pbar = (p1 + p2) / 2;
    const varNull = 2 * pbar * (1 - pbar); // pooled-null variance (numerator uses sqrt of this)
    const varAlt = p1 * (1 - p1) + p2 * (1 - p2); // alternative variance (the two arms' combined spread)
    const za = normalQuantile(1 - alpha / 2);
    const zb = normalQuantile(targetPower);
    const nEff = n1 > 0 && n2 > 0 ? 2 / (1 / n1 + 1 / n2) : 0;
    let power = 0;
    if (nEff > 0) {
        const seAlt = Math.sqrt(varAlt / nEff);
        // Perfect separation (both arms at a 0/1 boundary) has zero alt-variance → the effect is detectable with
        // certainty; otherwise the standard upper-tail power of the two-proportion z test.
        power = seAlt > 0 ? normalCdf((effDelta - za * Math.sqrt(varNull / nEff)) / seAlt) : 1;
    }
    const num = za * Math.sqrt(varNull) + zb * Math.sqrt(varAlt);
    return { power: Math.min(1, Math.max(0, power)), requiredN: Math.ceil((num * num) / (effDelta * effDelta)) };
}
/**
 * Run both arms over the same task suite and compare. A verdict of evolver_better/worse requires BOTH a practical
 * delta (|passRateDelta| >= minPassRateDelta) AND statistical significance (two-proportion test p <= alpha);
 * otherwise no_significant_diff. reuseRate and costDelta are reported, never scored.
 */
export async function runThesis(suite, solver, opts = {}) {
    const minDelta = opts.minPassRateDelta ?? 0.05;
    const minSamples = opts.minSamples ?? 30;
    const alpha = opts.alpha ?? 0.05;
    const targetPower = opts.targetPower ?? 0.8;
    const baselineSamples = [];
    const evolverSamples = [];
    if (opts.interleave) {
        for (const task of suite.tasks) {
            baselineSamples.push(await solver(task, 'baseline'));
            evolverSamples.push(await solver(task, 'evolver'));
        }
    }
    else {
        for (const task of suite.tasks)
            baselineSamples.push(await solver(task, 'baseline'));
        for (const task of suite.tasks)
            evolverSamples.push(await solver(task, 'evolver'));
    }
    const baseline = summarize('baseline', baselineSamples);
    const evolver = summarize('evolver', evolverSamples);
    const passRateDelta = evolver.passRate - baseline.passRate;
    const costDelta = evolver.avgCost - baseline.avgCost;
    // Power read of the result: with the observed baseline rate and this n, could a minDelta effect have been seen?
    const { power, requiredN } = powerAnalysis(baseline.passRate, minDelta, baseline.n, evolver.n, alpha, targetPower);
    // Two-proportion significance test of (evolver − baseline). Guarded against n=0 (only reachable when minSamples
    // is forced to 0); an empty arm has no testable difference. Otherwise this is the gate that stops a verdict from
    // riding on sampling noise.
    const test = baseline.n > 0 && evolver.n > 0
        ? twoProportionTest(evolver.passes, evolver.n, baseline.passes, baseline.n, alpha)
        : { z: 0, pValue: 1, significant: false, ciLow: passRateDelta, ciHigh: passRateDelta };
    // Verdict needs BOTH bars: a practical delta (>= minDelta) AND statistical significance (p <= alpha). A 5pt
    // delta at n=30 is ~0.4σ — well inside noise — so the practical bar alone could call noise a win; the
    // significance bar is what makes the headline thesis number defensible.
    let verdict;
    if (baseline.n < minSamples || evolver.n < minSamples)
        verdict = 'insufficient_samples';
    else if (test.significant && passRateDelta >= minDelta)
        verdict = 'evolver_better';
    else if (test.significant && passRateDelta <= -minDelta)
        verdict = 'evolver_worse';
    else
        verdict = 'no_significant_diff';
    return {
        suite: suite.name, baseline, evolver, passRateDelta, costDelta,
        z: test.z, pValue: test.pValue, significant: test.significant, ciLow: test.ciLow, ciHigh: test.ciHigh,
        power, requiredN,
        verdict,
    };
}