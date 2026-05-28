'use strict';

const { getEvomapPath } = require('../gep/paths');
const { MailboxStore } = require('./mailbox/store');
const { ProxyHttpServer } = require('./server/http');
const { buildRoutes } = require('./server/routes');
const { buildMessagesHandler } = require('./router/messages_route');
const { SyncEngine } = require('./sync/engine');
const { EventConsumer } = require('./sync/eventConsumer');
const { LifecycleManager } = require('./lifecycle/manager');
const { TaskMonitor } = require('./task/monitor');
const { SkillUpdater } = require('./extensions/skillUpdater');
const { DmHandler } = require('./extensions/dmHandler');
const { SessionHandler } = require('./extensions/sessionHandler');

// Lazy via paths.getEvomapPath() — honors EVOLVER_HOME (#114).
function _defaultDataDir() { return getEvomapPath('mailbox'); }

class EvoMapProxy {
  constructor(opts = {}) {
    this.hubUrl = (opts.hubUrl || process.env.A2A_HUB_URL || '').replace(/\/+$/, '');
    this.dataDir = opts.dataDir || opts.dbPath || _defaultDataDir();
    this.port = opts.port;
    this.logger = opts.logger || console;
    this._skillPath = opts.skillPath || null;
    this._anthropicBaseUrl = (opts.anthropicBaseUrl || process.env.EVOMAP_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

    this.store = null;
    this.server = null;
    this.sync = null;
    this.lifecycle = null;
    this.eventConsumer = null;
    this.taskMonitor = null;
    this.skillUpdater = null;
    this.dmHandler = null;
    this.sessionHandler = null;
    this._started = false;
  }

  async start() {
    if (this._started) throw new Error('Proxy already started');

    this.store = new MailboxStore(this.dataDir);

    this.lifecycle = new LifecycleManager({
      hubUrl: this.hubUrl,
      store: this.store,
      logger: this.logger,
      getTaskMeta: () => this.taskMonitor ? this.taskMonitor.getHeartbeatMeta() : {},
    });

    this.taskMonitor = new TaskMonitor({
      store: this.store,
      logger: this.logger,
    });

    this.skillUpdater = new SkillUpdater({
      store: this.store,
      skillPath: this._skillPath,
      logger: this.logger,
    });

    this.dmHandler = new DmHandler({
      store: this.store,
      logger: this.logger,
    });

    this.sessionHandler = new SessionHandler({
      store: this.store,
      logger: this.logger,
    });

    const getHeaders = () => this.lifecycle._buildHeaders();
    const taskMonitor = this.taskMonitor;

    this.sync = new SyncEngine({
      store: this.store,
      hubUrl: this.hubUrl,
      getHeaders,
      logger: this.logger,
      onAuthError: () => this.lifecycle.reAuthenticate(),
      onInboundReceived: () => {
        try { this.skillUpdater?.pollAndApply(); } catch (e) {
          this.logger?.warn?.('[proxy] skillUpdater.pollAndApply failed:', e.message);
        }
      },
      // #544 "sync alive but heartbeat dead": if the sync engine recovers
      // (inbound pull with data, or successful auth re-auth) the heartbeat
      // loop must be told so it can break out of exponential backoff.
      onLiveness: (_reason) => {
        try { this.lifecycle.pokeHeartbeat(); }
        catch (e) { this.logger?.warn?.('[sync] onLiveness poke failed:', e.message); }
      },
    });

    const proxyHandlers = {
      assetFetch: (body) => this._proxyHttp('/a2a/fetch', body),
      assetSearch: (body) => this._proxyHttp('/a2a/assets/search', body),
      assetValidate: (body) => this._proxyHttp('/a2a/validate', body),
      // ATP passthrough (#460 Bug 2): merchant/consumer flows that used to call
      // hub directly via src/atp/hubClient.js must route through the proxy when
      // EVOMAP_PROXY=1 so proxy sees the transaction (for audit + offline queue).
      atpPost: (endpoint, body) => this._proxyHttp(endpoint, body),
      atpGet: (endpoint, query) => this._proxyHttp(endpoint, null, { method: 'GET', query }),
    };

    const messagesHandler = buildMessagesHandler({
      anthropicProxy: (reqPath, body, opts) => this._proxyAnthropic(reqPath, body, opts),
      logger: this.logger,
    });

    const routes = buildRoutes(this.store, proxyHandlers, this.taskMonitor, {
      dmHandler: this.dmHandler,
      skillUpdater: this.skillUpdater,
      sessionHandler: this.sessionHandler,
      getHubMailboxStatus: () => this._getHubMailboxStatus(),
      messagesHandler,
    });

    const OUTBOUND_ROUTES = [
      'POST /mailbox/send',
      'POST /asset/submit',
      'POST /task/claim',
      'POST /task/complete',
      'POST /task/subscribe',
      'POST /task/unsubscribe',
      'POST /dm/send',
      'POST /session/create',
      'POST /session/join',
      'POST /session/leave',
      'POST /session/message',
      'POST /session/delegate',
      'POST /session/submit',
    ];
    for (const key of OUTBOUND_ROUTES) {
      const original = routes[key];
      if (!original) continue;
      routes[key] = async (ctx) => {
        const result = await original(ctx);
        this.sync.notifyNewOutbound();
        return result;
      };
    }

    this.server = new ProxyHttpServer(routes, {
      port: this.port,
      logger: this.logger,
      lifecycle: this.lifecycle,
    });

    const serverInfo = await this.server.start();

    if (this.hubUrl) {
      // F7: Previously this return value was discarded. If the very first
      // hello() returns ok=false (e.g. hub returns hello_rate_limited with
      // Retry-After 3600s, transient DNS failure, or hub returns a 5xx),
      // _helloRateLimitUntil gets set and the daemon then silently spins
      // for up to an hour with no user-visible signal -- every subsequent
      // tick re-enters hello() which short-circuits at the rate-limit gate.
      // Surface the failure: log it loudly AND write a system inbound the
      // dashboard can render so the user knows the daemon is wedged on
      // first-start rather than running normally.
      const helloResult = await this.lifecycle.hello();
      if (helloResult && helloResult.ok === false) {
        const reason = helloResult.error || 'unknown';
        const retryHint = helloResult.retryAfter
          ? ` (retry after ${helloResult.retryAfter}s)`
          : (helloResult.waitSec ? ` (waiting ${helloResult.waitSec}s)` : '');
        this.logger.error(
          `[proxy] First hello() failed: ${reason}${retryHint}. ` +
            'Daemon will keep retrying via the heartbeat loop, but external traffic may ' +
            'observe "evolver dead" until hello succeeds.'
        );
        try {
          this.store?.writeInbound({
            type: 'system',
            priority: 'high',
            channel: 'evomap-hub',
            payload: {
              action: 'first_hello_failed',
              reason,
              retry_after_sec: helloResult.retryAfter || helloResult.waitSec || null,
              message:
                `Initial handshake with hub failed (${reason}). Daemon is still running but ` +
                `the hub does not yet consider this node alive. If the cause is rate limiting, ` +
                `recovery is automatic once the window expires. If persistent, check A2A_HUB_URL ` +
                `and A2A_NODE_SECRET.`,
              docs_url: 'https://evomap.ai/account',
            },
          });
        } catch (_writeErr) { /* never block startup on the inbound write */ }
      }
      // keepAlive: proxy is a long-running daemon. The drift detector is
      // the recovery primitive after macOS sleep/wake and App Nap; if
      // unref'd, Node will deprioritise it under background coalescing
      // and the heartbeat can stay dead past wake. See manager.js
      // startHeartbeatLoop comment for the full rationale (#548 D2).
      this.lifecycle.startHeartbeatLoop(undefined, { keepAlive: true });
      this.sync.start();

      // Long-poll hub events. Independently of the heartbeat tick, this
      // proves auth+network are healthy every successful round-trip and
      // pokes the heartbeat loop. Survives macOS App Nap where setInterval
      // would not. EVOLVER_EVENT_POLL=0 disables. See sync/eventConsumer.js.
      if (String(process.env.EVOLVER_EVENT_POLL || '1') !== '0') {
        this.eventConsumer = new EventConsumer({
          hubUrl: this.hubUrl,
          lifecycle: this.lifecycle,
          logger: this.logger,
        });
        this.eventConsumer.start();
      }
    } else {
      this.logger.warn('[proxy] No A2A_HUB_URL set, running in offline/local mode');
    }

    this._started = true;

    return {
      url: serverInfo.url,
      port: serverInfo.port,
      nodeId: this.lifecycle.nodeId,
    };
  }

  async stop() {
    if (!this._started) return;
    if (this.eventConsumer) {
      try { await this.eventConsumer.stop(); } catch (_e) { /* never block shutdown */ }
    }
    this.sync?.stop();
    this.lifecycle?.stopHeartbeatLoop();
    await this.server?.stop();
    this.store?.close();
    this._started = false;
    this.logger.log('[proxy] stopped');
  }

  get mailbox() {
    return this.store;
  }

  async _proxyHttp(path, body, opts = {}) {
    if (!this.hubUrl) throw Object.assign(new Error('Hub not configured'), { statusCode: 503 });

    const method = (opts.method || 'POST').toUpperCase();
    const query = opts.query && typeof opts.query === 'object' ? opts.query : null;
    const timeoutMs = opts.timeoutMs || 30_000;

    let fullPath = path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const qsString = qs.toString();
      if (qsString) fullPath += (path.includes('?') ? '&' : '?') + qsString;
    }

    const endpoint = `${this.hubUrl}${fullPath}`;
    const init = {
      method,
      headers: this.lifecycle._buildHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(body || {});
    }

    const res = await fetch(endpoint, init);

    if (res.status === 403 || res.status === 401) {
      const recovered = await this.lifecycle.reAuthenticate();
      if (recovered) {
        const retryInit = {
          method,
          headers: this.lifecycle._buildHeaders(),
          signal: AbortSignal.timeout(timeoutMs),
        };
        if (method !== 'GET' && method !== 'HEAD') {
          retryInit.body = JSON.stringify(body || {});
        }
        const retry = await fetch(endpoint, retryInit);
        if (!retry.ok) {
          const text = await retry.text().catch(() => '');
          throw Object.assign(new Error(`Hub ${retry.status}: ${text}`), { statusCode: retry.status });
        }
        return retry.json();
      }
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`Hub ${res.status} (re-auth failed): ${text}`), { statusCode: res.status });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`Hub ${res.status}: ${text}`), { statusCode: res.status });
    }

    return res.json();
  }

  // Phase C slice 4 + token mediation: relay to api.anthropic.com. The
  // route layer applies router rewrite and decides stream vs. JSON; this
  // method forwards the request and exposes the response shape.
  //
  // Allowed forward headers (lowercased): x-api-key, anthropic-version,
  // and anything matching anthropic-* (anthropic-beta, etc.). Everything
  // else (host, authorization, cookie, content-length, ...) is dropped
  // so the inbound proxy-auth header never leaks upstream.
  //
  // Token mediation: the proxy server's `Authorization: Bearer <token>`
  // header is consumed by ProxyHttpServer for self-auth and stripped
  // here, so clients (e.g. Claude Code) can authenticate to the proxy
  // with `ANTHROPIC_AUTH_TOKEN=<proxy_token>` without losing the ability
  // to reach Anthropic upstream. When the client did not pass x-api-key,
  // the proxy substitutes its own ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
  // env var on the upstream request. Env is read per-request so creds
  // can be hot-swapped without restart, matching the EVOMAP_MODEL_*
  // policy in README.
  async _proxyAnthropic(reqPath, body, opts = {}) {
    const baseUrl = (opts.baseUrl || this._anthropicBaseUrl || '').replace(/\/+$/, '');
    const inbound = opts.inboundHeaders || {};
    const timeoutMs = opts.timeoutMs || 60_000;

    const fwd = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(inbound)) {
      if (v === undefined || v === null) continue;
      const lk = k.toLowerCase();
      if (lk === 'x-api-key' || lk === 'anthropic-version' || lk.startsWith('anthropic-')) {
        fwd[lk] = Array.isArray(v) ? v.join(', ') : String(v);
      }
    }

    if (!fwd['x-api-key']) {
      if (process.env.ANTHROPIC_API_KEY) {
        fwd['x-api-key'] = process.env.ANTHROPIC_API_KEY;
      } else if (process.env.ANTHROPIC_AUTH_TOKEN) {
        fwd['authorization'] = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
      }
    }

    const endpoint = `${baseUrl}${reqPath}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: fwd,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const headers = Object.fromEntries(res.headers.entries());
    const contentType = (headers['content-type'] || '').toLowerCase();
    const isStream = contentType.includes('text/event-stream');

    return {
      status: res.status,
      headers,
      stream: isStream ? res.body : null,
      json: isStream ? null : () => res.json(),
      text: () => res.text(),
    };
  }

  async _getHubMailboxStatus() {
    if (!this.hubUrl) return { error: 'Hub not configured' };
    const nodeId = this.lifecycle.nodeId;
    if (!nodeId) return { error: 'No node_id yet' };
    const endpoint = `${this.hubUrl}/a2a/mailbox/status?node_id=${encodeURIComponent(nodeId)}`;
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: this.lifecycle._buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { error: `Hub ${res.status}` };
      return res.json();
    } catch (err) {
      return { error: err.message };
    }
  }
}

async function startProxy(opts = {}) {
  const proxy = new EvoMapProxy(opts);
  const info = await proxy.start();
  return { proxy, ...info };
}

module.exports = { EvoMapProxy, startProxy };
