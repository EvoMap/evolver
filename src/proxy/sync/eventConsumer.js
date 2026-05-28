'use strict';

// Long-polling event consumer for hub-provided AgentEvent stream.
//
// The hub exposes POST /a2a/events/poll (see evomap-hub
// src/routes/a2a/protocol.js) which hangs up to ~55s waiting for an
// AgentEvent targeted at this node (council_invite, work_assigned,
// task_available, ...). Before this consumer existed, evolver had no
// way to know about queued events except by happening to send a
// heartbeat within the 7-min Redis cache window.
//
// The motivating problem is broader than "deliver events promptly": the
// poll itself is a *partial* external liveness probe. A successful HTTP
// round-trip to /a2a/events/poll proves the network, TLS, and hub
// availability are working from the OUTBOUND direction, which is enough
// to know the heartbeat loop's failure (if any) is local and to wake it
// via lifecycle.pokeHeartbeat().
//
// Caveat -- NOT a fully independent auth channel:
//   The hub mounts both /a2a/events/poll and /a2a/heartbeat behind the
//   same middleware stack (evomap-hub _middleware.js:52-60): the same
//   captureNodeSecret + checkSenderBan + requireNodeSecret guards, the
//   same `badsec:` Redis cache, the same sender-ban list. If the hub
//   judges our node_secret invalid, BOTH endpoints return 403 in
//   lockstep -- the consumer cannot survive an auth failure that the
//   heartbeat loop also sees. We document this here rather than oversell
//   the consumer as a "fully independent liveness channel": it is a
//   recovery channel for transient transport / scheduler failures, not
//   for hub-side terminal auth states. For the latter,
//   `node_secret_invalid` from either endpoint deliberately fans out to
//   manual reset (see manager.js reAuthenticate terminal-rejection
//   short-circuit).
//
// Implementation notes:
//   - The loop is async (while+await), not setInterval. macOS App Nap
//     can suspend setInterval timers across a sleep/wake cycle without
//     re-firing them; an awaited fetch resumes naturally when libuv
//     resumes I/O after wake. This is the core reason this module
//     exists alongside the supervisor: it provides a recovery channel
//     that does not depend on setInterval semantics.
//   - Backoff is exponential on transport / 5xx errors, capped at 60s.
//     Success resets it. Auth errors (401/403) trigger a one-shot
//     reauth via the lifecycle and do not compound backoff.
//   - stop() aborts the in-flight fetch and wakes any pending sleep so
//     the loop exits within ms. Both abort and the running flag are
//     re-checked at each await boundary to avoid use-after-stop work.

const { hubFetch } = require('../../gep/hubFetch');

// F10: bumped from 30s -> 50s. Hub caps single pollEvents at 55s
// (evomap-hub/src/services/agentEventService.js:208-209), so 30s wasted
// roughly half of the available long-poll window and doubled the empty
// round-trip rate. 50s leaves a 5s margin for fetch overhead under
// FETCH_DEADLINE_PADDING_MS below.
const DEFAULT_POLL_TIMEOUT_MS = 50_000;
const FETCH_DEADLINE_PADDING_MS = 10_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const NODE_NOT_READY_RETRY_MS = 2_000;
// F8: tiny inter-poll pause on the success path. Hub rate-limits
// /a2a/events/poll at limit=4 windowMs=60_000 per sender
// (evomap-hub/src/routes/a2a/protocol.js:182). When events are queued,
// each round-trip returns immediately and we re-enter the loop with no
// delay; three events in 0-2s blew through the budget and the consumer
// then back-off-spun for 60s. A 250ms pause floors the cadence at
// ~4 polls/second worst case, well below the hub limit, while keeping
// event-delivery latency under 300ms.
const SUCCESS_PAUSE_MS = 250;

class EventConsumer {
  /**
   * @param {object} deps
   * @param {string} deps.hubUrl                  - Hub base URL (trailing slash trimmed).
   * @param {object} deps.lifecycle               - LifecycleManager instance (for pokeHeartbeat / reAuthenticate).
   * @param {object} [deps.logger]                - Logger with log/warn/error.
   * @param {function} [deps.getNodeId]           - () => string|null. Returns nodeId once hello completed.
   * @param {function} [deps.getHeaders]          - () => headers. Defaults to lifecycle._buildHeaders().
   * @param {function} [deps.onEvent]             - (event) => void, invoked per delivered event.
   * @param {function} [deps.fetchImpl]           - Override fetch (testing).
   * @param {number}   [deps.pollTimeoutMs]       - Long-poll wait passed to hub.
   */
  constructor({
    hubUrl,
    lifecycle,
    logger,
    getNodeId,
    getHeaders,
    onEvent,
    fetchImpl,
    pollTimeoutMs,
  } = {}) {
    this.hubUrl = (hubUrl || '').replace(/\/+$/, '');
    this.lifecycle = lifecycle || null;
    this.logger = logger || console;
    this._getNodeId = typeof getNodeId === 'function'
      ? getNodeId
      : () => (lifecycle && lifecycle.nodeId) || null;
    this._getHeaders = typeof getHeaders === 'function'
      ? getHeaders
      : () => (lifecycle && typeof lifecycle._buildHeaders === 'function'
        ? lifecycle._buildHeaders()
        : { 'Content-Type': 'application/json' });
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : hubFetch;
    this._pollTimeoutMs = typeof pollTimeoutMs === 'number' && pollTimeoutMs > 0
      ? pollTimeoutMs
      : DEFAULT_POLL_TIMEOUT_MS;

    this._running = false;
    this._abortCtrl = null;
    this._runPromise = null;
    this._backoffMs = MIN_BACKOFF_MS;
    this._wakeSleep = null;
    // Test hook: invoked after each loop iteration completes. Receives
    // { status: 'ok' | 'error' | 'auth' | 'no_node', detail }. Mirrors
    // LifecycleManager._onTickReschedule so tests can drive deterministic
    // assertions without polling timing.
    this._onIteration = null;
  }

  start() {
    if (this._running) return false;
    if (!this.hubUrl) {
      this.logger.warn?.('[eventConsumer] no hub URL configured; not starting');
      return false;
    }
    this._running = true;
    this._backoffMs = MIN_BACKOFF_MS;
    this._runPromise = this._loop().catch((e) => {
      this.logger.warn?.('[eventConsumer] loop exited unexpectedly: ' + (e && e.message || e));
    });
    return true;
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    // Wake any pending backoff sleep first so the loop body re-checks
    // _running and breaks before issuing a new fetch.
    if (this._wakeSleep) {
      try { this._wakeSleep(); } catch (_e) { /* noop */ }
      this._wakeSleep = null;
    }
    if (this._abortCtrl) {
      try { this._abortCtrl.abort(); } catch (_e) { /* noop */ }
    }
    if (this._runPromise) {
      try { await this._runPromise; } catch (_e) { /* noop */ }
      this._runPromise = null;
    }
  }

  async _loop() {
    while (this._running) {
      const nodeId = this._safeGetNodeId();
      if (!nodeId) {
        // Hello has not completed yet (typical at startup). Wait briefly
        // and retry; do not advance backoff -- this is expected state,
        // not a failure.
        this._notifyIteration({ status: 'no_node' });
        await this._sleep(NODE_NOT_READY_RETRY_MS);
        continue;
      }

      let res = null;
      let fetchErr = null;
      this._abortCtrl = new AbortController();
      // Deadline timer is a safety net for transports that ignore the
      // long-poll timeout we tell the hub about. Hub max wait is ~55s;
      // we abort a touch after our requested timeout to leave room for
      // the response itself to come back.
      const deadlineMs = this._pollTimeoutMs + FETCH_DEADLINE_PADDING_MS;
      const deadline = setTimeout(() => {
        try { this._abortCtrl?.abort(); } catch (_e) { /* noop */ }
      }, deadlineMs);
      if (deadline && typeof deadline.unref === 'function') deadline.unref();

      try {
        const endpoint = `${this.hubUrl}/a2a/events/poll`;
        const headers = this._safeGetHeaders();
        res = await this._fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            node_id: nodeId,
            timeout_ms: this._pollTimeoutMs,
          }),
          signal: this._abortCtrl.signal,
        });
      } catch (err) {
        fetchErr = err;
      } finally {
        clearTimeout(deadline);
        this._abortCtrl = null;
      }

      if (!this._running) break;

      if (fetchErr) {
        // Aborted by stop() -- exit cleanly.
        if (fetchErr.name === 'AbortError') break;
        const msg = fetchErr.message || String(fetchErr);
        this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS);
        this.logger.warn?.(
          `[eventConsumer] poll error: ${msg}; retrying in ${this._backoffMs}ms`,
        );
        this._notifyIteration({ status: 'error', error: msg });
        await this._sleep(this._backoffMs);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        // Auth failed. Defer to lifecycle's reauth state machine -- it
        // has hello rate limiting, rotate-on-secret-invalid logic, and a
        // watchdog for hung hello. Reset backoff so we re-poll promptly
        // once reauth completes.
        try {
          if (this.lifecycle && typeof this.lifecycle.reAuthenticate === 'function') {
            await this.lifecycle.reAuthenticate();
          }
        } catch (_e) { /* lifecycle watchdog handles hangs */ }
        this._backoffMs = MIN_BACKOFF_MS;
        this._notifyIteration({ status: 'auth', code: res.status });
        await this._sleep(MIN_BACKOFF_MS);
        continue;
      }

      if (!res.ok) {
        // Transient: 429 / 5xx / etc. Backoff and retry.
        this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS);
        this.logger.warn?.(
          `[eventConsumer] hub ${res.status}; retrying in ${this._backoffMs}ms`,
        );
        this._notifyIteration({ status: 'error', code: res.status });
        await this._sleep(this._backoffMs);
        continue;
      }

      // Success path. Reset backoff. The poll itself is the liveness
      // signal -- whether or not the response contains events, we just
      // proved network + auth + hub are healthy.
      this._backoffMs = MIN_BACKOFF_MS;

      let data = null;
      try { data = await res.json(); } catch (_e) { data = null; }
      const events = data && Array.isArray(data.events) ? data.events : [];

      // Wake the heartbeat loop BEFORE delivering events. If pokeHeartbeat
      // throws (it should not -- it has an internal try/catch -- but we
      // never trust it), event delivery still happens.
      try {
        if (this.lifecycle && typeof this.lifecycle.pokeHeartbeat === 'function') {
          this.lifecycle.pokeHeartbeat();
        }
      } catch (e) {
        this.logger.warn?.('[eventConsumer] pokeHeartbeat threw: ' + (e && e.message || e));
      }

      for (const evt of events) {
        try {
          this._onEvent(evt);
        } catch (e) {
          this.logger.warn?.('[eventConsumer] onEvent threw: ' + (e && e.message || e));
        }
      }

      this._notifyIteration({ status: 'ok', count: events.length });
      // F8: tiny pause before next poll. Keeps the steady-state cadence
      // safely under the hub's 4/min rate limit even when events arrive
      // back-to-back. _sleep is interruptible by stop() so shutdown is
      // not delayed.
      if (this._running) await this._sleep(SUCCESS_PAUSE_MS);
    }
  }

  _safeGetNodeId() {
    try { return this._getNodeId(); } catch (_e) { return null; }
  }

  _safeGetHeaders() {
    try {
      const h = this._getHeaders();
      return h && typeof h === 'object' ? h : { 'Content-Type': 'application/json' };
    } catch (_e) {
      return { 'Content-Type': 'application/json' };
    }
  }

  _notifyIteration(info) {
    if (typeof this._onIteration !== 'function') return;
    try { this._onIteration(info); } catch (_e) { /* test hook must never throw */ }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      if (!this._running) return resolve();
      const t = setTimeout(() => {
        this._wakeSleep = null;
        resolve();
      }, ms);
      if (t && typeof t.unref === 'function') t.unref();
      this._wakeSleep = () => {
        try { clearTimeout(t); } catch (_e) { /* noop */ }
        this._wakeSleep = null;
        resolve();
      };
    });
  }
}

module.exports = {
  EventConsumer,
  DEFAULT_POLL_TIMEOUT_MS,
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
};
