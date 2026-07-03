// Solo-mode circuit breaker (pure decision logic), TypeScript port of v1.
//
// The wild Mad Dog loop, on a crash, sleeps and blindly retries forever. Solo
// replaces that with a bounded breaker: count consecutive failed cycles, reset
// on any success, and once the count hits the threshold, signal STOP so the
// caller can hard-stop instead of thrashing. Pure (no git, no exit, no clock)
// so solo/breaker.test.ts can exercise every transition without a daemon.
/**
 * Advance the breaker by one cycle result.
 *   ok:  did the cycle succeed?
 *   maxConsecutiveFailures: threshold (clamped to >= 1)
 */
export function step(state, ok, maxConsecutiveFailures) {
    const max = Math.max(1, Math.trunc(maxConsecutiveFailures) || 0);
    const prev = state?.consecutiveFailures ?? 0;
    const consecutiveFailures = ok ? 0 : prev + 1;
    return {
        state: { consecutiveFailures },
        tripped: !ok && consecutiveFailures >= max,
    };
}