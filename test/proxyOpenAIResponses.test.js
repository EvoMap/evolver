'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { EvoMapProxy, resolveOpenAIBaseUrl } = require('../src/proxy');

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

// Header-phase abort budget for the "does not abort an SSE stream" test. It must
// comfortably exceed real header-arrival latency to the localhost stub — measured
// at ~76ms on a cold first request (undici/JIT/socket warm-up) and up to ~90ms
// under GC/scheduler pressure — so the header race is never lost. A `before`-hook
// warm-up pays the cold-start once; this budget then only has to absorb jitter.
const SLOW_STREAM_TIMEOUT_MS = 150;
// The slow stub's body must finish AFTER the header timeout so the test keeps its
// teeth: an uncleared header-phase timer would abort the body before it arrives.
const SLOW_STREAM_BODY_DELAY_MS = 300;

describe('EvoMapProxy._proxyOpenAIResponses', () => {
  let stub, proxy, captured;
  let savedOpenAIKey, savedEvomapOpenAIKey, savedOpenAIBaseUrl;

  before(async () => {
    captured = [];
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedEvomapOpenAIKey = process.env.EVOMAP_OPENAI_API_KEY;
    savedOpenAIBaseUrl = process.env.EVOMAP_OPENAI_BASE_URL;
    stub = await startStub((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        captured.push({ path: req.url, method: req.method, rawBody: raw, headers: req.headers, body: JSON.parse(raw || '{}') });
        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o', object: 'model' }] }));
          return;
        }
        if (req.url === '/v1/responses-stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"type":"response.created"}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (req.url === '/v1/responses-slow-stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"type":"response.created"}\n\n');
          // Body completes well after SLOW_STREAM_TIMEOUT_MS so the test still has
          // teeth: if the proxy failed to clear its header-phase abort timer once
          // the stream began, that timer would fire here and abort the body read.
          setTimeout(() => {
            res.write('data: {"type":"response.completed"}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, SLOW_STREAM_BODY_DELAY_MS);
          return;
        }
        if (req.url === '/v1/responses-timeout') {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'late' }));
          }, 80);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_1',
          object: 'response',
          model: 'gpt-5.5',
          output: [],
          usage: { input_tokens: 3, output_tokens: 4 },
        }));
      });
    });
    proxy = new EvoMapProxy({
      openaiBaseUrl: stub.baseUrl,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    // Warm up the streaming path (undici lazy init, JIT, keep-alive socket) once,
    // outside any timed assertion. Without this the first *real* streaming request
    // pays ~76ms of cold-start; under the tight header-phase timeout that made the
    // "does not abort an SSE stream" subtest fail deterministically when run in
    // isolation (it was the first such request) and flake intermittently in the
    // full file. Doing it here makes every subtest independent of run order.
    process.env.OPENAI_API_KEY = 'sk-warmup';
    try {
      const warm = await proxy._proxyOpenAIResponses('/responses-stream', { model: 'warmup', stream: true }, {
        inboundHeaders: {},
      });
      for await (const _chunk of warm.stream) { /* drain */ }
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  after(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
    if (savedEvomapOpenAIKey === undefined) delete process.env.EVOMAP_OPENAI_API_KEY;
    else process.env.EVOMAP_OPENAI_API_KEY = savedEvomapOpenAIKey;
    if (savedOpenAIBaseUrl === undefined) delete process.env.EVOMAP_OPENAI_BASE_URL;
    else process.env.EVOMAP_OPENAI_BASE_URL = savedOpenAIBaseUrl;
  });

  beforeEach(() => {
    captured.length = 0;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EVOMAP_OPENAI_API_KEY;
    delete process.env.EVOMAP_OPENAI_BASE_URL;
  });

  it('substitutes daemon OpenAI key and strips proxy auth headers', async () => {
    process.env.EVOMAP_OPENAI_API_KEY = 'sk-upstream';
    const res = await proxy._proxyOpenAIResponses('/responses', { model: 'gpt-5.5', input: 'hi' }, {
      inboundHeaders: {
        authorization: 'Bearer proxy-token',
        cookie: 'sid=bad',
        host: '127.0.0.1:19820',
        'openai-organization': 'org_123',
        'x-stainless-package-version': 'codex-test',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, '/v1/responses');
    assert.equal(captured[0].headers.authorization, 'Bearer sk-upstream');
    assert.equal(captured[0].headers.cookie, undefined);
    assert.notEqual(captured[0].headers.host, '127.0.0.1:19820');
    assert.equal(captured[0].headers['openai-organization'], 'org_123');
    assert.equal(captured[0].headers['x-stainless-package-version'], 'codex-test');
  });

  it('forwards a GET (e.g. /models) with no body', async () => {
    process.env.EVOMAP_OPENAI_API_KEY = 'sk-upstream';
    const res = await proxy._proxyOpenAIResponses('/models', null, { method: 'GET', inboundHeaders: {} });
    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, '/v1/models');
    assert.equal(captured[0].method, 'GET');
    assert.equal(captured[0].rawBody, '');                       // GET must send NO body
    const body = await res.json();
    assert.equal(body.data[0].id, 'gpt-4o');                     // model list returned
  });

  it('does not use inbound x-api-key as an OpenAI upstream credential', async () => {
    process.env.EVOMAP_OPENAI_API_KEY = 'sk-upstream';
    const res = await proxy._proxyOpenAIResponses('/responses', { model: 'gpt-5.5', input: 'hi' }, {
      inboundHeaders: {
        'x-api-key': 'proxy-token-should-stay-local',
        'openai-api-key': 'client-key-should-stay-local',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(captured[0].headers.authorization, 'Bearer sk-upstream');
    assert.equal(captured[0].headers['x-api-key'], undefined);
    assert.equal(captured[0].headers['openai-api-key'], undefined);
  });

  it('fails closed when called directly without a daemon OpenAI key', async () => {
    await assert.rejects(
      () => proxy._proxyOpenAIResponses('/responses', { model: 'gpt-5.5', input: 'hi' }, {
        inboundHeaders: { 'x-api-key': 'proxy-token-should-stay-local' },
      }),
      (err) => err.statusCode === 401 && /openai api key required/.test(err.message),
    );
    assert.equal(captured.length, 0);
  });

  it('returns a stream for event-stream Responses API output', async () => {
    process.env.OPENAI_API_KEY = 'sk-upstream';
    const res = await proxy._proxyOpenAIResponses('/responses-stream', { model: 'gpt-5.5', stream: true }, {
      inboundHeaders: {},
    });

    assert.equal(res.status, 200);
    assert.ok(res.stream, 'stream must be present');
    let collected = '';
    for await (const chunk of res.stream) {
      collected += Buffer.from(chunk).toString();
    }
    assert.match(collected, /response\.created/);
  });

  it('does not abort an SSE stream after response headers arrive', async () => {
    process.env.OPENAI_API_KEY = 'sk-upstream';
    const res = await proxy._proxyOpenAIResponses('/responses-slow-stream', { model: 'gpt-5.5', stream: true }, {
      inboundHeaders: {},
      timeoutMs: SLOW_STREAM_TIMEOUT_MS,
    });

    let collected = '';
    for await (const chunk of res.stream) {
      collected += Buffer.from(chunk).toString();
    }
    assert.match(collected, /response\.created/);
    assert.match(collected, /response\.completed/);
  });

  it('maps upstream header timeout to a gateway timeout', async () => {
    process.env.OPENAI_API_KEY = 'sk-upstream';
    await assert.rejects(
      () => proxy._proxyOpenAIResponses('/responses-timeout', { model: 'gpt-5.5' }, {
        inboundHeaders: {},
        timeoutMs: 20,
      }),
      (err) => err.statusCode === 504 && /timed out/.test(err.message),
    );
  });

  it('rejects unsafe EVOMAP_OPENAI_BASE_URL values on the Responses path', async () => {
    process.env.EVOMAP_OPENAI_BASE_URL = 'http://127.0.0.1:65535/v1';
    process.env.OPENAI_API_KEY = 'sk-upstream';
    const unsafeProxy = new EvoMapProxy({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
    await assert.rejects(
      () => unsafeProxy._proxyOpenAIResponses('/responses', { model: 'gpt-5.5', input: 'hi' }, { inboundHeaders: {} }),
      /EVOMAP_OPENAI_BASE_URL must be an OpenAI or known OpenAI-compatible https \/v1 endpoint/,
    );
  });

  it('rejects confusing OpenAI base URL shapes from environment', async () => {
    process.env.OPENAI_API_KEY = 'sk-upstream';
    for (const raw of [
      'https://api.openai.com.evil.test/v1',
      'https://api.openai.com/v1?x=1',
      'https://api.openai.com/v1#x',
      'https://user:pass@api.openai.com/v1',
      'https://api.openai.com/anything',
    ]) {
      process.env.EVOMAP_OPENAI_BASE_URL = raw;
      const unsafeProxy = new EvoMapProxy({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
      await assert.rejects(
        () => unsafeProxy._proxyOpenAIResponses('/responses', { model: 'gpt-5.5', input: raw }, { inboundHeaders: {} }),
        /EVOMAP_OPENAI_BASE_URL must be an OpenAI or known OpenAI-compatible https \/v1 endpoint/,
      );
    }
  });

  it('accepts OpenAI regional HTTPS base URLs from environment', () => {
    assert.equal(resolveOpenAIBaseUrl('https://us.api.openai.com/v1/'), 'https://us.api.openai.com/v1');
  });

  it('accepts the MiniMax OpenAI-compatible base URL from environment', () => {
    assert.equal(resolveOpenAIBaseUrl('https://api.minimax.io/v1/'), 'https://api.minimax.io/v1');
  });
});
