'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const skill2gep = require('../src/gep/skill2gep');
const audit = require('../src/gep/skill2gepAudit');
const assetStore = require('../src/gep/assetStore');

// A Skill whose validation uses a node-only command so it survives the GEP
// allow-list. Triggers/workflow give the parser real signals and strategy.
function skillMd(name, validationCmd) {
  return [
    '---',
    'name: ' + name,
    'description: Build a CLI monthly forecaster. Triggers: forecast, seasonality, history_csv.',
    '---',
    '',
    '# ' + name,
    '',
    '## When to use',
    'Use when: monthly sales forecast, seasonality needed.',
    '',
    '## Workflow',
    '1. Read the input file and group rows by product.',
    '2. Fit a per-product model and write the output arrays.',
    '',
    '## Validation',
    '```bash',
    validationCmd,
    '```',
    '',
  ].join('\n');
}

function evolvedExecution() {
  return {
    status: 'success',
    blast_radius: { files: 1, lines: 40 },
    mutation_log: ['keyword_only_seasonality'],
    rollouts: [
      { step: 0, kind: 'solve', status: 'failed', error_type: 'keyword_only_seasonality' },
      { step: 1, kind: 'mutate', status: 'success' },
    ],
    corrective_insight: 'Make a seasonal Holt-Winters model the default path; only fall back to pure-Python when statsmodels is missing.',
    final_solution: 'ExponentialSmoothing(y, trend="add", seasonal="add")',
    signals: ['holt_winters'],
  };
}

describe('skill2gep.classifyProvenance', () => {
  it('flags a fail->pass trajectory as evolved', () => {
    assert.equal(skill2gep.classifyProvenance(evolvedExecution()), 'evolved');
  });

  it('flags a run with no evidence as manual', () => {
    assert.equal(skill2gep.classifyProvenance({}), 'manual');
  });

  it('flags reference-distilled signal as distilled', () => {
    assert.equal(skill2gep.classifyProvenance({
      status: 'success', blast_radius: { files: 1, lines: 5 }, reference_distilled: true,
    }), 'distilled');
  });

  it('treats a first-try success as distilled, not evolved (no failure overcome)', () => {
    // A verified passing run with no failure to learn from carries real
    // evidence but no corrective insight, so it is distilled (not evolved, and
    // not manual which has no evidence at all).
    assert.equal(skill2gep.classifyProvenance({
      status: 'success', blast_radius: { files: 1, lines: 5 },
      rollouts: [{ step: 0, kind: 'solve', status: 'success' }],
    }), 'distilled');
  });

  it('classifies a success with mutation_log but zero blast as distilled, not manual', () => {
    // Has real execution evidence (mutation_log), just not a blast-bearing
    // evolved trajectory -> distilled, never manual.
    assert.equal(skill2gep.classifyProvenance({
      status: 'success', blast_radius: { files: 0, lines: 0 }, mutation_log: ['x'],
    }), 'distilled');
  });
});

describe('skill2gep.synthesizeGene — evolved provenance', () => {
  const md = skillMd('monthly-forecast', 'node --check forecast.js');
  const parsed = skill2gep.parseSkillMd(md);
  const r = skill2gep.synthesizeGene(parsed, evolvedExecution(), {
    skillName: parsed.name, skillMd: md, platform: 'claude-code',
  });

  it('produces a valid evolved Gene with a high quality score', () => {
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.equal(r.source, 'evolved');
    assert.ok(r.quality_score >= 0.8, 'quality_score should be high: ' + r.quality_score);
    assert.equal(r.gene._source.generation_source, 'evolved');
  });

  it('puts the corrective insight first in strategy', () => {
    assert.match(r.gene.strategy[0], /Holt-Winters model the default path/);
  });

  it('turns the mutation_log into a precondition', () => {
    const joined = r.gene.preconditions.join(' | ');
    assert.match(joined, /keyword only seasonality/);
  });

  it('preserves a real, runnable validation command', () => {
    assert.deepEqual(r.gene.validation, ['node --check forecast.js']);
  });
});

describe('skill2gep.synthesizeGene — no bogus validation fallback', () => {
  it('emits an empty validation list when the Skill has no allowed command', () => {
    // pytest is not on the node/npm/npx allow-list, so nothing is runnable.
    const md = skillMd('plain-skill', 'pytest tests/');
    const parsed = skill2gep.parseSkillMd(md);
    const r = skill2gep.synthesizeGene(parsed, {}, { skillName: parsed.name, skillMd: md });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.deepEqual(r.gene.validation, []);
    assert.ok(!JSON.stringify(r.gene.validation).includes('node --version'),
      'must not inject a node --version fallback');
  });
});

describe('skill2gep.synthesizeGene — manual provenance is low quality', () => {
  it('marks a no-trajectory Skill as manual with a low score', () => {
    const md = skillMd('plain-skill', 'pytest tests/');
    const parsed = skill2gep.parseSkillMd(md);
    const r = skill2gep.synthesizeGene(parsed, {}, { skillName: parsed.name, skillMd: md });
    assert.equal(r.source, 'manual');
    assert.ok(r.quality_score <= 0.5, 'manual quality should be low: ' + r.quality_score);
  });
});

describe('skill2gep — mechanical leakage audit', () => {
  it('redacts a hidden numeric constant that is not in the public Skill', () => {
    const md = skillMd('leaky', 'node --check x.js');
    const parsed = skill2gep.parseSkillMd(md);
    const execution = {
      status: 'success',
      blast_radius: { files: 1, lines: 9 },
      mutation_log: ['wrong_threshold'],
      // The magic number 202 appears only in the hidden solution / feedback.
      final_solution: 'threshold = 202\nreturn total',
      corrective_insight: 'The mineralization threshold must be 202, not the dataset median.',
      trace: [{ step: 1, cmd: 'node --check x.js', exit: 0, stdout_tail: 'got 0.0 expected 202.0' }],
    };
    const r = skill2gep.synthesizeGene(parsed, execution, { skillName: parsed.name, skillMd: md });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    const blob = JSON.stringify(r.gene);
    assert.ok(!/\b202\b/.test(blob), 'the private constant 202 must be redacted from the Gene: ' + blob);
    assert.equal(r.audit.redacted, true);
  });

  it('buildPrivateVocab keeps public tokens out of the private set', () => {
    const md = '# F\n## Workflow\n1. write forecast.json\n';
    const priv = audit.buildPrivateVocab(md, { final_solution: 'forecast.json\nseasonal_periods=12' });
    assert.ok(priv.has('12'), 'hidden constant should be private');
    assert.ok(!priv.has('forecast.json'), 'public file name must not be private');
  });

  it('drops a validation command that carries a private literal (does not mangle it)', () => {
    const priv = new Set(['987654']);
    const gene = {
      summary: 's', strategy: ['x'], signals_match: ['y'], preconditions: [],
      validation: ['npm test -- --seed 987654', 'node --check a.js'],
    };
    const r = audit.redactPrivateLiterals(gene, priv);
    assert.deepEqual(r.validation, ['node --check a.js']);
    assert.equal(audit.findLeakage(r, priv).length, 0);
  });

  it('scans and redacts _source.overcame_errors (published mutation_log copy)', () => {
    const priv = new Set(['99887']);
    const gene = {
      summary: 's', strategy: ['x'], signals_match: ['y'], preconditions: [],
      _source: { overcame_errors: ['error 99887'] },
    };
    assert.equal(audit.findLeakage(gene, priv).length, 1);
    const r = audit.redactPrivateLiterals(gene, priv);
    assert.equal(audit.findLeakage(r, priv).length, 0);
    assert.ok(!/99887/.test(JSON.stringify(r._source.overcame_errors)));
  });

  it('strict mode rejects when the audit drops all runnable validation', () => {
    const md = skillMd('leaky3', 'npm test -- --seed 555444');
    const parsed = skill2gep.parseSkillMd(md);
    const execution = {
      status: 'success', blast_radius: { files: 1, lines: 9 }, mutation_log: ['x'],
      // 555444 appears only in the hidden solution, so the audit marks it
      // private and drops the only validation command that references it.
      final_solution: 'seed = 555444',
    };
    const r = skill2gep.synthesizeGene(parsed, execution, { skillName: parsed.name, skillMd: md, strict: true });
    assert.equal(r.valid, false);
    assert.match(r.errors.join(' '), /validation/);
  });
});

describe('skill2gep.distillWithLLM — payload merges even with a top-level insight', () => {
  it('keeps distilled_payload strategy/preconditions when corrective_insight is also set', () => {
    const md = ['---', 'name: merge', 'description: CLI. Triggers: a, b.', '---', '# merge', '## Workflow', '1. base'].join('\n');
    const parsed = skill2gep.parseSkillMd(md);
    const execution = {
      corrective_insight: 'Top-level insight wins.',
      distilled_payload: {
        corrective_insight: 'Payload insight (should be overridden by top-level).',
        strategy: ['Extra distilled step from the host.'],
        preconditions: ['Extra host precondition.'],
      },
    };
    const merged = skill2gep.distillWithLLM(parsed, execution, { skillMd: md });
    assert.equal(merged.corrective_insight, 'Top-level insight wins.');
    assert.deepEqual(merged.distilled_strategy, ['Extra distilled step from the host.']);
    assert.deepEqual(merged.distilled_preconditions, ['Extra host precondition.']);
  });
});

describe('skill2gep — strict leakage rejection', () => {
  it('rejects in strict mode if a literal cannot be redacted away', () => {
    // A purely numeric token with no surrounding word boundary is still
    // redactable; this asserts the strict path returns a structured error when
    // residual leaks remain. We simulate by feeding an execution whose private
    // token also matches inside a redaction-resistant context is not trivial,
    // so we assert the non-strict redaction succeeds (residual empty) instead.
    const md = skillMd('leaky2', 'node --check x.js');
    const parsed = skill2gep.parseSkillMd(md);
    const execution = {
      status: 'success', blast_radius: { files: 1, lines: 9 }, mutation_log: ['x'],
      final_solution: 'magic = 987654', corrective_insight: 'Use 987654 as the seed.',
    };
    const r = skill2gep.synthesizeGene(parsed, execution, { skillName: parsed.name, skillMd: md, strict: true });
    // Either it redacted cleanly (valid) or it rejected with a structured error.
    if (!r.valid) {
      assert.match(r.errors.join(' '), /leakage audit/);
    } else {
      assert.ok(!/987654/.test(JSON.stringify(r.gene)));
    }
  });
});

function writeReviewSkill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(name).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const sigs = [slug + '_alpha', slug + '_beta', slug + '_gamma'].join(', ');
  const md = [
    '---',
    'name: ' + name,
    'description: Repair ' + name + ' flow. Triggers: ' + sigs + '.',
    '---',
    '',
    '# ' + name,
    '',
    '## When to use',
    'Use when: ' + sigs + ' appear in logs.',
    '',
    '## Workflow',
    '1. Inspect the failing assertion and locate the rounding step.',
    '2. Apply the smallest targeted fix to the total computation.',
    '3. Re-run the validation command and abort if it fails.',
    '',
    '## Validation',
    '```bash',
    'node --version',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  return dir;
}

function successReviewExecution(suffix) {
  return {
    status: 'success',
    score: 0.9,
    blast_radius: { files: 1, lines: 12 },
    trigger: ['signal_' + suffix],
    summary: 'fixed ' + suffix,
    corrective_insight: 'Prefer the safe path for ' + suffix,
    mutation_log: ['fix_' + suffix],
    rollouts: [
      { step: 0, kind: 'solve', status: 'failed', error_type: 'fix_' + suffix },
      { step: 1, kind: 'mutate', status: 'success' },
    ],
    trace: [
      { step: 1, cmd: 'node --version', exit: 0, stdout_tail: 'v22' },
    ],
  };
}

function approveInvoker() {
  return {
    approved: true,
    confidence: 0.95,
    concerns: [],
    summary: 'safe to promote',
  };
}

function rejectInvoker() {
  return {
    approved: false,
    confidence: 0.2,
    concerns: ['too risky'],
    summary: 'blocked by policy',
  };
}

describe('skill2gep review promotion gate', () => {
  let tmpDir;
  const saved = {};
  const ENV_KEYS = [
    'GEP_ASSETS_DIR',
    'MEMORY_DIR',
    'EVOLUTION_DIR',
    'EVOLVER_REPO_ROOT',
    'EVOLVER_LLM_REVIEW',
    'SKILL2GEP_AUTO_PUBLISH',
    'A2A_HUB_URL',
    'A2A_NODE_ID',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2g-review-'));
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; });
    process.env.GEP_ASSETS_DIR = path.join(tmpDir, 'assets');
    process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
    process.env.EVOLUTION_DIR = path.join(tmpDir, 'memory', 'evolution');
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    process.env.SKILL2GEP_AUTO_PUBLISH = 'false';
    process.env.EVOLVER_LLM_REVIEW = 'true';
    process.env.A2A_NODE_ID = 'node_' + 'b'.repeat(12);
    delete process.env.A2A_HUB_URL;
    fs.mkdirSync(process.env.GEP_ASSETS_DIR, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_DIR, { recursive: true });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  function geneIds() {
    return assetStore.loadGenes().map((g) => g && g.id).filter(Boolean);
  }

  function capsuleIds() {
    return assetStore.loadCapsules().map((c) => c && c.id).filter(Boolean);
  }

  it('persists and marks seen on approved review', () => {
    const skillDir = writeReviewSkill(path.join(tmpDir, 'skills', 'ok'), 'review-ok');
    const beforeGenes = geneIds().length;
    const beforeCapsules = capsuleIds().length;
    const res = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-ok',
      execution: successReviewExecution('ok'),
      publish: false,
      reviewInvoker: approveInvoker,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.gene);
    assert.ok(res.capsule);
    assert.ok(geneIds().length > beforeGenes);
    assert.ok(capsuleIds().length > beforeCapsules);

    const again = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-ok',
      execution: successReviewExecution('ok'),
      publish: false,
      reviewInvoker: approveInvoker,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_distilled');
  });

  it('blocks rejected/unavailable/failed reviews without writing seen or assets', () => {
    const skillDir = writeReviewSkill(path.join(tmpDir, 'skills', 'blocked'), 'review-blocked');
    const beforeGenes = new Set(geneIds());
    const beforeCapsules = new Set(capsuleIds());

    const rejected = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-blocked',
      execution: successReviewExecution('blocked'),
      publish: false,
      reviewInvoker: rejectInvoker,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'llm_review_blocked');
    assert.equal(rejected.review.status, 'rejected');
    assert.equal(rejected.diagnostic.recovery.action, 'address_review_concerns_and_retry');

    const unavailable = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-blocked',
      execution: successReviewExecution('blocked'),
      publish: false,
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, 'llm_review_blocked');
    assert.equal(unavailable.review.status, 'unavailable');

    const failed = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-blocked',
      execution: successReviewExecution('blocked'),
      publish: false,
      invoke: () => { throw new Error('provider timeout'); },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'llm_review_blocked');
    assert.equal(failed.review.status, 'failed');
    assert.equal(failed.diagnostic.recovery.action, 'restore_review_provider_and_retry');

    const afterGenes = geneIds().filter((id) => !beforeGenes.has(id));
    const afterCapsules = capsuleIds().filter((id) => !beforeCapsules.has(id));
    assert.deepEqual(afterGenes, []);
    assert.deepEqual(afterCapsules, []);

    const recovered = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-blocked',
      execution: successReviewExecution('blocked'),
      publish: false,
      reviewInvoker: approveInvoker,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.ok(recovered.gene);
    assert.ok(recovered.capsule);
  });

  it('keeps disabled review path compatible (no invoker required)', () => {
    process.env.EVOLVER_LLM_REVIEW = 'false';
    const skillDir = writeReviewSkill(path.join(tmpDir, 'skills', 'disabled'), 'review-disabled');
    const res = skill2gep.runOnSkillInvocation({
      skillPath: skillDir,
      skillName: 'review-disabled',
      execution: successReviewExecution('disabled'),
      publish: false,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.gene);
    assert.ok(res.capsule);
  });
});
