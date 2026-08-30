// Epigenetic per-environment gene suppression (ported from v1 src/gep/epigenetics.js, adapted to v2's
// derive-from-events model). A gene that fails in the CURRENT environment class (but works elsewhere)
// should be penalized HERE only, not globally — its global health is untouched. v1 stored marks on the
// gene asset; v2 derives the penalty from recent per-(gene, env) outcomes at selection time, so no asset
// mutation and no schema churn. The penalty is subtracted from the gene's selection score; a gene that
// fails hard in this env falls in ranking (and below the floor → innovate) without being globally banned.
import { envFingerprintKey } from '../bootstrap/envFingerprint.js';
export { envFingerprintKey };
const MIN_ENV_ATTEMPTS = 3; // need this many attempts of the gene in this env before the penalty engages
const SUPPRESS_FAIL_RATE = 0.7; // fail rate (in this env) at/above which the penalty starts
const MAX_PENALTY = 0.5; // cap (subtracted from a [0,1]-ish score)
/**
 * Epigenetic penalty in [0, MAX_PENALTY] for `geneId` in the current `envKey`, from recent per-env outcomes.
 * 0 when there is not enough evidence (< MIN_ENV_ATTEMPTS) or the in-env fail rate is below SUPPRESS_FAIL_RATE;
 * scales linearly from 0 at SUPPRESS_FAIL_RATE up to MAX_PENALTY at a 100% in-env fail rate.
 */
export function epigeneticPenaltyForIds(ids, envKey, outcomes) {
    if (!envKey)
        return 0;
    const idSet = new Set(ids.filter((id) => id.length > 0));
    if (idSet.size === 0)
        return 0;
    let attempts = 0;
    let fails = 0;
    for (const o of outcomes) {
        if (!idSet.has(o.geneId) || o.envKey !== envKey)
            continue;
        attempts += 1;
        if (o.status === 'failed')
            fails += 1;
    }
    if (attempts < MIN_ENV_ATTEMPTS)
        return 0;
    const failRate = fails / attempts;
    if (failRate < SUPPRESS_FAIL_RATE)
        return 0;
    return Math.min(MAX_PENALTY, MAX_PENALTY * ((failRate - SUPPRESS_FAIL_RATE) / (1 - SUPPRESS_FAIL_RATE)));
}
export function epigeneticPenalty(geneId, envKey, outcomes) {
    return epigeneticPenaltyForIds([geneId], envKey, outcomes);
}