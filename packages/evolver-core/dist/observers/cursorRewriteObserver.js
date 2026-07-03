// Cursor rewrite observer (#124) — the observer-bus member that keeps cursor's injected gene memory FRESH.
//
// Cursor has no SessionStart hook (the CC/codex freshness mechanism): a cursor `alwaysApply:true` rule file is
// read as-is on every request, so there is no pull-at-start moment to re-render it. Freshness therefore comes
// from REWRITE-ON-CHANGE: when the gene set changes, we re-render .cursor/rules/evolver.mdc. This observer is
// the live trigger for that — it is hung off the SAME ObserverBus that fans out from the daemon's Ingestor, so a
// real cycle solidifying a gene (or a distill landing one) ticks it. It is the cursor analogue of the value
// digest observer: a side-effect hung off the bus, fully fault-isolated by the bus (a throwing rewrite
// quarantines the observer without ever touching the main write path).
//
// Boundaries: the observer owns ONLY the trigger policy (which events count as a gene-set change + debounce). It
// does NOT render or write the file itself — a `rewrite` callback is injected (the CLI composition layer wires
// it to the cursorRulesInstaller). So core stays free of fs/cursor knowledge and the observer is testable with a
// spy. Debounced so a burst of gene events (a cycle emits several) coalesces into ONE rewrite.
/**
 * Event types that mean "the APPROVED gene set the agent should see may have changed":
 *  - cycle.solidified / capsule.produced : a cycle solidified a gene — its learning history (and therefore the
 *    top-genes ordering) just moved. Emitted by the CycleEngine through the daemon's Ingestor → genuinely live.
 *  - actor.human.teach                   : a human taught a gene directly (`evolver distill`); it enters the pool
 *    UN-quarantined, so it is immediately part of the rendered set.
 *  - actor.human.review.approve          : a human approved a quarantined draft (`evolver review --approve`) — it
 *    now passes the read-side review gate (A2a), so the rendered set genuinely changed (A2b).
 * NOT subscribed: `gene.distilled`. An auto-distilled draft enters QUARANTINED, and the read side (A2a) withholds
 * it until approved — so re-rendering on distill would only ever be a no-op. The meaningful change is the APPROVE
 * above. Subscribing to this exact set (not all events) keeps the observer quiet on unrelated traffic.
 */
export const GENE_SET_CHANGE_EVENT_TYPES = [
    'cycle.solidified',
    'capsule.produced',
    'actor.human.teach',
    'actor.human.review.approve',
];
/** Default debounce window — a cycle emits several gene-set-change events in quick succession; coalesce them
 *  into a single rewrite rather than re-rendering the file once per event. */
export const DEFAULT_CURSOR_REWRITE_DEBOUNCE_MS = 2_000;
/**
 * Build the cursor rewrite observer. Subscribes to the gene-set-change event types only. On each such event it
 * (re)arms a debounce timer; when the timer fires it calls `rewrite()` once for the whole burst. Because the bus
 * dispatches asynchronously and the debounce is timer-based, the observer's own `handle` returns immediately
 * (just arming the timer) — the actual rewrite runs on the timer and reports its own errors to `onError`.
 *
 * idempotent=false: a rewrite has an external side effect (a file write), so the bus must not assume free re-run.
 */
export function cursorRewriteObserver(deps) {
    const debounceMs = deps.debounceMs ?? DEFAULT_CURSOR_REWRITE_DEBOUNCE_MS;
    const now = deps.now ?? (() => Date.now());
    let timer;
    let armedAt;
    let lastError;
    const meta = {
        name: 'cursor-rewrite',
        eventTypes: GENE_SET_CHANGE_EVENT_TYPES,
        idempotent: false,
        timeoutMs: deps.timeoutMs ?? 5_000,
    };
    // The actual rewrite, run once per coalesced burst. Swallows nothing on its own — but since it runs on a timer
    // (out of the bus's handle path) it cannot use the bus DLQ, so it records lastError for flush() to surface.
    async function fire() {
        timer = undefined;
        armedAt = undefined;
        try {
            const changed = await deps.rewrite();
            if (changed !== false && deps.onChange)
                await deps.onChange();
            lastError = undefined;
        }
        catch (e) {
            lastError = e;
        }
    }
    function arm() {
        armedAt = now();
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => { void fire(); }, debounceMs);
        // Do not keep the process alive solely for a pending rewrite (the daemon is resident anyway; tests exit).
        timer.unref?.();
    }
    return {
        meta,
        handle(_event) {
            // Just (re)arm the debounce — fast + non-blocking so the bus never stalls on a gene event.
            arm();
        },
        /** Force any pending debounced rewrite to run now and await it (graceful shutdown / tests). Re-throws the
         *  last rewrite error so a broken rewrite is not silently swallowed when explicitly flushed. */
        async flush() {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
                armedAt = undefined;
                await fire();
            }
            if (lastError) {
                const e = lastError;
                lastError = undefined;
                throw e instanceof Error ? e : new Error(String(e));
            }
        },
        /** Whether a rewrite is currently armed (debounce in flight). */
        pending() { return armedAt !== undefined; },
    };
}