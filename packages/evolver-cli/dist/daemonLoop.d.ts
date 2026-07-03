import { daemon } from '@evomap/evolver-core';
export interface Beat {
    intensity: daemon.Intensity;
    /** The delay until the NEXT tick (ms), after applying the idle multiplier. */
    delayMs: number;
    idleSeconds: number;
}
export interface ResidentLoopDeps {
    /** The work to run each tick. Should already be single-flight-guarded by the caller; never expected to throw. */
    tick: (beat: Beat) => unknown | Promise<unknown>;
    /** Base poll cadence (ms). Idle multiplier scales this: aggressive ×0.5, deep ×0.25, normal ×1. */
    basePollMs: number;
    /** Idle-aware pacing (default true). False → fixed `basePollMs` cadence. */
    idleAware?: boolean;
    idleProbe?: daemon.IdleProbe;
    thresholds?: daemon.IdleThresholds;
    /** Called after each tick with the next-delay decision — the daemon emits its heartbeat here. */
    onBeat?: (beat: Beat) => void;
    /** Run the first tick immediately (default true). False → wait one delay before the first tick. */
    runFirstImmediately?: boolean;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}
export interface ResidentLoopHandle {
    /** Stop scheduling: cancel the pending tick and await any in-flight one. Idempotent. */
    stop: () => Promise<void>;
}
/**
 * Start an idle-aware, self-rescheduling resident loop. Each tick is followed by a delay of
 * `basePollMs × idleMultiplier` (idle machine → smaller delay → runs more often). `stop()` makes a graceful
 * shutdown: no further ticks are scheduled and an in-flight tick is awaited, so there is no orphaned work.
 */
export declare function startResidentLoop(deps: ResidentLoopDeps): ResidentLoopHandle;