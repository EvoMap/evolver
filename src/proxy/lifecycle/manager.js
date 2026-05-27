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
// Floor for any hub-provided next_heartbeat_ms hint. Without this, a hub
// bug or misconfiguration that returns next_heartbeat_ms=0 would put us
// in a hot loop. 30s matches the existing floor applied to the
// caller-supplied intervalMs in startHeartbeatLoop.
const MIN_HEARTBEAT_INTERVAL = 30_000;
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
// Hung-tick watchdog. The fetch inside _tick is bounded by
// AbortSignal.timeout(HEARTBEAT_TIMEOUT=10s), but the AbortSignal can be
// ignored or fail to interrupt in pathological cases (TLS-level hang, a
// stuck kernel socket, a custom transport that doesn't honor abort). If
// _tickInFlight stays true forever, every subsequent pokeHeartbeat()
// early-returns at the in-flight gate and the loop is permanently dead.
// 60s sits comfortably above HEARTBEAT_TIMEOUT so we don't race a normal
// abort cycle while still rescuing the loop within one drift sample.
const TICK_HUNG_THRESHOLD_MS = 60_000;
// Reauth-hung watchdog. _reauthInProgress is set true at the top of
// reAuthenticate() and cleared only in the finally. If the inner hello()
// or heartbeat() returns a never-resolving promise (TLS-level hang where
// the AbortSignal is ignored, same failure class TICK_HUNG_THRESHOLD_MS
// guards against), the finally never runs and _reauthInProgress stays
// true forever. Every subsequent pokeHeartbeat() early-returns true at
// the reauth-in-progress gate without doing any work -- exact
// "I keep clicking but evolver is dead" symptom. Wrapping the body in
// Promise.race against this timeout lets the finally clear the latch
// even when the underlying fetch never settles. 60s mirrors
// TICK_HUNG_THRESHOLD_MS for the same "comfortably above the inner
// AbortSignal" reason.
const REAUTH_HUNG_THRESHOLD_MS = 60_000;
// Threshold for the drift-detector recovery branch. Keys off
// _lastTickSuccessAt (NOT attempt time): a node failing fast every 30s
// would keep its attempt timestamp fresh and the branch would never fire.
const TICK_SUCCESS_STALE_MS = 90_000;

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
    // Hub-provided next-tick hints. Set on a successful heartbeat
    // response that includes next_heartbeat_ms, cleared on failure paths
    // so the local backoff math takes over. Null = use the configured
    // interval / backoff math.
    this._lastHubNextHeartbeatMs = null;
    // Hub rate-limit hint from HTTP 429 Retry-After header / retry_after_ms
    // body. The reschedule logic floors the next delay to this value so we
    // never retry sooner than the hub asked. Cleared on the next
    // successful (non-429) response.
    this._hubRetryAfterMs = null;
    // Hub-provided heartbeat signals consumed in heartbeat()'s success
    // branch. resend_hello asks us to re-run hello() on the next tick (hub
    // lost the env fingerprint and wants a fresh handshake). force_update
    // says the hub considers this client below a hard version floor;
    // upgrade_available is a soft hint. The *_Logged flags dedupe the
    // user-facing warn/info so we never spam the same banner every 60s.
    this._resendHelloPending = false;
    this._forceUpdateRequired = false;
    this._forceUpdateLogged = false;
    this._upgradeAvailableLogged = false;
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
    // The inner async function holds the full reauth state machine. We
    // race it against REAUTH_HUNG_THRESHOLD_MS so a hung hello()/heartbeat()
    // promise that never settles cannot latch _reauthInProgress=true
    // forever. The underlying fetch promise may keep dangling in the
    // background (we cannot cancel a promise we don't own), but the state
    // machine releases for the next attempt -- which is the whole point:
    // every subsequent pokeHeartbeat() would otherwise no-op at the
    // reauth-in-progress gate. See REAUTH_HUNG_THRESHOLD_MS above.
    const run = async () => {
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
    };

    let watchdogTimer = null;
    const watchdog = new Promise((_, reject) => {
      watchdogTimer = setTimeout(
        () => reject(new Error('reauth_hung_timeout')),
        REAUTH_HUNG_THRESHOLD_MS,
      );
      // unref() so a still-pending watchdog never keeps the event loop
      // alive on its own (matches the unref pattern used elsewhere in
      // this file for heartbeat / drift timers).
      if (watchdogTimer && watchdogTimer.unref) watchdogTimer.unref();
    });

    try {
      return await Promise.race([run(), watchdog]);
    } catch (err) {
      if (err && err.message === 'reauth_hung_timeout') {
        this.logger.error(
          `[lifecycle] re-auth watchdog fired after ${Math.round(REAUTH_HUNG_THRESHOLD_MS / 1000)}s; ` +
            'releasing _reauthInProgress so subsequent pokes can drive recovery. ' +
            'Underlying hello/heartbeat fetch may still be pending in the background.',
        );
        return false;
      }
      // Inner state-machine throw (rare; hello/heartbeat normally return
      // {ok:false} instead of throwing). Bump the failure counter so the
      // backoff escalation tracks reality, and surface false.
      this.logger.error(`[lifecycle] re-auth threw unexpectedly: ${err && err.message || err}`);
      return false;
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
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

  async heartbeat({ _skipReauth = false, _abortSignal = null } = {}) {
    if (!this.hubUrl) return { ok: false, error: 'no_hub_url' };

    // Snapshot the tick generation on entry. After `await hubFetch` resumes,
    // a watchdog (_rescueHungTick) may have bumped _tickGeneration and
    // started a replacement tick. The zombie original must NOT mutate any
    // state (this._consecutiveFailures, reAuthenticate, last_heartbeat_at,
    // writeInboundBatch, proxy_upgrade_required emit). See issue #544
    // BUG-1: pre-fix, the generation check at _tick's finally only stopped
    // the zombie from rescheduling -- it still ran every post-await
    // mutation. We now re-check the generation before every mutation site.
    // When called outside the heartbeat loop (e.g. from reAuthenticate's
    // verification path, where _tickGeneration is undefined) the snapshot
    // and compare are both undefined and the guard is a no-op.
    const myHeartbeatGen = this._tickGeneration;
    const _isStaleGen = () => (
      myHeartbeatGen !== undefined && myHeartbeatGen !== this._tickGeneration
    );

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

      // Compose the per-tick AbortController (forwarded from _tick so the
      // watchdog can cancel a hung fetch) with the normal request timeout.
      // AbortSignal.any() resolves whichever fires first.
      const timeoutSignal = AbortSignal.timeout(HEARTBEAT_TIMEOUT);
      const signal = _abortSignal
        ? AbortSignal.any([_abortSignal, timeoutSignal])
        : timeoutSignal;

      const res = await hubFetch(endpoint, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal,
      });

      // Zombie guard. If a watchdog bumped _tickGeneration while we were
      // awaiting hubFetch, the replacement tick owns the state machine; we
      // must return without touching _consecutiveFailures, reAuthenticate,
      // last_heartbeat_at, or writeInboundBatch.
      if (_isStaleGen()) return null;

      if (res.status === 403 || res.status === 401) {
        this._consecutiveFailures++;
        // Auth failure: drop any stale hub next-heartbeat hint so the
        // local backoff math owns the reschedule cadence.
        this._lastHubNextHeartbeatMs = null;
        const errText = await res.text().catch(() => '');
        this.logger.error(`[lifecycle] heartbeat auth failed (${res.status}): ${errText}`);
        if (_isStaleGen()) return null;
        if (!_skipReauth) {
          const recovered = await this.reAuthenticate();
          if (_isStaleGen()) return null;
          if (recovered) {
            this._consecutiveFailures = 0;
            return { ok: true, recovered: true };
          }
        }
        return { ok: false, error: `auth_failed_${res.status}`, statusCode: res.status };
      }

      if (!res.ok) {
        this._consecutiveFailures++;
        // Hub returns HTTP 429 with Retry-After header (seconds) and
        // optional retry_after_ms in the JSON body when rate-limiting us
        // (evomap-hub/src/lib/rateLimitHints.js). Honor whichever is
        // present so we never retry sooner than the hub asked. Body wins
        // when both present (ms is more precise than seconds).
        if (res.status === 429) {
          let retryMs = null;
          try {
            const body = await res.clone().json().catch(() => null);
            if (body && typeof body.retry_after_ms === 'number' && body.retry_after_ms > 0) {
              retryMs = body.retry_after_ms;
            }
          } catch { /* body not JSON; fall back to header */ }
          if (retryMs === null) {
            const retryAfterHeader = res.headers.get('retry-after');
            const retryAfterSec = parseInt(retryAfterHeader || '', 10);
            if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
              retryMs = retryAfterSec * 1000;
            }
          }
          if (retryMs !== null) {
            this._hubRetryAfterMs = retryMs;
            this.logger.warn(
              `[lifecycle] heartbeat 429 from hub; honoring Retry-After=${Math.round(retryMs / 1000)}s`,
            );
          }
        }
        // Clear stale next-heartbeat hint -- failure response means the
        // local backoff math owns the next reschedule.
        this._lastHubNextHeartbeatMs = null;
        const errText = await res.text().catch(() => '');
        this.logger.error(`[lifecycle] heartbeat HTTP ${res.status}: ${errText}`);
        return { ok: false, error: `http_${res.status}`, statusCode: res.status };
      }

      const data = await res.json();

      if (_isStaleGen()) return null;

      this._consecutiveFailures = 0;
      // Successful (non-429) response: clear any pending hub rate-limit
      // hint -- the hub is no longer asking us to back off.
      this._hubRetryAfterMs = null;

      // Suspended status: hub considers this node terminally disabled
      // (admin disabled, secret revoked, etc. -- see
      // evomap-hub/src/services/a2aService.js). Bump the failure counter
      // (so backoff escalates) and surface a clear log pointing at the
      // operator-actionable URL, but do NOT write last_heartbeat_at -- the
      // node is not really live and stamping a fresh timestamp would mask
      // the terminal state from any tooling that watches it. The loop
      // continues so a manual un-suspend recovers on its own.
      if (data?.status === 'suspended') {
        this._consecutiveFailures++;
        this._lastHubNextHeartbeatMs = null;
        this.logger.warn(
          '[lifecycle] node is suspended on hub; check https://evomap.ai/account',
        );
        return { ok: false, suspended: true, error: 'node_suspended' };
      }

      this.store.setState('last_heartbeat_at', new Date().toISOString());

      // Snapshot the hub's next-heartbeat hint. Hub drops this to ~60s
      // when has_pending_events is true (see a2aService.js), so honoring
      // it bounds queued event delivery latency to the hub's preferred
      // cadence rather than DEFAULT_HEARTBEAT_INTERVAL (6 min). The
      // reschedule logic in _tick's finally consumes this if set.
      if (typeof data?.next_heartbeat_ms === 'number' && data.next_heartbeat_ms > 0) {
        this._lastHubNextHeartbeatMs = data.next_heartbeat_ms;
      } else {
        this._lastHubNextHeartbeatMs = null;
      }

      if (data?.status === 'unknown_node') {
        this.logger.warn('[lifecycle] Node unknown, re-registering...');
        await this.hello();
        if (_isStaleGen()) return null;
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

      // Hub-provided heartbeat signals (a2aService.js:6252-6317):
      //
      //   resend_hello       -- hub-side env fingerprint was missing for this
      //                         node; hub wants the client to re-run hello()
      //                         on the NEXT tick instead of another heartbeat,
      //                         so the fingerprint gets rebuilt. We just set
      //                         the latch here; _tick consumes it.
      //   force_update       -- hub considers this client below a hard
      //                         version floor. Surface loudly (once per
      //                         process) and record on the instance so other
      //                         subsystems can read state.
      //   upgrade_available  -- soft hint that a newer version exists. Log
      //                         once per process; no state mutation.
      //
      // All three use strict === true comparisons so a malformed value
      // (string "true", number 1, object) cannot trip the handlers and
      // cannot crash the loop. Each mutation site re-checks _isStaleGen()
      // so a zombie tick rescued by the watchdog never installs these
      // signals on top of the replacement tick's state.
      // Info-level helper. Some logger adapters expose `info`, others only
      // `log`. Prefer `info` when present (better severity routing); fall
      // back to `log`. Wrapped in try/catch so a broken transport cannot
      // escape this far into the success path and skip the return below.
      const _logInfo = (msg) => {
        try {
          const fn = typeof this.logger.info === 'function' ? this.logger.info : this.logger.log;
          if (typeof fn === 'function') fn.call(this.logger, msg);
        } catch { /* logger blew up; signal is best-effort */ }
      };

      if (data?.resend_hello === true) {
        if (_isStaleGen()) return null;
        this._resendHelloPending = true;
        _logInfo(
          '[lifecycle] hub requested resend_hello (reason=' + (data.resend_reason || 'unspecified') + ')',
        );
      }
      if (data?.force_update === true) {
        if (_isStaleGen()) return null;
        this._forceUpdateRequired = true;
        if (!this._forceUpdateLogged) {
          this._forceUpdateLogged = true;
          this.logger.warn(
            '[lifecycle] hub requires evolver upgrade (force_update). ' +
              'Heartbeats may be rejected soon. ' +
              'See https://github.com/EvoMap/evolver/releases',
          );
        }
      }
      if (data?.upgrade_available === true) {
        if (_isStaleGen()) return null;
        if (!this._upgradeAvailableLogged) {
          this._upgradeAvailableLogged = true;
          _logInfo(
            '[lifecycle] hub indicates upgrade available. ' +
              'See https://github.com/EvoMap/evolver/releases',
          );
        }
      }

      return { ok: true, response: data };
    } catch (err) {
      // Zombie guard for the catch path too. A rescued tick whose fetch
      // rejects with AbortError must NOT bump _consecutiveFailures -- the
      // replacement tick will record its own outcome.
      if (_isStaleGen()) return null;
      this._consecutiveFailures++;
      // Network throw or similar: drop any stale next-heartbeat hint so
      // the local backoff math takes over for the reschedule.
      this._lastHubNextHeartbeatMs = null;
      this.logger.error(`[lifecycle] heartbeat failed (${this._consecutiveFailures}): ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  startHeartbeatLoop(intervalMs) {
    if (this._running) return;
    this._running = true;
    this._startedAt = Date.now();
    this._tickInFlight = false;
    this._tickStartedAt = null;
    this._lastTickAttemptAt = 0;
    this._lastTickSuccessAt = null;
    // Generation counter to detect zombie ticks. Bumped by every watchdog
    // rescue (_rescueHungTick) so the original tick, when its hung fetch
    // finally resolves, sees a generation mismatch and bails without
    // rescheduling. Without this, a hung-tick rescue produces TWO concurrent
    // _tick invocations: the replacement (started by the rescuer) and the
    // zombie original (eventually resolved). Both would write _tickInFlight,
    // _heartbeatTimer, and _consecutiveFailures, fanning out into duplicate
    // timers and racing on backoff state.
    this._tickGeneration = 0;
    // Per-tick AbortController slot. Set by each _tick invocation, cleared
    // by that same invocation's finally; _rescueHungTick may abort the
    // current one to interrupt a hung hubFetch.
    this._inflightAbortController = null;

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
      const myGen = ++this._tickGeneration;
      this._tickInFlight = true;
      this._tickStartedAt = Date.now();
      this._lastTickAttemptAt = this._tickStartedAt;
      // Per-tick AbortController so _rescueHungTick can cancel a stuck
      // hubFetch and force the zombie heartbeat() into its catch path
      // promptly (rather than waiting up to a TLS-level keep-alive for
      // the underlying socket to close on its own). Stored on the
      // instance so the watchdog can reach it.
      const controller = new AbortController();
      this._inflightAbortController = controller;
      let tickResult = null;
      try {
        // Hub-requested handshake refresh (see heartbeat() success branch
        // where _resendHelloPending is set in response to data.resend_hello).
        // The hub lost our env fingerprint and wants a fresh hello() instead
        // of another heartbeat() this tick. Clear the latch FIRST so a
        // thrown hello cannot loop forever, then swallow any throw so the
        // loop survives -- mirrors the heartbeat() catch path below. We
        // leave tickResult=null intentionally so _lastTickSuccessAt is not
        // stamped: a successful hello is not the same liveness signal as a
        // successful heartbeat (the drift detector keys off heartbeats).
        if (this._resendHelloPending) {
          this._resendHelloPending = false;
          try {
            await this.hello({ reason: 'hub_requested_resend' });
          } catch (err) {
            try {
              this.logger.error(
                '[lifecycle] resend_hello attempt threw: ' + (err && err.message || err),
              );
            } catch { /* logger blew up; loop must still survive */ }
          }
        } else {
          try {
            tickResult = await this.heartbeat({ _abortSignal: controller.signal });
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
        }
      } finally {
        // Zombie check: if a watchdog rescued us mid-await by bumping
        // _tickGeneration, the rescuer is now the owner of the loop
        // (it cleared _tickInFlight and scheduled a fallback timer). The
        // zombie must NOT touch _tickInFlight, _heartbeatTimer, or
        // _consecutiveFailures -- doing so would either overwrite the
        // rescuer's replacement state or leak a duplicate setTimeout
        // (the prior reference, when overwritten, still fires later).
        if (this._tickGeneration !== myGen) return;
        // Reschedule lives in finally so NO failure path inside the try
        // (including the catch above) can drop us out of the loop. This
        // is the load-bearing invariant of issue #544 -- if this line is
        // ever skipped, the daemon goes offline until restart.
        if (tickResult && tickResult.ok === true) {
          this._lastTickSuccessAt = Date.now();
        }
        this._tickInFlight = false;
        this._tickStartedAt = null;
        // Clear only if still ours: a watchdog rescue may have replaced
        // the controller with a fresh one for the next tick.
        if (this._inflightAbortController === controller) {
          this._inflightAbortController = null;
        }
        if (this._running) {
          // Base delay decision tree:
          //   - Hub gave us next_heartbeat_ms on the last successful
          //     response -> honor it (floored to MIN_HEARTBEAT_INTERVAL).
          //     This lets the hub pull us in to 60s when there are
          //     pending events, instead of waiting the full 6 min for
          //     the next natural tick.
          //   - Otherwise: failures -> exponential backoff, else interval.
          let baseDelay;
          if (this._lastHubNextHeartbeatMs !== null && this._consecutiveFailures === 0) {
            baseDelay = Math.max(this._lastHubNextHeartbeatMs, MIN_HEARTBEAT_INTERVAL);
          } else if (this._consecutiveFailures > 0) {
            baseDelay = Math.min(interval * Math.pow(2, this._consecutiveFailures), 30 * 60_000);
          } else {
            baseDelay = interval;
          }
          // Honor any pending hub Retry-After hint. The hub asked us to
          // wait at least this long; never retry sooner. Cleared on the
          // next non-429 response.
          const finalDelay = this._hubRetryAfterMs !== null
            ? Math.max(baseDelay, this._hubRetryAfterMs)
            : baseDelay;
          this._scheduleNextTick(finalDelay, 'tick-finally');
        }
      }
    };

    // Backstop in case tick ever throws synchronously before its own try.
    this._tick().catch(() => {});

    // Wall-clock drift detector. See DRIFT_* constants above for the
    // rationale. Uses Date.now() (wall-clock) because setTimeout fires on
    // libuv's monotonic clock and won't tell us the host was suspended.
    this._lastDriftCheckAt = Date.now();
    // Outer try/catch wraps the whole callback. The inner try/catch around
    // pokeHeartbeat() already exists, but logger.warn / _rescueHungTick /
    // the arithmetic above them all sit outside it. A throw out of a
    // setInterval callback routes to process.on('uncaughtException'), so a
    // single bad log (file handle exhausted, transport error in a logger
    // adapter) could take down a daemon whose uncaughtException handler is
    // configured to exit. Containing the failure here keeps the detector
    // alive and the process safe; setInterval continues firing either way,
    // but we lose the work this tick would have done.
    this._driftInterval = setInterval(() => {
      try {
      if (!this._running) return;
      const now = Date.now();
      const gap = now - this._lastDriftCheckAt;
      this._lastDriftCheckAt = now;
      // Hung-tick rescue. The helper bumps _tickGeneration so the zombie
      // original tick bails on resolve, and schedules a fallback timer so
      // the loop survives even when the rest of the drift handler decides
      // not to fire a pokeHeartbeat().
      this._rescueHungTick('drift-detector', now);
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
      // Mitigation: if we already have a recent failure AND no successful
      // tick within TICK_SUCCESS_STALE_MS (~90s), poke again. We
      // deliberately key the staleness window to the drift-check cadence
      // (90s > 2 * DRIFT_CHECK_MS = 60s, comfortably above the noise) --
      // not to the configured heartbeat interval -- because the heartbeat
      // interval can be 6 min (DEFAULT_HEARTBEAT_INTERVAL), which would
      // push 2 * interval out to ~12 min and recreate the symptom this
      // fix exists to solve. The poke itself is throttled and single-
      // flighted, and this branch never runs when _consecutiveFailures
      // === 0, so healthy nodes are not affected. Effective user-
      // perceived recovery time after a failed post-wake tick: bounded
      // by TICK_SUCCESS_STALE_MS (~90s), two or three drift samples.
      if (
        this._consecutiveFailures > 0
        && (
          this._lastTickSuccessAt === null
          || (now - this._lastTickSuccessAt) > TICK_SUCCESS_STALE_MS
        )
      ) {
        const sinceSuccessMs = this._lastTickSuccessAt === null
          ? null
          : now - this._lastTickSuccessAt;
        this.logger.warn(
          `[lifecycle] persistent failure (${this._consecutiveFailures}) and no success for ` +
            `${sinceSuccessMs === null ? 'ever' : Math.round(sinceSuccessMs / 1000) + 's'}; poking heartbeat`,
        );
        try { this.pokeHeartbeat(); } catch { /* never let the detector escape */ }
      }
      } catch (driftErr) {
        // Outer guard: swallow any throw from log adapters, rescue helper,
        // or future additions so the setInterval callback never raises into
        // uncaughtException territory. See block comment above setInterval.
        try { this.logger.warn('[lifecycle] drift detector tick threw: ' + (driftErr && driftErr.message || driftErr)); }
        catch (_) { /* logger itself broken; nothing useful to do */ }
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
   * Force-reset a hung tick and ensure the loop has a scheduled timer
   * after the rescue.
   *
   * Two responsibilities, both critical:
   *
   * 1. Bump _tickGeneration so the zombie original tick, when its hung
   *    fetch eventually resolves, detects the generation mismatch in its
   *    finally and bails without rescheduling. Without this, the loop
   *    fans out into duplicate concurrent _tick invocations after every
   *    rescue, each writing _tickInFlight / _heartbeatTimer / _consecutive
   *    Failures and leaking timer references that still fire.
   *
   * 2. Schedule a short fallback timer so the loop never coasts to a halt
   *    when the rescuing path decides not to fire pokeHeartbeat (e.g. the
   *    drift detector found a hung tick but no wake event and no failure
   *    streak) or when pokeHeartbeat itself returns false for an unrelated
   *    reason (throttle, reauth-in-progress). The fallback is short
   *    (1s) so user-perceived recovery is bounded.
   *
   * @param {string} reason - log tag describing the rescue source.
   * @param {number} now - current wall-clock millis from the caller.
   * @returns {boolean} true if a rescue was performed.
   */
  _rescueHungTick(reason, now) {
    if (!this._tickInFlight || !this._tickStartedAt) return false;
    const heldMs = now - this._tickStartedAt;
    if (heldMs <= TICK_HUNG_THRESHOLD_MS) return false;
    this.logger.warn(
      `[lifecycle] tick hung for ${heldMs}ms (${reason}), force-resetting`,
    );
    // Abort the hung fetch BEFORE bumping the generation. Two reasons:
    //   1. Cancels the underlying request promptly so the zombie tick falls
    //      into its catch path instead of waiting for the socket to time
    //      out on its own (which can be minutes on a TLS-level hang).
    //   2. The zombie's catch path checks _tickGeneration against the
    //      snapshot it took on entry; the bump immediately below ensures
    //      that check fails and the catch is a no-op (no
    //      _consecutiveFailures bump from the synthetic AbortError).
    if (this._inflightAbortController) {
      try { this._inflightAbortController.abort(new Error('hung_tick_rescued')); }
      catch { /* abort throws on no listeners in some runtimes; best-effort */ }
      this._inflightAbortController = null;
    }
    this._tickInFlight = false;
    this._tickStartedAt = null;
    this._tickGeneration++;
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._running) {
      this._scheduleNextTick(1_000, 'rescue-fallback');
    }
    return true;
  }

  /**
   * Single funnel for every reschedule of the heartbeat tick. Three sites
   * call it: the normal `_tick` finally, `_rescueHungTick`'s 1s fallback,
   * and `pokeHeartbeat`'s throttle-window pull-in. Centralising the
   * setTimeout call lets tests subscribe to reschedules via the explicit
   * `_onTickReschedule(delayMs, reason)` hook without resorting to
   * fragile `setTimeout(fn).toString().includes('_tickInFlight')` sniffing
   * that breaks under minification or rename.
   *
   * @param {number} delayMs - milliseconds until next tick should fire.
   * @param {string} reason - log tag describing which reschedule site
   *   invoked this. Forwarded to the test hook for assertions.
   */
  _scheduleNextTick(delayMs, reason) {
    // Hook fires BEFORE setTimeout so a test stub can flag "the next
    // setTimeout call is the heartbeat reschedule" and chain it with a
    // 0-ms real timer. Without this ordering, the test would need to
    // resort to fn.toString() sniffing the setTimeout fn -- fragile under
    // minification or rename.
    if (typeof this._onTickReschedule === 'function') {
      try { this._onTickReschedule(delayMs, reason || 'unknown'); }
      catch { /* never let a test hook escape into production code paths */ }
    }
    this._heartbeatTimer = setTimeout(this._tick, delayMs);
    if (this._heartbeatTimer && this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  /**
   * Wake the heartbeat loop. Two distinct effects, separately gated:
   *
   *   1. State recovery (clearing _consecutiveFailures and, unless deep
   *      reauth failure, _reauthBackoffUntil). This does NOT hit the hub
   *      on its own -- it only affects the starting point of the next
   *      scheduled tick. Runs unconditionally once we know no liveness
   *      work is already in flight, so user activity can drive recovery
   *      even when the throttle blocks an immediate hub call.
   *
   *   2. Firing a fresh tick. This DOES hit the hub, so it is bounded by
   *      POKE_THROTTLE_MS. The earlier "wasFailing bypass" let high-
   *      frequency activity sources (a polling IDE hitting /mailbox/poll
   *      every 250ms) fan out into many ticks per second once each tick
   *      completed fast on a 401, exhausting the hub's 6/300s per-sender
   *      heartbeat budget. Bounding recovery to ~60s is fine -- the
   *      drift detector's race-recovery branch covers the post-wake
   *      case independently, and a throttled poke still reschedules the
   *      pending timer to fire when the throttle window opens.
   *
   * Reauth backoff handling:
   *   When the hub has genuinely invalidated the secret (operator did
   *   "Reset Secret" in the account UI), the 30-min _reauthBackoffUntil
   *   that reAuthenticate() just installed must NOT be wiped per-request.
   *   Gate the clear on _consecutiveReauthFailures < 2:
   *     - 1st/2nd failure: let user activity drive a retry. The backoff
   *       was probably set against a transient hub blip.
   *     - >= 2 failures: the hub is genuinely rejecting; the backoff is
   *       doing real work and user activity must not wipe it.
   *
   * Hung-rescue interaction: a rescue inside _rescueHungTick means we
   * just waited >=TICK_HUNG_THRESHOLD_MS (~60s) on a stuck tick, which is
   * past the throttle window anyway. Skip the throttle in that case so
   * the rescued poke can fire a fresh tick immediately.
   *
   * @returns {boolean} true if a tick is in flight, a reauth is in
   *   progress, or a fresh tick was kicked off. false if the loop is
   *   stopped, or the poke was throttled (state-clear may still have
   *   happened and the pending timer may have been pulled in).
   */
  pokeHeartbeat() {
    if (!this._running || !this._tick) return false;

    // Hung-tick rescue. The helper bumps _tickGeneration so the zombie
    // original tick bails on resolve, and schedules a 1s fallback timer
    // so the loop survives even if the rest of this function returns
    // without firing a fresh tick.
    const didRescue = this._rescueHungTick('pokeHeartbeat', Date.now());

    // The in-flight tick IS the liveness proof we wanted. Do NOT mutate
    // state here -- the running tick will record its own outcome, and
    // wiping _consecutiveFailures / _reauthBackoffUntil mid-await would
    // corrupt the failure history the backoff math depends on.
    if (this._tickInFlight) return true;

    // An active reauth (typically triggered by SyncEngine's onAuthError,
    // which does NOT set _tickInFlight) is ALSO liveness work. Firing a
    // parallel _tick here would just have heartbeat() call reAuthenticate
    // which sees _reauthInProgress=true and returns false -- recording a
    // spurious failure and pushing _consecutiveFailures up while the
    // original reauth is still running.
    if (this._reauthInProgress) return true;

    // State recovery (free, always applied): clear accumulated backoff
    // so the next tick -- whether it fires immediately below or via the
    // scheduled timer when the throttle releases -- starts clean.
    const deepReauthFailure = this._consecutiveReauthFailures >= 2;
    this._consecutiveFailures = 0;
    if (!deepReauthFailure) {
      this._reauthBackoffUntil = 0;
    }

    // Throttle gate: applies uniformly EXCEPT after a rescue (which has
    // already waited past the throttle window by construction).
    if (!didRescue) {
      const sinceLast = Date.now() - (this._lastTickAttemptAt || 0);
      if (this._lastTickAttemptAt && sinceLast < POKE_THROTTLE_MS) {
        // Pull the pending timer in to fire at the throttle window. The
        // previously-scheduled tick was using backoff math from the
        // (now-cleared) _consecutiveFailures, so its delay could be up
        // to 30 min. Bounding user-perceived recovery to ~60s.
        const waitMs = Math.max(0, POKE_THROTTLE_MS - sinceLast);
        if (this._heartbeatTimer) {
          clearTimeout(this._heartbeatTimer);
          this._heartbeatTimer = null;
        }
        this._scheduleNextTick(waitMs, 'poke-throttle');
        return false;
      }
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
