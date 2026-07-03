export interface BreakerState {
    consecutiveFailures: number;
}
export interface BreakerStep {
    state: BreakerState;
    /** Whether the caller should trip: stop the loop / exit. */
    tripped: boolean;
}
/**
 * Advance the breaker by one cycle result.
 *   ok:  did the cycle succeed?
 *   maxConsecutiveFailures: threshold (clamped to >= 1)
 */
export declare function step(state: BreakerState | undefined, ok: boolean, maxConsecutiveFailures: number): BreakerStep;