'use strict';

const crypto = require('crypto');
const http = require('http');
const { writeSettings, readSettings, clearSettings, clearIfStale } = require('./settings');

const MAX_PORT_ATTEMPTS = 100;
const DEFAULT_PORT = 19820;

// Routes whose handlers are read-only introspection of proxy/hub state. We
// must NOT call lifecycle.pokeHeartbeat() on these because stale-state
// detection paths (CLI status probes, UI pollers, the user manually checking
// "is my proxy alive?") hit them; poking from inside those calls would mask
// the very backoff condition the user is trying to observe and would also
// burn the hub's 6/300s per-sender heartbeat rate budget on no-op traffic.
const POKE_EXCLUDED_PATHS = new Set([
  '/proxy/status',
  '/proxy/config',
  '/proxy/hub-status',
]);

// GHSA-7xp7-m392-h92c: cap request body at 1 MiB. The proxy's HTTP surface is
// bound to 127.0.0.1 but still reachable by any local process (other users on
// a shared dev host, container neighbors sharing the host netns, malicious
// postinstall scripts). Without a cap, /asset/submit and /mailbox/send write
// the full body verbatim into messages.jsonl, so an attacker can fill the
// disk and make the daemon OOM on every restart (readFileSync over a multi-
// GB JSONL). Tune via EVOMAP_PROXY_MAX_BODY_BYTES if a legitimate workload
// truly needs bigger bodies.
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
function resolveMaxBodyBytes() {
  const raw = Number(process.env.EVOMAP_PROXY_MAX_BODY_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_BODY_BYTES;
}

function parseBody(req, opts) {
  const maxBytes = (opts && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0)
    ? opts.maxBytes
    : resolveMaxBodyBytes();
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      return reject(err);
    }
    const chunks = [];
    let received = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      received += c.length;
      if (received > maxBytes) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        return fail(err);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', fail);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') return resolve(false);
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
}

class ProxyHttpServer {
  constructor(routes, { port, logger, lifecycle } = {}) {
    this.routes = routes;
    this.basePort = port || Number(process.env.EVOMAP_PROXY_PORT) || DEFAULT_PORT;
    this.actualPort = null;
    this.logger = logger || console;
    this.server = null;
    this.token = null;
    // Optional reference to LifecycleManager. Held weakly in the sense that
    // every access is null-checked: tests and partial-init paths construct
    // the HTTP server without a lifecycle and must still work.
    this.lifecycle = lifecycle || null;
  }

  async start() {
    clearIfStale();
    this.token = crypto.randomBytes(32).toString('hex');
    this.server = http.createServer((req, res) => this._handleRequest(req, res));

    let port = this.basePort;
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const ok = await tryListen(this.server, port);
      if (ok) {
        this.actualPort = port;
        const url = `http://127.0.0.1:${port}`;
        writeSettings({
          proxy: {
            url,
            pid: process.pid,
            started_at: new Date().toISOString(),
            token: this.token,
          },
        });
        this.logger.log(`[proxy] HTTP server listening on ${url}`);
        return { port, url, token: this.token };
      }
      port++;
    }
    throw new Error(`Could not find free port after ${MAX_PORT_ATTEMPTS} attempts starting from ${this.basePort}`);
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    clearSettings();
  }

  async _handleRequest(req, res) {
    const authHeader = req.headers['authorization'] || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const expBuf = Buffer.from(this.token || '', 'utf8');
    const provBuf = Buffer.from(provided, 'utf8');
    const valid = this.token &&
      provBuf.length === expBuf.length &&
      crypto.timingSafeEqual(provBuf, expBuf);
    if (!valid) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const url = new URL(req.url, `http://127.0.0.1:${this.actualPort}`);
    const routeKey = `${req.method} ${url.pathname}`;

    const paramMatch = this._matchRoute(req.method, url.pathname);

    if (!paramMatch) {
      return sendJson(res, 404, { error: 'Not found', path: url.pathname });
    }

    const { handler, params } = paramMatch;

    // #544: any authenticated inbound request is liveness proof that the user
    // is actively driving the proxy (Cursor, Claude Code, Codex, etc.). Poke
    // the lifecycle manager so a node stuck in 30-min reauth backoff can drop
    // that state and re-prove itself instead of staying "dead" while the user
    // hammers the proxy. pokeHeartbeat() has its own 60s throttle for healthy
    // nodes and a single-flight gate, so per-request invocation is safe.
    if (this.lifecycle && !POKE_EXCLUDED_PATHS.has(url.pathname)) {
      try { this.lifecycle.pokeHeartbeat(); }
      catch (e) { this.logger.warn?.('[proxy] pokeHeartbeat failed:', e.message); }
    }

    try {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await parseBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const headers = req.headers;
      const result = await handler({ body, query, params, headers });
      if (result && result.stream) {
        await this._streamResponse(res, result);
      } else {
        sendJson(res, result.status || 200, result.body || result);
      }
    } catch (err) {
      this.logger.error(`[proxy] ${routeKey} error:`, err.message);
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
      } else {
        sendJson(res, err.statusCode || 500, {
          error: err.message || 'Internal error',
        });
      }
    }
  }

  // SSE / pass-through streaming path used by /v1/messages (slice 5).
  // `result.stream` may be any async iterable yielding Buffer or string
  // chunks (Web ReadableStream from fetch, or a Node Readable). Headers
  // default to text/event-stream so Anthropic-style SSE bytes piped
  // through reach the client unmodified. The caller owns producing
  // correctly-framed SSE; this method only relays bytes.
  async _streamResponse(res, result) {
    const headers = Object.assign({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }, result.headers || {});
    res.writeHead(result.status || 200, headers);

    // Browsers, network blips, and Ctrl-C all close the SSE socket mid-stream.
    // If we await `drain` without watching for `close`, the drain event never
    // fires on a destroyed socket and this coroutine hangs forever — which
    // also pins the upstream fetch body open (real Anthropic socket leak, not
    // just coroutine leak). For Web ReadableStream upstreams we read via an
    // explicit reader so cancellation can go through the same lock; for sync
    // generators / Node Readables we fall back to for-await.
    const stream = result.stream;
    const reader = stream && typeof stream.getReader === 'function' ? stream.getReader() : null;

    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      if (reader) {
        reader.cancel().catch(() => { /* upstream already settled */ });
      } else if (stream && typeof stream.destroy === 'function') {
        try { stream.destroy(); } catch { /* ignore */ }
      }
    };
    res.once('close', onClose);

    const awaitBackpressure = () => new Promise((resolve) => {
      let settled = false;
      const onDrain = () => {
        if (settled) return;
        settled = true;
        res.off('close', onCloseInner);
        resolve();
      };
      const onCloseInner = () => {
        if (settled) return;
        settled = true;
        res.off('drain', onDrain);
        resolve();
      };
      res.once('drain', onDrain);
      res.once('close', onCloseInner);
    });

    try {
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || clientGone) break;
          if (!res.write(value)) {
            await awaitBackpressure();
            if (clientGone) break;
          }
        }
      } else {
        for await (const chunk of stream) {
          if (clientGone) break;
          if (!res.write(chunk)) {
            await awaitBackpressure();
            if (clientGone) break;
          }
        }
      }
    } finally {
      res.off('close', onClose);
      try { res.end(); } catch { /* socket may already be destroyed */ }
    }
  }

  _matchRoute(method, pathname) {
    for (const [pattern, handler] of Object.entries(this.routes)) {
      const [routeMethod, routePath] = pattern.split(' ');
      if (routeMethod !== method) continue;

      const params = matchPath(routePath, pathname);
      if (params !== null) return { handler, params };
    }
    return null;
  }
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

module.exports = { ProxyHttpServer, parseBody, sendJson, DEFAULT_PORT, DEFAULT_MAX_BODY_BYTES, resolveMaxBodyBytes };
