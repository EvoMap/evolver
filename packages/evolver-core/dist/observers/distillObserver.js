/** The root_event ingestion emits when a batch of material lands (see CLI ingest). The only trigger this observer
 *  subscribes to — it claims from the consumer group, so the event is a tick, not a payload it reads. */
export const MATERIAL_READY_EVENT_TYPE = 'material.batch_ready';
/**
 * Build the distill observer. Subscribes to `material.batch_ready` only. On each such event it runs `distill()`
 * once, SINGLE-FLIGHT: an event arriving while a drain is in flight is coalesced into ONE trailing drain (never
 * dropped). If a drain STALLS on a stuck head, the observer self-schedules a backoff retry so a transient write
 * failure cannot stall the queue forever waiting on an external event. idempotent=false: distill writes a gene +
 * a root_event, so the bus must not assume a free re-run.
 */
export function distillObserver(deps) {
    const retryDelayMs = deps.retryDelayMs ?? 30_000;
    let inFlight;
    let pending = false; // a wakeup arrived while a drain was running — coalesce it into ONE trailing drain
    let retryTimer;
    let lastError;
    function trigger() {
        // Single-flight with coalesce: if a drain is running, REMEMBER the wakeup (pending); otherwise start one.
        if (inFlight) {
            pending = true;
            return;
        }
        // Wrap in an IIFE that AWAITS run(): even when run() settles synchronously (e.g. deps.distill() throws before
        // any real await), the `await` suspends, so `inFlight = …` is ASSIGNED before we clear it. Clearing inside
        // run()'s own finally would otherwise race the assignment, leave inFlight pointing at an already-settled
        // promise, and make flush()'s `while (inFlight) await inFlight` spin forever. Clear + retry live HERE (after
        // the await) so inFlight is undefined before scheduleRetry checks it.
        inFlight = (async () => {
            const stalled = await run();
            inFlight = undefined;
            if (stalled)
                scheduleRetry();
        })();
    }
    function scheduleRetry() {
        if (retryTimer || inFlight)
            return; // a retry/run is already coming
        retryTimer = setTimeout(() => { retryTimer = undefined; trigger(); }, retryDelayMs);
        retryTimer.unref?.(); // never keep the process alive solely for a pending retry
    }
    /** One drain cycle. Returns true if it STALLED on a stuck head (un-acked backlog), false if fully drained.
     *  Trailing edge: loops while wakeups arrive mid-drain so a coalesced wakeup is never dropped. Does NOT touch
     *  inFlight (the caller owns it — see trigger). */
    async function run() {
        let stalled = false;
        try {
            do {
                pending = false;
                stalled = Boolean(await deps.distill());
            } while (pending);
            lastError = undefined;
        }
        catch (e) {
            // A THROWN drain (e.g. store.list / readAll failed) is a transient failure that left the backlog un-drained
            // — treat it as stalled so a backoff retry is scheduled, same as an explicit stuck head. Without this a
            // throw would silently stop all draining until an unrelated future event.
            lastError = e;
            stalled = true;
        }
        return stalled;
    }
    const meta = {
        name: 'distill',
        eventTypes: [MATERIAL_READY_EVENT_TYPE],
        idempotent: false,
        timeoutMs: deps.timeoutMs ?? 30_000,
    };
    return {
        meta,
        handle(_event) {
            trigger(); // returns immediately (the drain runs in the background) so the bus never stalls on a slow drain
        },
        /** Await the drain chain to settle (a pending trailing drain may chain another) and re-throw its last error
         *  (graceful shutdown / tests) — so a broken drain is not silently swallowed when explicitly flushed. */
        async flush() {
            while (inFlight)
                await inFlight;
            if (lastError) {
                const e = lastError;
                lastError = undefined;
                throw e instanceof Error ? e : new Error(String(e));
            }
        },
        /** Whether a drain is currently in flight. */
        running() { return inFlight !== undefined; },
        /** Whether a backoff retry of a stalled drain is armed (introspection for tests / shutdown). */
        retryScheduled() { return retryTimer !== undefined; },
        /** Trigger an initial drain WITHOUT a material.batch_ready event — the daemon calls this once after
         *  registration so a process restart recovers any un-acked backlog (the in-memory backoff retry does not
         *  survive a restart). Same single-flight/coalesce/retry path as an event-driven wakeup. */
        kick() { trigger(); },
    };
}