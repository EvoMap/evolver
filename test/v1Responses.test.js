'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProxyHttpServer } = require('../src/proxy/server/http');
const { buildRoutes } = require('../src/proxy/server/routes');
const { buildResponsesHandler } = require('../src/proxy/router/responses_route');
const { EvoMapProxy } = require('../src/proxy');

function rawPost(url, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /v1/responses — Codex/OpenAI passthrough', () => {
  let server, baseUrl, token, captured;
  let savedSettingsDir, savedOpenAIKey, savedEvomapOpenAIKey, settingsDir;

  before(async () => {
    captured = [];
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1responses-settings-'));
    savedSettingsDir = process.env.EVOLVER_SETTINGS_DIR;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedEvomapOpenAIKey = process.env.EVOMAP_OPENAI_API_KEY;
    process.env.EVOLVER_SETTINGS_DIR = settingsDir;
    process.env.EVOMAP_OPENAI_API_KEY = 'sk-upstream';

    const responsesHandler = buildResponsesHandler({
      openAIProxy: async (reqPath, body, opts) => {
        captured.push({ reqPath, body, opts });
        if (body.input === 'throw-before-response') {
          throw new Error('connect failed');
        }
        if (body.stream === true) {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode('data: {"type":"response.created"}\n\n'));
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'x-request-id': 'req_stream',
              'x-ratelimit-remaining-requests': '12',
              'set-cookie': 'must-not-forward=1',
            },
            stream,
          };
        }
        if (body.input === 'rate-limit') {
          return {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'req_rate_limit',
              'retry-after': '7',
              'x-ratelimit-reset-requests': '123',
              authorization: 'Bearer upstream-secret',
              'set-cookie': 'must-not-forward=1',
            },
            stream: null,
            text: () => JSON.stringify({ error: { message: 'rate limited' } }),
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          stream: null,
          text: () => {
            if (body.input === 'read-error') throw new Error('body read failed');
            return JSON.stringify({
              id: 'resp_1',
              model: body.model,
              output: [],
              usage: { input_tokens: 5, output_tokens: 6 },
            });
          },
        };
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const routes = buildRoutes({}, {}, null, { responsesHandler });
    assert.equal(typeof routes['POST /v1/responses'], 'function');

    server = new ProxyHttpServer(routes, {
      port: 39850,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
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
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
    if (savedEvomapOpenAIKey === undefined) delete process.env.EVOMAP_OPENAI_API_KEY;
    else process.env.EVOMAP_OPENAI_API_KEY = savedEvomapOpenAIKey;
  });

  beforeEach(() => {
    captured.length = 0;
    process.env.EVOMAP_OPENAI_API_KEY = 'sk-upstream';
  });

  it('forwards Responses API requests through the openAIProxy contract', async () => {
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });

    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].reqPath, '/responses');
    assert.equal(captured[0].opts.upstreamMode, 'openai');
    assert.equal(JSON.parse(res.body).id, 'resp_1');
  });

  it('passes through safe OpenAI response metadata headers', async () => {
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: 'rate-limit',
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers['x-request-id'], 'req_rate_limit');
    assert.equal(res.headers['retry-after'], '7');
    assert.equal(res.headers['x-ratelimit-reset-requests'], '123');
    assert.equal(res.headers.authorization, undefined);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(JSON.parse(res.body).error.message, 'rate limited');
  });

  it('rejects when daemon OpenAI upstream credentials are absent', async () => {
    delete process.env.EVOMAP_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: 'hi',
    });

    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).error, 'openai api key required');
    assert.equal(captured.length, 0);
  });

  it('does not accept inbound x-api-key as a daemon OpenAI credential', async () => {
    delete process.env.EVOMAP_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: 'hi',
    }, { 'x-api-key': token });

    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).error, 'openai api key required');
    assert.equal(captured.length, 0);
  });

  it('returns gateway status when upstream fails before an HTTP response', async () => {
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: 'throw-before-response',
    });

    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'openai upstream request failed');
  });

  it('returns gateway status when upstream body read fails', async () => {
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: 'read-error',
    });

    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'openai upstream request failed');
  });

  it('passes through streaming Responses API SSE bytes verbatim', async () => {
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      stream: true,
      input: 'hi',
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['x-request-id'], 'req_stream');
    assert.equal(res.headers['x-ratelimit-remaining-requests'], '12');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.match(res.body, /response\.created/);
  });
});

describe('POST /v1/responses — OpenAI upstream diagnostics', () => {
  let server, baseUrl, token, settingsDir, logs;
  let savedSettingsDir, savedOpenAIKey, savedEvomapOpenAIKey, savedOpenAIBaseUrl;

  before(async () => {
    logs = [];
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1responses-bad-base-'));
    savedSettingsDir = process.env.EVOLVER_SETTINGS_DIR;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedEvomapOpenAIKey = process.env.EVOMAP_OPENAI_API_KEY;
    savedOpenAIBaseUrl = process.env.EVOMAP_OPENAI_BASE_URL;

    process.env.EVOLVER_SETTINGS_DIR = settingsDir;
    process.env.OPENAI_API_KEY = 'sk-upstream';
    delete process.env.EVOMAP_OPENAI_API_KEY;
    process.env.EVOMAP_OPENAI_BASE_URL = 'http://127.0.0.1:65535/v1';

    const logger = {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    };
    const proxy = new EvoMapProxy({ logger });
    const responsesHandler = buildResponsesHandler({
      openAIProxy: (reqPath, body, opts) => proxy._proxyOpenAIResponses(reqPath, body, opts),
      logger,
    });
    const routes = buildRoutes({}, {}, null, { responsesHandler });
    server = new ProxyHttpServer(routes, { port: 39851, logger });
    const info = await server.start();
    baseUrl = info.url;
    token = info.token;
  });

  after(async () => {
    await server.stop();
    try { fs.rmSync(settingsDir, { recursive: true }); } catch {}
    if (savedSettingsDir === undefined) delete process.env.EVOLVER_SETTINGS_DIR;
    else process.env.EVOLVER_SETTINGS_DIR = savedSettingsDir;
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
    if (savedEvomapOpenAIKey === undefined) delete process.env.EVOMAP_OPENAI_API_KEY;
    else process.env.EVOMAP_OPENAI_API_KEY = savedEvomapOpenAIKey;
    if (savedOpenAIBaseUrl === undefined) delete process.env.EVOMAP_OPENAI_BASE_URL;
    else process.env.EVOMAP_OPENAI_BASE_URL = savedOpenAIBaseUrl;
  });

  it('surfaces safe base URL diagnostics without logging inbound credentials', async () => {
    logs.length = 0;
    const inboundKey = 'client-key-should-not-log';
    const openAIKey = 'openai-key-should-not-log';
    const res = await rawPost(`${baseUrl}/v1/responses`, token, {
      model: 'gpt-5.5',
      input: 'hi',
    }, {
      'x-api-key': inboundKey,
      'openai-api-key': openAIKey,
    });

    assert.equal(res.status, 502);
    const body = JSON.parse(res.body);
    assert.match(body.error, /^openai upstream request failed:/);
    assert.match(body.error, /EVOMAP_OPENAI_BASE_URL must be an OpenAI or known OpenAI-compatible https \/v1 endpoint/);

    const logText = logs.map((entry) => entry.map(String).join(' ')).join('\n');
    assert.match(logText, /EVOMAP_OPENAI_BASE_URL must be an OpenAI or known OpenAI-compatible https \/v1 endpoint/);
    assert.doesNotMatch(logText, new RegExp(token));
    assert.doesNotMatch(logText, new RegExp(inboundKey));
    assert.doesNotMatch(logText, new RegExp(openAIKey));
  });
});
