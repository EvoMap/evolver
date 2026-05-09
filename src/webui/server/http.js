'use strict';

const http = require('http');
const { buildWebUiRoutes } = require('./routes');
const { getIndexHtml, getClientJs, getStylesCss } = require('../client/static');

const DEFAULT_WEBUI_PORT = 19821;
const MAX_PORT_ATTEMPTS = 50;

class WebUiServer {
  constructor(opts = {}) {
    this.port = opts.port || Number(process.env.EVOLVER_WEBUI_PORT) || DEFAULT_WEBUI_PORT;
    this.logger = opts.logger || console;
    this.routes = opts.routes || buildWebUiRoutes();
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
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, 'text/html; charset=utf-8', getIndexHtml());
    if (req.method === 'GET' && url.pathname === '/app.js') return sendText(res, 200, 'application/javascript; charset=utf-8', getClientJs());
    if (req.method === 'GET' && url.pathname === '/app.css') return sendText(res, 200, 'text/css; charset=utf-8', getStylesCss());

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
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
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
