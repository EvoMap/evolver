'use strict';

const { getEvomapPath } = require('../gep/paths');
const { MailboxStore } = require('./mailbox/store');
const { ProxyHttpServer } = require('./server/http');
const { buildRoutes } = require('./server/routes');
const { buildMessagesHandler, canonicalizeForBedrock, supportsAdaptiveThinking } = require('./router/messages_route');
const { ensureEnvelope } = require('./envelope');
const { buildResponsesHandler, buildChatCompletionsHandler } = require('./router/responses_route');
const { buildGeminiHandler } = require('./router/gemini_route');
const { buildModelsHandler } = require('./router/models_route');
const { buildOllamaHandler } = require('./router/ollama_route');
const { buildVertexHandler } = require('./router/vertex_route');
const { SyncEngine } = require('./sync/engine');
const { LifecycleManager } = require('./lifecycle/manager');
const { TaskMonitor } = require('./task/monitor');
const { SkillUpdater } = require('./extensions/skillUpdater');
const { DmHandler } = require('./extensions/dmHandler');
const { SessionHandler } = require('./extensions/sessionHandler');
const { TraceControl } = require('./extensions/traceControl');
const { backfillProxyTraceUploads } = require('./trace/extractor');
const { hubFetch, sanitizeHubResponseForLog } = require('../gep/hubFetch');

const TRACE_BACKFILL_DRAIN_MAX_PASSES = 8;
const TRACE_BACKFILL_STARTUP_DRAIN_MAX_MS = 250;
const TRACE_BACKFILL_RUNTIME_DRAIN_MAX_MS = 50;

// Lazy via paths.getEvomapPath() — honors EVOLVER_HOME (#114).
function _defaultDataDir() { return getEvomapPath('mailbox'); }

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_COMPATIBLE_BASE_URLS = Object.freeze({
  minimax: 'https://api.minimax.io/v1',
});
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

function isAllowedOpenAIHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'api.openai.com' || h.endsWith('.api.openai.com');
}

function resolveOpenAIBaseUrl(raw, { trustedOverride = false } = {}) {
  const value = String(raw || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  if (trustedOverride) return value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[proxy] EVOMAP_OPENAI_BASE_URL is not a valid URL');
  }

  const canonicalValue = `${parsed.origin}${parsed.pathname}`;
  const allowedCompatibleUrl = Object.values(OPENAI_COMPATIBLE_BASE_URLS).includes(canonicalValue);
  if (
    parsed.protocol !== 'https:'
    || (!isAllowedOpenAIHostname(parsed.hostname) && !allowedCompatibleUrl)
    || parsed.pathname !== '/v1'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('[proxy] EVOMAP_OPENAI_BASE_URL must be an OpenAI or known OpenAI-compatible https /v1 endpoint');
  }
  return value;
}

function makeOpenAIGatewayError(err, fallbackStatus = 502) {
  const name = err && err.name ? String(err.name) : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  const out = new Error(isTimeout ? 'openai upstream timed out' : 'openai upstream request failed');
  out.statusCode = isTimeout ? 504 : fallbackStatus;
  out.cause = err;
  return out;
}

function makeGeminiGatewayError(err, fallbackStatus = 502) {
  const name = err && err.name ? String(err.name) : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  const out = new Error(isTimeout ? 'gemini upstream timed out' : 'gemini upstream request failed');
  out.statusCode = isTimeout ? 504 : fallbackStatus;
  out.cause = err;
  return out;
}

function makeOllamaGatewayError(err, fallbackStatus = 502) {
  const name = err && err.name ? String(err.name) : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  const out = new Error(isTimeout ? 'ollama upstream timed out' : 'ollama upstream request failed');
  out.statusCode = isTimeout ? 504 : fallbackStatus;
  out.cause = err;
  return out;
}

function makeVertexGatewayError(err, fallbackStatus = 502) {
  const name = err && err.name ? String(err.name) : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  const out = new Error(isTimeout ? 'vertex upstream timed out' : 'vertex upstream request failed');
  out.statusCode = isTimeout ? 504 : fallbackStatus;
  out.cause = err;
  return out;
}

// The hub serves asset signal-search as `GET /a2a/assets/search` with query
// params (signals, status, limit, fields, domain); `signals`/`fields` are
// comma-separated lists. The proxy's public contract stays `POST /asset/search`
// with a JSON body, so we translate that body into the hub's query string here.
// Historically assetSearch forwarded as `POST /a2a/assets/search`, which the
// current hub rejects with `route_not_found` (it only matches the GET form).
function buildAssetSearchQuery(body = {}) {
  const query = {};
  const csv = (v) => (Array.isArray(v) ? v.join(',') : v);
  if (body.signals != null) query.signals = csv(body.signals);
  if (body.fields != null) query.fields = csv(body.fields);
  if (body.status != null) query.status = body.status;
  if (body.domain != null) query.domain = body.domain;
  if (body.limit != null) query.limit = body.limit;
  return query;
}

// Free-text path: `GET /a2a/assets/semantic-search?q=...` is the hub's vector
// similarity search. Unlike signal-search it takes ONE natural-language query
// string (the hub sanitizes it to <=200 chars) rather than a signal-keyword
// list, so a caller can ask "what asset fits my current situation?" in prose.
// The situation text rides in `q`; type / limit / fields forward the same way.
function buildSemanticSearchQuery(body = {}) {
  const query = { q: body.query };
  const csv = (v) => (Array.isArray(v) ? v.join(',') : v);
  if (body.fields != null) query.fields = csv(body.fields);
  if (body.type != null) query.type = body.type;
  if (body.limit != null) query.limit = body.limit;
  return query;
}

// Pick the hub endpoint for the proxy's `POST /asset/search` contract. A
// non-empty free-text `query` selects semantic-search (natural-language context
// match); anything else keeps the signal-keyword path byte-for-byte, so every
// existing signals-only caller is unaffected.
function planAssetSearch(body = {}) {
  const q = typeof body.query === 'string' ? body.query.trim() : '';
  if (q) {
    return {
      path: '/a2a/assets/semantic-search',
      query: buildSemanticSearchQuery({ ...body, query: q }),
    };
  }
  return { path: '/a2a/assets/search', query: buildAssetSearchQuery(body) };
}

// Asset-search client-side relief. The hub meters /a2a/assets/search per client
// IP, so an entire proxy fleet sharing one egress (plus the operator hitting it
// manually) collapses into a single bucket and 429s itself. We cache identical
// signal searches briefly, collapse concurrent duplicates into one request, and
// honour the hub's Retry-After so we stop hammering — and stop consuming the
// shared bucket — during a rate-limit window. Tunable via env for ops.
const ASSET_SEARCH_CACHE_TTL_MS = Number(process.env.EVOMAP_ASSET_SEARCH_CACHE_TTL_MS) || 30_000;
const ASSET_SEARCH_CACHE_MAX = Number(process.env.EVOMAP_ASSET_SEARCH_CACHE_MAX) || 256;
// How long a cached result may still be served as "stale" while we are in a
// rate-limit cooldown (better to return slightly-old discovery results than to
// fail the caller and fire a doomed request).
const ASSET_SEARCH_STALE_GRACE_MS = 5 * 60_000;

// Extract a retry delay (ms) from a hub 429 response: prefer the JSON body's
// ms-precision retry_after_ms (buildRateLimitBody), fall back to the RFC
// Retry-After header (seconds). Returns 0 when neither is present.
function parseRetryAfterMs(res, bodyText) {
  try {
    const body = bodyText ? JSON.parse(bodyText) : null;
    const ms = Number(body && body.retry_after_ms);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
  } catch { /* body is not JSON; fall through to the header */ }
  const secs = Number(res && res.headers && res.headers.get && res.headers.get('retry-after'));
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  return 0;
}

class EvoMapProxy {
  constructor(opts = {}) {
    // evolver#567: default to the canonical Hub URL (config.resolveHubUrl →
    // https://evomap.ai, honouring the A2A_HUB_URL / EVOMAP_HUB_URL /
    // EVOLVER_DEFAULT_HUB_URL precedence + https enforcement) instead of '',
    // so a freshly-launched proxy is Hub-connected out of the box after
    // `evolver login` rather than silently staying hub-less/offline (which
    // surfaced as 503 "Hub not configured" and node_id: null over MCP).
    // opts.hubUrl still overrides everything.
    const { resolveHubUrl } = require('../config');
    this.hubUrl = (opts.hubUrl || resolveHubUrl()).replace(/\/+$/, '');
    this.dataDir = opts.dataDir || opts.dbPath || _defaultDataDir();
    this.port = opts.port;
    this.logger = opts.logger || console;
    this.clientSettings = opts.clientSettings || null;
    this._skillPath = opts.skillPath || null;
    this._anthropicBaseUrl = (opts.anthropicBaseUrl || process.env.EVOMAP_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    this._openaiBaseUrl = String(opts.openaiBaseUrl || process.env.EVOMAP_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    this._geminiBaseUrl = String(opts.geminiBaseUrl || process.env.EVOMAP_GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
    this._ollamaBaseUrl = String(opts.ollamaBaseUrl || process.env.EVOMAP_OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    this._openaiBaseUrlTrusted = !!opts.openaiBaseUrl;

    this.store = null;
    this.server = null;
    this.sync = null;
    this.lifecycle = null;
    this.taskMonitor = null;
    this.skillUpdater = null;
    this.dmHandler = null;
    this.sessionHandler = null;
    this.traceControl = null;
    this._traceBackfillDraining = false;
    this._started = false;

    // Asset-search relief state (see ASSET_SEARCH_* constants above).
    this._searchCache = new Map();      // key -> { value, expiresAt, staleUntil }
    this._searchInflight = new Map();   // key -> Promise (concurrent dedup)
    this._searchCooldownUntil = 0;      // epoch ms; >now means hub rate-limited us
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

    this.traceControl = new TraceControl({
      store: this.store,
      logger: this.logger,
    });
    try { this.traceControl.pollAndApply(); } catch (e) {
      this.logger?.warn?.('[proxy] traceControl initial poll failed:', e.message);
    }

    const getHeaders = () => this.lifecycle._buildHeaders();
    const taskMonitor = this.taskMonitor;

    this.sync = new SyncEngine({
      store: this.store,
      hubUrl: this.hubUrl,
      getHeaders,
      logger: this.logger,
      onAuthError: () => this.lifecycle.reAuthenticate(),
      onOutboundFlushed: () => this._drainProxyTraceBackfill({
        maxMs: TRACE_BACKFILL_RUNTIME_DRAIN_MAX_MS,
      }),
      onInboundReceived: () => {
        try { this.skillUpdater?.pollAndApply(); } catch (e) {
          this.logger?.warn?.('[proxy] skillUpdater.pollAndApply failed:', e.message);
        }
        try { this.traceControl?.pollAndApply(); } catch (e) {
          this.logger?.warn?.('[proxy] traceControl.pollAndApply failed:', e.message);
        }
      },
    });

    const proxyHandlers = {
      // /a2a/fetch and /a2a/validate are strict GEP-A2A protocol endpoints:
      // the hub runs isValidProtocolMessage and rejects bare bodies
      // ({asset_ids: [...]}) with 400 invalid_protocol_message, so wrap them
      // in an envelope first. The GET search endpoints below are lenient REST
      // and take plain query params -- no envelope there.
      assetFetch: (body) => this._proxyHttp('/a2a/fetch', this._wrapA2a('fetch', body)),
      // GET (not POST). planAssetSearch() picks signal-search vs semantic-search
      // by whether the body carries a free-text `query` or a `signals` list.
      assetSearch: (body) => this._assetSearch(body),
      assetValidate: (body) => this._proxyHttp('/a2a/validate', this._wrapA2a('validate', body)),
      assetPublish: (body) => this._assetPublish(body),
      // Reuse-attribution report -> hub /a2a/memory/record. FLAT body (not an
      // envelope): the record endpoint reads sender_id/signals/used_asset_ids at
      // the top level, so this goes through _reportReuse (like the lenient REST
      // search path), not _wrapA2a.
      reportReuse: (body) => this._reportReuse(body),
      // ATP passthrough (#460 Bug 2): merchant/consumer flows that used to call
      // hub directly via src/atp/hubClient.js must route through the proxy when
      // EVOMAP_PROXY=1 so proxy sees the transaction (for audit + offline queue).
      atpPost: (endpoint, body) => this._proxyHttp(endpoint, body),
      atpGet: (endpoint, query) => this._proxyHttp(endpoint, null, { method: 'GET', query }),
    };

    const messagesHandler = buildMessagesHandler({
      // Provider dispatch: EVOMAP_UPSTREAM read per-request (matches the
      // hot-swap policy used for ANTHROPIC_API_KEY at line 266 below).
      // Default 'anthropic' keeps the existing path byte-for-byte; 'bedrock'
      // forwards via AWS Bedrock InvokeModel/InvokeModelWithResponseStream
      // and re-emits standard SSE so the client contract is unchanged.
      anthropicProxy: (reqPath, body, opts) => {
        // Mode is decided once per request in messages_route.js (the same
        // place the auth gate reads it), then passed in via opts.upstreamMode.
        // This makes the gate decision and the routing decision share one
        // env read, so a hot-swap of EVOMAP_UPSTREAM mid-request can't make
        // them disagree (e.g. gate skipped but request still hits Anthropic).
        const mode = opts?.upstreamMode || 'anthropic';
        return mode === 'bedrock'
          ? this._proxyBedrock(reqPath, body, opts)
          : this._proxyAnthropic(reqPath, body, opts);
      },
      logger: this.logger,
      traceStore: this.store,
      onTraceQueued: () => this.sync?.notifyNewOutbound(),
    });
    const responsesHandler = buildResponsesHandler({
      openAIProxy: (reqPath, body, opts) => this._proxyOpenAIResponses(reqPath, body, opts),
      logger: this.logger,
      traceStore: this.store,
      onTraceQueued: () => this.sync?.notifyNewOutbound(),
    });
    const geminiHandler = buildGeminiHandler({
      geminiProxy: (reqPath, body, opts) => this._proxyGemini(reqPath, body, opts),
      logger: this.logger,
      traceStore: this.store,
      onTraceQueued: () => this.sync?.notifyNewOutbound(),
    });
    const chatCompletionsHandler = buildChatCompletionsHandler({
      openAIProxy: (reqPath, body, opts) => this._proxyOpenAIResponses(reqPath, body, opts),
      logger: this.logger,
      traceStore: this.store,
      onTraceQueued: () => this.sync?.notifyNewOutbound(),
    });
    const modelsHandler = buildModelsHandler({
      // Models list goes straight to the native upstream (never bedrock — /v1/models is an Anthropic/OpenAI
      // API concept), so call the provider methods directly rather than the EVOMAP_UPSTREAM-aware closure.
      anthropicProxy: (reqPath, body, opts) => this._proxyAnthropic(reqPath, body, opts),
      openAIProxy: (reqPath, body, opts) => this._proxyOpenAIResponses(reqPath, body, opts),
      logger: this.logger,
    });
    const ollamaProxy = (reqPath, body, opts) => this._proxyOllama(reqPath, body, opts);
    const ollamaTraceOpts = { logger: this.logger, traceStore: this.store, onTraceQueued: () => this.sync?.notifyNewOutbound() };
    const ollamaChatHandler = buildOllamaHandler({ ollamaProxy, apiPath: '/api/chat', ...ollamaTraceOpts });
    const ollamaGenerateHandler = buildOllamaHandler({ ollamaProxy, apiPath: '/api/generate', ...ollamaTraceOpts });
    const vertexHandler = buildVertexHandler({
      vertexProxy: (reqPath, body, opts) => this._proxyVertex(reqPath, body, opts),
      logger: this.logger,
      traceStore: this.store,
      onTraceQueued: () => this.sync?.notifyNewOutbound(),
    });

    const routes = buildRoutes(this.store, proxyHandlers, this.taskMonitor, {
      dmHandler: this.dmHandler,
      skillUpdater: this.skillUpdater,
      sessionHandler: this.sessionHandler,
      getHubMailboxStatus: () => this._getHubMailboxStatus(),
      messagesHandler,
      responsesHandler,
      geminiHandler,
      chatCompletionsHandler,
      modelsHandler,
      ollamaChatHandler,
      ollamaGenerateHandler,
      vertexHandler,
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
      clientSettings: this.clientSettings,
    });

    const serverInfo = await this.server.start();

    if (this.hubUrl) {
      await this.lifecycle.hello();
      this.lifecycle.startHeartbeatLoop();
      this.sync.start();
    } else {
      this.logger.warn('[proxy] No A2A_HUB_URL set, running in offline/local mode');
    }

    this._drainProxyTraceBackfill({ maxMs: TRACE_BACKFILL_STARTUP_DRAIN_MAX_MS });

    this._started = true;

    return {
      url: serverInfo.url,
      port: serverInfo.port,
      nodeId: this.lifecycle.nodeId,
    };
  }

  _runProxyTraceBackfillPass() {
    try {
      return backfillProxyTraceUploads({
        store: this.store,
        logger: this.logger,
      });
    } catch (e) {
      this.logger.warn('[proxy] trace backfill failed:', e && e.message ? e.message : e);
      return { queued: 0, reasons: { thrown: 1 } };
    }
  }

  _drainProxyTraceBackfill({
    maxPasses = TRACE_BACKFILL_DRAIN_MAX_PASSES,
    maxMs = TRACE_BACKFILL_RUNTIME_DRAIN_MAX_MS,
  } = {}) {
    if (this._traceBackfillDraining) return { queued: 0, passes: 0, deferred: true };
    this._traceBackfillDraining = true;
    const started = Date.now();
    const total = {
      queued: 0,
      scanned: 0,
      skipped: 0,
      duplicates: 0,
      passes: 0,
      reasons: {},
    };
    try {
      for (let i = 0; i < maxPasses; i++) {
        const stats = this._runProxyTraceBackfillPass();
        total.passes += 1;
        total.queued += stats.queued || 0;
        total.scanned += stats.scanned || 0;
        total.skipped += stats.skipped || 0;
        total.duplicates += stats.duplicates || 0;
        for (const [reason, count] of Object.entries(stats.reasons || {})) {
          total.reasons[reason] = (total.reasons[reason] || 0) + count;
        }
        const madeProgress = (stats.scanned || 0) > 0
          || (stats.queued || 0) > 0
          || (stats.skipped || 0) > 0
          || (stats.duplicates || 0) > 0;
        if (!madeProgress) break;
        if (stats.reasons?.max_pending_uploads || stats.reasons?.max_enqueue_bytes
          || stats.reasons?.collection_disabled
          || stats.reasons?.missing_file || stats.reasons?.missing_store
          || stats.reasons?.read_failed || stats.reasons?.thrown) {
          break;
        }
        if (Date.now() - started >= maxMs) break;
      }
    } finally {
      this._traceBackfillDraining = false;
    }
    if (total.queued > 0) {
      this.logger.log('[proxy] queued ' + total.queued + ' existing proxy trace upload(s)');
      this.sync?.notifyNewOutbound();
    }
    return total;
  }

  async stop() {
    if (!this._started) return;
    // Tear down in deliberate reverse-of-start order, but don't let one
    // failing step abort the rest: a thrown sync.stop() must not leave the
    // HTTP server and store leaked. Each step is isolated; failures are
    // warned and collected so shutdown always completes.
    const steps = [
      ['sync', () => this.sync?.stop()],
      ['heartbeat', () => this.lifecycle?.stopHeartbeatLoop()],
      ['server', () => this.server?.stop()],
      ['store', () => this.store?.close()],
    ];
    const errors = [];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
        this.logger.warn('[proxy] error stopping ' + name + ': ' + (err && err.message ? err.message : err));
      }
    }
    this._started = false;
    if (errors.length) {
      this.logger.log('[proxy] stopped with ' + errors.length + ' teardown error(s)');
    } else {
      this.logger.log('[proxy] stopped');
    }
  }

  get mailbox() {
    return this.store;
  }

  // Wrap a bare body in a GEP-A2A envelope (pass-through if already one),
  // signing it with this proxy's node_id as sender_id so callers cannot
  // impersonate another node through the proxy.
  _wrapA2a(messageType, body) {
    return ensureEnvelope(messageType, body, this.store.getState('node_id'));
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

    const res = await hubFetch(endpoint, init);

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
        const retry = await hubFetch(endpoint, retryInit);
        if (!retry.ok) {
          const text = await retry.text().catch(() => '');
          throw Object.assign(new Error(`Hub ${retry.status}: ${sanitizeHubResponseForLog(text)}`), { statusCode: retry.status });
        }
        return retry.json();
      }
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`Hub ${res.status} (re-auth failed): ${sanitizeHubResponseForLog(text)}`), { statusCode: res.status });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = Object.assign(new Error(`Hub ${res.status}: ${sanitizeHubResponseForLog(text)}`), { statusCode: res.status });
      if (res.status === 429) err.retryAfterMs = parseRetryAfterMs(res, text);
      throw err;
    }

    return res.json();
  }

  // Build the hub asset-search plan with this node's identity attached, so the
  // hub's bulkFetchGuard / per-node metering attributes the call to the right
  // node instead of treating every fleet member as one anonymous IP. As with
  // _wrapA2a, we always stamp the proxy's OWN node_id (never a caller-supplied
  // one) so a client cannot attribute its searches to another node through the
  // proxy. node_id is advisory; the hub still gates on the Bearer node_secret.
  _planAssetSearchWithNode(body) {
    const plan = planAssetSearch(body);
    const nodeId = this.store && this.store.getState && this.store.getState('node_id');
    if (nodeId) plan.query = { ...plan.query, node_id: nodeId };
    return plan;
  }

  // Stable cache key: same path + same (order-independent) query params.
  _assetSearchCacheKey(plan) {
    const q = plan.query || {};
    const stable = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
    return `${plan.path}?${stable}`;
  }

  _cacheSearchResult(key, value, now) {
    // Bound memory: Map preserves insertion order, so the first key is oldest.
    if (this._searchCache.size >= ASSET_SEARCH_CACHE_MAX && !this._searchCache.has(key)) {
      const oldest = this._searchCache.keys().next().value;
      if (oldest !== undefined) this._searchCache.delete(oldest);
    }
    this._searchCache.delete(key); // re-insert to refresh recency
    this._searchCache.set(key, {
      value,
      expiresAt: now + ASSET_SEARCH_CACHE_TTL_MS,
      staleUntil: now + ASSET_SEARCH_CACHE_TTL_MS + ASSET_SEARCH_STALE_GRACE_MS,
    });
  }

  // Asset search with client-side relief: fresh-cache short-circuit, concurrent
  // dedup, and Retry-After-aware cooldown. Preserves the original return shape
  // and the 429 error contract so existing callers (and their "proceed on local
  // evidence" fallback) are unaffected.
  // Report which fetched assets the agent reused, so the hub credits their
  // authors (reuse-reward attribution). Unlike fetch/validate (strict GEP-A2A
  // envelopes), the hub's /a2a/memory/record reads a FLAT top-level body
  // ({sender_id, signals, status, used_asset_ids}); envelope-wrapping would bury
  // those under .payload and the record would 400. The proxy reports as its OWN
  // node -- the same node that fetched the asset -- so the hub's buildAttribution
  // finds the matching AssetFetcher row (cross-owner + GDI verified hub-side).
  // Declaration model, never server-inferred. Best-effort: a report failure
  // (insufficient credits, hub error) must never break the agent's session.
  // Kill-switch: EVOLVER_PROXY_REPORT_REUSE=0.
  async _reportReuse(body) {
    if (process.env.EVOLVER_PROXY_REPORT_REUSE === '0') {
      return { ok: false, reason: 'report_reuse_disabled' };
    }
    const nodeId = this.store.getState('node_id');
    if (!nodeId) return { ok: false, reason: 'no_node_id' };

    const b = body || {};
    const used = Array.isArray(b.used_asset_ids)
      ? b.used_asset_ids.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, 50)
      : [];
    if (used.length === 0) return { ok: false, reason: 'no_used_asset_ids' };

    let signals = Array.isArray(b.signals)
      ? b.signals.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 32)
      : [];
    if (signals.length === 0) signals = ['reused_via_mcp'];

    const flat = {
      sender_id: nodeId,
      signals,
      status: b.status === 'failed' ? 'failed' : 'success',
      used_asset_ids: used,
      ...(typeof b.score === 'number' ? { score: b.score } : {}),
    };

    try {
      const res = await this._proxyHttp('/a2a/memory/record', flat);
      return { ok: true, recorded: res && res.recorded, used_asset_ids: used };
    } catch (err) {
      this.logger?.warn?.(`[proxy] report-reuse failed: ${err.message}`);
      return { ok: false, reason: err.message, statusCode: err.statusCode };
    }
  }

  async _assetSearch(body) {
    const plan = this._planAssetSearchWithNode(body);
    const key = this._assetSearchCacheKey(plan);
    const now = Date.now();

    // Fresh cache hit — skip the network entirely.
    const cached = this._searchCache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    // Cooldown set by a prior 429: don't fire (it would only fail and burn more
    // of the shared bucket). Serve stale within grace if we have it; otherwise
    // surface a 429-shaped error so the caller's fallback kicks in with no
    // wasted round-trip.
    if (now < this._searchCooldownUntil) {
      if (cached && cached.staleUntil > now) return cached.value;
      throw Object.assign(new Error('Hub 429: rate_limited (client cooldown)'), {
        statusCode: 429,
        retryAfterMs: this._searchCooldownUntil - now,
        fromCooldown: true,
      });
    }

    // Collapse concurrent identical searches into one in-flight request.
    const inflight = this._searchInflight.get(key);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const value = await this._proxyHttp(plan.path, null, { method: 'GET', query: plan.query });
        this._cacheSearchResult(key, value, Date.now());
        return value;
      } catch (err) {
        if (err && err.statusCode === 429) {
          const retryAfterMs = Number(err.retryAfterMs) > 0 ? Number(err.retryAfterMs) : ASSET_SEARCH_CACHE_TTL_MS;
          this._searchCooldownUntil = Date.now() + retryAfterMs;
          if (this.logger && this.logger.warn) {
            this.logger.warn(`[proxy] asset search rate-limited by hub; cooling down ${Math.ceil(retryAfterMs / 1000)}s`);
          }
          // Prefer serving stale over failing the caller during cooldown.
          const stale = this._searchCache.get(key);
          if (stale && stale.staleUntil > Date.now()) return stale.value;
        }
        throw err;
      } finally {
        this._searchInflight.delete(key);
      }
    })();

    this._searchInflight.set(key, p);
    return p;
  }

  // Cross-agent / MCP publish. The legacy `evolver_publish_asset` path queued
  // an `asset_submit` mailbox message, but the Hub gated that off
  // (A2A_MAILBOX_ASSET_SUBMIT_ENABLED) and now enforces signed Gene+Capsule
  // bundles on POST /a2a/publish. Route loose asset submits through
  // buildPublishBundle so publishing actually reaches the Hub (single-asset
  // publish is rejected; the Hub quarantines new bundles for safety review).
  async _assetPublish(body) {
    const a2a = require('../gep/a2aProtocol');
    const nodeId = this.store && this.store.getState && this.store.getState('node_id');
    const rawAssets = Array.isArray(body.assets) ? body.assets : (body.asset ? [body.asset] : []);
    if (rawAssets.length === 0) {
      throw Object.assign(new Error('assets is required'), { statusCode: 400 });
    }
    const results = [];
    for (const raw of rawAssets) {
      try {
        const { gene, capsule } = this._buildBundleFromLooseAsset(raw);
        const msg = a2a.buildPublishBundle({ gene, capsule, nodeId });
        const res = await this._proxyHttp('/a2a/publish', msg);
        results.push({ ok: true, gene_asset_id: gene.asset_id, capsule_asset_id: capsule.asset_id, response: res });
      } catch (err) {
        results.push({ ok: false, error: err.message, statusCode: err.statusCode });
      }
    }
    return { published: results.filter(r => r.ok).length, total: results.length, results };
  }

  // Build a Hub-valid Gene+Capsule bundle from a loose MCP asset
  // ({type, content, summary, signals}). The Hub quality-gates genes (strategy
  // >=2 steps >=15 chars; sandboxable `node -e` validation) and requires a
  // companion capsule carrying substantive content; fill the structural
  // defaults and map the caller's content into strategy/content. Caller-
  // supplied strategy/validation/category/outcome win when present.
  _buildBundleFromLooseAsset(raw) {
    const crypto = require('crypto');
    const { SCHEMA_VERSION } = require('../gep/contentHash');
    const r = raw || {};
    const text = String(r.content || r.summary || '').trim();
    const signals = (Array.isArray(r.signals) && r.signals.length) ? r.signals
      : (Array.isArray(r.signals_match) && r.signals_match.length) ? r.signals_match : ['user_request'];
    // Gene strategy: the Hub requires >=2 actionable steps, each >=15 chars.
    // Enforce upfront (clean 400) rather than letting the Hub reject the publish.
    // Bugbot #256: caller-supplied short steps and a sub-50-char capsule content
    // previously slipped past the proxy and got rejected at the Hub instead.
    let strategy;
    if (Array.isArray(r.strategy) && r.strategy.length) {
      strategy = r.strategy.map((s) => String(s).trim()).filter((s) => s.length >= 15);
      if (strategy.length < 2) {
        throw Object.assign(new Error('publish: `strategy` needs >=2 steps, each >=15 chars (Hub quality gate).'), { statusCode: 400 });
      }
    } else {
      const steps = text.split(/[.\n;]+/).map((s) => s.trim()).filter((s) => s.length >= 15);
      if (steps.length >= 2) {
        strategy = steps.slice(0, 8);
      } else if (text.length >= 50) {
        strategy = [text.slice(0, 200), 'Validate the result before adopting the change'];
      } else {
        throw Object.assign(new Error('publish: provide `content` (>=50 chars) or a `strategy` of >=2 steps (each >=15 chars); the Hub quality-gates published genes.'), { statusCode: 400 });
      }
    }
    const VALID_CATEGORIES = ['repair', 'optimize', 'innovate', 'explore'];
    const schemaVersion = r.schema_version || SCHEMA_VERSION;
    const gid = r.gene_id || ('mcp_g_' + crypto.randomBytes(6).toString('hex'));
    const summary = r.summary || text.slice(0, 120) || 'manually published asset';
    // Capsule needs >=50 chars of substance (Hub gate); guarantee it upfront.
    const capsuleContent = text.length >= 50 ? text : (summary + ' — ' + strategy.join(' ')).trim();
    if (capsuleContent.length < 50) {
      throw Object.assign(new Error('publish: capsule content resolves to <50 chars; provide a longer `content` or `summary`.'), { statusCode: 400 });
    }
    const gene = {
      type: 'Gene', schema_version: schemaVersion, id: gid,
      category: VALID_CATEGORIES.includes(r.category) ? r.category : 'explore',
      summary,
      signals_match: signals,
      strategy,
      constraints: (r.constraints && typeof r.constraints === 'object') ? r.constraints : { max_files: 50, forbidden_paths: [] },
      validation: (Array.isArray(r.validation) && r.validation.length) ? r.validation : ['node -e "if (![1].length) process.exit(1)"'],
    };
    const capsule = {
      type: 'Capsule', schema_version: schemaVersion, id: 'mcp_c_' + crypto.randomBytes(6).toString('hex'),
      trigger: signals, gene: gid, summary,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
      blast_radius: { files: 1, lines: 1 },
      env_fingerprint: { platform: process.platform, arch: process.arch },
      outcome: (r.outcome && typeof r.outcome === 'object' && r.outcome.status) ? r.outcome : { status: 'success', score: 0.5 },
      content: capsuleContent,
    };
    // Redact PII/secrets before publish (Bugbot #256 High). Without client-side
    // sanitize, the Hub's server-side redaction rewrites the body and recomputes
    // a divergent asset_id, causing persistent roundtrip_missing. Sanitize before
    // buildPublishBundle stamps asset_id. Mirrors skill2gep's publish path.
    const { sanitizePayload } = require('../gep/sanitize');
    return { gene: sanitizePayload(gene), capsule: sanitizePayload(capsule) };
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
  // the proxy substitutes its own EVOMAP_ANTHROPIC_API_KEY /
  // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN env var on the upstream request.
  // Env is read per-request so creds
  // can be hot-swapped without restart, matching the EVOMAP_MODEL_*
  // policy in README.
  async _proxyAnthropic(reqPath, body, opts = {}) {
    const injectedUpstreamBaseUrl = process.env.EVOMAP_PROXY_AUTO_INJECTED === '1'
      ? process.env.EVOMAP_ANTHROPIC_BASE_URL
      : '';
    const baseUrl = (opts.baseUrl || injectedUpstreamBaseUrl || this._anthropicBaseUrl || '').replace(/\/+$/, '');
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
      const upstreamApiKey = process.env.EVOMAP_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (upstreamApiKey) {
        fwd['x-api-key'] = upstreamApiKey;
      } else {
        const upstreamAuthToken = process.env.EVOMAP_ANTHROPIC_AUTH_TOKEN
          || (process.env.EVOMAP_PROXY_AUTO_INJECTED === '1' ? '' : process.env.ANTHROPIC_AUTH_TOKEN);
        if (upstreamAuthToken) {
          fwd['authorization'] = `Bearer ${upstreamAuthToken}`;
        }
      }
    }

    const endpoint = `${baseUrl}${reqPath}`;
    const method = (opts.method || 'POST').toUpperCase();
    const init = { method, headers: fwd, signal: AbortSignal.timeout(timeoutMs) };
    if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body || {}); // GET (e.g. /v1/models) sends no body
    const res = await fetch(endpoint, init);

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

  // OpenAI Responses-compatible passthrough for Codex custom providers. The
  // proxy token is consumed by ProxyHttpServer and must never be forwarded as
  // upstream auth; the daemon supplies the real upstream key from env.
  async _proxyOpenAIResponses(reqPath, body, opts = {}) {
    const baseUrl = resolveOpenAIBaseUrl(opts.baseUrl || this._openaiBaseUrl || DEFAULT_OPENAI_BASE_URL, {
      trustedOverride: !!opts.baseUrl || this._openaiBaseUrlTrusted,
    });
    const inbound = opts.inboundHeaders || {};
    const timeoutMs = opts.timeoutMs || 60_000;

    const fwd = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(inbound)) {
      if (v === undefined || v === null) continue;
      const lk = k.toLowerCase();
      if (
        lk === 'openai-organization'
        || lk === 'openai-project'
        || lk === 'openai-beta'
        || lk.startsWith('x-stainless-')
      ) {
        fwd[lk] = Array.isArray(v) ? v.join(', ') : String(v);
      }
    }

    const upstreamKey = process.env.EVOMAP_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!upstreamKey) {
      const err = new Error('openai api key required');
      err.statusCode = 401;
      throw err;
    }
    if (upstreamKey) {
      fwd.authorization = `Bearer ${upstreamKey}`;
    }

    const endpoint = `${baseUrl}${reqPath}`;
    const abortController = new AbortController();
    const timeoutErr = new Error('openai upstream timed out');
    timeoutErr.name = 'TimeoutError';
    const abortTimer = setTimeout(() => abortController.abort(timeoutErr), timeoutMs);
    abortTimer.unref?.();
    const method = (opts.method || 'POST').toUpperCase();
    const init = { method, headers: fwd, signal: abortController.signal };
    if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body || {}); // GET (e.g. /models) sends no body
    let res;
    try {
      res = await fetch(endpoint, init);
    } catch (err) {
      clearTimeout(abortTimer);
      throw makeOpenAIGatewayError(err);
    }

    const headers = Object.fromEntries(res.headers.entries());
    const contentType = (headers['content-type'] || '').toLowerCase();
    const isStream = contentType.includes('text/event-stream');
    if (isStream) clearTimeout(abortTimer);

    const readText = async () => {
      try {
        return await res.text();
      } catch (err) {
        throw makeOpenAIGatewayError(err);
      } finally {
        clearTimeout(abortTimer);
      }
    };

    return {
      status: res.status,
      headers,
      stream: isStream ? res.body : null,
      json: isStream ? null : async () => JSON.parse(await readText()),
      text: isStream ? null : readText,
    };
  }

  // Gemini upstream (Google Generative Language API). Native passthrough — the model + action live in the path
  // (`/v1beta/models/<model>:generateContent` | `:streamGenerateContent`), not the body, so we forward reqPath
  // (incl. query like ?alt=sse) verbatim. Auth is the `x-goog-api-key` header (proxy-mediated). No translation:
  // a Gemini-shaped request goes to a Gemini upstream, same return contract as the other providers.
  async _proxyGemini(reqPath, body, opts = {}) {
    const baseUrl = (opts.baseUrl || this._geminiBaseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
    const inbound = opts.inboundHeaders || {};
    const timeoutMs = opts.timeoutMs || 60_000;

    const fwd = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(inbound)) {
      if (v === undefined || v === null) continue;
      const lk = k.toLowerCase();
      // Forward Gemini metadata headers; the api key is injected below (never trust the inbound one).
      if (lk === 'x-goog-user-project' || lk === 'x-goog-api-client' || lk.startsWith('x-goog-request-')) {
        fwd[lk] = Array.isArray(v) ? v.join(', ') : String(v);
      }
    }

    const upstreamKey = process.env.EVOMAP_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!upstreamKey) {
      const err = new Error('gemini api key required');
      err.statusCode = 401;
      throw err;
    }
    fwd['x-goog-api-key'] = upstreamKey;

    const endpoint = `${baseUrl}${reqPath}`;
    const abortController = new AbortController();
    const timeoutErr = new Error('gemini upstream timed out');
    timeoutErr.name = 'TimeoutError';
    const abortTimer = setTimeout(() => abortController.abort(timeoutErr), timeoutMs);
    abortTimer.unref?.();
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: fwd,
        body: JSON.stringify(body || {}),
        signal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(abortTimer);
      throw makeGeminiGatewayError(err);
    }

    const headers = Object.fromEntries(res.headers.entries());
    const contentType = (headers['content-type'] || '').toLowerCase();
    // `:streamGenerateContent` IS a stream regardless of content-type: with ?alt=sse it is text/event-stream,
    // but the DEFAULT (no alt=sse) is a chunked JSON-array stream served as application/json. Detecting only by
    // content-type would buffer + JSON.parse that array stream and hand the client a broken {error:...} wrapper
    // instead of a live stream. Forward the body as a stream whenever the action is streamGenerateContent.
    const isStream = contentType.includes('text/event-stream') || /:streamGenerateContent(\b|\?|$)/.test(reqPath);
    if (isStream) clearTimeout(abortTimer);

    const readText = async () => {
      try {
        return await res.text();
      } catch (err) {
        throw makeGeminiGatewayError(err);
      } finally {
        clearTimeout(abortTimer);
      }
    };

    return {
      status: res.status,
      headers,
      stream: isStream ? res.body : null,
      json: isStream ? null : async () => JSON.parse(await readText()),
      text: isStream ? null : readText,
    };
  }

  // Ollama native passthrough (local model server). Native paths /api/chat | /api/generate, body carries the
  // model + `stream` flag. Ollama is typically local with no auth; forward verbatim to EVOMAP_OLLAMA_BASE_URL
  // (default 127.0.0.1:11434). Optional bearer for a remote/protected Ollama via EVOMAP_OLLAMA_API_KEY. Streaming
  // is newline-delimited JSON (NDJSON), not SSE — content-type application/json + chunked. No translation.
  async _proxyOllama(reqPath, body, opts = {}) {
    const baseUrl = (opts.baseUrl || this._ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs || 60_000;
    const fwd = { 'content-type': 'application/json' };
    const upstreamKey = process.env.EVOMAP_OLLAMA_API_KEY || '';
    if (upstreamKey) fwd.authorization = `Bearer ${upstreamKey}`;

    const endpoint = `${baseUrl}${reqPath}`;
    const abortController = new AbortController();
    const timeoutErr = new Error('ollama upstream timed out');
    timeoutErr.name = 'TimeoutError';
    const abortTimer = setTimeout(() => abortController.abort(timeoutErr), timeoutMs);
    abortTimer.unref?.();
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: fwd, body: JSON.stringify(body || {}), signal: abortController.signal });
    } catch (err) {
      clearTimeout(abortTimer);
      throw makeOllamaGatewayError(err);
    }

    const headers = Object.fromEntries(res.headers.entries());
    // Ollama streams when the request body has stream:true (default true). The reply is chunked NDJSON
    // (application/json), not SSE, so detect by the request flag, not content-type — buffering a stream would
    // break the client. Non-stream (stream:false) returns a single JSON object.
    const isStream = !(body && body.stream === false);
    if (isStream) clearTimeout(abortTimer);

    const readText = async () => {
      try { return await res.text(); } catch (err) { throw makeOllamaGatewayError(err); } finally { clearTimeout(abortTimer); }
    };

    return {
      status: res.status,
      headers,
      stream: isStream ? res.body : null,
      json: isStream ? null : async () => JSON.parse(await readText()),
      text: isStream ? null : readText,
    };
  }

  // Vertex AI Gemini passthrough. Same Gemini body as the AI Studio route, but a Vertex path
  // (/v1/projects/<p>/locations/<l>/publishers/google/models/<model>:generateContent), a region-specific base
  // (<location>-aiplatform.googleapis.com, computed by the route and passed via opts.baseUrl), and OAuth Bearer
  // auth. The access token comes from EVOMAP_VERTEX_ACCESS_TOKEN (provisioned/refreshed by the daemon via
  // `gcloud auth print-access-token` or a token sidecar); SA-key auto-minting is a follow-up. No translation.
  async _proxyVertex(reqPath, body, opts = {}) {
    const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) { const e = new Error('vertex base url required'); e.statusCode = 500; throw e; }
    const token = process.env.EVOMAP_VERTEX_ACCESS_TOKEN || '';
    if (!token) { const e = new Error('vertex access token required'); e.statusCode = 401; throw e; }
    const timeoutMs = opts.timeoutMs || 60_000;
    const fwd = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    const endpoint = `${baseUrl}${reqPath}`;
    const abortController = new AbortController();
    const timeoutErr = new Error('vertex upstream timed out');
    timeoutErr.name = 'TimeoutError';
    const abortTimer = setTimeout(() => abortController.abort(timeoutErr), timeoutMs);
    abortTimer.unref?.();
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: fwd, body: JSON.stringify(body || {}), signal: abortController.signal });
    } catch (err) {
      clearTimeout(abortTimer);
      throw makeVertexGatewayError(err);
    }

    const headers = Object.fromEntries(res.headers.entries());
    const contentType = (headers['content-type'] || '').toLowerCase();
    const isStream = contentType.includes('text/event-stream') || /:streamGenerateContent(\b|\?|$)/.test(reqPath);
    if (isStream) clearTimeout(abortTimer);

    const readText = async () => {
      try { return await res.text(); } catch (err) { throw makeVertexGatewayError(err); } finally { clearTimeout(abortTimer); }
    };

    return {
      status: res.status,
      headers,
      stream: isStream ? res.body : null,
      json: isStream ? null : async () => JSON.parse(await readText()),
      text: isStream ? null : readText,
    };
  }

  // Bedrock upstream mode: same return contract as _proxyAnthropic so
  // messages_route.js and ProxyHttpServer._streamResponse don't change.
  // Body transformation: model -> URL path; inject anthropic_version;
  // strip top-level model so Bedrock InvokeModel doesn't 400. SDK owns
  // SigV4 signing (creds via AWS_* env or opts.bedrockCredentials for
  // tests) and AWS event-stream binary decoding; we only re-emit each
  // chunk as standard SSE so clients remain Anthropic-compatible.
  async _proxyBedrock(reqPath, body, opts = {}) {
    if (!this._bedrockSdk) {
      this._bedrockSdk = require('@aws-sdk/client-bedrock-runtime');
    }
    const {
      BedrockRuntimeClient,
      InvokeModelCommand,
      InvokeModelWithResponseStreamCommand,
    } = this._bedrockSdk;

    // Defense-in-depth: when router is disabled (EVOMAP_ROUTER_ENABLED!=1)
    // the router handler skips the body-rewrite step, so a short inbound ID
    // would otherwise reach Bedrock InvokeModel and trigger ValidationException.
    // Re-canonicalize here; idempotent for already-canonical IDs from the
    // router-enabled path.
    const rawModel = body && typeof body.model === 'string' ? body.model : null;
    const modelId = rawModel ? canonicalizeForBedrock(rawModel) : null;
    if (!modelId) {
      const errBody = JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'body.model required for Bedrock upstream' },
      });
      return {
        status: 400,
        headers: { 'content-type': 'application/json' },
        stream: null,
        json: () => JSON.parse(errBody),
        text: () => errBody,
      };
    }

    const upstreamBody = { ...body };
    delete upstreamBody.model;
    if (!upstreamBody.anthropic_version) {
      upstreamBody.anthropic_version = 'bedrock-2023-05-31';
    }
    const wantsStream = upstreamBody.stream === true;
    // Bedrock infers stream-vs-not from the command, not the body field.
    delete upstreamBody.stream;

    // Claude Code v2.1.150+ sends `thinking: { type: 'adaptive' }` plus
    // `output_config.effort` for Opus 4.7+. Keep that shape for those models:
    // folding it to `enabled` makes current 4.7+ endpoints reject compaction
    // with: "thinking.type.enabled is not supported for this model".
    //
    // Older Bedrock-deployed 4.5/4.1 generation models only accept
    // 'enabled' | 'disabled'. Fold 'adaptive' for those older models:
    //
    // Two hard constraints collide:
    //   - Anthropic: budget_tokens >= 1024 when thinking is enabled
    //   - Bedrock:   budget_tokens <  max_tokens (strictly)
    //
    // For max_tokens <= 1024 there's no valid budget at all (1024 floor
    // would fail Bedrock's strict-less-than check), so we have to drop
    // thinking entirely on those calls — fold to 'disabled'. For larger
    // max_tokens we default to max_tokens/2 (the model picks budget in
    // adaptive mode, but Bedrock 'enabled' requires the field).
    const modelSupportsAdaptiveThinking = supportsAdaptiveThinking(modelId);
    if (
      !modelSupportsAdaptiveThinking
      && upstreamBody.thinking
      && upstreamBody.thinking.type === 'adaptive'
    ) {
      const maxTokens = typeof upstreamBody.max_tokens === 'number' ? upstreamBody.max_tokens : 8192;
      const haveBudget = typeof upstreamBody.thinking.budget_tokens === 'number';
      if (!haveBudget && maxTokens <= 1024) {
        upstreamBody.thinking = { type: 'disabled' };
      } else {
        upstreamBody.thinking = {
          ...upstreamBody.thinking,
          type: 'enabled',
          budget_tokens: haveBudget ? upstreamBody.thinking.budget_tokens : Math.max(1024, Math.floor(maxTokens / 2)),
        };
      }
    }

    // Claude Code v2.1.150+ adds top-level fields. Keep output_config for
    // 4.7 adaptive thinking, where it controls effort; older Bedrock schemas
    // reject it as an extra input.
    //
    //   - output_config: { effort }      (when effortLevel is set)
    //   - context_management: { ... }    (auto context window management)
    // Bedrock's strict schema means any unknown top-level field 400s the
    // whole call, so strip the known CC additions before forwarding. New CC
    // fields will surface as 400s and need to be added here.
    for (const k of ['context_management']) {
      if (k in upstreamBody) delete upstreamBody[k];
    }
    if (!modelSupportsAdaptiveThinking && 'output_config' in upstreamBody) {
      delete upstreamBody.output_config;
    }

    // Cache the BedrockRuntimeClient across requests so its connection
    // pool, DNS cache, and credential-chain resolution amortize. Reusing
    // a single client matches what _proxyAnthropic does with the global
    // fetch + Agent. Cache key includes the SDK module identity so test
    // SDK injection (proxy._bedrockSdk = mock) invalidates correctly.
    const clientArgs = {
      region: opts.bedrockRegion || process.env.AWS_REGION || 'us-east-1',
      ...(opts.bedrockEndpoint || process.env.EVOMAP_BEDROCK_ENDPOINT
        ? { endpoint: opts.bedrockEndpoint || process.env.EVOMAP_BEDROCK_ENDPOINT }
        : {}),
      ...(opts.bedrockCredentials ? { credentials: opts.bedrockCredentials } : {}),
    };
    const cacheKey = JSON.stringify(clientArgs);
    if (
      !this._bedrockClient
      || this._bedrockClientKey !== cacheKey
      || this._bedrockClientSdk !== this._bedrockSdk
    ) {
      this._bedrockClient = new BedrockRuntimeClient(clientArgs);
      this._bedrockClientKey = cacheKey;
      this._bedrockClientSdk = this._bedrockSdk;
    }
    const client = this._bedrockClient;

    // Match _proxyAnthropic's per-request timeout boundary so a hung
    // upstream can't pin a Bedrock connection forever. AWS SDK v3
    // commands accept abortSignal in the second arg.
    const timeoutMs = opts.timeoutMs || 60_000;
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      if (wantsStream) {
        const out = await client.send(new InvokeModelWithResponseStreamCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(upstreamBody),
        }), { abortSignal: abortController.signal });
        // The timeout that bounds the initial send must not apply to the
        // streaming body — chunks arrive over many seconds. Clear it now;
        // the readable-stream's cancel() handler is what closes the
        // upstream when the client disconnects mid-stream.
        clearTimeout(abortTimer);
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            try {
              for await (const event of out.body) {
                if (event.chunk?.bytes) {
                  const json = Buffer.from(event.chunk.bytes).toString('utf8');
                  controller.enqueue(enc.encode(`data: ${json}\n\n`));
                  continue;
                }
                // Bedrock InvokeModelWithResponseStream may emit any of these
                // exception envelopes mid-stream; missing one silently drops
                // it and closes the stream without an error frame, so the
                // client sees a truncated-but-clean response.
                const ex = event.internalServerException
                  || event.modelStreamErrorException
                  || event.throttlingException
                  || event.validationException
                  || event.modelTimeoutException
                  || event.serviceUnavailableException;
                if (ex) {
                  const errFrame = JSON.stringify({
                    type: 'error',
                    error: { type: ex.name || 'upstream_error', message: ex.message || String(ex) },
                  });
                  controller.enqueue(enc.encode(`event: error\ndata: ${errFrame}\n\n`));
                }
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
          // ProxyHttpServer._streamResponse calls reader.cancel() when the
          // downstream HTTP client disconnects. Without this, the AWS
          // event-stream AsyncIterable keeps pulling frames into a
          // discarded ReadableStream, leaking the underlying HTTP/2
          // stream + socket out of the SDK's pool.
          cancel() {
            try {
              if (typeof out.body?.return === 'function') {
                out.body.return();
              }
            } catch { /* AsyncIterable already closed */ }
          },
        });
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          stream,
          json: null,
          text: null,
          traceRequestBody: upstreamBody,
        };
      }

      const out = await client.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(upstreamBody),
      }), { abortSignal: abortController.signal });
      clearTimeout(abortTimer);
      const text = Buffer.from(out.body).toString('utf8');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        stream: null,
        json: () => JSON.parse(text),
        text: () => text,
        traceRequestBody: upstreamBody,
      };
    } catch (err) {
      clearTimeout(abortTimer);
      const status = err.$metadata?.httpStatusCode || 500;
      const errBody = JSON.stringify({
        type: 'error',
        error: { type: err.name || 'upstream_error', message: err.message || String(err) },
      });
      return {
        status,
        headers: { 'content-type': 'application/json' },
        stream: null,
        json: () => JSON.parse(errBody),
        text: () => errBody,
        traceRequestBody: upstreamBody,
      };
    }
  }

  async _getHubMailboxStatus() {
    if (!this.hubUrl) return { error: 'Hub not configured' };
    const nodeId = this.lifecycle.nodeId;
    if (!nodeId) return { error: 'No node_id yet' };
    const endpoint = `${this.hubUrl}/a2a/mailbox/status?node_id=${encodeURIComponent(nodeId)}`;
    try {
      const res = await hubFetch(endpoint, {
        method: 'GET',
        headers: this.lifecycle._buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Drain body so undici can recycle the socket back to the pool.
        // Without this, repeated non-ok responses leak pool slots and
        // eventually starve the dispatcher.
        try { res.body?.cancel?.().catch(() => {}); } catch {}
        return { error: `Hub ${res.status}` };
      }
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

module.exports = {
  EvoMapProxy,
  startProxy,
  buildAssetSearchQuery,
  buildSemanticSearchQuery,
  planAssetSearch,
  parseRetryAfterMs,
  resolveOpenAIBaseUrl,
  OPENAI_COMPATIBLE_BASE_URLS,
};
