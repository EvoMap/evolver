export const SELECTION_POLICIES = ['engine-health', 'ucb1-shadow', 'ucb1'];
export const UCB1_SELECTION_POLICY_VERSION = 'ucb1-v1';
export const UCB1_REWARD_POLICY_VERSION = 'productive-binary-v1';
function nonEmptyString(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}
function decisionProjection(event) {
    if (event.type !== 'decision.gene_selected')
        return undefined;
    const payload = event.payload;
    const cycleId = nonEmptyString(payload['cycleId']);
    const geneId = nonEmptyString(payload['selectedGeneId']);
    if (!cycleId)
        return undefined;
    if (!geneId || geneId === 'ad-hoc')
        return { cycleId, decision: null };
    return {
        cycleId,
        decision: { armId: nonEmptyString(payload['selectedAssetId']) ?? geneId },
    };
}
function terminalReward(event) {
    if (event.type !== 'cycle.failed' && event.type !== 'cycle.solidified')
        return null;
    const payload = event.payload;
    const cycleId = nonEmptyString(payload['cycleId']);
    if (!cycleId)
        return null;
    if (event.type === 'cycle.failed' || payload['producedValue'] === false)
        return { cycleId, reward: 0 };
    // Legacy solidified events predate producedValue. Preserve the existing confidence replay compatibility policy.
    return { cycleId, reward: 1 };
}
/**
 * Rebuild UCB1 state from the append-only root event log. Decisions are pulls immediately, so later readers no
 * longer treat an in-flight arm as cold. The read-select-append sequence is not an atomic reservation across
 * workers. A terminal event adds reward exactly once per cycle; duplicate rows collapse to their latest projection.
 */
export function deriveUcb1History(events) {
    const cycles = new Map();
    for (const event of events) {
        const decision = decisionProjection(event);
        // A restarted/re-emitted decision for the same cycleId begins a new pending lifecycle. Never let a terminal
        // from the earlier lifecycle leak reward into this newer arm.
        if (decision) {
            if (decision.decision)
                cycles.set(decision.cycleId, { decision: decision.decision });
            else
                cycles.delete(decision.cycleId);
        }
        const terminal = terminalReward(event);
        if (terminal) {
            const cycle = cycles.get(terminal.cycleId);
            if (cycle)
                cycle.reward = terminal.reward;
        }
    }
    const mutable = new Map();
    for (const cycle of cycles.values()) {
        const current = mutable.get(cycle.decision.armId) ?? { pulls: 0, completedPulls: 0, rewardSum: 0 };
        current.pulls += 1;
        if (cycle.reward !== undefined) {
            current.completedPulls += 1;
            current.rewardSum += cycle.reward;
        }
        mutable.set(cycle.decision.armId, current);
    }
    const arms = new Map();
    for (const [armId, stats] of mutable) {
        arms.set(armId, {
            armId,
            ...stats,
            meanReward: stats.completedPulls > 0 ? stats.rewardSum / stats.completedPulls : 0,
        });
    }
    return { arms, totalPulls: cycles.size };
}
function emptyStats(armId) {
    return { armId, pulls: 0, completedPulls: 0, rewardSum: 0, meanReward: 0 };
}
/** Combine current asset identity with legacy gene-only history when that bridge is unambiguous. */
export function ucb1StatsForCandidate(history, geneId, assetId, includeLegacyGeneHistory = true) {
    const armId = assetId ?? geneId;
    const identities = assetId === undefined
        ? [geneId]
        : [...new Set([assetId, ...(includeLegacyGeneHistory ? [geneId] : [])])];
    const matches = identities.map((identity) => history.arms.get(identity)).filter((stats) => stats !== undefined);
    if (matches.length === 0)
        return emptyStats(armId);
    const pulls = matches.reduce((sum, stats) => sum + stats.pulls, 0);
    const completedPulls = matches.reduce((sum, stats) => sum + stats.completedPulls, 0);
    const rewardSum = matches.reduce((sum, stats) => sum + stats.rewardSum, 0);
    return {
        armId,
        pulls,
        completedPulls,
        rewardSum,
        meanReward: completedPulls > 0 ? rewardSum / completedPulls : 0,
    };
}
function finiteBaseScore(value) {
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}
function finiteCount(value) {
    return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Math.max(0, value))) : 0;
}
function finiteMeanReward(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function saturatingCountSum(total, value) {
    const count = finiteCount(value);
    return total >= Number.MAX_SAFE_INTEGER - count ? Number.MAX_SAFE_INTEGER : total + count;
}
/**
 * Canonical UCB1: mean reward + sqrt(2 ln(total pulls) / arm pulls). Cold arms have +Infinity and are ordered
 * deterministically by base score then arm identity. The caller supplies only the already-gated exploration window.
 */
export function chooseUcb1Arm(arms, historyTotalPulls) {
    if (arms.length === 0)
        return { choice: null, fallbackReason: 'empty_pool' };
    if (arms.some((arm) => !arm.explorationEligible))
        return { choice: null, fallbackReason: 'ineligible_arm' };
    const totalPulls = Math.max(1, finiteCount(historyTotalPulls), arms.reduce((sum, arm) => saturatingCountSum(sum, arm.stats.pulls), 0));
    const ranked = arms.map((arm) => {
        const pulls = finiteCount(arm.stats.pulls);
        const meanReward = finiteMeanReward(arm.stats.meanReward);
        const coldStart = pulls === 0;
        const bonus = coldStart ? null : Math.sqrt((2 * Math.log(totalPulls)) / pulls);
        const index = coldStart ? null : meanReward + bonus;
        return { arm, pulls, meanReward, coldStart, bonus, index };
    }).sort((left, right) => {
        if (left.coldStart !== right.coldStart)
            return left.coldStart ? -1 : 1;
        if (left.index !== null && right.index !== null && left.index !== right.index)
            return right.index - left.index;
        const leftScore = finiteBaseScore(left.arm.baseScore);
        const rightScore = finiteBaseScore(right.arm.baseScore);
        return rightScore !== leftScore ? rightScore - leftScore : left.arm.armId.localeCompare(right.arm.armId);
    });
    const winner = ranked[0];
    return {
        choice: {
            armId: winner.arm.armId,
            pulls: winner.pulls,
            completedPulls: finiteCount(winner.arm.stats.completedPulls),
            totalPulls,
            meanReward: winner.meanReward,
            bonus: winner.bonus,
            index: winner.index,
            coldStart: winner.coldStart,
        },
    };
}