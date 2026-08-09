import { type GeneDecision, type SelectionInput } from '../algo/geneSelection.js';
export declare const SELECTION_FLAT_ABSTENTION_BENCHMARK_VERSION = "global-flat-abstention-paired-v1";
export type SelectionFlatArm = 'current' | 'global-flat-abstain';
export type SelectionFlatSplit = 'calibration' | 'holdout';
export type SelectionFlatAction = {
    kind: 'reuse';
    geneId: string;
    assetId?: string;
} | {
    kind: 'innovate';
};
export interface SelectionFlatComparison {
    targeted: boolean;
    targetReason?: 'outside_plateau_flat_positive';
    currentDecision: GeneDecision;
    currentAction: SelectionFlatAction;
    globalFlatAbstainAction: SelectionFlatAction;
}
export interface SelectionFlatCohort {
    id: string;
    version: string;
    sourceCommit: string;
    taskFingerprints: readonly string[];
    verifier: {
        id: string;
        version: string;
    };
}
export type SelectionFlatExpectedRole = 'target' | 'control';
export interface SelectionFlatExpectation {
    role: SelectionFlatExpectedRole;
    currentAction: SelectionFlatAction;
    globalFlatAbstainAction: SelectionFlatAction;
}
export interface SelectionFlatTaskSnapshot<I> {
    id: string;
    workspaceSnapshotDigest: string;
    split: SelectionFlatSplit;
    stratum: string;
    /** Verifier input is a private structured-clone-normalized copy (for example, Node Buffer becomes Uint8Array). */
    payload: I;
    selection: Omit<SelectionInput, 'selectionGuard'>;
    expectation: SelectionFlatExpectation;
}
export interface SelectionFlatTask<I> extends SelectionFlatTaskSnapshot<I> {
    taskFingerprint: string;
}
export interface SelectionFlatBenchmarkSuite<I> {
    name: string;
    cohort: SelectionFlatCohort;
    tasks: readonly SelectionFlatTask<I>[];
}
export interface SelectionFlatVerifierProof {
    id: string;
    version: string;
    proofSha256: string;
}
export interface SelectionFlatObjectiveOutcome {
    passed: boolean;
    producedValue: boolean;
    unsafe: boolean;
    cost: number;
    verifier: SelectionFlatVerifierProof;
}
export interface SelectionFlatVerificationRequest<I> {
    task: SelectionFlatTask<I>;
    arm: SelectionFlatArm;
    action: SelectionFlatAction;
    isolationKey: string;
    order: 0 | 1;
}
export type SelectionFlatVerifier<I> = (request: SelectionFlatVerificationRequest<I>) => Promise<SelectionFlatObjectiveOutcome> | SelectionFlatObjectiveOutcome;
export interface SelectionFlatBenchmarkRow {
    taskFingerprint: string;
    split: SelectionFlatSplit;
    stratum: string;
    armOrder: readonly [SelectionFlatArm, SelectionFlatArm];
    current: {
        action: SelectionFlatAction['kind'];
        outcome: SelectionFlatObjectiveOutcome;
    };
    globalFlatAbstain: {
        action: SelectionFlatAction['kind'];
        outcome: SelectionFlatObjectiveOutcome;
    };
}
export interface SelectionFlatPairedStats {
    n: number;
    currentPasses: number;
    globalFlatAbstainPasses: number;
    bothPass: number;
    bothFail: number;
    globalOnlyPass: number;
    currentOnlyPass: number;
    currentPassRate: number;
    globalFlatAbstainPassRate: number;
    pairedRiskDifference: number;
    ci95Low: number;
    ci95High: number;
    mcnemarPValue: number;
    currentProducedValueRate: number;
    globalFlatAbstainProducedValueRate: number;
    currentUnsafeRate: number;
    globalFlatAbstainUnsafeRate: number;
    unsafeRateDelta: number;
    currentAverageCost: number;
    globalFlatAbstainAverageCost: number;
    averageCostDelta: number;
    currentInnovateRate: number;
    globalFlatAbstainInnovateRate: number;
}
export interface SelectionFlatBenchmarkReport {
    benchmarkVersion: typeof SELECTION_FLAT_ABSTENTION_BENCHMARK_VERSION;
    statisticalMethods: {
        mcnemar: 'exact-two-sided-binomial';
        riskDifferenceCi: 'paired-hoeffding-95';
    };
    suite: string;
    cohort: Omit<SelectionFlatCohort, 'taskFingerprints'> & {
        registeredTasks: number;
    };
    datasetDigest: string;
    targetTasks: number;
    controlTasks: number;
    controlDivergences: 0;
    rows: SelectionFlatBenchmarkRow[];
    overall: SelectionFlatPairedStats;
    calibration: SelectionFlatPairedStats;
    holdout: SelectionFlatPairedStats;
    strata: Record<string, SelectionFlatPairedStats>;
}
export interface SelectionFlatPassPair {
    currentPassed: boolean;
    globalFlatAbstainPassed: boolean;
}
/** Compare production with a benchmark-only global flat-positive abstention counterfactual. */
export declare function compareOutsidePlateauFlatSelection(input: Omit<SelectionInput, 'selectionGuard'>): SelectionFlatComparison;
/** Compute the digest that the cohort manifest must pre-register for this exact task snapshot. */
export declare function computeSelectionFlatTaskFingerprint<I>(task: SelectionFlatTaskSnapshot<I>): string;
/** Exact two-sided McNemar p-value over the discordant pairs. */
export declare function exactMcNemarTwoSided(globalOnlyPass: number, currentOnlyPass: number): number;
/** Distribution-free Hoeffding 95% CI for the mean paired success difference (global minus current). */
export declare function pairedRiskDifference95(pairs: readonly SelectionFlatPassPair[]): {
    difference: number;
    ci95Low: number;
    ci95High: number;
};
/**
 * Run a pre-registered, full-information paired benchmark. Controls are classification checks only and are never
 * executed. Target tasks run both arms on separately cloned inputs and caller-owned isolated workspaces.
 */
export declare function runSelectionFlatAbstentionBenchmark<I>(suite: SelectionFlatBenchmarkSuite<I>, verifier: SelectionFlatVerifier<I>): Promise<SelectionFlatBenchmarkReport>;