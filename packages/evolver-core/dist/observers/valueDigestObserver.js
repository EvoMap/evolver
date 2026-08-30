// Value digest observer (#113) — the observer bus's FIRST built-in observer. The bus has shipped (fault
// isolation + DLQ + timeout) with zero members; this is the first notification side-effect hung off it.
//
// What it does: on each dispatched event it asks "is a weekly digest due?" — and only when (a) at least the
// cadence has elapsed since the last delivery AND (b) this period produced MEASURED value does it build a digest
// and hand it to a pluggable sink. Everything else is a no-op. The cadence + the "measured value only" gate are
// the frequency controls the issue makes first-class ("宁可少触达，不可惹人烦").
//
// Boundaries: the observer NEVER derives savings itself — a `summaryProvider` is injected (the composition layer
// wires it to loadValueSummary over trace+events). The sink is injected too (file / MOTD / future webhook). The
// observer only orchestrates: cadence check → gate → format → deliver → record delivery. All side-effecting
// dependencies (clock, last-delivery state, sink) are injected so it is fully testable without real I/O.
import { buildValueDigest, digestShouldSend } from '../ops/valueOutreach.js';
/** In-memory state store (tests / ephemeral runs). Production injects a file-backed one. */
export class InMemoryDigestState {
    last;
    constructor(seed) { this.last = seed; }
    lastDeliveredAt() { return this.last; }
    markDelivered(at) { this.last = at; }
}
export const DEFAULT_DIGEST_CADENCE_MS = 7 * 24 * 60 * 60 * 1000; // weekly
export const DEFAULT_DIGEST_EXTRAS_TIMEOUT_MS = 1_000;
const DIGEST_EXTRAS_MAX_OBSERVER_BUDGET = 0.5;
/** 可选 enrichment 不得抑制有实测价值的 digest，也不得导致 observer 被隔离。 */
async function readDigestExtras(load, timeoutMs) {
    if (!load || timeoutMs <= 0)
        return {};
    return new Promise((resolve) => {
        let settled = false;
        const finish = (extras) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(extras);
        };
        const timer = setTimeout(() => finish({}), timeoutMs);
        Promise.resolve()
            .then(() => load())
            .then((extras) => finish(extras), () => finish({}));
    });
}
/** Period label "YYYY-MM-DD..YYYY-MM-DD" for the window [since, now). Deterministic given the two epochs. */
function periodLabel(sinceMs, nowMs) {
    const d = (ms) => new Date(ms).toISOString().slice(0, 10);
    return `${d(sinceMs)}..${d(nowMs)}`;
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
export function valueDigestObserver(deps) {
    const state = deps.state ?? new InMemoryDigestState();
    const now = deps.now ?? (() => Date.now());
    const cadenceMs = deps.cadenceMs ?? DEFAULT_DIGEST_CADENCE_MS;
    const observerTimeoutMs = deps.timeoutMs ?? 5_000;
    const configuredExtrasTimeout = deps.digestExtrasTimeoutMs ?? DEFAULT_DIGEST_EXTRAS_TIMEOUT_MS;
    const validExtrasTimeout = Number.isFinite(configuredExtrasTimeout) && configuredExtrasTimeout > 0
        ? Math.floor(configuredExtrasTimeout)
        : DEFAULT_DIGEST_EXTRAS_TIMEOUT_MS;
    const meta = {
        name: 'value-digest',
        idempotent: false,
        timeoutMs: observerTimeoutMs,
    };
    return {
        meta,
        async handle() {
            const observerStartedAt = Date.now();
            const t = now();
            const last = state.lastDeliveredAt();
            // 1. cadence gate.
            if (last !== undefined && t - last < cadenceMs)
                return;
            // 2. value gate — only a window WITH measured value is worth an unsolicited push.
            const since = t - cadenceMs;
            const window = { since: new Date(since).toISOString(), until: new Date(t).toISOString() };
            const summary = deps.summaryProvider(window);
            if (!digestShouldSend(summary))
                return; // zero-measured-value week → produce nothing
            const period = periodLabel(since, t);
            // 只允许可选 enrichment 使用剩余 observer 预算的一半，给摘要格式化和 sink 留出确定的余量。
            const elapsedMs = Math.max(0, Date.now() - observerStartedAt);
            const remainingObserverBudgetMs = Math.max(0, observerTimeoutMs - elapsedMs);
            const extrasBudget = Math.floor(remainingObserverBudgetMs * DIGEST_EXTRAS_MAX_OBSERVER_BUDGET);
            const digestExtrasTimeoutMs = Math.min(validExtrasTimeout, Math.max(0, extrasBudget));
            const extras = await readDigestExtras(deps.digestExtras, digestExtrasTimeoutMs);
            const markdown = buildValueDigest(summary, period, extras);
            if (markdown === null)
                return; // belt-and-suspenders: gate already passed, but never deliver a null
            // 3. deliver, then record the delivery time so the cadence advances. If the sink throws, the bus isolates
            // it (DLQ + quarantine) and the delivery time is NOT advanced, so a fixed sink retries next tick.
            await deps.sink.deliver(markdown, { period, at: new Date(t).toISOString() });
            state.markDelivered(t);
        },
    };
}