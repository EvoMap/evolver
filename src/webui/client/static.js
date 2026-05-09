'use strict';

function getIndexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Evolver Web UI</title>
  <link rel="stylesheet" href="/app.css">
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">EvoMap Evolver</p>
      <h1>Web UI Observability</h1>
    </div>
    <nav class="tabs">
      <button class="tab active" data-tab="overview">Overview</button>
      <button class="tab" data-tab="pipelines">Pipelines</button>
      <button class="tab" data-tab="assets">Assets</button>
      <button class="tab" data-tab="interactions">Interactions</button>
      <button class="tab" data-tab="personality">Personality</button>
    </nav>
    <button id="refresh">Refresh</button>
  </header>
  <main>
    <section data-view="overview" class="view active">
      <div class="grid-top">
        <div class="panel"><h2>Status</h2><div id="status">Loading...</div></div>
        <div class="panel"><h2>Safety</h2><div id="safety">Loading...</div></div>
        <div class="panel"><h2>Interactions</h2><div id="interactions">Loading...</div></div>
      </div>
      <div class="grid-charts">
        <div class="panel"><h2>Genes by Category</h2><div id="genesChart" class="chart-container"></div></div>
        <div class="panel"><h2>Capsules by Outcome</h2><div id="capsulesChart" class="chart-container"></div></div>
        <div class="panel"><h2>Asset Calls</h2><div id="callsChart" class="chart-container"></div></div>
      </div>
      <div class="grid-bottom">
        <div class="panel">
          <h2>Latest Pipeline Run</h2>
          <div id="latest-run">Loading...</div>
        </div>
        <div class="panel">
          <h2>Skills</h2>
          <div id="skills">Loading...</div>
        </div>
      </div>
    </section>

    <section data-view="pipelines" class="view">
      <div class="grid-bottom">
        <div class="panel">
          <h2>Pipeline Runs</h2>
          <div class="table-wrapper">
            <table id="runsTable">
              <thead><tr><th>Run ID</th><th>Status</th><th>Gene</th><th>Updated</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <h2>Run Trace</h2>
          <div id="run-detail"><p style="color: var(--text-muted)">Select a run to inspect its trace.</p></div>
        </div>
      </div>
    </section>

    <section data-view="assets" class="view">
      <div class="asset-tabs">
        <button class="asset-tab active" data-asset="genes">Genes</button>
        <button class="asset-tab" data-asset="capsules">Capsules</button>
        <button class="asset-tab" data-asset="events">Events</button>
        <button class="asset-tab" data-asset="candidates">Candidates</button>
        <button class="asset-tab" data-asset="calls">Asset Calls</button>
      </div>
      <div class="panel">
        <div id="asset-list">Loading...</div>
      </div>
    </section>

    <section data-view="interactions" class="view">
      <div class="grid-charts">
        <div class="panel"><h2>Hub A2A by Action</h2><div id="hubActionChart" class="chart-container"></div></div>
        <div class="panel"><h2>Activity (last 30 days)</h2><div id="activityChart" class="chart-container"></div></div>
        <div class="panel"><h2>Mailbox by Type</h2><div id="mailboxChart" class="chart-container"></div></div>
      </div>
      <div class="grid-bottom">
        <div class="panel">
          <h2>Hub A2A Stream</h2>
          <p class="muted small" style="margin:-8px 0 12px 0">Asset calls and ATP proofs/orders exchanged with the Hub.</p>
          <div id="hub-stream">Loading...</div>
        </div>
        <div class="panel">
          <h2>Agent Interactions</h2>
          <p class="muted small" style="margin:-8px 0 12px 0">Mailbox messages, sessions and DMs (read-only, redacted).</p>
          <div id="agent-stream">Loading...</div>
        </div>
      </div>
      <div class="panel">
        <h2>Proxy Snapshots</h2>
        <div id="proxy-snapshots" class="snapshot-grid">Loading...</div>
      </div>
    </section>

    <section data-view="personality" class="view">
      <div class="grid-charts">
        <div class="panel"><h2>Personality Traits</h2><div id="personalityChart" class="chart-container" style="height: 320px"></div></div>
        <div class="panel"><h2>Personality Detail</h2><div id="personality-detail">Loading...</div></div>
      </div>
      <div class="panel">
        <h2>Memory Graph (last 100 events)</h2>
        <div id="memory-graph-chart" class="chart-container" style="height: 480px"></div>
      </div>
    </section>
  </main>
  <script src="/app.js"></script>
</body>
</html>`;
}

function getClientJs() {
  return `
const state = { selectedRunId: null, charts: {}, currentTab: 'overview', currentAsset: 'genes' };
const $ = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || 'Request failed');
  return body;
}

function isDarkMode() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function chartTextColor() {
  return isDarkMode() ? '#c7d0d9' : '#5c6975';
}

function ensureChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (!state.charts[id]) state.charts[id] = echarts.init(el);
  return state.charts[id];
}

function getStatusClass(status) {
  if (status === 'success' || status === 'completed') return 'status-success';
  if (status === 'running' || status === 'pending') return 'status-running';
  if (status === 'failed') return 'status-failed';
  if (status === 'blocked' || status === 'review_pending') return 'status-blocked';
  if (status === 'selected') return 'status-running';
  return 'status-skipped';
}

function kv(rows) {
  return '<dl>' + rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(format(v)) + '</dd>').join('') + '</dl>';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function format(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function formatTime(value) {
  if (!value) return '-';
  const t = new Date(value);
  if (isNaN(t.getTime()) || t.getTime() === 0) return '-';
  return t.toLocaleString();
}

function pillList(items, kind) {
  if (!items || !items.length) return '<span class="muted">none</span>';
  return items.map((item) => '<span class="pill ' + (kind || '') + '">' + esc(item) + '</span>').join(' ');
}

// ---- Overview ----

function renderStatus(status) {
  const lastRun = status.lastRun || {};
  $('status').innerHTML = kv([
    ['Mode', status.mode],
    ['Proxy', status.proxy?.running ? 'running' : 'not running'],
    ['Heartbeat', status.heartbeat?.phase || 'idle'],
    ['Last run', lastRun.run_id || '-'],
    ['Last activity', formatTime(lastRun.finished_at || lastRun.created_at)],
  ]);
}

function renderSafety(safety) {
  const warnings = safety.warnings?.length
    ? '<ul style="margin-top:8px;padding-left:20px;color:var(--warning)">' + safety.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>'
    : '<p style="margin-top:8px;color:var(--success)">No unsafe automation flags detected.</p>';
  $('safety').innerHTML = '<div style="margin-bottom:8px"><span class="status-indicator ' + (safety.safeMode ? 'status-success' : 'status-warning') + '"></span><strong>' + (safety.safeMode ? 'Safe mode' : 'Review required') + '</strong></div>' + kv([
    ['Autobuy', safety.autobuyEnabled],
    ['Auto publish', safety.autoPublishEnabled],
    ['Validator', safety.validatorEnabled],
    ['Trace level', safety.traceLevel],
  ]) + warnings;
}

function renderInteractions(interactions) {
  $('interactions').innerHTML = kv([
    ['Proxy', interactions.proxy?.running ? interactions.proxy.url : 'not running'],
    ['Mailbox messages', interactions.mailbox?.pagination?.totalItems || 0],
    ['Task metrics', interactions.proxySnapshots?.taskMetrics?.ok ? 'available' : 'not available'],
    ['Sessions', interactions.proxySnapshots?.sessions?.ok ? 'available' : 'not available'],
  ]);
}

function renderOverviewCharts(assets) {
  const isDark = isDarkMode();
  const textColor = chartTextColor();
  const palette = ['#3274d9', '#28a745', '#ffc107', '#dc3545', '#6f42c1', '#17a2b8'];

  ensureChart('genesChart')?.setOption({
    color: palette,
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: textColor } },
    series: [{
      type: 'pie',
      radius: ['45%', '72%'],
      itemStyle: { borderRadius: 4, borderColor: isDark ? '#181b1f' : '#fff', borderWidth: 2 },
      label: { color: textColor, formatter: '{b}: {c}' },
      data: Object.entries(assets.genesByCategory || {}).map(([name, value]) => ({ name, value })),
    }],
  });

  const capsules = Object.entries(assets.capsulesByOutcome || {});
  ensureChart('capsulesChart')?.setOption({
    color: palette,
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: textColor } },
    series: [{
      type: 'pie',
      radius: ['45%', '72%'],
      itemStyle: { borderRadius: 4, borderColor: isDark ? '#181b1f' : '#fff', borderWidth: 2 },
      label: { color: textColor },
      data: capsules.length ? capsules.map(([name, value]) => ({ name, value })) : [{ name: 'no capsules yet', value: 1, itemStyle: { color: '#444' } }],
    }],
  });

  const calls = Object.entries(assets.assetCallsByAction || {});
  ensureChart('callsChart')?.setOption({
    color: palette,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: '3%', right: '4%', bottom: '5%', containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: isDark ? '#2c3235' : '#e4e7eb' } }, axisLabel: { color: textColor } },
    yAxis: { type: 'category', data: calls.length ? calls.map(d => d[0]) : ['no calls'], axisLabel: { color: textColor } },
    series: [{
      type: 'bar',
      data: calls.length ? calls.map(d => d[1]) : [0],
      itemStyle: { color: '#3274d9', borderRadius: [0, 4, 4, 0] },
    }],
  });
}

function renderLatestRun(runs) {
  const list = runs.data || [];
  if (!list.length) {
    $('latest-run').innerHTML = '<p class="muted">No runs recorded yet.</p>';
    return;
  }
  const run = list[0];
  $('latest-run').innerHTML = kv([
    ['Run ID', run.runId],
    ['Status', '<span class="status-indicator ' + getStatusClass(run.status) + '"></span>' + run.status],
    ['Selected Gene', run.selectedGeneId || '-'],
    ['Validation', run.validationResult || 'unknown'],
    ['Updated', formatTime(run.updatedAt)],
    ['Requires confirmation', run.requiresConfirmation ? 'yes' : 'no'],
  ]).replace(/&lt;span/g, '<span').replace(/&lt;\\/span&gt;/g, '</span>');
}

function renderSkills(skills) {
  if (!skills.exists || !skills.items.length) {
    $('skills').innerHTML = '<p class="muted">No local skills installed yet.</p>';
    return;
  }
  $('skills').innerHTML = '<ul class="skill-list">' + skills.items.map((skill) =>
    '<li><strong>' + esc(skill.name) + '</strong>' +
    (skill.description ? '<p>' + esc(skill.description) + '</p>' : '') +
    '<small class="muted">' + skill.fileCount + ' files · ' + (skill.docFile || 'no doc') + '</small></li>'
  ).join('') + '</ul>';
}

// ---- Pipelines ----

function renderRuns(result) {
  const runs = result.data || [];
  const tbody = document.querySelector('#runsTable tbody');
  if (!runs.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No runs recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = runs.map((run) =>
    '<tr data-run="' + esc(run.runId) + '">' +
    '<td><strong>' + esc(run.runId) + '</strong></td>' +
    '<td><span class="status-indicator ' + getStatusClass(run.status) + '"></span>' + esc(run.status) + '</td>' +
    '<td>' + esc(run.selectedGeneId || '-') + '</td>' +
    '<td>' + esc(formatTime(run.updatedAt)) + '</td>' +
    '</tr>'
  ).join('');
  document.querySelectorAll('#runsTable tbody tr[data-run]').forEach((tr) => {
    tr.addEventListener('click', () => loadRun(tr.getAttribute('data-run')));
  });
}

function renderRunDetail(run) {
  const phases = run.phases || [];
  const detail = run.detail || {};

  let html = '<div class="run-header">' +
    '<h3>' + esc(run.runId) + '</h3>' +
    '<div class="run-meta">' +
    '<span>Status: <span class="status-indicator ' + getStatusClass(run.status) + '"></span><strong>' + esc(run.status) + '</strong></span>' +
    '<span>Gene: <strong>' + esc(run.selectedGeneId || '-') + '</strong></span>' +
    '<span>Updated: <strong>' + esc(formatTime(run.updatedAt)) + '</strong></span>' +
    '</div></div>';

  html += '<div class="run-body">';

  // Left: timeline
  html += '<div><h4>Pipeline Timeline</h4><ul class="timeline">';
  html += phases.map((phase) => {
    const cls = phase.status === 'success' ? 'success' :
                phase.status === 'failed' ? 'failed' :
                phase.status === 'running' || phase.status === 'pending' ? 'running' :
                phase.status === 'blocked' ? 'blocked' : '';
    return '<li class="' + cls + '">' +
      '<div class="timeline-title">' + esc(phase.phase) + ' <span class="muted small">' + esc(phase.status) + '</span></div>' +
      '<p class="timeline-desc">' + esc(phase.summary) + '</p>' +
      '</li>';
  }).join('');
  html += '</ul></div>';

  // Right: graph
  html += '<div><h4>Run Graph</h4><div id="runGraph" class="chart-container" style="height: 360px;"></div></div>';

  html += '</div>';

  // Detail sections
  if (detail) {
    html += '<div class="run-detail-grid">';
    html += '<div class="detail-block"><h4>Signals</h4>' + pillList(detail.signals, 'signal') + '</div>';
    if (detail.selector) {
      html += '<div class="detail-block"><h4>Selector reasoning</h4>' +
        kv([
          ['Selected', detail.selector.selected],
          ['Path', detail.selector.selectionPath || detail.selector.selection_path],
          ['Memory used', detail.selector.memoryUsed || detail.selector.memory_used],
        ]) +
        '<ul class="reason-list">' + (detail.selector.reason || []).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
        '</div>';
    }
    if (detail.mutation) {
      html += '<div class="detail-block"><h4>Mutation</h4>' + kv([
        ['ID', detail.mutation.id],
        ['Category', detail.mutation.category],
        ['Target type', detail.mutation.targetType],
        ['Strategy steps', detail.mutation.strategySteps],
        ['Trigger signals', (detail.mutation.triggerSignals || []).join(', ') || '-'],
      ]) + '</div>';
    }
    if (detail.blastRadius) {
      html += '<div class="detail-block"><h4>Blast radius</h4>' + kv([
        ['Files', detail.blastRadius.files],
        ['Lines', detail.blastRadius.lines],
        ['Risk', detail.blastRadius.risk_level || detail.blastRadius.risk],
      ]) + '</div>';
    }
    if (detail.personalityState) {
      html += '<div class="detail-block"><h4>Personality at run</h4>' + kv(
        Object.entries(detail.personalityState).slice(0, 8)
      ) + '</div>';
    }
    if (detail.initialUserPrompt) {
      html += '<div class="detail-block"><h4>Initial user prompt</h4><pre class="snippet">' + esc(detail.initialUserPrompt) + '</pre></div>';
    }
    html += '</div>';
  }

  $('run-detail').innerHTML = html;

  // Render run graph
  setTimeout(() => {
    const chartEl = document.getElementById('runGraph');
    if (!chartEl) return;
    const chart = echarts.init(chartEl);
    const textColor = chartTextColor();
    const isDark = isDarkMode();

    const nodes = [{ id: 'Run', name: 'Run\\n' + run.runId.slice(-8), symbolSize: 56, itemStyle: { color: '#3274d9' }, category: 0 }];
    const edges = [];
    const categories = [{ name: 'Run' }, { name: 'Gene' }, { name: 'Signal' }, { name: 'Event' }, { name: 'Asset' }];

    if (run.selectedGeneId) {
      nodes.push({ id: 'Gene', name: 'Gene\\n' + run.selectedGeneId.replace('gene_gep_', ''), symbolSize: 44, itemStyle: { color: '#28a745' }, category: 1 });
      edges.push({ source: 'Run', target: 'Gene' });
    }
    (detail.signals || []).slice(0, 6).forEach((sig, i) => {
      const id = 'Sig' + i;
      nodes.push({ id, name: sig, symbolSize: 30, itemStyle: { color: '#ffc107' }, category: 2 });
      edges.push({ source: id, target: 'Run' });
      if (run.selectedGeneId) edges.push({ source: id, target: 'Gene', lineStyle: { type: 'dashed' } });
    });
    (run.evidence || []).slice(0, 5).forEach((ev, i) => {
      const id = 'Ev' + i;
      nodes.push({ id, name: 'Event\\n' + (ev.id || '').slice(-6), symbolSize: 28, itemStyle: { color: '#dc3545' }, category: 3 });
      edges.push({ source: 'Run', target: id });
    });
    (run.assets || []).slice(0, 5).forEach((a, i) => {
      const id = 'Ast' + i;
      nodes.push({ id, name: a.action || 'asset', symbolSize: 26, itemStyle: { color: '#6f42c1' }, category: 4 });
      edges.push({ source: 'Run', target: id });
    });

    chart.setOption({
      tooltip: {},
      legend: { data: categories.map(c => c.name), bottom: 0, textStyle: { color: textColor } },
      series: [{
        type: 'graph',
        layout: 'force',
        data: nodes,
        links: edges,
        categories,
        roam: true,
        label: { show: true, color: textColor, fontSize: 10 },
        lineStyle: { color: isDark ? '#5c6975' : '#cdd3da', width: 1.5, curveness: 0.15 },
        force: { repulsion: 220, edgeLength: 90 },
      }],
    });
  }, 0);
}

async function loadRun(runId) {
  state.selectedRunId = runId;
  $('run-detail').innerHTML = '<p class="muted">Loading trace...</p>';
  try {
    const run = await api('/webui/runs/' + encodeURIComponent(runId));
    renderRunDetail(run);
  } catch (err) {
    $('run-detail').innerHTML = '<p class="status-failed">Failed to load run: ' + esc(err.message) + '</p>';
  }
}

// ---- Assets ----

const ASSET_RENDERERS = {
  genes: (data) => '<table class="data-table"><thead><tr><th>ID</th><th>Category</th><th>Signals</th><th>Strategy</th><th>Validation</th></tr></thead><tbody>' +
    data.map((g) => '<tr><td><strong>' + esc(g.id) + '</strong></td>' +
      '<td><span class="pill ' + esc(g.category) + '">' + esc(g.category) + '</span></td>' +
      '<td>' + pillList(g.signals_match || [], 'signal') + '</td>' +
      '<td><details><summary>' + (g.strategy?.length || 0) + ' steps</summary><ol class="reason-list">' + (g.strategy || []).map(s => '<li>' + esc(s) + '</li>').join('') + '</ol></details></td>' +
      '<td><details><summary>' + (g.validation?.length || 0) + ' cmd(s)</summary><ul class="reason-list">' + (g.validation || []).map(s => '<li><code>' + esc(s) + '</code></li>').join('') + '</ul></details></td>' +
      '</tr>').join('') +
    '</tbody></table>',

  capsules: (data) => data.length
    ? '<table class="data-table"><thead><tr><th>ID</th><th>Gene</th><th>Outcome</th><th>Confidence</th><th>Blast</th></tr></thead><tbody>' +
      data.map((c) => '<tr><td><strong>' + esc(c.id) + '</strong></td><td>' + esc(c.gene || '-') + '</td>' +
        '<td><span class="status-indicator ' + getStatusClass(c.outcome?.status) + '"></span>' + esc(c.outcome?.status || '-') + '</td>' +
        '<td>' + esc(c.confidence ?? '-') + '</td>' +
        '<td>' + esc((c.blast_radius?.files ?? '-') + '/' + (c.blast_radius?.lines ?? '-')) + '</td>' +
        '</tr>').join('') +
      '</tbody></table>'
    : '<p class="muted">No capsules yet. Capsules are created after a successful solidify.</p>',

  events: (data) => data.length
    ? '<ul class="event-list">' + data.map((e) => '<li>' +
      '<div><strong>' + esc(e.id || '-') + '</strong> <span class="muted small">' + esc(formatTime(e.timestamp || e.created_at)) + '</span></div>' +
      '<div>signals: ' + pillList(e.signals || e.signals_matched || [], 'signal') + '</div>' +
      '<div>genes_used: ' + pillList(e.genes_used || [], '') + '</div>' +
      '<div>outcome: <span class="status-indicator ' + getStatusClass(e.outcome?.status) + '"></span>' + esc(e.outcome?.status || '-') + '</div>' +
      '</li>').join('') + '</ul>'
    : '<p class="muted">No solidified events yet. Run <code>evolver solidify</code> to produce events.</p>',

  candidates: (data) => data.length
    ? '<table class="data-table"><thead><tr><th>Source</th><th>Asset ID</th><th>Score</th><th>Time</th></tr></thead><tbody>' +
      data.map((c) => '<tr><td>' + esc(c.source || c.source_node_id || '-') + '</td>' +
        '<td><code>' + esc(c.asset_id || c.id || '-') + '</code></td>' +
        '<td>' + esc(c.score ?? '-') + '</td>' +
        '<td>' + esc(formatTime(c.timestamp)) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<p class="muted">No candidates collected yet.</p>',

  calls: (data) => data.length
    ? '<table class="data-table"><thead><tr><th>Time</th><th>Action</th><th>Asset</th><th>Run</th><th>Score</th></tr></thead><tbody>' +
      data.map((c) => '<tr><td>' + esc(formatTime(c.timestamp)) + '</td>' +
        '<td><span class="pill ' + esc(c.action) + '">' + esc(c.action) + '</span></td>' +
        '<td><code>' + esc(c.asset_id || '-') + '</code></td>' +
        '<td>' + esc(c.run_id || '-') + '</td>' +
        '<td>' + esc(c.score ?? '-') + '</td></tr>').join('') +
      '</tbody></table>'
    : '<p class="muted">No asset calls recorded.</p>',
};

const ASSET_ENDPOINTS = {
  genes: '/webui/assets/genes',
  capsules: '/webui/assets/capsules',
  events: '/webui/assets/events',
  candidates: '/webui/assets/candidates',
  calls: '/webui/assets/calls',
};

async function loadAsset(kind) {
  state.currentAsset = kind;
  $('asset-list').innerHTML = '<p class="muted">Loading ' + esc(kind) + '...</p>';
  document.querySelectorAll('.asset-tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-asset') === kind));
  try {
    const result = await api(ASSET_ENDPOINTS[kind] + '?limit=200');
    const renderer = ASSET_RENDERERS[kind];
    const total = result.pagination?.totalItems ?? (result.data || []).length;
    $('asset-list').innerHTML =
      '<div class="muted small" style="margin-bottom:12px">' + total + ' record(s)</div>' +
      renderer(result.data || []);
  } catch (err) {
    $('asset-list').innerHTML = '<p class="status-failed">Failed: ' + esc(err.message) + '</p>';
  }
}

// ---- Interactions (Hub A2A + Agent) ----

function renderHubStream(calls, atpProofs, atpOrders) {
  const items = [];
  (calls || []).forEach((c) => items.push({
    kind: 'asset',
    time: c.timestamp,
    action: c.action,
    title: c.asset_id || '-',
    meta: 'run ' + (c.run_id || '-') + (c.score != null ? ' · score ' + c.score : ''),
    detail: c,
  }));
  (atpProofs || []).forEach((p) => items.push({
    kind: 'atp_proof',
    time: p.created_at || p.timestamp,
    action: 'atp_' + (p.status || 'proof'),
    title: p.delivery_id || p.order_id || '-',
    meta: (p.role || 'consumer') + ' · ' + (p.amount != null ? p.amount + ' credits' : '-'),
    detail: p,
  }));
  (atpOrders || []).forEach((o) => items.push({
    kind: 'atp_order',
    time: o.created_at || o.updated_at,
    action: 'atp_order_' + (o.status || 'pending'),
    title: o.order_id || o.id || '-',
    meta: (o.routing || '-') + ' · ' + (o.budget != null ? o.budget + ' credits' : '-'),
    detail: o,
  }));

  if (!items.length) {
    $('hub-stream').innerHTML = '<p class="muted">No Hub interactions recorded yet. Run <code>evolver run</code> or place an ATP order to populate.</p>';
    return;
  }
  items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  $('hub-stream').innerHTML = '<ul class="stream-list">' + items.slice(0, 60).map(streamItem).join('') + '</ul>';
}

function renderAgentStream(mailbox, sessions, dms) {
  const items = [];
  (mailbox || []).forEach((m) => items.push({
    kind: 'mailbox',
    time: m.timestamp,
    action: 'mb_' + (m.direction || 'msg'),
    title: m.summary || m.type || '-',
    meta: (m.type || '-') + ' · ' + (m.status || '-'),
    detail: m,
  }));
  (sessions || []).forEach((s) => items.push({
    kind: 'session',
    time: s.created_at || s.updated_at,
    action: 'session_' + (s.status || 'active'),
    title: s.session_id || s.id || '-',
    meta: 'with ' + (s.peer || s.peer_node_id || '-'),
    detail: s,
  }));
  (dms || []).forEach((d) => items.push({
    kind: 'dm',
    time: d.created_at,
    action: 'dm_' + (d.direction || 'msg'),
    title: d.title || d.message_id || '-',
    meta: (d.from || '-') + ' → ' + (d.to || '-'),
    detail: d,
  }));

  if (!items.length) {
    $('agent-stream').innerHTML = '<p class="muted">No agent interactions yet.</p>';
    return;
  }
  items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  $('agent-stream').innerHTML = '<ul class="stream-list">' + items.slice(0, 60).map(streamItem).join('') + '</ul>';
}

function streamItem(item) {
  return '<li class="stream-item">' +
    '<div class="stream-head">' +
      '<span class="pill ' + esc(item.action) + '">' + esc(item.action) + '</span>' +
      '<span class="muted small">' + esc(formatTime(item.time)) + '</span>' +
    '</div>' +
    '<div class="stream-title">' + esc(item.title) + '</div>' +
    '<div class="muted small">' + esc(item.meta) + '</div>' +
    '</li>';
}

function renderInteractionCharts(calls, atpProofs, mailbox) {
  const textColor = chartTextColor();
  const isDark = isDarkMode();

  const actionCounts = {};
  (calls || []).forEach((c) => { actionCounts[c.action] = (actionCounts[c.action] || 0) + 1; });
  ensureChart('hubActionChart')?.setOption({
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie', radius: ['40%', '70%'],
      itemStyle: { borderRadius: 4, borderColor: isDark ? '#181b1f' : '#fff', borderWidth: 2 },
      label: { color: textColor, formatter: '{b}: {c}' },
      data: Object.keys(actionCounts).length
        ? Object.entries(actionCounts).map(([name, value]) => ({ name, value }))
        : [{ name: 'no calls', value: 1, itemStyle: { color: '#444' } }],
    }],
  });

  const dayBuckets = bucketByDay([...(calls || []), ...(atpProofs || []), ...(mailbox || [])], 30);
  ensureChart('activityChart')?.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '8%', containLabel: true },
    xAxis: { type: 'category', data: dayBuckets.labels, axisLabel: { color: textColor, fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: textColor }, splitLine: { lineStyle: { color: isDark ? '#2c3235' : '#e4e7eb' } } },
    series: [{
      type: 'line', data: dayBuckets.values, smooth: true, areaStyle: { opacity: 0.18, color: '#3274d9' },
      lineStyle: { color: '#3274d9', width: 2 }, itemStyle: { color: '#3274d9' },
    }],
  });

  const typeCounts = {};
  (mailbox || []).forEach((m) => { typeCounts[m.type || 'unknown'] = (typeCounts[m.type || 'unknown'] || 0) + 1; });
  ensureChart('mailboxChart')?.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '5%', containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: textColor }, splitLine: { lineStyle: { color: isDark ? '#2c3235' : '#e4e7eb' } } },
    yAxis: { type: 'category', data: Object.keys(typeCounts).length ? Object.keys(typeCounts) : ['no messages'], axisLabel: { color: textColor } },
    series: [{
      type: 'bar',
      data: Object.keys(typeCounts).length ? Object.values(typeCounts) : [0],
      itemStyle: { color: '#28a745', borderRadius: [0, 4, 4, 0] },
    }],
  });
}

function bucketByDay(items, days) {
  const today = new Date(); today.setHours(0,0,0,0);
  const labels = [], counts = new Array(days).fill(0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    labels.push((d.getMonth()+1) + '/' + d.getDate());
  }
  items.forEach((it) => {
    const t = new Date(it.timestamp || it.time || it.created_at || 0);
    if (isNaN(t.getTime())) return;
    t.setHours(0,0,0,0);
    const diff = Math.round((today - t) / 86400000);
    if (diff >= 0 && diff < days) counts[days - 1 - diff]++;
  });
  return { labels, values: counts };
}

function renderProxySnapshots(snapshots) {
  if (!snapshots || !Object.keys(snapshots).length) {
    $('proxy-snapshots').innerHTML = '<p class="muted snapshot-empty">Proxy not running. Start <code>evolver run</code> to enable live snapshots.</p>';
    return;
  }
  $('proxy-snapshots').innerHTML = Object.entries(snapshots).map(([key, snap]) => {
    const ok = snap?.ok;
    const dot = '<span class="status-indicator ' + (ok ? 'status-success' : 'status-failed') + '"></span>';
    const detail = ok && snap.body
      ? (Array.isArray(snap.body) ? snap.body.length + ' items' : Object.keys(snap.body).length + ' fields')
      : (snap?.error || 'unavailable');
    return '<div class="snapshot-card"><div>' + dot + '<strong>' + esc(key) + '</strong></div>' +
      '<div class="muted small">' + esc(detail) + '</div></div>';
  }).join('');
}

async function loadInteractions() {
  $('hub-stream').innerHTML = '<p class="muted">Loading...</p>';
  $('agent-stream').innerHTML = '<p class="muted">Loading...</p>';
  try {
    const [callsResult, interactions] = await Promise.all([
      api('/webui/assets/calls?limit=500'),
      api('/webui/interactions?last=200'),
    ]);
    const calls = callsResult.data || [];
    const proofs = interactions.proxySnapshots?.atpProofs?.body?.proofs || interactions.proxySnapshots?.atpProofs?.body || [];
    const orders = interactions.proxySnapshots?.atpProofs?.body?.orders || [];
    const sessions = interactions.proxySnapshots?.sessions?.body?.sessions || interactions.proxySnapshots?.sessions?.body || [];
    const dms = interactions.proxySnapshots?.dms?.body?.dms || interactions.proxySnapshots?.dms?.body || [];
    const mailbox = interactions.mailbox?.data || [];

    renderHubStream(calls, Array.isArray(proofs) ? proofs : [], Array.isArray(orders) ? orders : []);
    renderAgentStream(mailbox, Array.isArray(sessions) ? sessions : [], Array.isArray(dms) ? dms : []);
    renderInteractionCharts(calls, Array.isArray(proofs) ? proofs : [], mailbox);
    renderProxySnapshots(interactions.proxySnapshots);
  } catch (err) {
    $('hub-stream').innerHTML = '<p class="status-failed">Failed: ' + esc(err.message) + '</p>';
  }
}

// ---- Personality ----

function renderPersonality(personality, memoryGraph) {
  const current = personality.current || {};
  const traits = ['rigor', 'creativity', 'risk_tolerance', 'caution', 'curiosity', 'persistence'];
  const indicators = traits.filter((t) => current[t] !== undefined).map((name) => ({ name, max: 1 }));
  const values = indicators.map((ind) => Number(current[ind.name]) || 0);

  const textColor = chartTextColor();
  if (indicators.length) {
    ensureChart('personalityChart')?.setOption({
      tooltip: {},
      radar: {
        indicator: indicators,
        axisName: { color: textColor },
        splitLine: { lineStyle: { color: isDarkMode() ? '#2c3235' : '#e4e7eb' } },
        splitArea: { areaStyle: { color: ['rgba(50, 116, 217, 0.04)', 'rgba(50, 116, 217, 0.08)'] } },
      },
      series: [{
        type: 'radar',
        data: [{ value: values, name: 'current', areaStyle: { color: 'rgba(50, 116, 217, 0.4)' }, lineStyle: { color: '#3274d9' } }],
      }],
    });
  } else {
    $('personalityChart').innerHTML = '<p class="muted" style="padding:40px;text-align:center">No personality data yet.</p>';
  }

  $('personality-detail').innerHTML = current && Object.keys(current).length
    ? kv(Object.entries(current).slice(0, 12))
    : '<p class="muted">No personality data recorded yet.</p>';

  renderMemoryGraph(memoryGraph);
}

function renderMemoryGraph(graph) {
  const isDark = isDarkMode();
  const textColor = chartTextColor();
  if (!graph.exists || !graph.items.length) {
    $('memory-graph-chart').innerHTML = '<p class="muted" style="padding:40px;text-align:center">No memory graph events yet.</p>';
    return;
  }

  const items = graph.items.slice(0, 100);
  const nodes = new Map();
  const links = [];

  function addNode(id, label, color, category) {
    if (!id) return;
    if (!nodes.has(id)) nodes.set(id, { id, name: label || id, symbolSize: 20, itemStyle: { color }, category });
  }

  const KIND_COLORS = { signal: '#3274d9', hypothesis: '#17a2b8', attempt: '#ffc107', outcome: '#28a745', reflection: '#6f42c1' };

  items.forEach((evt) => {
    try {
      const eventId = 'evt_' + (evt.id || Math.random().toString(36).slice(2, 8));
      addNode(eventId, evt.kind || 'event', KIND_COLORS[evt.kind] || '#3274d9', 0);

      const geneId = evt.gene && (evt.gene.id || evt.gene);
      if (typeof geneId === 'string') {
        const gNode = 'g_' + geneId;
        addNode(gNode, geneId.replace('gene_gep_', ''), '#28a745', 1);
        links.push({ source: eventId, target: gNode });
      }

      const signals = (evt.signal && Array.isArray(evt.signal.signals)) ? evt.signal.signals
        : (Array.isArray(evt.signals) ? evt.signals : []);
      signals.slice(0, 4).forEach((sig) => {
        const sNode = 's_' + sig;
        addNode(sNode, sig, '#ffc107', 2);
        links.push({ source: sNode, target: eventId, lineStyle: { type: 'dashed' } });
      });

      const outcomeStatus = evt.outcome && (evt.outcome.status || evt.outcome.predicted_outcome?.status);
      if (typeof outcomeStatus === 'string') {
        const oNode = 'o_' + outcomeStatus;
        addNode(oNode, outcomeStatus, outcomeStatus === 'success' ? '#28a745' : '#dc3545', 3);
        links.push({ source: eventId, target: oNode });
      }

      const mutationCategory = evt.mutation && evt.mutation.category;
      if (typeof mutationCategory === 'string') {
        const mNode = 'm_' + mutationCategory;
        addNode(mNode, mutationCategory, '#dc3545', 4);
        links.push({ source: eventId, target: mNode, lineStyle: { type: 'dotted' } });
      }
    } catch (_) { /* skip malformed entry */ }
  });

  ensureChart('memory-graph-chart')?.setOption({
    tooltip: {},
    legend: { data: ['Event', 'Gene', 'Signal', 'Outcome', 'Mutation'], top: 0, textStyle: { color: textColor } },
    series: [{
      type: 'graph',
      layout: 'force',
      data: Array.from(nodes.values()),
      links,
      categories: [{ name: 'Event' }, { name: 'Gene' }, { name: 'Signal' }, { name: 'Outcome' }, { name: 'Mutation' }],
      roam: true,
      label: { show: true, fontSize: 9, color: textColor },
      lineStyle: { color: isDark ? '#3a4045' : '#d8dde2', width: 1, curveness: 0.1 },
      force: { repulsion: 110, edgeLength: 60, gravity: 0.05 },
    }],
  });
}

// ---- Tabs ----

function activateTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.getAttribute('data-view') === tab));
  setTimeout(() => Object.values(state.charts).forEach((c) => c.resize && c.resize()), 50);
  if (tab === 'pipelines') loadPipelines();
  if (tab === 'assets') loadAsset(state.currentAsset);
  if (tab === 'interactions') loadInteractions();
  if (tab === 'personality') loadPersonality();
}

async function loadPipelines() {
  try {
    const runs = await api('/webui/runs?limit=50');
    renderRuns(runs);
  } catch (err) {
    console.error(err);
  }
}

async function loadPersonality() {
  try {
    const [personality, graph] = await Promise.all([
      api('/webui/personality'),
      api('/webui/memory-graph?limit=100'),
    ]);
    renderPersonality(personality, graph);
  } catch (err) {
    console.error(err);
  }
}

async function loadOverview() {
  try {
    const [status, runs, assets, interactions, skills] = await Promise.all([
      api('/webui/status'),
      api('/webui/runs?limit=20'),
      api('/webui/assets'),
      api('/webui/interactions?limit=20'),
      api('/webui/skills'),
    ]);
    renderStatus(status);
    renderSafety(status.safety || {});
    renderInteractions(interactions);
    renderOverviewCharts(assets);
    renderLatestRun(runs);
    renderSkills(skills);
  } catch (err) {
    console.error(err);
  }
}

async function refresh() {
  if (state.currentTab === 'overview') return loadOverview();
  if (state.currentTab === 'pipelines') return loadPipelines();
  if (state.currentTab === 'assets') return loadAsset(state.currentAsset);
  if (state.currentTab === 'interactions') return loadInteractions();
  if (state.currentTab === 'personality') return loadPersonality();
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => activateTab(b.getAttribute('data-tab'))));
document.querySelectorAll('.asset-tab').forEach((b) => b.addEventListener('click', () => loadAsset(b.getAttribute('data-asset'))));
$('refresh').addEventListener('click', refresh);
window.addEventListener('resize', () => Object.values(state.charts).forEach((c) => c.resize && c.resize()));
window.loadRun = loadRun;
loadOverview();
`;
}

function getStylesCss() {
  return `
:root {
  --bg-color: #111217;
  --panel-bg: #181b1f;
  --border-color: #2c3235;
  --text-main: #c7d0d9;
  --text-muted: #8e99a4;
  --accent: #3274d9;
  --success: #28a745;
  --warning: #ffc107;
  --danger: #dc3545;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-color: #f4f5f5;
    --panel-bg: #ffffff;
    --border-color: #e4e7eb;
    --text-main: #24292e;
    --text-muted: #5c6975;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg-color); color: var(--text-main); font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: var(--panel-bg); border-bottom: 1px solid var(--border-color); gap: 16px; }
h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
h2 { font-size: 0.85rem; margin: 0 0 14px 0; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
h3 { font-size: 1rem; margin: 0 0 8px 0; }
h4 { font-size: 0.85rem; margin: 0 0 8px 0; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.eyebrow { font-size: 0.7rem; color: var(--text-muted); margin: 0 0 2px 0; text-transform: uppercase; letter-spacing: 0.1em; }
main { padding: 24px; }

.tabs { display: flex; gap: 4px; flex: 1; justify-content: center; }
.tab { background: transparent; color: var(--text-muted); border: 1px solid transparent; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
.tab.active { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.tab:hover { color: var(--text-main); }

.view { display: none; flex-direction: column; gap: 24px; }
.view.active { display: flex; }
.grid-top { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
.grid-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; }
.grid-bottom { display: grid; grid-template-columns: 1fr 2fr; gap: 24px; }
@media (max-width: 1100px) { .grid-bottom { grid-template-columns: 1fr; } }

.panel { background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.chart-container { width: 100%; height: 240px; }
button { background: var(--accent); color: #fff; border: none; border-radius: 4px; padding: 7px 14px; cursor: pointer; font-weight: 500; font-size: 0.85rem; transition: opacity 0.2s; }
button:hover { opacity: 0.9; }
code { background: color-mix(in srgb, var(--text-main) 8%, transparent); padding: 1px 6px; border-radius: 3px; font-size: 0.85em; }
.muted { color: var(--text-muted); }
.small { font-size: 0.78rem; }

dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 0.88rem; }
dt { color: var(--text-muted); }
dd { margin: 0; font-weight: 500; word-break: break-all; }

.table-wrapper { overflow-x: auto; margin: -18px; margin-top: 0; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
th, td { padding: 10px 18px; text-align: left; border-bottom: 1px solid var(--border-color); vertical-align: top; }
th { color: var(--text-muted); font-weight: 500; background: color-mix(in srgb, var(--panel-bg) 95%, var(--text-main) 5%); position: sticky; top: 0; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; }
tr:last-child td { border-bottom: none; }
#runsTable tbody tr:hover td { background: color-mix(in srgb, var(--text-main) 4%, transparent); cursor: pointer; }

.data-table { width: 100%; }
.data-table td details summary { cursor: pointer; color: var(--accent); }

.status-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.status-success { background: var(--success); }
.status-running { background: var(--accent); }
.status-failed { background: var(--danger); }
.status-blocked { background: var(--warning); }
.status-skipped { background: var(--text-muted); }
.status-warning { background: var(--warning); }

.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); margin: 2px 2px 2px 0; }
.pill.repair { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
.pill.optimize { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.pill.innovate { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
.pill.explore { background: color-mix(in srgb, var(--warning) 22%, transparent); color: var(--warning); }
.pill.signal { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--warning); }
.pill.asset_publish, .pill.asset_publish_skip { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
.pill.hub_search_hit { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.pill.asset_reuse, .pill.asset_reference { background: color-mix(in srgb, #6f42c1 22%, transparent); color: #b388f7; }

.timeline { list-style: none; padding: 0; margin: 0; position: relative; }
.timeline::before { content: ''; position: absolute; left: 11px; top: 4px; bottom: 0; width: 2px; background: var(--border-color); }
.timeline li { position: relative; padding: 0 0 18px 32px; }
.timeline li:last-child { padding-bottom: 0; }
.timeline li::before { content: ''; position: absolute; left: 6px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: var(--panel-bg); border: 2px solid var(--border-color); z-index: 1; }
.timeline li.success::before { border-color: var(--success); background: var(--success); }
.timeline li.running::before { border-color: var(--accent); background: var(--accent); }
.timeline li.failed::before { border-color: var(--danger); background: var(--danger); }
.timeline li.blocked::before { border-color: var(--warning); background: var(--warning); }
.timeline-title { font-weight: 600; font-size: 0.95rem; margin-bottom: 4px; line-height: 1; }
.timeline-desc { font-size: 0.85rem; color: var(--text-muted); margin: 0; line-height: 1.4; }

.run-header { margin-bottom: 16px; }
.run-meta { display: flex; gap: 18px; font-size: 0.85rem; color: var(--text-muted); flex-wrap: wrap; margin-top: 4px; }
.run-meta strong { color: var(--text-main); }
.run-body { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 18px; }
@media (max-width: 1000px) { .run-body { grid-template-columns: 1fr; } }
.run-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; padding-top: 16px; border-top: 1px solid var(--border-color); }
.detail-block { background: color-mix(in srgb, var(--panel-bg) 96%, var(--text-main) 4%); border: 1px solid var(--border-color); border-radius: 6px; padding: 14px; }
.detail-block h4 { margin: 0 0 8px 0; }
.reason-list { padding-left: 18px; margin: 4px 0; font-size: 0.83rem; }
.reason-list li { margin: 2px 0; }
.snippet { font-size: 0.78rem; background: color-mix(in srgb, var(--text-main) 8%, transparent); padding: 8px; border-radius: 4px; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-word; }

.skill-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }
.skill-list li { padding: 10px 0; border-bottom: 1px solid var(--border-color); }
.skill-list li:last-child { border: none; }
.skill-list p { margin: 4px 0; font-size: 0.85rem; }

.asset-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.asset-tab { background: var(--panel-bg); color: var(--text-muted); border: 1px solid var(--border-color); padding: 6px 14px; border-radius: 6px 6px 0 0; cursor: pointer; font-size: 0.85rem; }
.asset-tab.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); border-bottom-color: transparent; }

.event-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }
.event-list li { padding: 12px; background: color-mix(in srgb, var(--panel-bg) 96%, var(--text-main) 4%); border-radius: 6px; font-size: 0.85rem; display: flex; flex-direction: column; gap: 4px; }

.stream-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; max-height: 540px; overflow-y: auto; }
.stream-item { padding: 10px 12px; background: color-mix(in srgb, var(--panel-bg) 96%, var(--text-main) 4%); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; font-size: 0.85rem; }
.stream-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.stream-title { font-weight: 500; word-break: break-all; }
.snapshot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.snapshot-grid .snapshot-empty { grid-column: 1 / -1; margin: 0; white-space: nowrap; }
.snapshot-card { padding: 12px; background: color-mix(in srgb, var(--panel-bg) 96%, var(--text-main) 4%); border-radius: 6px; border: 1px solid var(--border-color); font-size: 0.85rem; }
`;
}

module.exports = {
  getIndexHtml,
  getClientJs,
  getStylesCss,
};
