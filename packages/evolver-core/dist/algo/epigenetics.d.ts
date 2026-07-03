import { envFingerprintKey } from '../bootstrap/envFingerprint.js';
export { envFingerprintKey };
export interface GeneEnvOutcome {
    geneId: string;
    envKey: string;
    status: 'success' | 'failed';
}
/**
 * Epigenetic penalty in [0, MAX_PENALTY] for `geneId` in the current `envKey`, from recent per-env outcomes.
 * 0 when there is not enough evidence (< MIN_ENV_ATTEMPTS) or the in-env fail rate is below SUPPRESS_FAIL_RATE;
 * scales linearly from 0 at SUPPRESS_FAIL_RATE up to MAX_PENALTY at a 100% in-env fail rate.
 */
export declare function epigeneticPenaltyForIds(ids: readonly string[], envKey: string, outcomes: readonly GeneEnvOutcome[]): number;
export declare function epigeneticPenalty(geneId: string, envKey: string, outcomes: readonly GeneEnvOutcome[]): number;