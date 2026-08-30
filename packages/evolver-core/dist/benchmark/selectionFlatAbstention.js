import { createHash, randomUUID } from 'node:crypto';
import { assessSelectionGuard, engineHealthSelection, } from '../algo/geneSelection.js';
export const SELECTION_FLAT_ABSTENTION_BENCHMARK_VERSION = 'global-flat-abstention-paired-v1';
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_METADATA_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CI95_ALPHA = 0.05;
function actionForDecision(decision) {
    if (!decision.selectedGeneId)
        return { kind: 'innovate' };
    return {
        kind: 'reuse',
        geneId: decision.selectedGeneId,
        ...(decision.selectedAssetId ? { assetId: decision.selectedAssetId } : {}),
    };
}
function actionsEqual(left, right) {
    return left.kind === right.kind
        && (left.kind === 'innovate' || (right.kind === 'reuse'
            && left.geneId === right.geneId
            && left.assetId === right.assetId));
}
/** Compare production with a benchmark-only global flat-positive abstention counterfactual. */
export function compareOutsidePlateauFlatSelection(input) {
    const currentDecision = engineHealthSelection.run({ ...input, selectionGuard: 'enforce' }, { now: 0, cycleId: 'benchmark-global-flat-abstention', rng: () => 0.5 });
    const currentAction = actionForDecision(currentDecision);
    const floor = input.floor ?? 0;
    const eligible = currentDecision.candidates.filter((candidate) => candidate.score > floor);
    const flatPoolAssessment = assessSelectionGuard(eligible, true);
    const targeted = input.exploration?.plateau?.active !== true
        && input.exploration?.driftEnabled !== true
        && !input.forcedGeneId?.trim()
        && currentAction.kind === 'reuse'
        && currentDecision.selectionGuard?.status === 'allowed'
        && flatPoolAssessment.reason === 'plateau_flat_match';
    return {
        targeted,
        ...(targeted ? { targetReason: 'outside_plateau_flat_positive' } : {}),
        currentDecision,
        currentAction,
        globalFlatAbstainAction: targeted ? { kind: 'innovate' } : currentAction,
    };
}
function assertSafeMetadata(value, field) {
    if (typeof value !== 'string' || !SAFE_METADATA_RE.test(value)) {
        throw new Error(`${field} must be a non-sensitive ASCII slug`);
    }
}
function validateExpectedAction(action, field) {
    if (action?.kind === 'innovate')
        return;
    if (action?.kind !== 'reuse' || typeof action.geneId !== 'string' || action.geneId.trim().length === 0) {
        throw new Error(`${field} must be a valid selection action`);
    }
    if (action.assetId !== undefined && (typeof action.assetId !== 'string' || action.assetId.trim().length === 0)) {
        throw new Error(`${field}.assetId must be non-empty when present`);
    }
}
function sha256(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function encodeOwnProperties(value, context) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error('task snapshot contains symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.getOwnPropertyNames(value).map((key) => {
        const descriptor = descriptors[key];
        if (descriptor.get || descriptor.set)
            throw new Error('task snapshot contains accessor properties');
        return `${JSON.stringify(key)}:${canonicalSnapshotValue(descriptor.value, context)}`;
    }).join(',');
}
function canonicalSnapshotValue(value, context = { seen: new Map(), nextId: 0 }) {
    if (value === null)
        return 'null';
    if (value === undefined)
        return 'undefined';
    if (typeof value === 'string')
        return `string:${JSON.stringify(value)}`;
    if (typeof value === 'boolean')
        return value ? 'boolean:true' : 'boolean:false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error('task snapshot contains a non-finite number');
        return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
    }
    if (typeof value === 'bigint')
        return `bigint:${value.toString()}`;
    if (typeof value !== 'object') {
        throw new Error(`task snapshot contains unsupported ${typeof value} data`);
    }
    const previousId = context.seen.get(value);
    if (previousId !== undefined)
        return `reference:${previousId}`;
    const id = context.nextId;
    context.nextId += 1;
    context.seen.set(value, id);
    if (Array.isArray(value)) {
        return `array#${id}:{${encodeOwnProperties(value, context)}}`;
    }
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
            throw new Error('task snapshot contains an invalid date');
        return `date#${id}:${value.toISOString()}:{${encodeOwnProperties(value, context)}}`;
    }
    if (value instanceof Map) {
        const entries = [...value.entries()].map(([key, item]) => (`${canonicalSnapshotValue(key, context)}=>${canonicalSnapshotValue(item, context)}`));
        return `map#${id}:[${entries.join(',')}]:{${encodeOwnProperties(value, context)}}`;
    }
    if (value instanceof Set) {
        const entries = [...value].map((item) => canonicalSnapshotValue(item, context));
        return `set#${id}:[${entries.join(',')}]:{${encodeOwnProperties(value, context)}}`;
    }
    if (ArrayBuffer.isView(value)) {
        if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
            throw new Error('task snapshot must not contain SharedArrayBuffer-backed views');
        }
        return `view#${id}:${value.constructor.name}:${value.byteOffset}:${value.byteLength}:${canonicalSnapshotValue(value.buffer, context)}:{${encodeOwnProperties(value, context)}}`;
    }
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
        throw new Error('task snapshot must not contain SharedArrayBuffer');
    }
    if (value instanceof ArrayBuffer) {
        return `array-buffer#${id}:${Buffer.from(value).toString('hex')}:{${encodeOwnProperties(value, context)}}`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('task snapshot contains unsupported non-plain object data');
    }
    return `object#${id}:{${encodeOwnProperties(value, context)}}`;
}
function cloneStructured(value, errorMessage) {
    try {
        return structuredClone(value);
    }
    catch {
        throw new Error(errorMessage);
    }
}
/** Compute the digest that the cohort manifest must pre-register for this exact task snapshot. */
export function computeSelectionFlatTaskFingerprint(task) {
    const snapshot = cloneStructured(task, 'task snapshot must be structured-cloneable for fingerprinting');
    return sha256(canonicalSnapshotValue([
        SELECTION_FLAT_ABSTENTION_BENCHMARK_VERSION,
        snapshot.id,
        snapshot.workspaceSnapshotDigest,
        snapshot.split,
        snapshot.stratum,
        snapshot.payload,
        snapshot.selection,
        snapshot.expectation,
    ]));
}
function isolationKey(datasetDigest, executionNonce, fingerprint, arm) {
    return sha256(`${datasetDigest}\0${executionNonce}\0${fingerprint}\0${arm}`);
}
function validateSuite(suite) {
    assertSafeMetadata(suite.name, 'suite.name');
    assertSafeMetadata(suite.cohort.id, 'cohort.id');
    assertSafeMetadata(suite.cohort.version, 'cohort.version');
    assertSafeMetadata(suite.cohort.verifier.id, 'cohort.verifier.id');
    assertSafeMetadata(suite.cohort.verifier.version, 'cohort.verifier.version');
    if (typeof suite.cohort.sourceCommit !== 'string'
        || !FULL_COMMIT_RE.test(suite.cohort.sourceCommit)) {
        throw new Error('cohort.sourceCommit must be a full lowercase 40-hex commit');
    }
    if (suite.cohort.taskFingerprints.length !== suite.tasks.length) {
        throw new Error('pre-registered cohort does not match the benchmark tasks');
    }
    const ids = new Set();
    const fingerprints = new Set();
    for (const [index, task] of suite.tasks.entries()) {
        assertSafeMetadata(task.id, `tasks[${index}].id`);
        assertSafeMetadata(task.stratum, `tasks[${index}].stratum`);
        if (task.split !== 'calibration' && task.split !== 'holdout') {
            throw new Error(`invalid split for task ${task.id}`);
        }
        if (typeof task.workspaceSnapshotDigest !== 'string'
            || !SHA256_RE.test(task.workspaceSnapshotDigest)) {
            throw new Error(`invalid workspace snapshot digest for task ${task.id}`);
        }
        if (task.expectation?.role !== 'target' && task.expectation?.role !== 'control') {
            throw new Error(`invalid expected role for task ${task.id}`);
        }
        validateExpectedAction(task.expectation.currentAction, `task ${task.id} current expectation`);
        validateExpectedAction(task.expectation.globalFlatAbstainAction, `task ${task.id} global expectation`);
        if (ids.has(task.id))
            throw new Error(`duplicate task id: ${task.id}`);
        if (fingerprints.has(task.taskFingerprint)) {
            throw new Error(`duplicate task fingerprint: ${task.taskFingerprint}`);
        }
        if (typeof task.taskFingerprint !== 'string' || !SHA256_RE.test(task.taskFingerprint)) {
            throw new Error(`invalid task fingerprint for ${task.id}`);
        }
        if (computeSelectionFlatTaskFingerprint(task) !== task.taskFingerprint) {
            throw new Error(`task content fingerprint mismatch for ${task.id}`);
        }
        if (suite.cohort.taskFingerprints[index] !== task.taskFingerprint) {
            throw new Error(`pre-registered cohort order mismatch at task ${task.id}`);
        }
        ids.add(task.id);
        fingerprints.add(task.taskFingerprint);
    }
}
function cleanOutcome(taskId, expectedVerifier, outcome) {
    const passed = outcome?.passed;
    const producedValue = outcome?.producedValue;
    const unsafe = outcome?.unsafe;
    const cost = outcome?.cost;
    const verifier = outcome?.verifier;
    const verifierId = verifier?.id;
    const verifierVersion = verifier?.version;
    const proofSha256 = verifier?.proofSha256;
    if (typeof passed !== 'boolean'
        || typeof producedValue !== 'boolean'
        || typeof unsafe !== 'boolean') {
        throw new Error(`verifier returned invalid boolean fields for task ${taskId}`);
    }
    if (!Number.isFinite(cost) || cost < 0) {
        throw new Error(`verifier returned invalid cost for task ${taskId}`);
    }
    if (verifierId !== expectedVerifier.id || verifierVersion !== expectedVerifier.version) {
        throw new Error(`verifier identity mismatch for task ${taskId}`);
    }
    if (typeof proofSha256 !== 'string' || !SHA256_RE.test(proofSha256)) {
        throw new Error(`verifier returned invalid proof digest for task ${taskId}`);
    }
    // Rebuild the object so adapter-only logs or payloads cannot leak into the persisted report.
    return {
        passed,
        producedValue,
        unsafe,
        cost,
        verifier: {
            id: verifierId,
            version: verifierVersion,
            proofSha256,
        },
    };
}
function logAdd(left, right) {
    if (left === Number.NEGATIVE_INFINITY)
        return right;
    if (right === Number.NEGATIVE_INFINITY)
        return left;
    const high = Math.max(left, right);
    return high + Math.log(Math.exp(left - high) + Math.exp(right - high));
}
/** Exact two-sided McNemar p-value over the discordant pairs. */
export function exactMcNemarTwoSided(globalOnlyPass, currentOnlyPass) {
    if (!Number.isSafeInteger(globalOnlyPass) || globalOnlyPass < 0
        || !Number.isSafeInteger(currentOnlyPass) || currentOnlyPass < 0) {
        throw new Error('McNemar counts must be non-negative safe integers');
    }
    const discordant = globalOnlyPass + currentOnlyPass;
    if (!Number.isSafeInteger(discordant)) {
        throw new Error('McNemar discordant total must be a safe integer');
    }
    if (discordant === 0)
        return 1;
    const tail = Math.min(globalOnlyPass, currentOnlyPass);
    let logProbability = -discordant * Math.log(2);
    let logCumulative = logProbability;
    for (let k = 1; k <= tail; k += 1) {
        logProbability += Math.log(discordant - k + 1) - Math.log(k);
        logCumulative = logAdd(logCumulative, logProbability);
    }
    return Math.min(1, 2 * Math.exp(logCumulative));
}
/** Distribution-free Hoeffding 95% CI for the mean paired success difference (global minus current). */
export function pairedRiskDifference95(pairs) {
    if (pairs.length === 0)
        return { difference: 0, ci95Low: -1, ci95High: 1 };
    const differences = pairs.map((pair) => Number(pair.globalFlatAbstainPassed) - Number(pair.currentPassed));
    const difference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    // Each paired difference lies in [-1, 1], so Hoeffding remains valid at small n and at all-win boundaries.
    const margin = Math.sqrt((2 * Math.log(2 / CI95_ALPHA)) / differences.length);
    return {
        difference,
        ci95Low: Math.max(-1, difference - margin),
        ci95High: Math.min(1, difference + margin),
    };
}
function rate(count, total) {
    return total === 0 ? 0 : count / total;
}
function average(values) {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function summarizeRows(rows) {
    const n = rows.length;
    let bothPass = 0;
    let bothFail = 0;
    let globalOnlyPass = 0;
    let currentOnlyPass = 0;
    for (const row of rows) {
        const currentPassed = row.current.outcome.passed;
        const globalPassed = row.globalFlatAbstain.outcome.passed;
        if (currentPassed && globalPassed)
            bothPass += 1;
        else if (!currentPassed && !globalPassed)
            bothFail += 1;
        else if (globalPassed)
            globalOnlyPass += 1;
        else
            currentOnlyPass += 1;
    }
    const currentPasses = bothPass + currentOnlyPass;
    const globalFlatAbstainPasses = bothPass + globalOnlyPass;
    const currentUnsafeRate = rate(rows.filter((row) => row.current.outcome.unsafe).length, n);
    const globalUnsafeRate = rate(rows.filter((row) => row.globalFlatAbstain.outcome.unsafe).length, n);
    const currentAverageCost = average(rows.map((row) => row.current.outcome.cost));
    const globalAverageCost = average(rows.map((row) => row.globalFlatAbstain.outcome.cost));
    const risk = pairedRiskDifference95(rows.map((row) => ({
        currentPassed: row.current.outcome.passed,
        globalFlatAbstainPassed: row.globalFlatAbstain.outcome.passed,
    })));
    return {
        n,
        currentPasses,
        globalFlatAbstainPasses,
        bothPass,
        bothFail,
        globalOnlyPass,
        currentOnlyPass,
        currentPassRate: rate(currentPasses, n),
        globalFlatAbstainPassRate: rate(globalFlatAbstainPasses, n),
        pairedRiskDifference: risk.difference,
        ci95Low: risk.ci95Low,
        ci95High: risk.ci95High,
        mcnemarPValue: exactMcNemarTwoSided(globalOnlyPass, currentOnlyPass),
        currentProducedValueRate: rate(rows.filter((row) => row.current.outcome.producedValue).length, n),
        globalFlatAbstainProducedValueRate: rate(rows.filter((row) => row.globalFlatAbstain.outcome.producedValue).length, n),
        currentUnsafeRate,
        globalFlatAbstainUnsafeRate: globalUnsafeRate,
        unsafeRateDelta: globalUnsafeRate - currentUnsafeRate,
        currentAverageCost,
        globalFlatAbstainAverageCost: globalAverageCost,
        averageCostDelta: globalAverageCost - currentAverageCost,
        currentInnovateRate: rate(rows.filter((row) => row.current.action === 'innovate').length, n),
        globalFlatAbstainInnovateRate: rate(rows.filter((row) => row.globalFlatAbstain.action === 'innovate').length, n),
    };
}
function cloneTaskForArm(task) {
    return cloneStructured(task, `task ${task.id} must be structured-cloneable for isolated arm execution`);
}
function cloneSuiteSnapshot(suite) {
    return cloneStructured(suite, 'benchmark suite must be structured-cloneable before validation');
}
function cloneAction(action) {
    return action.kind === 'innovate'
        ? { kind: 'innovate' }
        : {
            kind: 'reuse',
            geneId: action.geneId,
            ...(action.assetId ? { assetId: action.assetId } : {}),
        };
}
function benchmarkDatasetDigest(suite, comparisons) {
    const material = [
        SELECTION_FLAT_ABSTENTION_BENCHMARK_VERSION,
        suite.name,
        suite.cohort.id,
        suite.cohort.version,
        suite.cohort.sourceCommit,
        suite.cohort.verifier.id,
        suite.cohort.verifier.version,
        suite.tasks.map((task, index) => [
            index,
            task.taskFingerprint,
            task.split,
            task.stratum,
            comparisons[index]?.targeted === true,
            comparisons[index]?.currentAction.kind,
            comparisons[index]?.globalFlatAbstainAction.kind,
        ]),
    ];
    return sha256(JSON.stringify(material));
}
function validatePreRegisteredExpectation(task, comparison) {
    const actualRole = comparison.targeted ? 'target' : 'control';
    if (task.expectation.role !== actualRole) {
        throw new Error(`pre-registered role mismatch for task ${task.id}`);
    }
    if (!actionsEqual(task.expectation.currentAction, comparison.currentAction)) {
        throw new Error(`pre-registered current action mismatch for task ${task.id}`);
    }
    if (!actionsEqual(task.expectation.globalFlatAbstainAction, comparison.globalFlatAbstainAction)) {
        throw new Error(`pre-registered global action mismatch for task ${task.id}`);
    }
}
function rowsByStratum(rows) {
    const result = Object.create(null);
    const strata = [...new Set(rows.map((row) => row.stratum))].sort();
    for (const stratum of strata) {
        result[stratum] = summarizeRows(rows.filter((row) => row.stratum === stratum));
    }
    return result;
}
/**
 * Run a pre-registered, full-information paired benchmark. Controls are classification checks only and are never
 * executed. Target tasks run both arms on separately cloned inputs and caller-owned isolated workspaces.
 */
export async function runSelectionFlatAbstentionBenchmark(suite, verifier) {
    const snapshot = cloneSuiteSnapshot(suite);
    validateSuite(snapshot);
    const comparisons = snapshot.tasks.map((task) => compareOutsidePlateauFlatSelection(task.selection));
    snapshot.tasks.forEach((task, index) => {
        validatePreRegisteredExpectation(task, comparisons[index]);
    });
    const datasetDigest = benchmarkDatasetDigest(snapshot, comparisons);
    const executionNonce = randomUUID();
    const rows = [];
    let targetIndex = 0;
    for (const [taskIndex, task] of snapshot.tasks.entries()) {
        const comparison = comparisons[taskIndex];
        if (!comparison.targeted) {
            if (!actionsEqual(comparison.currentAction, comparison.globalFlatAbstainAction)) {
                throw new Error(`control action divergence for task ${task.id}`);
            }
            continue;
        }
        const armOrder = targetIndex % 2 === 0
            ? ['current', 'global-flat-abstain']
            : ['global-flat-abstain', 'current'];
        targetIndex += 1;
        const outcomes = new Map();
        for (const [order, arm] of armOrder.entries()) {
            const action = arm === 'current'
                ? comparison.currentAction
                : comparison.globalFlatAbstainAction;
            const rawOutcome = await verifier({
                task: cloneTaskForArm(task),
                arm,
                action: cloneAction(action),
                isolationKey: isolationKey(datasetDigest, executionNonce, task.taskFingerprint, arm),
                order: order,
            });
            outcomes.set(arm, cleanOutcome(task.id, snapshot.cohort.verifier, rawOutcome));
        }
        rows.push({
            taskFingerprint: task.taskFingerprint,
            split: task.split,
            stratum: task.stratum,
            armOrder,
            current: {
                action: comparison.currentAction.kind,
                outcome: outcomes.get('current'),
            },
            globalFlatAbstain: {
                action: comparison.globalFlatAbstainAction.kind,
                outcome: outcomes.get('global-flat-abstain'),
            },
        });
    }
    return {
        benchmarkVersion: SELECTION_FLAT_ABSTENTION_BENCHMARK_VERSION,
        statisticalMethods: {
            mcnemar: 'exact-two-sided-binomial',
            riskDifferenceCi: 'paired-hoeffding-95',
        },
        suite: snapshot.name,
        cohort: {
            id: snapshot.cohort.id,
            version: snapshot.cohort.version,
            sourceCommit: snapshot.cohort.sourceCommit,
            verifier: { ...snapshot.cohort.verifier },
            registeredTasks: snapshot.cohort.taskFingerprints.length,
        },
        datasetDigest,
        targetTasks: rows.length,
        controlTasks: snapshot.tasks.length - rows.length,
        controlDivergences: 0,
        rows,
        overall: summarizeRows(rows),
        calibration: summarizeRows(rows.filter((row) => row.split === 'calibration')),
        holdout: summarizeRows(rows.filter((row) => row.split === 'holdout')),
        strata: rowsByStratum(rows),
    };
}