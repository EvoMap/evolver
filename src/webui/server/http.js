'use strict';

const http = require('http');
const { buildWebUiRoutes } = require('./routes');
const { getIndexHtml, getClientJs, getStylesCss, getVendorEcharts } = require('../client/static');

const DEFAULT_WEBUI_PORT = 19821;
const MAX_PORT_ATTEMPTS = 50;

class WebUiServer {
  constructor(opts = {}) {
    this.port = opts.port || Number(process.env.EVOLVER_WEBUI_PORT) || DEFAULT_WEBUI_PORT;
    this.logger = opts.logger || console;
    this.routes = opts.routes || buildWebUiRoutes();
    // onRequest fires once per inbound HTTP request, before any route
    // matching. webui is the only persistent default-mode process that
    // serves user-driven HTTP, so this is the only hook in default mode
    // where "user is actively using evolver" can drive heartbeat recovery
    // (proxy mode pokes from its own http handler; --loop pokes from the
    // evolve cycle entry). Without it, a user opening the dashboard after
    // a long sleep would have to wait for the supervisor's 30-60s
    // interval-based recovery instead of recovering on the first click.
    this.onRequest = typeof opts.onRequest === 'function' ? opts.onRequest : null;
    this.server = null;
    this.actualPort = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    let port = this.port;
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const ok = await tryListen(this.server, port);
      if (ok) {
        this.actualPort = port;
        const url = `http://127.0.0.1:${port}`;
        this.logger.log(`[webui] listening on ${url}`);
        return { port, url };
      }
      port++;
    }
    throw new Error(`Could not find free Web UI port after ${MAX_PORT_ATTEMPTS} attempts`);
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async _handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.actualPort || this.port}`);
    // Fire the activity hook before route dispatch so even 404s and static
    // asset fetches count -- the user IS interacting with evolver. Never
    // let a misbehaving hook break request handling.
    if (this.onRequest) {
      try { this.onRequest(req, url); } catch (_) { /* hook must not break requests */ }
    }
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, 'text/html; charset=utf-8', getIndexHtml());
    if (req.method === 'GET' && url.pathname === '/app.js') return sendText(res, 200, 'application/javascript; charset=utf-8', getClientJs());
    if (req.method === 'GET' && url.pathname === '/app.css') return sendText(res, 200, 'text/css; charset=utf-8', getStylesCss());
    if (req.method === 'GET' && url.pathname === '/vendor/echarts.min.js') return sendText(res, 200, 'application/javascript; charset=utf-8', getVendorEcharts());

    const matched = matchRoute(this.routes, req.method, url.pathname);
    if (!matched) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found', details: { path: url.pathname } } });

    try {
      const query = Object.fromEntries(url.searchParams);
      const result = await matched.handler({ query, params: matched.params });
      return sendJson(res, result.status || 200, result.body || result);
    } catch (err) {
      this.logger.error('[webui] request failed:', err && err.message || err);
      return sendJson(res, err.statusCode || 500, {
        error: {
          code: err.code || 'READ_FAILED',
          message: err.message || 'Internal error',
          details: err.details || {},
        },
      });
    }
  }
}

function matchRoute(routes, method, pathname) {
  for (const [pattern, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = pattern.split(' ');
    if (routeMethod !== method) continue;
    const params = matchPath(routePath, pathname);
    if (params) return { handler, params };
  }
  return null;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      // decodeURIComponent throws URIError on malformed percent escapes
      // (e.g. /webui/runs/%E0%A4%A). matchPath runs outside _handle's
      // try/catch, so an unhandled rejection would crash the request and
      // depending on the Node version's unhandled-rejection policy could
      // tip the local WebUI into a denial-of-service. Treat a malformed
      // segment as "no route matches" so the request falls through to a
      // clean 404.
      try {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } catch (_) {
        return null;
      }
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') return resolve(false);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  sendText(res, status, 'application/json; charset=utf-8', payload);
}

function sendText(res, status, contentType, text) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

module.exports = {
  WebUiServer,
  DEFAULT_WEBUI_PORT,
  matchPath,
};
