// Regression guard for #460 Bug 2: when EVOMAP_PROXY=1 and a proxy is
// running, src/atp/hubClient.js MUST route /atp/* calls through the local
// proxy (127.0.0.1) and NOT make a direct call to the Hub. The proxy is the
// single egress point for the mailbox/task/session/ATP surface.
//
// We spin up an in-memory HTTP server that impersonates both the proxy and
// the hub on the same loopback interface. The proxy endpoint increments
// `proxyHits`; the hub endpoint increments `hubHits`. We then assert which
// counter moves under each env/settings combination.

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({ raw }); }
    });
  });
}

describe('ATP hubClient proxy routing (regression #460 Bug 2)', () => {
  let proxyServer;
  let hubServer;
  let proxyUrl;
  let hubUrl;
  let proxyHits;
  let hubHits;
  let lastProxyBody;
  let origHome;
  let origUserProfile;
  let tmpHome;
  let origEnv;

  const ENV_KEYS = [
    'EVOMAP_PROXY', 'A2A_TRANSPORT', 'A2A_HUB_URL', 'A2A_NODE_ID',
    'A2A_NODE_SECRET', 'EVOMAP_PROXY_PORT', 'EVOMAP_HUB_ALLOW_INSECURE',
    'EVOLVER_SETTINGS_DIR',
  ];

  before(async () => {
    proxyServer = await listen(async (req, res) => {
      proxyHits.push({ method: req.method, path: req.url });
      if (req.method === 'POST') lastProxyBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ via: 'proxy', path: req.url }));
    });
    proxyUrl = proxyServer.url;

    hubServer = await listen(async (req, res) => {
      hubHits.push({ method: req.method, path: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ via: 'hub', path: req.url }));
    });
    hubUrl = hubServer.url;
  });

  after(async () => {
    await new Promise((r) => proxyServer.server.close(r));
    await new Promise((r) => hubServer.server.close(r));
  });

  beforeEach(() => {
    proxyHits = [];
    hubHits = [];
    lastProxyBody = null;

    origEnv = {};
    for (const k of ENV_KEYS) { origEnv[k] = process.env[k]; delete process.env[k]; }

    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-atp-route-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.EVOLVER_SETTINGS_DIR = path.join(tmpHome, '.evolver');

    // Seed A2A env so hubClient can call getNodeId / buildHubHeaders without
    // touching the filesystem persist path. We mint a fresh 64-hex secret
    // per test so module caches (if any) don't leak between tests.
    process.env.A2A_HUB_URL = hubUrl;
    process.env.A2A_NODE_ID = 'node_' + crypto.randomBytes(8).toString('hex');
    process.env.A2A_NODE_SECRET = crypto.randomBytes(32).toString('hex');
    // The mock hub above is plain http://127.0.0.1:<port>. hubClient's
    // _hubPost / _hubGet now enforce the same https-only posture as
    // hubFetch, so we set the documented escape hatch to keep these mock
    // servers usable.
    process.env.EVOMAP_HUB_ALLOW_INSECURE = '1';

    // Bust the require cache so our env changes take effect for every test.
    for (const key of Object.keys(require.cache)) {
      if (/src[\\/](atp[\\/]hubClient|proxy[\\/]server[\\/]settings|gep[\\/]a2aProtocol)\.js$/.test(key)) {
        delete require.cache[key];
      }
    }
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;

    for (const k of ENV_KEYS) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }

    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function writeProxySettings(url) {
    const settingsDir = process.env.EVOLVER_SETTINGS_DIR;
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      proxy: { url, pid: process.pid, started_at: new Date().toISOString() },
    }));
  }

  it('routes placeOrder through proxy when EVOMAP_PROXY=1 and proxy is running', async () => {
    process.env.EVOMAP_PROXY = '1';
    writeProxySettings(proxyUrl);

    const hubClient = require('../src/atp/hubClient');
    const result = await hubClient.placeOrder({
      capabilities: ['test'],
      budget: 5,
      question: 'does proxy see this?',
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.via, 'proxy', 'response should come from proxy, not hub');
    assert.equal(hubHits.length, 0, 'hub MUST NOT be called directly when proxy is running');
    assert.equal(proxyHits.length, 1);
    assert.equal(proxyHits[0].method, 'POST');
    assert.equal(proxyHits[0].path, '/atp/order');
    assert.equal(lastProxyBody.sender_id, process.env.A2A_NODE_ID);
    assert.equal(lastProxyBody.budget, 5);
  });

  it('routes getOrderStatus (GET) through proxy when EVOMAP_PROXY=1', async () => {
    process.env.EVOMAP_PROXY = '1';
    writeProxySettings(proxyUrl);

    const hubClient = require('../src/atp/hubClient');
    const result = await hubClient.getOrderStatus('ord_abc123');

    assert.equal(result.ok, true);
    assert.equal(result.data.via, 'proxy');
    assert.equal(hubHits.length, 0);
    assert.equal(proxyHits.length, 1);
    assert.equal(proxyHits[0].method, 'GET');
    assert.equal(proxyHits[0].path, '/atp/order/ord_abc123');
  });

  it('routes listProofs with query string through proxy when EVOMAP_PROXY=1', async () => {
    process.env.EVOMAP_PROXY = '1';
    writeProxySettings(proxyUrl);

    const hubClient = require('../src/atp/hubClient');
    const result = await hubClient.listProofs({ role: 'merchant', limit: 10 });

    assert.equal(result.ok, true);
    assert.equal(hubHits.length, 0);
    assert.equal(proxyHits.length, 1);
    assert.match(proxyHits[0].path, /^\/atp\/proofs\?/);
    assert.match(proxyHits[0].path, /role=merchant/);
    assert.match(proxyHits[0].path, /limit=10/);
  });

  it('falls back to hub direct when EVOMAP_PROXY is unset', async () => {
    // EVOMAP_PROXY not set at all -- legacy behavior.
    const hubClient = require('../src/atp/hubClient');
    const result = await hubClient.placeOrder({ capabilities: ['test'], budget: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.data.via, 'hub');
    assert.equal(hubHits.length, 1);
    assert.equal(hubHits[0].path, '/a2a/atp/order');
    assert.equal(proxyHits.length, 0, 'proxy MUST NOT be called when EVOMAP_PROXY is unset');
  });

  it('falls back to hub direct when EVOMAP_PROXY=1 but proxy is not running', async () => {
    process.env.EVOMAP_PROXY = '1';
    // intentionally NOT calling writeProxySettings -- simulates "user set the
    // env flag but the proxy never started / crashed". We must not strand
    // the call; falling back to hub keeps the CLI usable.
    const hubClient = require('../src/atp/hubClient');
    const result = await hubClient.placeOrder({ capabilities: ['test'], budget: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.data.via, 'hub');
    assert.equal(hubHits.length, 1);
    assert.equal(proxyHits.length, 0);
  });

  it('A2A_TRANSPORT=mailbox is equivalent to EVOMAP_PROXY=1', async () => {
    process.env.A2A_TRANSPORT = 'mailbox';
    writeProxySettings(proxyUrl);

    const hubClient = require('../src/atp/hubClient');
    const result = await hubClient.placeOrder({ capabilities: ['test'], budget: 1 });

    assert.equal(result.data.via, 'proxy');
    assert.equal(hubHits.length, 0);
    assert.equal(proxyHits.length, 1);
  });
});
