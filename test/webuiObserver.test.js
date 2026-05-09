'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEYS = [
  'EVOLUTION_DIR',
  'GEP_ASSETS_DIR',
  'EVOLVER_REPO_ROOT',
  'MEMORY_DIR',
  'SKILLS_DIR',
  'AGENT_SESSIONS_DIR',
  'EVOLVER_LOGS_DIR',
  'EVOLVER_ATP_AUTOBUY',
  'ATP_AUTOBUY_DAILY_CAP_CREDITS',
  'ATP_AUTOBUY_PER_ORDER_CAP_CREDITS',
  'EVOLVER_AUTO_PUBLISH',
  'EVOLVER_VALIDATOR_ENABLED',
];

function freshObserver() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}webui${path.sep}`) || key.endsWith(`${path.sep}src${path.sep}gep${path.sep}paths.js`)) {
      delete require.cache[key];
    }
  }
  return require('../src/webui/observer');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

describe('webui observer', () => {
  let tmpDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-observer-'));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.EVOLUTION_DIR = path.join(tmpDir, 'evolution');
    process.env.GEP_ASSETS_DIR = path.join(tmpDir, 'assets', 'gep');
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
    process.env.SKILLS_DIR = path.join(tmpDir, 'skills');
    process.env.AGENT_SESSIONS_DIR = path.join(tmpDir, 'sessions');
    process.env.EVOLVER_LOGS_DIR = path.join(tmpDir, 'logs');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports safe default status when files are missing', () => {
    const observer = freshObserver();
    const status = observer.getStatus();

    assert.equal(status.mode, 'idle');
    assert.equal(status.safety.safeMode, true);
    assert.equal(status.filesPresent.events, false);
  });

  it('normalizes runs from cycle state, events, and asset calls', () => {
    const evoDir = process.env.EVOLUTION_DIR;
    const gepDir = process.env.GEP_ASSETS_DIR;
    writeJson(path.join(evoDir, 'cycle_progress.json'), {
      run_id: 'run-1',
      outer_cycle: 7,
      phase: 'evolve.run',
      started_at: Date.now() - 1000,
      updated_at: Date.now(),
    });
    writeJson(path.join(evoDir, 'evolution_solidify_state.json'), {
      pending: true,
      last_run: { run_id: 'run-1', selected_gene_id: 'gene_a', validation: { ok: true } },
    });
    appendJsonl(path.join(gepDir, 'events.jsonl'), [
      { id: 'evt-1', run_id: 'run-1', genes_used: ['gene_a'], outcome: { status: 'success' } },
    ]);
    appendJsonl(path.join(evoDir, 'asset_call_log.jsonl'), [
      { run_id: 'run-1', action: 'hub_search_hit', asset_id: 'asset-1', timestamp: new Date().toISOString() },
    ]);

    const observer = freshObserver();
    const runs = observer.listRuns().data;
    const detail = observer.getRun('run-1');

    assert.equal(runs.length, 1);
    assert.equal(runs[0].selectedGeneId, 'gene_a');
    assert.equal(runs[0].requiresConfirmation, true);
    assert.ok(detail.phases.some((phase) => phase.phase === 'asset_search' && phase.status === 'success'));
  });

  it('lists assets and lineage without leaking secrets', () => {
    const gepDir = process.env.GEP_ASSETS_DIR;
    writeJson(path.join(gepDir, 'genes.json'), {
      genes: [{ type: 'Gene', id: 'gene_secret', category: 'repair', node_secret: 'secret-value' }],
    });
    writeJson(path.join(gepDir, 'capsules.json'), {
      capsules: [{ type: 'Capsule', id: 'cap-1', gene: 'gene_secret', outcome: { status: 'success' } }],
    });
    appendJsonl(path.join(gepDir, 'events.jsonl'), [
      { id: 'evt-1', genes_used: ['gene_secret'], capsule_id: 'cap-1' },
    ]);

    const observer = freshObserver();
    const genes = observer.listGenes().data;
    const lineage = observer.getLineage('gene_secret');

    assert.equal(genes[0].node_secret, '[REDACTED]');
    assert.equal(lineage.capsules.length, 1);
    assert.equal(lineage.events.length, 1);
  });
});
