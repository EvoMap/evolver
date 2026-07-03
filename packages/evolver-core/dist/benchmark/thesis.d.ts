export type ThesisArm = 'baseline' | 'evolver';
export interface ThesisTask<I> {
    id: string;
    input: I;
}
/** One task's objective result for one arm. */
export interface ThesisOutcome {
    /** Objectively solved (e.g. the validation hook passed). Decided by a verifier, not the agent. */
    passed: boolean;
    /** Normalized cost (tokens/time/etc.; caller defines the unit). */
    cost: number;
    /** Whether a prior gene was reused this run (descriptive only — never counted toward the verdict). */
    reusedGene: boolean;
}
/**
 * Solver seam: the real agent plugs in here (arm='evolver' runs with the learned-gene pool, 'baseline'
 * runs without it). Tests inject a deterministic fake, so the harness is never bound to a live LLM.
 */
export type ThesisSolver<I> = (task: ThesisTask<I>, arm: ThesisArm) => Promise<ThesisOutcome> | ThesisOutcome;
export interface ArmReport {
    arm: ThesisArm;
    n: number;
    /** Tasks the arm objectively passed — the numerator behind passRate, kept so the verdict can run a real
     *  two-proportion test (rates alone lose the counts the test needs). */
    passes: number;
    passRate: number;
    avgCost: number;
    /** Descriptive only, does not affect the verdict. baseline is ~0 (no gene pool). */
    reuseRate: number;
}
export type ThesisVerdict = 'evolver_better' | 'no_significant_diff' | 'evolver_worse' | 'insufficient_samples';
export interface ThesisReport {
    suite: string;
    baseline: ArmReport;
    evolver: ArmReport;
    /** evolver.passRate - baseline.passRate. The practical-significance input to the verdict. */
    passRateDelta: number;
    /** evolver.avgCost - baseline.avgCost. */
    costDelta: number;
    /** Two-proportion z statistic for (evolver − baseline) pass rates (pooled-variance test). 0 when undefined. */
    z: number;
    /** Two-sided p-value for `z` (normal approximation). 1 when the test is undefined (zero variance). */
    pValue: number;
    /** Whether the pass-rate difference is statistically significant at `alpha` (pValue <= alpha). A REQUIREMENT
     *  for an evolver_better/worse verdict — a practical delta alone (>= minPassRateDelta) is no longer enough,
     *  because at small n a 5pt delta is well inside sampling noise (the headline thesis number must be defensible). */
    significant: boolean;
    /** (1 − alpha) Wald confidence interval for passRateDelta. When it straddles 0 the difference is not significant. */
    ciLow: number;
    ciHigh: number;
    /** Achieved power to detect an effect of size minPassRateDelta at the OBSERVED baseline rate and this n (alpha
     *  two-sided). The number a bare `no_significant_diff` hides: a LOW power means the null is underpowered (the
     *  experiment couldn't have seen the minimum interesting effect), not that there is no effect. 0 when undefined. */
    power: number;
    /** Per-arm sample size needed to reach `targetPower` for a minPassRateDelta effect at the observed baseline rate.
     *  Actionable "run ~N tasks/arm" guidance; Infinity when minPassRateDelta is 0 (no effect size to power for). */
    requiredN: number;
    verdict: ThesisVerdict;
}
export interface ThesisOptions {
    /** Min absolute passRate gain to call evolver better/worse (default 0.05) — the PRACTICAL bar. */
    minPassRateDelta?: number;
    /** Significance level for the two-proportion test (default 0.05) — the STATISTICAL bar. The verdict needs both. */
    alpha?: number;
    /** Min samples per arm before drawing a verdict (default 30); below it => insufficient_samples. */
    minSamples?: number;
    /** Target power for the requiredN guidance + the underpowered read of a null (default 0.8). */
    targetPower?: number;
    /**
     * Interleave arms per task: run baseline then evolver on each task before moving to the next,
     * instead of all-baseline first then all-evolver. Prevents API rate limits from hitting the
     * second arm disproportionately (the serial default runs baseline entirely first, so evolver
     * faces the tail-end of a rate-limit window).
     */
    interleave?: boolean;
}
/**
 * Run both arms over the same task suite and compare. A verdict of evolver_better/worse requires BOTH a practical
 * delta (|passRateDelta| >= minPassRateDelta) AND statistical significance (two-proportion test p <= alpha);
 * otherwise no_significant_diff. reuseRate and costDelta are reported, never scored.
 */
export declare function runThesis<I>(suite: {
    name: string;
    tasks: readonly ThesisTask<I>[];
}, solver: ThesisSolver<I>, opts?: ThesisOptions): Promise<ThesisReport>;