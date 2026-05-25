'use strict';

// #544 follow-up: verify that the proxy HTTP server pokes the lifecycle
// manager on every inbound request. pokeHeartbeat() is the recovery hook
// added in 549611b; without this wiring, a node stuck in 30-min reauth
// backoff stays dead even while the user is actively driving the proxy.
//
// The test cares about WIRING, not throttling. Throttling is a property
// of LifecycleManager.pokeHeartbeat itself and has its own coverage in
// the lifecycle manager test suite.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProxyHttpServer } = require('../src/proxy/server/http');

function request(url, method, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('ProxyHttpServer pokes lifecycle on request entry (#544)', () => {
  let server, baseUrl, token;
  let savedSettingsDir, settingsDir;
  let fakeLifecycle;

  before(async () => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-poke-settings-'));
    savedSettingsDir = process.env.EVOLVER_SETTINGS_DIR;
    process.env.EVOLVER_SETTINGS_DIR = settingsDir;

    fakeLifecycle = {
      pokeCalls: 0,
      pokeHeartbeat() { this.pokeCalls++; return true; },
    };

    const routes = {
      'POST /mailbox/send': async () => ({ status: 200, body: { ok: true } }),
      'GET /proxy/status': async () => ({ status: 200, body: { status: 'running' } }),
      'GET /proxy/config': async () => ({ status: 200, body: { ok: true } }),
      'GET /proxy/hub-status': async () => ({ status: 200, body: { ok: true } }),
    };

    server = new ProxyHttpServer(routes, {
      port: 39840,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      lifecycle: fakeLifecycle,
    });
    const info = await server.start();
    baseUrl = info.url;
    token = info.token;
  });

  after(async () => {
    await server.stop();
    try { fs.rmSync(settingsDir, { recursive: true }); } catch {}
    if (savedSettingsDir === undefined) delete process.env.EVOLVER_SETTINGS_DIR;
    else process.env.EVOLVER_SETTINGS_DIR = savedSettingsDir;
  });

  it('pokes lifecycle exactly once per authenticated user request', async () => {
    fakeLifecycle.pokeCalls = 0;
    const res = await request(`${baseUrl}/mailbox/send`, 'POST', { type: 't', payload: {} }, token);
    assert.equal(res.status, 200);
    assert.equal(fakeLifecycle.pokeCalls, 1, 'first request must poke');
  });

  it('pokes again on a back-to-back second request (no HTTP-level throttling)', async () => {
    // The 60s healthy-node throttle lives INSIDE pokeHeartbeat itself; the
    // HTTP layer must not second-guess it, otherwise a failing node would
    // also be suppressed and the recovery path stays broken.
    fakeLifecycle.pokeCalls = 0;
    const r1 = await request(`${baseUrl}/mailbox/send`, 'POST', { type: 't', payload: {} }, token);
    const r2 = await request(`${baseUrl}/mailbox/send`, 'POST', { type: 't', payload: {} }, token);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(fakeLifecycle.pokeCalls, 2, 'each request must fire its own poke');
  });

  it('does NOT poke for /proxy/status (stale-state probe path)', async () => {
    fakeLifecycle.pokeCalls = 0;
    const res = await request(`${baseUrl}/proxy/status`, 'GET', null, token);
    assert.equal(res.status, 200);
    assert.equal(fakeLifecycle.pokeCalls, 0, '/proxy/status must not mask backoff state');
  });

  it('does NOT poke for /proxy/config or /proxy/hub-status', async () => {
    fakeLifecycle.pokeCalls = 0;
    await request(`${baseUrl}/proxy/config`, 'GET', null, token);
    await request(`${baseUrl}/proxy/hub-status`, 'GET', null, token);
    assert.equal(fakeLifecycle.pokeCalls, 0, 'introspection routes must be silent');
  });

  it('does NOT poke for unauthenticated requests', async () => {
    fakeLifecycle.pokeCalls = 0;
    const res = await request(`${baseUrl}/mailbox/send`, 'POST', { type: 't', payload: {} });
    assert.equal(res.status, 401);
    assert.equal(fakeLifecycle.pokeCalls, 0, '401s must not feed the poke path');
  });

  it('does NOT poke for unknown routes (404)', async () => {
    fakeLifecycle.pokeCalls = 0;
    const res = await request(`${baseUrl}/nope`, 'GET', null, token);
    assert.equal(res.status, 404);
    assert.equal(fakeLifecycle.pokeCalls, 0, '404s must not feed the poke path');
  });

  it('survives a throwing pokeHeartbeat without dropping the request', async () => {
    const original = fakeLifecycle.pokeHeartbeat;
    fakeLifecycle.pokeHeartbeat = () => { throw new Error('synthetic'); };
    try {
      const res = await request(`${baseUrl}/mailbox/send`, 'POST', { type: 't', payload: {} }, token);
      assert.equal(res.status, 200, 'poke failure must not break the handler');
    } finally {
      fakeLifecycle.pokeHeartbeat = original;
    }
  });
});

describe('ProxyHttpServer works without a lifecycle (test / partial-init)', () => {
  let server, baseUrl, token;
  let savedSettingsDir, settingsDir;

  before(async () => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nopoke-settings-'));
    savedSettingsDir = process.env.EVOLVER_SETTINGS_DIR;
    process.env.EVOLVER_SETTINGS_DIR = settingsDir;
    const routes = {
      'POST /mailbox/send': async () => ({ status: 200, body: { ok: true } }),
    };
    server = new ProxyHttpServer(routes, {
      port: 39841,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
    });
    const info = await server.start();
    baseUrl = info.url;
    token = info.token;
  });

  after(async () => {
    await server.stop();
    try { fs.rmSync(settingsDir, { recursive: true }); } catch {}
    if (savedSettingsDir === undefined) delete process.env.EVOLVER_SETTINGS_DIR;
    else process.env.EVOLVER_SETTINGS_DIR = savedSettingsDir;
  });

  it('still serves requests when no lifecycle reference is wired in', async () => {
    const res = await request(`${baseUrl}/mailbox/send`, 'POST', { type: 't', payload: {} }, token);
    assert.equal(res.status, 200);
  });
});
