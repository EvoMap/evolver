'use strict';

const { OutboundSync } = require('./outbound');
const { InboundSync, DEFAULT_POLL_INTERVAL_ACTIVE, DEFAULT_POLL_INTERVAL_IDLE } = require('./inbound');
const { AuthError } = require('../lifecycle/manager');

const DEFAULT_OUTBOUND_INTERVAL = 5_000;
const IDLE_THRESHOLD = 5 * 60_000;

class SyncEngine {
  constructor({ store, hubUrl, getHeaders, logger, onInboundReceived, onAuthError }) {
    this.store = store;
    this.hubUrl = hubUrl;
    this.logger = logger || console;
    this.getHeaders = getHeaders;
    this.onInboundReceived = onInboundReceived || null;
    this.onAuthError = onAuthError || null;

    this.outbound = new OutboundSync({ store, hubUrl, getHeaders, logger });
    this.inbound = new InboundSync({ store, hubUrl, getHeaders, logger });

    this._outTimer = null;
    this._inTimer = null;
    this._running = false;
    this._lastActivity = Date.now();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastActivity = Date.now();
    this._scheduleOutbound(500);
    this._scheduleInbound(1_000);
    this.logger.log('[sync] engine started');
  }

  stop() {
    this._running = false;
    if (this._outTimer) { clearTimeout(this._outTimer); this._outTimer = null; }
    if (this._inTimer) { clearTimeout(this._inTimer); this._inTimer = null; }
    this.logger.log('[sync] engine stopped');
  }

  notifyNewOutbound() {
    this._lastActivity = Date.now();
    if (this._running && !this._outPending) {
      if (this._outTimer) clearTimeout(this._outTimer);
      this._scheduleOutbound(100);
    }
  }

  _isIdle() {
    return (Date.now() - this._lastActivity) > IDLE_THRESHOLD;
  }

  async _handleAuthError(source) {
    this.logger.error(`[sync] auth error from ${source}, triggering re-authentication`);
    if (typeof this.onAuthError === 'function') {
      try { await this.onAuthError(); } catch (e) {
        this.logger.error(`[sync] onAuthError callback failed: ${e.message}`);
      }
    }
  }

  // Same loop-killer bug class as #544 (heartbeat tick in lifecycle/manager.js).
  // Pre-fix shape:
  //   try { await flush() } catch { ... await _handleAuthError() ... }
  //   const next = store.countPending(...);  // OUTSIDE try; can throw
  //   this._scheduleOutbound(next);          // OUTSIDE try; never reached
  // A sqlite EBUSY from countPending (very real during macOS sleep/wake or
  // when the heartbeat manager writes concurrently), or a rejection from
  // the awaited _handleAuthError call inside catch, would escape and skip
  // the reschedule -- the outbound sync loop dies until the daemon
  // restarts, mailbox stops draining, "evolver dead" symptom.
  // Fix invariants:
  //   - Whole async body wrapped in try/finally.
  //   - Reschedule lives in finally; no failure path can skip it.
  //   - Defensive try/catch around _handleAuthError so its rejection
  //     cannot pull control out of the finally block.
  //   - countPending() call moved inside try.
  _scheduleOutbound(delayMs) {
    if (!this._running) return;
    this._outTimer = setTimeout(async () => {
      if (!this._running) return;
      this._outPending = true;
      let nextDelay = DEFAULT_OUTBOUND_INTERVAL;
      try {
        try {
          const result = await this.outbound.flush();
          if (result.sent > 0) this._lastActivity = Date.now();
        } catch (err) {
          if (err instanceof AuthError) {
            // _handleAuthError awaits an external callback that can itself
            // reject; without this guard the rejection would escape both
            // catches and skip the reschedule in finally.
            try { await this._handleAuthError('outbound'); }
            catch (e) {
              try { this.logger.error(`[sync] _handleAuthError(outbound) threw: ${e && e.message || e}`); }
              catch { /* logger blew up; loop must still survive */ }
            }
          } else {
            try { this.logger.error(`[sync] outbound error: ${err.message}`); }
            catch { /* logger blew up; loop must still survive */ }
          }
        }
        try {
          nextDelay = this.store.countPending({ direction: 'outbound' }) > 0
            ? 1_000
            : DEFAULT_OUTBOUND_INTERVAL;
        } catch (e) {
          try { this.logger.error(`[sync] countPending(outbound) threw: ${e && e.message || e}`); }
          catch { /* logger blew up; fall through to default delay */ }
          nextDelay = DEFAULT_OUTBOUND_INTERVAL;
        }
      } finally {
        this._outPending = false;
        // Load-bearing: this reschedule must run on every path. Issue #544
        // proved that letting it sit outside try/finally is a latent
        // daemon-killer.
        this._scheduleOutbound(nextDelay);
      }
    }, delayMs);
    if (this._outTimer.unref) this._outTimer.unref();
  }

  // Same fix shape as _scheduleOutbound; see comment block there.
  _scheduleInbound(delayMs) {
    if (!this._running) return;
    this._inTimer = setTimeout(async () => {
      if (!this._running) return;
      let nextDelay = DEFAULT_POLL_INTERVAL_ACTIVE;
      try {
        try {
          const result = await this.inbound.pull();
          if (result.received > 0) {
            this._lastActivity = Date.now();
            if (typeof this.onInboundReceived === 'function') {
              try { this.onInboundReceived(result.received); } catch (e) {
                try { this.logger.warn?.('[sync] onInboundReceived callback failed:', e.message); }
                catch { /* logger blew up; loop must still survive */ }
              }
            }
          }
          await this.inbound.ackDelivered();
        } catch (err) {
          if (err instanceof AuthError) {
            try { await this._handleAuthError('inbound'); }
            catch (e) {
              try { this.logger.error(`[sync] _handleAuthError(inbound) threw: ${e && e.message || e}`); }
              catch { /* logger blew up; loop must still survive */ }
            }
          } else {
            try { this.logger.error(`[sync] inbound error: ${err.message}`); }
            catch { /* logger blew up; loop must still survive */ }
          }
        }
        try {
          nextDelay = this._isIdle()
            ? DEFAULT_POLL_INTERVAL_IDLE
            : DEFAULT_POLL_INTERVAL_ACTIVE;
        } catch (e) {
          try { this.logger.error(`[sync] _isIdle() threw: ${e && e.message || e}`); }
          catch { /* logger blew up; fall through to default delay */ }
          nextDelay = DEFAULT_POLL_INTERVAL_ACTIVE;
        }
      } finally {
        this._scheduleInbound(nextDelay);
      }
    }, delayMs);
    if (this._inTimer.unref) this._inTimer.unref();
  }
}

module.exports = { SyncEngine, DEFAULT_OUTBOUND_INTERVAL };
