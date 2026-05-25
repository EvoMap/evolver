'use strict';

const fs = require('fs');
const path = require('path');
const { PROXY_PROTOCOL_VERSION } = require('../mailbox/store');
const crypto = require('crypto');
const { hubFetch } = require('../../gep/hubFetch');
const { getEvomapPath } = require('../../gep/paths');

// Hub's nodeId regex; mirror of src/gep/a2aProtocol.js so a malformed
// legacy file can never feed garbage into the hello payload.
const NODE_ID_RE = /^node_[a-f0-9]{12,32}$/;

const DEFAULT_HEARTBEAT_INTERVAL = 360_000;
const HELLO_TIMEOUT = 15_000;
const HEARTBEAT_TIMEOUT = 10_000;
const MAX_REAUTH_ATTEMPTS = 2;
// First failure = 30 min, subsequent consecutive failures double up to ~4h.
// Without escalation a daemon stuck on a bad secret gets re-poked every 30
// minutes by inbound auth errors and fills the log forever.
const REAUTH_BACKOFF_BASE_MS = 30 * 60_000;
const REAUTH_BACKOFF_MAX_MS = 4 * 60 * 60_000;
// pokeHeartbeat() debounce window. Hub enforces ~6 heartbeats / 300s per
// sender (evomap-hub/src/routes/a2a/protocol.js); without a client-side
// throttle, pokes wired to user activity would 429 on busy proxies. A
// healthy node that has just ticked is skipped until this window passes;
// failing nodes (consecutiveFailures > 0 or active reauth backoff) bypass
// the throttle so recovery isn't blocked.
const POKE_THROTTLE_MS = 60_000;
// Wall-clock drift detector tuning. setTimeout is driven by libuv's
// monotonic clock, which does NOT advance while the host is suspended
// (macOS sleep, laptop lid close, hypervisor pause, debugger break, App
// Nap throttling). On wake, a pending 6-minute heartbeat timer that was
// queued seconds before sleep fires immediately, but the first 1-3 ticks
// usually fail because WiFi/DNS are still coming up; backoff then
// escalates to the 30-min cap and the node looks "dead" for up to 30
// minutes. A separate interval sampling Date.now() (which IS wall-clock,
// not monotonic) detects the suspension after-the-fact: a gap between
// samples larger than DRIFT_SLEEP_THRESHOLD_MS could not have happened
// during normal scheduling and means the process was suspended. We then
// pokeHeartbeat() to clear accumulated backoff and trigger a fresh check.
// Standard pattern in cron daemons / Electron / browser extensions.
const DRIFT_CHECK_MS = 30_000;
const DRIFT_SLEEP_THRESHOLD_MS = 90_000;

let _cachedFingerprint = null;
function _getEnvFingerprint() {
  if (_cachedFingerprint) return _cachedFingerprint;
  try {
    const { captureEnvFingerprint } = require('../../gep/envFingerprint');
    _cachedFingerprint = captureEnvFingerprint();
  } catch {
    _cachedFingerprint = {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
    };
  }
  return _cachedFingerprint;
}

// Recover a node_id persisted by the legacy GEP path
// (`src/gep/a2aProtocol.js` writes ~/.evomap/node_id, falling back to
// `<install>/.evomap_node_id` when the home dir isn't writable). Without
// this fallback, a daemon whose MailboxStore was created AFTER the legacy
// GEP file (any install upgrading from pre-lifecycle to lifecycle, or any
// state.json wiped without also wiping the legacy file) mints a fresh
// `node_${randomBytes(6)}` identity in hello(), which the hub registers
// as a *new* A2ANode under the same owner — the original (with stake,
// reputation, aliases) gets silently abandoned. Mirror the writer's two
// candidates in the same order as `_loadPersistedNodeId` so both code
// paths land on the single identity.
//
// Resolve both paths on every call:
//   - getEvomapPath() reads EVOLVER_HOME (and falls through to os.homedir())
//     at call time, so tests and privileged-drop daemons can flip the
//     resolved location without monkey-patching globals.
//   - The install-root path uses __dirname so it's stable across cwd changes.
function _readLegacyNodeId() {
  const candidates = [
    getEvomapPath('node_id'),
    path.resolve(__dirname, '..', '..', '..', '.evomap_node_id'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (NODE_ID_RE.test(raw)) return raw;
    } catch {
      // Unreadable / racing writer — try the next location.
    }
  }
  return null;
}

class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

class LifecycleManager {
  constructor({ hubUrl, store, logger, getTaskMeta } = {}) {
    this.hubUrl = (hubUrl || process.env.A2A_HUB_URL || '').replace(/\/+$/, '');
    this.store = store;
    this.logger = logger || console;
    this.getTaskMeta = getTaskMeta || null;
    this._heartbeatTimer = null;
    this._running = false;
    this._startedAt = null;
    this._consecutiveFailures = 0;
    this._reauthInProgress = false;
    this._helloRateLimitUntil = 0;
    this._reauthBackoffUntil = 0;
    this._consecutiveReauthFailures = 0;
  }

  get nodeId() {
    return this.store.getState('node_id');
  }

  get nodeSecret() {
    return this._resolveNodeSecret();
  }

  /**
   * Resolve the active node_secret with conflict reconciliation between the
   * persistent MailboxStore and `process.env.A2A_NODE_SECRET`.
   *
   * Two opposite failure modes shape this logic:
   *
   *   #529 (env-fresh, store-stale): operator exports a freshly minted
   *     secret in A2A_NODE_SECRET (e.g. from .env), but the MailboxStore
   *     still holds a long-stale value. The store value would otherwise
   *     win and produce a 403 -> rotate -> 30-min backoff loop.
   *
   *   "store-fresh, env-stale": process A rotates the secret via /a2a/hello,
   *     so the store holds the value the hub now recognises. Process A then
   *     restarts (typical: daemon respawn after upgrade or crash). The shell
   *     it inherits its env from still exports the *previous* value of
   *     A2A_NODE_SECRET. Without source-tracking we would treat this as
   *     env-vs-store conflict, env-wins, and silently overwrite the
   *     hub-recognised secret with a stale shell value -- exactly the loop
   *     #529 was meant to fix, just symmetrical.
   *
   * Resolution: track *who wrote* the store value. When the hub returns a
   * rotated secret (`hello`), we tag the store entry with
   * `node_secret_source = 'hub_rotate'`. On conflict we honour that tag:
   *
   *   source=hub_rotate -> store wins (recent rotation; env is stale)
   *   source missing/'env_seed' -> env wins (legacy / first-boot bootstrap)
   *
   * Single-source mode (only one of store/env present) is unchanged.
   * @returns {string|null}
   */
  _resolveNodeSecret() {
    const envSecret = this._suppressEnvSecret
      ? null
      : ((process.env.A2A_NODE_SECRET || '').trim() || null);
    const storeSecret = this.store.getState('node_secret') || null;
    const storeSource = this.store.getState('node_secret_source') || null;
    const valid = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s);

    if (envSecret && storeSecret && envSecret !== storeSecret) {
      // Store value came from a successful hub rotation -> trust it.
      // The env var is necessarily stale: it was captured by the parent
      // shell before the rotation and a child process cannot mutate it
      // back into its parent.
      if (storeSource === 'hub_rotate' && valid(storeSecret)) {
        if (!this._storeSourceLogged) {
          this._storeSourceLogged = true;
          this.logger.warn(
            '[lifecycle] A2A_NODE_SECRET env var differs from MailboxStore; ' +
              'store value originated from a hub rotation, treating env as stale. ' +
              'Run `evolver reset-local-secret` after a manual web reset, or ' +
              'unset A2A_NODE_SECRET to silence this warning.'
          );
        }
        return storeSecret;
      }
      if (valid(envSecret)) {
        this.store.setState('node_secret', envSecret);
        // Mark the new store value as env-seeded so a future rotation can
        // distinguish "operator pasted this in" from "hub returned this".
        this.store.setState('node_secret_source', 'env_seed');
        if (!this._envOverrideLogged) {
          this._envOverrideLogged = true;
          this.logger.warn(
            '[lifecycle] A2A_NODE_SECRET env var differs from MailboxStore; using env value and syncing store. ' +
              'Clear ~/.evomap/mailbox/state.json or unset A2A_NODE_SECRET to silence this warning.'
          );
        }
        return envSecret;
      }
      // env var malformed -- ignore it, fall back to store
      return storeSecret;
    }

    return storeSecret || envSecret || null;
  }

  _buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const secret = this.nodeSecret;
    if (secret) headers['Authorization'] = 'Bearer ' + secret;
    headers['x-correlation-id'] = crypto.randomUUID();
    return headers;
  }

  async hello({ rotateSecret = false } = {}) {
    if (!this.hubUrl) return { ok: false, error: 'no_hub_url' };

    if (this._helloRateLimitUntil > Date.now()) {
      const waitSec = Math.ceil((this._helloRateLimitUntil - Date.now()) / 1000);
      this.logger.warn(`[lifecycle] hello suppressed: rate limited for ${waitSec}s`);
      return { ok: false, error: 'hello_rate_limit_active', waitSec };
    }

    const endpoint = `${this.hubUrl}/a2a/hello`;
    const nodeId = this.store.getState('node_id')
      || _readLegacyNodeId()
      || `node_${crypto.randomBytes(6).toString('hex')}`;

    const payload = { capabilities: {} };
    if (rotateSecret) payload.rotate_secret = true;

    const fp = _getEnvFingerprint();

    const body = {
      protocol: 'gep-a2a',
      protocol_version: '1.0.0',
      message_type: 'hello',
      message_id: 'msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
      sender_id: nodeId,
      timestamp: new Date().toISOString(),
      payload,
      env_fingerprint: fp,
    };

    try {
      const res = await hubFetch(endpoint, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HELLO_TIMEOUT),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData?.error || `http_${res.status}`;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '3600', 10);
          this._helloRateLimitUntil = Date.now() + retryAfter * 1000;
          this.logger.error(`[lifecycle] hello rate limited (429): retry after ${retryAfter}s`);
          return { ok: false, error: 'hello_rate_limited', retryAfter };
        }
        this.logger.error(`[lifecycle] hello HTTP ${res.status}: ${errMsg}`);
        return { ok: false, error: errMsg, statusCode: res.status };
      }

      const data = await res.json();

      if (data?.payload?.status === 'rejected') {
        this.logger.error(`[lifecycle] hello rejected: ${data.payload.reason || 'unknown'}`);
        return { ok: false, error: data.payload.reason || 'hello_rejected', response: data };
      }

      const secret = data?.payload?.node_secret || data?.node_secret || null;
      if (secret && /^[a-f0-9]{64}$/i.test(secret)) {
        this.store.setState('node_secret', secret);
        // Tag the store entry so the next process that boots into a stale
        // shell env can recognise this value as hub-authoritative and
        // refuse to overwrite it (see _resolveNodeSecret above).
        this.store.setState('node_secret_source', 'hub_rotate');
        // Hub just handed us a fresh secret. Whatever sits in
        // A2A_NODE_SECRET is now older than the store, so suppress the
        // env-wins reconciliation in _resolveNodeSecret for the rest of
        // this process. Without this, the very next _buildHeaders call
        // (e.g. the verification heartbeat in reAuthenticate) would see
        // env vs store as a conflict, treat the env value as authoritative,
        // and overwrite the freshly rotated secret with the stale one,
        // re-creating the auth loop the previous patch fixed (see #529
        // and the Bugbot review on PR #22).
        this._suppressEnvSecret = true;
        this.logger.log('[lifecycle] new node_secret stored from hello response');
      }

      this.store.setState('node_id', nodeId);
      this.logger.log(`[lifecycle] hello OK, node_id=${nodeId}${rotateSecret ? ' (secret rotated)' : ''}`);
      return { ok: true, nodeId, response: data };
    } catch (err) {
      this.logger.error(`[lifecycle] hello failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Re-authenticate after 403: rotate secret via hello, then verify with a
   * heartbeat. Returns true if auth is restored, false otherwise.
   *
   * Recovery sequence (issue EvoMap/evolver#529):
   *   attempt 1 -> hello with current Bearer + rotate_secret=true
   *                (works when the stale secret is still recognised)
   *   attempt 2 -> drop the bearer locally, hello WITHOUT Authorization
   *                + rotate_secret=true. If the node is owned by someone
   *                else, hub returns node_id_already_claimed; we surface a
   *                manual-reset hint to the user instead of churning forever.
   */
  async reAuthenticate() {
    if (this._reauthInProgress) return false;
    if (this._reauthBackoffUntil > Date.now()) {
      const waitSec = Math.ceil((this._reauthBackoffUntil - Date.now()) / 1000);
      this.logger.warn(`[lifecycle] re-auth suppressed: backoff active for ${waitSec}s`);
      return false;
    }
    this._reauthInProgress = true;
    let manualResetRequired = false;
    try {
      for (let attempt = 1; attempt <= MAX_REAUTH_ATTEMPTS; attempt++) {
        this.logger.warn(`[lifecycle] re-auth attempt ${attempt}/${MAX_REAUTH_ATTEMPTS}: rotating secret via hello...`);
        const helloResult = await this.hello({ rotateSecret: true });
        if (!helloResult.ok) {
          this.logger.error(`[lifecycle] re-auth hello failed: ${helloResult.error}`);
          if (helloResult.error === 'hello_rate_limited' || helloResult.error === 'hello_rate_limit_active') break;
          if (typeof helloResult.error === 'string' && helloResult.error.startsWith('node_id_already_claimed')) {
            // Hub does not believe we own this nodeId. Our locally cached
            // secret(s) are useless. Drop them so attempt 2 retries WITHOUT
            // a Bearer (lenient hello path). If even unauthenticated rotate
            // is rejected, only a manual reset can recover.
            if (attempt < MAX_REAUTH_ATTEMPTS) {
              this._dropLocalSecret('node_id_already_claimed');
              continue;
            }
            manualResetRequired = true;
            break;
          }
          continue;
        }
        const newSecret = helloResult.response?.payload?.node_secret;
        if (!newSecret) {
          this.logger.error('[lifecycle] re-auth: hub did not return a new secret (rotate may not have taken effect)');
          break;
        }
        const hbResult = await this.heartbeat({ _skipReauth: true });
        if (hbResult.ok) {
          this.logger.log('[lifecycle] re-auth succeeded: heartbeat confirmed with new secret');
          this._consecutiveReauthFailures = 0;
          // Clear the pending backoff window too. Without this, a stale
          // _reauthBackoffUntil from a previous incident would still be in
          // the future when the next 401 arrives, causing the next call to
          // reAuthenticate() to short-circuit and refuse to try -- even
          // though we just proved auth is healthy.
          this._reauthBackoffUntil = 0;
          // Note: _envOverrideLogged is intentionally NOT reset here.
          // The successful hello path above already set _suppressEnvSecret=true,
          // which means _resolveNodeSecret will never hit the env-vs-store
          // conflict branch again in this process, so the warning would never
          // fire a second time anyway. Resetting the flag was misleading.
          return true;
        }
        this.logger.warn(`[lifecycle] re-auth attempt ${attempt}: heartbeat still failing after rotate`);
      }
      if (manualResetRequired) {
        this._emitManualResetNeeded();
      }
      this._consecutiveReauthFailures += 1;
      const backoffMs = Math.min(
        REAUTH_BACKOFF_BASE_MS * Math.pow(2, this._consecutiveReauthFailures - 1),
        REAUTH_BACKOFF_MAX_MS
      );
      const backoffMin = Math.round(backoffMs / 60_000);
      this.logger.error(
        `[lifecycle] re-auth exhausted all attempts (failure #${this._consecutiveReauthFailures}), ` +
          `backing off for ${backoffMin} minutes`
      );
      this._reauthBackoffUntil = Date.now() + backoffMs;
      return false;
    } finally {
      this._reauthInProgress = false;
    }
  }

  /**
   * Drop the cached node_secret in MailboxStore AND signal the env-var path to
   * skip its value for this process lifetime. Used when the hub explicitly
   * disowns our claim.
   * @param {string} reason - log tag describing why we are dropping it.
   */
  _dropLocalSecret(reason) {
    this.logger.warn(`[lifecycle] dropping cached node_secret (reason=${reason}); next hello will run unauthenticated`);
    try { this.store.setState('node_secret', ''); } catch { /* best-effort */ }
    // Clear the source tag too -- nothing is stored, nothing to attribute.
    try { this.store.setState('node_secret_source', ''); } catch { /* best-effort */ }
    // Suppress the env override for this process so _resolveNodeSecret stops
    // re-seeding the store with the same stale env value next call.
    this._suppressEnvSecret = true;
  }

  _emitManualResetNeeded() {
    try {
      this.store.writeInbound({
        type: 'system',
        priority: 'high',
        channel: 'evomap-hub',
        payload: {
          action: 'manual_secret_reset_required',
          message:
            'Hub disowns this node_id (node_id_already_claimed). Local node_secret in MailboxStore and A2A_NODE_SECRET env var are both invalid. Visit https://evomap.ai/account, click "Reset Secret" on the agent card, then update A2A_NODE_SECRET (or delete ~/.evomap/mailbox/state.json) and restart proxy.',
          docs_url: 'https://evomap.ai/account',
        },
      });
    } catch (err) {
      this.logger.warn(`[lifecycle] failed to emit manual_secret_reset_required event: ${err.message}`);
    }
  }

  async heartbeat({ _skipReauth = false } = {}) {
    if (!this.hubUrl) return { ok: false, error: 'no_hub_url' };

    // The try block must cover ALL of body assembly, not just the fetch.
    // Previously, this.nodeId / this.getTaskMeta() / this.store.countPending()
    // ran before `try {` -- any synchronous throw there (corrupt store, hook
    // raising, locked mailbox file) escaped heartbeat(), escaped the tick
    // closure in startHeartbeatLoop, and the next setTimeout(tick) was never
    // scheduled. Loop dead until daemon restart.
    try {
      const nodeId = this.nodeId;
      if (!nodeId) {
        const helloResult = await this.hello();
        if (!helloResult.ok) return helloResult;
      }

      const endpoint = `${this.hubUrl}/a2a/heartbeat`;
      const taskMeta = typeof this.getTaskMeta === 'function' ? this.getTaskMeta() : {};
      const fp = _getEnvFingerprint();
      const body = {
        node_id: this.nodeId,
        sender_id: this.nodeId,
        evolver_version: fp.evolver_version || PROXY_PROTOCOL_VERSION,
        env_fingerprint: fp,
        meta: {
          proxy_version: PROXY_PROTOCOL_VERSION,
          proxy_protocol_version: PROXY_PROTOCOL_VERSION,
          outbound_pending: this.store.countPending({ direction: 'outbound' }),
          inbound_pending: this.store.countPending({ direction: 'inbound' }),
          ...taskMeta,
        },
      };

      const res = await hubFetch(endpoint, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT),
      });

      if (res.status === 403 || res.status === 401) {
        this._consecutiveFailures++;
        const errText = await res.text().catch(() => '');
        this.logger.error(`[lifecycle] heartbeat auth failed (${res.status}): ${errText}`);
        if (!_skipReauth) {
          const recovered = await this.reAuthenticate();
          if (recovered) {
            this._consecutiveFailures = 0;
            return { ok: true, recovered: true };
          }
        }
        return { ok: false, error: `auth_failed_${res.status}`, statusCode: res.status };
      }

      if (!res.ok) {
        this._consecutiveFailures++;
        const errText = await res.text().catch(() => '');
        this.logger.error(`[lifecycle] heartbeat HTTP ${res.status}: ${errText}`);
        return { ok: false, error: `http_${res.status}`, statusCode: res.status };
      }

      const data = await res.json();

      this._consecutiveFailures = 0;
      this.store.setState('last_heartbeat_at', new Date().toISOString());

      if (data?.status === 'unknown_node') {
        this.logger.warn('[lifecycle] Node unknown, re-registering...');
        await this.hello();
      }

      if (Array.isArray(data?.events) && data.events.length > 0) {
        this.store.writeInboundBatch(
          data.events.map(e => ({
            type: e.type || 'hub_event',
            payload: e,
            channel: 'evomap-hub',
          }))
        );
      }

      if (data?.min_proxy_version && this._shouldUpgrade(data.min_proxy_version)) {
        this.store.writeInbound({
          type: 'system',
          payload: {
            action: 'proxy_upgrade_required',
            min_version: data.min_proxy_version,
            current_version: PROXY_PROTOCOL_VERSION,
            upgrade_url: data.upgrade_url || null,
            message: data.upgrade_message || 'Proxy version is below the minimum required by Hub.',
          },
          channel: 'evomap-hub',
          priority: 'high',
        });
        this.logger.warn(`[lifecycle] Hub requires proxy >= ${data.min_proxy_version}, current: ${PROXY_PROTOCOL_VERSION}`);
      }

      return { ok: true, response: data };
    } catch (err) {
      this._consecutiveFailures++;
      this.logger.error(`[lifecycle] heartbeat failed (${this._consecutiveFailures}): ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  startHeartbeatLoop(intervalMs) {
    if (this._running) return;
    this._running = true;
    this._startedAt = Date.now();
    this._tickInFlight = false;
    this._lastTickAt = 0;

    const interval = Math.max(30_000, intervalMs || DEFAULT_HEARTBEAT_INTERVAL);

    // Hoisted to this._tick so pokeHeartbeat() can re-enter the loop after
    // resetting backoff state without having to start a parallel loop.
    this._tick = async () => {
      if (!this._running) return;
      // Single-flight gate. Prevents pokeHeartbeat() (or any other re-entry)
      // from starting a parallel tick while one is mid-await. Two ticks
      // running concurrently would each schedule a setTimeout at the end
      // and the earlier timer reference would be leaked (and would still
      // fire later, fanning out into more parallel ticks).
      if (this._tickInFlight) return;
      this._tickInFlight = true;
      this._lastTickAt = Date.now();
      try {
        try {
          await this.heartbeat();
        } catch (err) {
          // Defense in depth. heartbeat() catches its own errors and returns
          // {ok:false}, but a future change that lets one slip through must
          // NOT silently kill the loop. Bump the failure counter so backoff
          // takes effect, then fall through (finally) to reschedule.
          this._consecutiveFailures++;
          // Wrap the logger call: if the logger transport itself throws,
          // we must not let it escape and skip the reschedule in finally.
          try {
            this.logger.error(
              `[lifecycle] heartbeat threw unexpectedly (${this._consecutiveFailures}): ${err && err.message || err}`,
            );
          } catch { /* logger blew up; loop must still survive */ }
        }
      } finally {
        // Reschedule lives in finally so NO failure path inside the try
        // (including the catch above) can drop us out of the loop. This
        // is the load-bearing invariant of issue #544 -- if this line is
        // ever skipped, the daemon goes offline until restart.
        this._tickInFlight = false;
        if (this._running) {
          const backoff = this._consecutiveFailures > 0
            ? Math.min(interval * Math.pow(2, this._consecutiveFailures), 30 * 60_000)
            : interval;
          this._heartbeatTimer = setTimeout(this._tick, backoff);
          if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
        }
      }
    };

    // Backstop in case tick ever throws synchronously before its own try.
    this._tick().catch(() => {});

    // Wall-clock drift detector. See DRIFT_* constants above for the
    // rationale. Uses Date.now() (wall-clock) because setTimeout fires on
    // libuv's monotonic clock and won't tell us the host was suspended.
    this._lastDriftCheckAt = Date.now();
    this._driftInterval = setInterval(() => {
      if (!this._running) return;
      const now = Date.now();
      const gap = now - this._lastDriftCheckAt;
      this._lastDriftCheckAt = now;
      if (gap > DRIFT_SLEEP_THRESHOLD_MS) {
        this.logger.warn(
          `[lifecycle] wall-clock jump detected (+${Math.round(gap / 1000)}s); ` +
            'likely sleep/wake or process suspension, poking heartbeat',
        );
        try { this.pokeHeartbeat(); } catch { /* never let the detector escape */ }
        return;
      }
      // Race recovery (task #14): on macOS wake the setInterval (this
      // detector) and the setTimeout (heartbeat tick) fire near-
      // simultaneously. If the tick enters first, _tickInFlight=true and
      // the detector's poke would no-op via the single-flight gate. That
      // post-wake tick almost always fails (WiFi/DNS not up yet), bumping
      // _consecutiveFailures to 1 and pushing the next scheduled tick out
      // to the backoff cap. By the next drift sample 30s later, the gap
      // test fails (~30s < 90s threshold) and no further poke fires --
      // the user is stuck in 12-30 min backoff even though network is up.
      //
      // Mitigation (Approach B from the review): if we already have a
      // recent failure AND it's been longer than 2*interval since the
      // last tick, poke again. The pokeHeartbeat throttle / in-flight
      // gate still protects healthy nodes (this branch never runs when
      // _consecutiveFailures === 0). Effective user-perceived recovery
      // time after a failed post-wake tick: ~30s (one drift-check
      // interval) instead of up to ~30 min.
      if (
        this._consecutiveFailures > 0
        && this._lastTickAt
        && (now - this._lastTickAt) > 2 * interval
      ) {
        this.logger.warn(
          `[lifecycle] persistent failure (${this._consecutiveFailures}) and no tick for ` +
            `${Math.round((now - this._lastTickAt) / 1000)}s; poking heartbeat`,
        );
        try { this.pokeHeartbeat(); } catch { /* never let the detector escape */ }
      }
    }, DRIFT_CHECK_MS);
    // Don't keep the event loop alive on behalf of the detector alone --
    // matches the unref() used on the heartbeat timer above.
    if (this._driftInterval.unref) this._driftInterval.unref();
  }

  stopHeartbeatLoop() {
    this._running = false;
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._driftInterval) {
      clearInterval(this._driftInterval);
      this._driftInterval = null;
    }
    // Clear the closure so a subsequent pokeHeartbeat() cleanly returns
    // false on its own check, not just via the _running guard. Keeps the
    // "noop if loop hasn't been started" docstring contract honest after
    // a stop.
    this._tick = null;
  }

  /**
   * Wake the heartbeat loop immediately. Clears accumulated loop-failure
   * backoff so subsequent failures start fresh, then fires one tick right
   * away if conditions allow.
   *
   * Throttling rules:
   *   - Returns false if the loop isn't running.
   *   - Returns true (no new tick) if a tick is already in flight -- that
   *     IS the liveness proof we wanted.
   *   - For a HEALTHY node (no consecutive failures, no active reauth
   *     backoff), the call is debounced to one tick per POKE_THROTTLE_MS
   *     so user-activity-triggered pokes can't bypass the hub's 6/300s
   *     per-sender heartbeat rate limit.
   *   - A node with a transient failure streak (consecutiveFailures > 0,
   *     OR _consecutiveReauthFailures < 2 with active reauth backoff)
   *     bypasses the throttle so recovery is never blocked.
   *   - A node DEEP in a reauth-failure streak (>= 2 consecutive reauth
   *     failures) still respects the throttle AND keeps its
   *     _reauthBackoffUntil intact. See below.
   *
   * Reauth backoff handling (issue #544 hot-loop fix):
   *   The HTTP middleware pokes on every authenticated request. If the hub
   *   has genuinely invalidated the secret (operator did "Reset Secret"
   *   in the account UI), every poke would otherwise wipe the 30-min
   *   _reauthBackoffUntil that reAuthenticate() just installed -> next
   *   user action would trigger another reAuth attempt (up to
   *   MAX_REAUTH_ATTEMPTS=2 /a2a/hello calls) -> the hub's per-IP 60/h
   *   hello rate limit would be exhausted in <30 minutes of typing. We
   *   gate the clear on _consecutiveReauthFailures < 2:
   *     - 1st/2nd failure: still let user activity drive a retry. The
   *       backoff was probably set against a transient hub blip and a
   *       fresh attempt is cheap.
   *     - >= 2 failures: the hub is genuinely-rejecting; the backoff is
   *       doing real work and user activity must not be able to wipe it.
   *
   * @returns {boolean} true if a tick is in flight or was kicked off.
   */
  pokeHeartbeat() {
    if (!this._running || !this._tick) return false;

    // Deep-failure nodes (>= 2 consecutive reauth failures) keep their
    // backoff intact and respect the throttle. wasFailing semantics here
    // mean "this poke is allowed to bypass the debounce", NOT "we cleared
    // backoff state". Loop-level failure counter is still always cleared
    // because the poke IS the user-driven retry signal we want to honor.
    const deepReauthFailure = this._consecutiveReauthFailures >= 2;
    const reauthBackoffActive = this._reauthBackoffUntil > Date.now();
    const wasFailing =
      this._consecutiveFailures > 0 || (reauthBackoffActive && !deepReauthFailure);
    this._consecutiveFailures = 0;
    if (!deepReauthFailure) {
      this._reauthBackoffUntil = 0;
    }

    if (this._tickInFlight) return true;

    if (!wasFailing) {
      const sinceLast = Date.now() - (this._lastTickAt || 0);
      if (this._lastTickAt && sinceLast < POKE_THROTTLE_MS) return false;
    }

    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._tick().catch(() => {});
    return true;
  }

  _shouldUpgrade(minVersion) {
    // parseInt strips trailing non-digit chars in prerelease segments like
    // `1-beta`, so `0.1.1-beta.1`.split('.')[2] -> `1-beta` -> parseInt = 1.
    // Using Number() here returned NaN and was treated as 0, under-counting
    // prerelease minimums. See community PR #516.
    const parse = (v) => String(v || '0.0.0').split('.').map((part) => parseInt(part, 10));
    const min = parse(minVersion);
    const cur = parse(PROXY_PROTOCOL_VERSION);
    for (let i = 0; i < 3; i++) {
      if ((cur[i] || 0) < (min[i] || 0)) return true;
      if ((cur[i] || 0) > (min[i] || 0)) return false;
    }
    return false;
  }
}

module.exports = { LifecycleManager, AuthError, DEFAULT_HEARTBEAT_INTERVAL };
