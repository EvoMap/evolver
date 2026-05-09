const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
const savedEnv = {};
const envKeys = ['EVOLVER_REPO_ROOT', 'OPENCLAW_WORKSPACE', 'GEP_ASSETS_DIR', 'MEMORY_DIR', 'EVOLUTION_DIR', 'EVOLVER_SESSION_SCOPE'];

function setupTempEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetstore-test-'));
  for (const k of envKeys) { savedEnv[k] = process.env[k]; }
  const assetsDir = path.join(tmpDir, 'assets', 'gep');
  fs.mkdirSync(assetsDir, { recursive: true });
  process.env.EVOLVER_REPO_ROOT = tmpDir;
  process.env.GEP_ASSETS_DIR = assetsDir;
  process.env.OPENCLAW_WORKSPACE = tmpDir;
  delete process.env.EVOLVER_SESSION_SCOPE;
}

function teardownTempEnv() {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function freshRequire() {
  const modPath = require.resolve('../src/gep/assetStore');
  const pathsPath = require.resolve('../src/gep/paths');
  delete require.cache[modPath];
  delete require.cache[pathsPath];
  return require(modPath);
}

function writeJsonl(filePath, objects) {
  fs.writeFileSync(filePath, objects.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
}

describe('readRecentCandidates', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns empty array when file does not exist', () => {
    const { readRecentCandidates } = freshRequire();
    assert.deepEqual(readRecentCandidates(), []);
  });

  it('returns empty array for empty file', () => {
    const { candidatesPath, readRecentCandidates } = freshRequire();
    fs.writeFileSync(candidatesPath(), '', 'utf8');
    assert.deepEqual(readRecentCandidates(), []);
  });

  it('reads and parses JSONL entries', () => {
    const { candidatesPath, readRecentCandidates } = freshRequire();
    const items = [
      { type: 'Candidate', id: 'c1', score: 0.8 },
      { type: 'Candidate', id: 'c2', score: 0.9 },
    ];
    writeJsonl(candidatesPath(), items);
    const result = readRecentCandidates(10);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'c1');
    assert.equal(result[1].id, 'c2');
  });

  it('respects limit parameter (returns last N)', () => {
    const { candidatesPath, readRecentCandidates } = freshRequire();
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push({ type: 'Candidate', id: 'c' + i });
    }
    writeJsonl(candidatesPath(), items);
    const result = readRecentCandidates(3);
    assert.equal(result.length, 3);
    assert.equal(result[0].id, 'c7');
    assert.equal(result[1].id, 'c8');
    assert.equal(result[2].id, 'c9');
  });

  it('skips malformed JSON lines gracefully', () => {
    const { candidatesPath, readRecentCandidates } = freshRequire();
    const content = '{"id":"c1"}\n{BROKEN\n{"id":"c2"}\n';
    fs.writeFileSync(candidatesPath(), content, 'utf8');
    const result = readRecentCandidates(10);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'c1');
    assert.equal(result[1].id, 'c2');
  });

  it('handles large file (>1MB) by reading tail only', () => {
    const { candidatesPath, readRecentCandidates } = freshRequire();
    const p = candidatesPath();
    const padding = '{"type":"pad","data":"' + 'x'.repeat(500) + '"}\n';
    const padCount = Math.ceil((1024 * 1024 + 100) / padding.length);
    let content = '';
    for (let i = 0; i < padCount; i++) content += padding;
    content += '{"type":"tail","id":"last1"}\n';
    content += '{"type":"tail","id":"last2"}\n';
    fs.writeFileSync(p, content, 'utf8');
    const stat = fs.statSync(p);
    assert.ok(stat.size > 1024 * 1024, 'file should be >1MB for large file path');
    const result = readRecentCandidates(2);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'last1');
    assert.equal(result[1].id, 'last2');
  });
});

describe('appendCandidateJsonl + readRecentCandidates roundtrip', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('appends and reads back candidates', () => {
    const { appendCandidateJsonl, readRecentCandidates } = freshRequire();
    appendCandidateJsonl({ type: 'Candidate', id: 'rt1', score: 0.5 });
    appendCandidateJsonl({ type: 'Candidate', id: 'rt2', score: 0.7 });
    const result = readRecentCandidates(10);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'rt1');
    assert.equal(result[1].id, 'rt2');
  });
});

describe('loadGenes', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns default genes when no files exist', () => {
    const { ensureAssetFiles, loadGenes } = freshRequire();
    ensureAssetFiles();
    const genes = loadGenes();
    assert.ok(Array.isArray(genes));
    assert.ok(genes.length >= 2, 'should have at least 2 default genes');
    assert.ok(genes.every(g => g.type === 'Gene'));
  });

  it('deduplicates genes by id (jsonl overrides json)', () => {
    const { genesPath, loadGenes } = freshRequire();
    const jsonContent = {
      version: 1,
      genes: [{ type: 'Gene', id: 'gene_a', category: 'repair', signals_match: ['error'] }],
    };
    fs.writeFileSync(genesPath(), JSON.stringify(jsonContent), 'utf8');
    const jsonlPath = path.join(path.dirname(genesPath()), 'genes.jsonl');
    fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'Gene', id: 'gene_a', category: 'optimize', signals_match: ['perf'] }) + '\n', 'utf8');
    const genes = loadGenes();
    const geneA = genes.find(g => g.id === 'gene_a');
    assert.ok(geneA);
    assert.equal(geneA.category, 'optimize');
  });

  // Bugbot follow-up on PR #25: loadGenes used to pass loaded genes through
  // createGene(), which synthesized default fields (epigenetic_marks,
  // learning_history, anti_patterns, summary, schema_version) on legacy genes
  // that were stored before those fields existed. Since computeAssetId hashes
  // every field except asset_id, those phantom additions invalidated the
  // stored asset_id and broke content-addressable integrity.
  it('preserves on-disk gene shape (does not synthesize default fields that would invalidate asset_id)', () => {
    const { genesPath, loadGenes } = freshRequire();
    const { computeAssetId, verifyAssetId } = require('../src/gep/contentHash');

    // A "legacy" gene with the minimal field set as it existed pre-#25.
    const legacyGene = {
      type: 'Gene',
      id: 'gene_legacy',
      category: 'repair',
      signals_match: ['error'],
      strategy: ['fix it'],
    };
    legacyGene.asset_id = computeAssetId(legacyGene);

    fs.writeFileSync(genesPath(), JSON.stringify({ version: 1, genes: [legacyGene] }), 'utf8');

    const loaded = loadGenes().find(g => g.id === 'gene_legacy');
    assert.ok(loaded, 'gene_legacy should be loaded');
    assert.ok(verifyAssetId(loaded), 'loaded gene asset_id must still verify');
    assert.equal(loaded.epigenetic_marks, undefined, 'must not synthesize epigenetic_marks');
    assert.equal(loaded.learning_history, undefined, 'must not synthesize learning_history');
    assert.equal(loaded.anti_patterns, undefined, 'must not synthesize anti_patterns');
    assert.equal(loaded.schema_version, undefined, 'must not synthesize schema_version');
    assert.equal(loaded.summary, undefined, 'must not synthesize summary');
  });
});

describe('readAllEvents', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns empty array when file does not exist', () => {
    const { readAllEvents } = freshRequire();
    assert.deepEqual(readAllEvents(), []);
  });

  it('parses JSONL events and skips malformed lines', () => {
    const { eventsPath, readAllEvents } = freshRequire();
    const content = [
      JSON.stringify({ type: 'EvolutionEvent', id: 'evt_1', intent: 'repair' }),
      'NOT_JSON',
      JSON.stringify({ type: 'EvolutionEvent', id: 'evt_2', intent: 'innovate' }),
    ].join('\n') + '\n';
    fs.writeFileSync(eventsPath(), content, 'utf8');
    const events = readAllEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].id, 'evt_1');
    assert.equal(events[1].id, 'evt_2');
  });

  // Regression for issue #30 (H6): readAllEvents previously read the whole
  // events.jsonl into memory unconditionally. On long-running daemons the
  // file accumulates dozens of MB, causing heap spikes per
  // computeCapsuleSuccessStreak call. Now bounded by
  // EVOLVER_EVENTS_FULL_READ_MAX_BYTES with a tail-read fallback.
  it('handles oversized file via tail-read and recovers recent events', () => {
    const { eventsPath, readAllEvents } = freshRequire();
    const p = eventsPath();
    // Pick a cap small enough to force tail-read but a tail chunk large enough
    // to start mid-file (readPos > 0), exercising the partial-line discard path.
    process.env.EVOLVER_EVENTS_FULL_READ_MAX_BYTES = '512';
    try {
      const padding = JSON.stringify({ type: 'EvolutionEvent', id: 'pad', data: 'x'.repeat(200) }) + '\n';
      const padCount = 30;
      let content = '';
      for (let i = 0; i < padCount; i++) content += padding;
      content += JSON.stringify({ type: 'EvolutionEvent', id: 'recent_1', intent: 'repair' }) + '\n';
      content += JSON.stringify({ type: 'EvolutionEvent', id: 'recent_2', intent: 'optimize' }) + '\n';
      fs.writeFileSync(p, content, 'utf8');
      // > 2MB tail chunk default ensures readPos = stat.size - chunkSize stays
      // at 0 here; the inner branch is exercised by the next test below.
      assert.ok(fs.statSync(p).size > 512, 'fixture must exceed cap');

      const events = readAllEvents();
      const ids = events.map(e => e && e.id).filter(Boolean);
      assert.ok(ids.includes('recent_1'), 'tail read should surface recent_1');
      assert.ok(ids.includes('recent_2'), 'tail read should surface recent_2');
    } finally {
      delete process.env.EVOLVER_EVENTS_FULL_READ_MAX_BYTES;
    }
  });

  // True mid-file tail read: readPos > 0, first chunk line MUST be discarded
  // because it is almost certainly a partial JSON record. We force this with
  // a tail size smaller than the file, leaving prefix bytes outside the chunk.
  it('discards a partial first line only when readPos > 0 (true mid-file tail)', () => {
    const { eventsPath, readAllEvents } = freshRequire();
    const p = eventsPath();
    process.env.EVOLVER_EVENTS_FULL_READ_MAX_BYTES = '256';
    process.env.EVOLVER_EVENTS_TAIL_READ_BYTES = '512';
    try {
      const longLineBody = 'x'.repeat(400);
      const events = [
        { type: 'EvolutionEvent', id: 'event_a', body: longLineBody },
        { type: 'EvolutionEvent', id: 'event_b' },
        { type: 'EvolutionEvent', id: 'event_c' },
      ];
      fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      const stat = fs.statSync(p);
      assert.ok(stat.size > 512, 'file must exceed tail-read chunk for readPos > 0');

      const recovered = readAllEvents();
      const ids = recovered.map(e => e && e.id).filter(Boolean);
      // event_a sits in the dropped-prefix region; event_b / event_c survive.
      assert.ok(!ids.includes('event_a'), 'partial first line must be discarded');
      assert.ok(ids.includes('event_b'), 'second event must survive');
      assert.ok(ids.includes('event_c'), 'last event must survive');
    } finally {
      delete process.env.EVOLVER_EVENTS_FULL_READ_MAX_BYTES;
      delete process.env.EVOLVER_EVENTS_TAIL_READ_BYTES;
    }
  });

  // Regression for Bugbot finding on PR #31: when the tail chunk covers the
  // whole file (readPos === 0), the first line is NOT partial -- it is the
  // start of the file -- and must NOT be discarded. The earlier version
  // unconditionally dropped lines[0], silently losing a complete event.
  it('does not drop the first event when tail chunk starts at offset 0', () => {
    const { eventsPath, readAllEvents } = freshRequire();
    const p = eventsPath();
    // cap < file size triggers tail path; default tail chunk (2MB) > file size
    // makes readPos === 0, so no partial line should be dropped.
    process.env.EVOLVER_EVENTS_FULL_READ_MAX_BYTES = '128';
    try {
      const lines = [
        JSON.stringify({ type: 'EvolutionEvent', id: 'first_event', intent: 'repair' }),
        JSON.stringify({ type: 'EvolutionEvent', id: 'middle_event', intent: 'optimize' }),
        JSON.stringify({ type: 'EvolutionEvent', id: 'last_event', intent: 'innovate' }),
      ];
      fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
      const stat = fs.statSync(p);
      assert.ok(stat.size > 128, 'fixture must exceed cap');
      assert.ok(stat.size < 2 * 1024 * 1024, 'fixture must fit in a single tail chunk');

      const events = readAllEvents();
      const ids = events.map(e => e && e.id).filter(Boolean);
      assert.equal(events.length, 3, 'all 3 events recovered, first must not be dropped');
      assert.deepEqual(ids, ['first_event', 'middle_event', 'last_event']);
    } finally {
      delete process.env.EVOLVER_EVENTS_FULL_READ_MAX_BYTES;
    }
  });
});

describe('upsertCapsule / upsertGene validation (issue #30 H1)', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('persists a well-formed Capsule without warning', () => {
    const { upsertCapsule, loadCapsules } = freshRequire();
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    try {
      upsertCapsule({
        type: 'Capsule',
        id: 'cap_ok',
        outcome: { status: 'success', score: 0.9 },
        trigger: ['log_error'],
        execution_trace: [{ step: 'run', ok: true }],
      });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.filter(w => w.includes('schema validation warning')).length, 0);
    const loaded = loadCapsules();
    assert.ok(loaded.find(c => c.id === 'cap_ok'), 'capsule should be persisted');
  });

  it('emits a warning but still persists a malformed Capsule (warn-only contract)', () => {
    const { upsertCapsule, loadCapsules } = freshRequire();
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    try {
      upsertCapsule({
        type: 'Capsule',
        id: 'cap_bad',
        outcome: { status: 'unknown_status', score: 0.5 },
        trigger: ['log_error'],
        execution_trace: [],
      });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warnings.some(w => w.includes('Capsule schema validation warning')),
      'should warn about invalid outcome.status',
    );
    const loaded = loadCapsules();
    assert.ok(loaded.find(c => c.id === 'cap_bad'), 'persistence must not be blocked by validator');
  });

  it('emits a warning but still persists a malformed Gene', () => {
    const { upsertGene, loadGenes } = freshRequire();
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    try {
      upsertGene({
        type: 'Gene',
        id: 'gene_bad_category',
        category: 'not_a_category',
        signals_match: ['log_error'],
        strategy: ['fix'],
      });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warnings.some(w => w.includes('Gene schema validation warning')),
      'should warn about invalid category',
    );
    const loaded = loadGenes();
    assert.ok(loaded.find(g => g.id === 'gene_bad_category'), 'persistence must not be blocked by validator');
  });
});

describe('getLastEventId', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns null when no events file', () => {
    const { getLastEventId } = freshRequire();
    assert.equal(getLastEventId(), null);
  });

  it('returns id of the last event', () => {
    const { eventsPath, getLastEventId } = freshRequire();
    writeJsonl(eventsPath(), [
      { type: 'EvolutionEvent', id: 'evt_first' },
      { type: 'EvolutionEvent', id: 'evt_last' },
    ]);
    assert.equal(getLastEventId(), 'evt_last');
  });
});

describe('readRecentFailedCapsules', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns empty array when file does not exist', () => {
    const { readRecentFailedCapsules } = freshRequire();
    assert.deepEqual(readRecentFailedCapsules(), []);
  });

  it('respects limit parameter', () => {
    const { failedCapsulesPath, readRecentFailedCapsules } = freshRequire();
    const list = [];
    for (let i = 0; i < 10; i++) list.push({ type: 'Capsule', id: 'fc' + i, outcome: { status: 'failed' } });
    fs.writeFileSync(failedCapsulesPath(), JSON.stringify({ version: 1, failed_capsules: list }), 'utf8');
    const result = readRecentFailedCapsules(3);
    assert.equal(result.length, 3);
    assert.equal(result[0].id, 'fc7');
  });
});
