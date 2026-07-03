// Resident-loop lifecycle for `evolver autoexec` (#106 daemon hardening). Extracted from the (untestable, never-
// resolving) runAutoExec shell so the SCHEDULING is unit-testable: an idle-aware, self-rescheduling timer that runs
// harder when the machine is idle and backs off when the user is active, plus a graceful stop that cancels the next
// tick and waits out an in-flight one. Pure of any autoexec specifics — the caller injects the (single-flight-
// guarded) work as `tick` and observes each beat via `onBeat` (the daemon emits a heartbeat from there).
import { daemon } from '@evomap/evolver-core';
/**
 * Start an idle-aware, self-rescheduling resident loop. Each tick is followed by a delay of
 * `basePollMs × idleMultiplier` (idle machine → smaller delay → runs more often). `stop()` makes a graceful
 * shutdown: no further ticks are scheduled and an in-flight tick is awaited, so there is no orphaned work.
 */
export function startResidentLoop(deps) {
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    const idleAware = deps.idleAware !== false;
    const probe = deps.idleProbe ?? daemon.defaultIdleProbe;
    let stopped = false;
    let timer = null;
    let inFlight = null;
    const planNext = () => {
        const rec = daemon.recommendSchedule(idleAware ? probe() : -1, {
            enabled: idleAware,
            ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
        });
        return { intensity: rec.intensity, idleSeconds: rec.idleSeconds, delayMs: Math.max(1, Math.round(deps.basePollMs * rec.sleepMultiplier)) };
    };
    const scheduleAfter = (delayMs) => {
        if (stopped)
            return;
        timer = setTimer(() => { void run(); }, delayMs);
    };
    const run = async () => {
        if (stopped)
            return;
        const beat = planNext();
        try {
            inFlight = Promise.resolve(deps.tick(beat));
            await inFlight;
        }
        catch { /* tick is expected to swallow its own errors */ }
        finally {
            inFlight = null;
        }
        if (stopped)
            return;
        deps.onBeat?.(beat);
        scheduleAfter(beat.delayMs);
    };
    if (deps.runFirstImmediately !== false) {
        void run();
    }
    else {
        const beat = planNext();
        deps.onBeat?.(beat);
        scheduleAfter(beat.delayMs);
    }
    return {
        stop: async () => {
            stopped = true;
            if (timer) {
                clearTimer(timer);
                timer = null;
            }
            if (inFlight) {
                try {
                    await inFlight;
                }
                catch { /* ignore */ }
            }
        },
    };
}