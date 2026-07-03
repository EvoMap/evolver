import type { Observer } from './observerBus.js';
import type { ValueSummary, SummaryWindow } from '../ops/valueLedger.js';
/** A delivery channel for a built digest. Local file + terminal MOTD to start; webhook/desktop later. */
export interface DigestSink {
    readonly name: string;
    deliver(markdown: string, meta: {
        period: string;
        at: string;
    }): void | Promise<void>;
}
/** Persists the last delivery time so the cadence survives restarts (the bus is in-process; weeks are not). */
export interface DigestStateStore {
    /** Epoch ms of the last delivery, or undefined if never delivered. */
    lastDeliveredAt(): number | undefined;
    /** Record a delivery at epoch ms. */
    markDelivered(at: number): void;
}
/** In-memory state store (tests / ephemeral runs). Production injects a file-backed one. */
export declare class InMemoryDigestState implements DigestStateStore {
    private last;
    constructor(seed?: number);
    lastDeliveredAt(): number | undefined;
    markDelivered(at: number): void;
}
export declare const DEFAULT_DIGEST_CADENCE_MS: number;
export interface ValueDigestObserverDeps {
    /** Aggregate the value summary for a window (composition wires this to loadValueSummary over trace+events). */
    summaryProvider(window: SummaryWindow): ValueSummary;
    /** Where a built digest goes. */
    sink: DigestSink;
    /** Cadence state (last-delivery persistence). Default in-memory (no persistence across process restarts). */
    state?: DigestStateStore;
    /** Injected clock (epoch ms). Default Date.now. */
    now?: () => number;
    /** Minimum interval between deliveries. Default weekly. */
    cadenceMs?: number;
    /** Observer handle timeout (the bus quarantines on timeout). Default 5s — plenty for format + a local sink. */
    timeoutMs?: number;
}
/**
 * Build the value-digest observer. Subscribes to ALL events (it is cadence-driven, not event-type-driven: any
 * event is just a "tick" that prompts the due-check). On each tick:
 *   1. cadence gate — skip unless `cadenceMs` has elapsed since the last delivery;
 *   2. value gate   — aggregate the past `cadenceMs` window and skip unless it has MEASURED value (digestShouldSend);
 *   3. deliver      — build the markdown digest and hand it to the sink, then record the delivery time.
 * The handler swallows nothing on its own — it lets the bus's fault isolation catch a throwing sink (so a broken
 * sink quarantines the observer without touching the main write path). idempotent=false: a delivery has an
 * external side effect (a file write / a printed MOTD), so the bus must not assume it can re-run it freely.
 */
export declare function valueDigestObserver(deps: ValueDigestObserverDeps): Observer;