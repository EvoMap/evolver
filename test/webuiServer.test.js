'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { WebUiServer } = require('../src/webui');

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: raw });
      });
    }).on('error', reject);
  });
}

describe('WebUiServer', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = new WebUiServer({
      port: 39921,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
    });
    const info = await server.start();
    baseUrl = info.url;
  });

  after(async () => {
    await server.stop();
  });

  it('serves the dashboard shell', async () => {
    const res = await request(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Evolver Web UI/);
    // Dashboard must load echarts from the vendored local route, not from a
    // third-party CDN. Privacy + offline-availability requirement.
    assert.match(res.body, /<script src="\/vendor\/echarts\.min\.js"><\/script>/);
    assert.doesNotMatch(res.body, /cdn\.jsdelivr\.net|unpkg\.com/);
  });

  it('serves the vendored echarts bundle with the Apache-2.0 header', async () => {
    const res = await request(`${baseUrl}/vendor/echarts.min.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/javascript/);
    // First-line ASF license banner is preserved by the upstream minifier;
    // its presence is a cheap integrity hint that we shipped the real file
    // (and a license-attribution check).
    assert.match(res.body.slice(0, 200), /Apache Software Foundation/);
    assert.ok(res.body.length > 500000, 'vendored echarts looks truncated');
  });

  it('serves read-only status API with structured JSON', async () => {
    const res = await request(`${baseUrl}/webui/status`);
    const body = JSON.parse(res.body);
    assert.equal(res.status, 200);
    assert.ok(body.safety);
    assert.ok(body.filesPresent);
  });

  it('uses structured API errors', async () => {
    const res = await request(`${baseUrl}/webui/runs/missing-run-id`);
    const body = JSON.parse(res.body);
    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'RUN_NOT_FOUND');
  });

  it('does not ship the kv-then-partial-replace HTML escape antipattern', async () => {
    // Cursor Bugbot Medium-severity finding on PR #532: passing a raw
    // <span> through kv() / esc() and then trying to undo the escape
    // with .replace(/&lt;span/g, ...).replace(/&lt;\\/span&gt;/g, ...)
    // leaves &quot; (from the class attribute) and &gt; (from the
    // opening tag terminator) intact, so the status indicator never
    // renders. The fix is to build the <dl> manually with esc()'d text
    // and inject the indicator span as real HTML. This guard catches
    // any future regression that brings the kv()+partial-replace dance
    // back -- the bundled client JS must not contain it.
    const res = await request(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(
      res.body,
      /\.replace\(\s*\/&lt;span/,
      'kv-then-partial-replace antipattern reintroduced; rebuild the dl manually instead',
    );
  });

  it('survives malformed percent escapes in path segments with a clean 404', async () => {
    // Cursor agentic security review (HIGH): matchPath used to call
    // decodeURIComponent without a try/catch, so a request like
    // /webui/runs/%E0%A4%A would throw URIError outside _handle's
    // try/catch and trip Node's unhandled-rejection policy, taking the
    // local WebUI down. The fix is to treat malformed segments as
    // "no route matches" -> clean 404.
    const res = await request(`${baseUrl}/webui/runs/%E0%A4%A`);
    assert.equal(res.status, 404, 'malformed escape must 404, not crash');
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('does not ship echarts.init() outside ensureChart() in pipelines.js', async () => {
    // Cursor Bugbot Medium-severity findings on this PR: renderScoreTrend
    // and renderRunGraph called echarts.init() directly, leaking instances
    // that disposeAllCharts() (theme/locale toggle) and the window-resize
    // handler can't see. Every chart must go through ensureChart() so the
    // instance is tracked in state.charts. This guard pins the rule on
    // the bundled client JS for the pipelines tab.
    const res = await request(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    // pipelines.js is concatenated into the bundle; ensureChart('runGraph')
    // and ensureChart('scoreTrendChart') must both appear, and no raw
    // echarts.init( call for either chart container must remain.
    assert.match(res.body, /ensureChart\(['"]runGraph['"]\)/);
    assert.match(res.body, /ensureChart\(['"]scoreTrendChart['"]\)/);
    // Allow the ensureChart definition itself (which legitimately uses
    // echarts.init), but reject any other call site that hits init().
    const initSites = res.body.match(/echarts\.init\(/g) || [];
    assert.equal(
      initSites.length, 1,
      `expected exactly one echarts.init( site (the ensureChart() definition), found ${initSites.length}`,
    );
  });

  it('isDarkMode trusts the .dark class as the only source of truth', async () => {
    // Cursor Bugbot Medium-severity finding on this PR: isDarkMode() used
    // to fall back to matchMedia('prefers-color-scheme: dark') when .dark
    // was absent. On a dark-OS system, toggling to light removed .dark but
    // matchMedia still returned true, so chartTextColor() rendered light
    // text on a light background. The single-source-of-truth fix is to
    // return only the class check; THEME_INIT_SCRIPT pre-resolves the
    // light/dark/system tri-state into the class before any JS runs.
    const res = await request(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(
      res.body,
      /matchMedia\(['"]\(prefers-color-scheme:\s*dark\)['"]\)\.matches/,
      'isDarkMode() must not fall back to matchMedia; the class is canonical',
    );
  });

  it('Hub Activity table escapes every dynamic cell (no asymmetric trust)', async () => {
    // Cursor Bugbot Low-severity finding (2026-05-10 round): the Hub
    // Activity table row in interactions.js esc()'d every column EXCEPT
    // e.statusCode and e.latencyMs, on the assumption they were always
    // numeric. The proxy daemon has historically leaked string shapes
    // there ('timeout', 'n/a', ...) so the asymmetric trust was an
    // injection seam. Every dynamic cell in this table must now flow
    // through esc(). Guard the bundled /app.js fingerprint so any
    // future refactor that drops the esc() wrap immediately fails the
    // suite.
    const res = await request(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    assert.match(
      res.body,
      /esc\(e\.statusCode/,
      'e.statusCode must be wrapped in esc() inside the Hub Activity table renderer',
    );
    assert.match(
      res.body,
      /esc\(e\.latencyMs/,
      'e.latencyMs must be wrapped in esc() inside the Hub Activity table renderer',
    );
  });

  it('Pipelines view ships a #scoreTrendChart container so renderScoreTrend is reachable', async () => {
    // Cursor Bugbot Medium-severity finding (2026-05-10 round):
    // renderScoreTrend in pipelines.js looks up
    // document.getElementById('scoreTrendChart'), but the pipelines
    // <section> in indexHtml.js never shipped the element. The function
    // always short-circuited at `if (!el) return`, so the score trend
    // chart feature was silently dead code. Pin both sides of the
    // contract: the dashboard shell must ship the container, and the
    // bundled client JS must call ensureChart('scoreTrendChart') (the
    // latter is already covered by the ensureChart pin above, but we
    // also assert the i18n key for the card title in both locales so
    // the AGENTS.md "every new i18n key lives in en + zh" invariant
    // cannot drift back).
    const shell = await request(`${baseUrl}/`);
    assert.equal(shell.status, 200);
    assert.match(
      shell.body,
      /id="scoreTrendChart"/,
      'pipelines view must ship the <div id="scoreTrendChart"> container',
    );
    assert.match(
      shell.body,
      /data-i18n="pipelines\.card\.scoreTrend"/,
      'Score Trend card heading must carry the i18n marker',
    );

    const js = await request(`${baseUrl}/app.js`);
    assert.equal(js.status, 200);
    assert.match(
      js.body,
      /'pipelines\.card\.scoreTrend'\s*:\s*\{\s*en:\s*'Score Trend',\s*zh:\s*'评分趋势'\s*\}/,
      'pipelines.card.scoreTrend must be present in both en and zh dicts',
    );
  });
});

describe('WebUiServer onRequest hook', () => {
  // Default-mode supervisor wiring relies on per-request poke() to bound
  // user-perceived heartbeat recovery to ~60s after long idle / sleep.
  // Without the onRequest hook, the user could open the dashboard and
  // still wait up to 30-60s for the supervisor's drift / liveness
  // intervals to fire. Pin the contract here so a future refactor that
  // drops the hook fails the suite instead of silently degrading.

  it('fires onRequest before route dispatch for every incoming request', async () => {
    const calls = [];
    const server = new WebUiServer({
      port: 39931,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      onRequest: (req, url) => calls.push({ method: req.method, path: url.pathname }),
    });
    try {
      const info = await server.start();
      await request(`${info.url}/`);
      await request(`${info.url}/webui/status`);
      await request(`${info.url}/this/path/does/not/exist`);
      assert.equal(calls.length, 3, 'onRequest must fire for every request, including 404s');
      assert.equal(calls[0].path, '/');
      assert.equal(calls[1].path, '/webui/status');
      assert.equal(calls[2].path, '/this/path/does/not/exist');
    } finally {
      await server.stop();
    }
  });

  it('a throwing onRequest does not break request handling', async () => {
    const server = new WebUiServer({
      port: 39932,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      onRequest: () => { throw new Error('synthetic hook failure'); },
    });
    try {
      const info = await server.start();
      const res = await request(`${info.url}/`);
      assert.equal(res.status, 200, 'a throwing onRequest must not break requests');
    } finally {
      await server.stop();
    }
  });
});
