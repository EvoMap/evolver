import type { Observer } from './observerBus.js';
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
export declare const GENE_SET_CHANGE_EVENT_TYPES: readonly string[];
/** Default debounce window — a cycle emits several gene-set-change events in quick succession; coalesce them
 *  into a single rewrite rather than re-rendering the file once per event. */
export declare const DEFAULT_CURSOR_REWRITE_DEBOUNCE_MS = 2000;
export interface CursorRewriteObserverDeps {
    /**
     * Re-render `.cursor/rules/evolver.mdc` from the CURRENT top genes. Injected by the composition layer (it reads
     * the gene pool + writes the file). May return whether the file actually changed (for the optional change
     * callback); a void return is treated as "rewritten". Async is awaited so the bus's timeout/DLQ apply.
     */
    rewrite(): boolean | void | Promise<boolean | void>;
    /** Debounce window in ms (a burst of gene events ⇒ one rewrite). Default 2s. */
    debounceMs?: number;
    /** Injected clock (epoch ms). Default Date.now. */
    now?: () => number;
    /** Observer handle timeout — the bus quarantines on timeout. Default 5s (plenty for a local file render). */
    timeoutMs?: number;
    /** Optional: called after a rewrite that actually changed the file (the composition layer can emit value.inject
     *  here so the inject rail stays consistent across runtimes; deduped to "on real change" only). */
    onChange?: () => void | Promise<void>;
}
/**
 * Build the cursor rewrite observer. Subscribes to the gene-set-change event types only. On each such event it
 * (re)arms a debounce timer; when the timer fires it calls `rewrite()` once for the whole burst. Because the bus
 * dispatches asynchronously and the debounce is timer-based, the observer's own `handle` returns immediately
 * (just arming the timer) — the actual rewrite runs on the timer and reports its own errors to `onError`.
 *
 * idempotent=false: a rewrite has an external side effect (a file write), so the bus must not assume free re-run.
 */
export declare function cursorRewriteObserver(deps: CursorRewriteObserverDeps): Observer & {
    flush(): Promise<void>;
    pending(): boolean;
};