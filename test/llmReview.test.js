'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const llmReview = require('../src/gep/llmReview');
const { runLlmReview, parseReviewResponse } = llmReview;

const input = {
  diff: 'diff --git a/example.js b/example.js\n+const safe = true;',
  gene: { id: 'gene_llm_review_test', category: 'repair' },
  signals: ['review-boundary'],
  mutation: { rationale: 'exercise the review boundary' },
};

let previousEnabled;
beforeEach(function () {
  previousEnabled = process.env.EVOLVER_LLM_REVIEW;
  process.env.EVOLVER_LLM_REVIEW = 'true';
});
afterEach(function () {
  if (previousEnabled === undefined) delete process.env.EVOLVER_LLM_REVIEW;
  else process.env.EVOLVER_LLM_REVIEW = previousEnabled;
});

function assertUnavailable(result, reason, attempts) {
  assert.equal(result.approved, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, reason);
  assert.equal(result.retryable, true);
  assert.equal(result.attempts, attempts);
  assert.equal(result.trace.length, attempts);
  assert.ok(result.trace.every(entry => entry.status === 'unavailable'));
}

describe('llmReview fail-closed boundary', function () {
  it('does not approve malformed output after retry exhaustion', function () {
    const result = runLlmReview(input, { execute: () => 'not-json', maxAttempts: 2 });
    assertUnavailable(result, 'malformed_output', 2);
  });

  it('does not approve empty output after retry exhaustion', function () {
    const result = runLlmReview(input, { execute: () => '  \n', maxAttempts: 2 });
    assertUnavailable(result, 'empty_output', 2);
  });

  it('does not approve runner errors after retry exhaustion', function () {
    const result = runLlmReview(input, {
      execute: () => { const error = new Error('runner failed'); error.code = 'EIO'; throw error; },
      maxAttempts: 2,
    });
    assertUnavailable(result, 'runner_error', 2);
  });

  it('does not approve timeouts after retry exhaustion', function () {
    const result = runLlmReview(input, {
      execute: () => { const error = new Error('spawnSync node ETIMEDOUT'); error.code = 'ETIMEDOUT'; throw error; },
      maxAttempts: 2,
    });
    assertUnavailable(result, 'timeout', 2);
  });

  it('does not approve truncated or structurally partial responses', function () {
    const truncated = runLlmReview(input, {
      execute: () => '{"approved":true,"confidence":',
      maxAttempts: 1,
    });
    assertUnavailable(truncated, 'partial_response', 1);

    const incomplete = runLlmReview(input, {
      execute: () => JSON.stringify({ approved: true, confidence: 0.8 }),
      maxAttempts: 1,
    });
    assertUnavailable(incomplete, 'partial_response', 1);
  });

  it('retries a recoverable failure and preserves the valid success path', function () {
    let calls = 0;
    const result = runLlmReview(input, {
      execute: () => {
        calls += 1;
        if (calls === 1) return '';
        return JSON.stringify({ approved: true, confidence: 0.9, concerns: [], summary: 'verified' });
      },
      maxAttempts: 2,
    });

    assert.equal(result.approved, true);
    assert.equal(result.status, 'approved');
    assert.equal(result.reason, 'review_approved');
    assert.equal(result.retryable, false);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.trace, [
      { attempt: 1, status: 'unavailable', reason: 'empty_output' },
      { attempt: 2, status: 'approved', reason: 'review_approved' },
    ]);
  });

  it('preserves explicit rejection and compatibility fields', function () {
    const result = runLlmReview(input, {
      execute: () => JSON.stringify({
        approved: false,
        confidence: 0.95,
        concerns: ['unsafe mutation'],
        summary: 'reject unsafe mutation',
      }),
      maxAttempts: 1,
    });

    assert.deepEqual(
      {
        approved: result.approved,
        confidence: result.confidence,
        concerns: result.concerns,
        summary: result.summary,
        status: result.status,
        reason: result.reason,
      },
      {
        approved: false,
        confidence: 0.95,
        concerns: ['unsafe mutation'],
        summary: 'reject unsafe mutation',
        status: 'rejected',
        reason: 'review_rejected',
      }
    );
  });

  it('is idempotent for the same input and deterministic runner output', function () {
    const prompts = [];
    const execute = ({ prompt }) => {
      prompts.push(prompt);
      return JSON.stringify({ approved: true, confidence: 0.8, concerns: [], summary: 'stable review' });
    };

    const first = runLlmReview(input, { execute, maxAttempts: 1 });
    const second = runLlmReview(input, { execute, maxAttempts: 1 });

    assert.deepEqual(second, first);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1], prompts[0]);
  });

  it('records a real subprocess trace and removes its temporary directory', function () {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-')));
    const result = runLlmReview(input, { maxAttempts: 1, timeoutMs: 5000 });
    const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-'));

    assert.equal(result.approved, true);
    assert.deepEqual(result.trace, [{ attempt: 1, status: 'approved', reason: 'review_approved' }]);
    assert.deepEqual(after.filter(name => !before.has(name)), []);
  });

  it('does not leak a temp directory when prompt write fails', function () {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-')));
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function (file) {
      if (String(file).includes('evolver-review-') && String(file).endsWith('prompt.txt')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return originalWrite.apply(this, arguments);
    };
    try {
      const result = runLlmReview(input, { maxAttempts: 1, timeoutMs: 5000 });
      assertUnavailable(result, 'runner_error', 1);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-'));
    assert.deepEqual(after.filter(name => !before.has(name)), []);
  });

  it('returns null when review is disabled', function () {
    process.env.EVOLVER_LLM_REVIEW = 'false';
    assert.equal(runLlmReview(input, { execute: () => { throw new Error('must not run'); } }), null);
  });
});

describe('parseReviewResponse', function () {
  it('rejects out-of-range confidence', function () {
    const invalid = parseReviewResponse(JSON.stringify({ approved: true, confidence: 2, concerns: [], summary: 'bad' }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, 'partial_response');
  });
});

function baseInput(extra) {
  return Object.assign({
    diff: 'diff --git a/x b/x\n+ok',
    gene: { id: 'gene_test', category: 'repair' },
    signals: ['signal_a'],
    mutation: { category: 'repair', rationale: 'fix flaky path' },
  }, extra || {});
}

describe('llmReview typed contract', function () {
  it('returns null when disabled', function () {
    process.env.EVOLVER_LLM_REVIEW = 'false';
    assert.equal(llmReview.runLlmReview(baseInput()), null);
  });

  it('returns unavailable without a provider', function () {
    const r = llmReview.runLlmReview(baseInput());
    assert.equal(r.status, 'unavailable');
    assert.equal(r.approved, false);
    assert.equal(r.decision.reason, 'review_provider_not_configured');
    assert.equal(r.recovery.action, 'configure_review_provider_and_retry');
    assert.equal(r.evidence.contract_version, llmReview.REVIEW_CONTRACT_VERSION);
    assert.ok(r.evidence.prompt_sha256);
  });

  it('classifies malformed JSON as inconclusive and never approves', function () {
    const r = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => '{not-json',
    }));
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.approved, false);
    assert.equal(r.decision.reason, 'malformed_review_json');
    assert.equal(r.recovery.action, 'provide_complete_review_evidence_and_retry');
  });

  it('classifies empty response as inconclusive', function () {
    const r = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => '   ',
    }));
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.approved, false);
    assert.equal(r.decision.reason, 'empty_review_response');
  });

  it('classifies provider throw as failed', function () {
    const r = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => { throw new Error('provider boom'); },
    }));
    assert.equal(r.status, 'failed');
    assert.equal(r.approved, false);
    assert.equal(r.decision.reason, 'review_provider_error');
    assert.equal(r.recovery.action, 'restore_review_provider_and_retry');
  });

  it('classifies timeout throw and timeout envelope as failed', function () {
    const thrown = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => {
        const err = new Error('request timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      },
    }));
    assert.equal(thrown.status, 'failed');
    assert.equal(thrown.decision.reason, 'review_provider_timeout');

    const envelope = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => ({ ok: false, timedOut: true, error: 'timeout' }),
    }));
    assert.equal(envelope.status, 'failed');
    assert.equal(envelope.decision.reason, 'review_provider_timeout');
  });

  it('rejects async invokers as failed', function () {
    const r = llmReview.runLlmReview(baseInput({
      reviewInvoker: async () => ({ approved: true, confidence: 1, concerns: [], summary: 'late' }),
    }));
    assert.equal(r.status, 'failed');
    assert.equal(r.decision.reason, 'async_review_invoker_unsupported');
    assert.equal(r.approved, false);
  });

  it('approves only strict boolean approved + empty concerns + finite confidence + summary', function () {
    const r = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => ({
        ok: true,
        response: {
          approved: true,
          confidence: 0.91,
          concerns: [],
          summary: 'Looks safe',
        },
        provider: 'fixture',
        model: 'fixture-model',
        request_id: 'req-1',
      }),
      provider: 'caller-provider',
      model: 'caller-model',
    }));
    assert.equal(r.status, 'approved');
    assert.equal(r.approved, true);
    assert.equal(r.confidence, 0.91);
    assert.equal(r.decision.reason, 'explicit_approval_policy_satisfied');
    assert.equal(r.recovery, null);
    assert.equal(r.provenance.provider, 'fixture');
    assert.equal(r.provenance.model, 'fixture-model');
    assert.equal(r.provenance.request_id, 'req-1');
    assert.ok(llmReview.isApprovedReview(r));
  });

  it('rejects non-empty concerns even when approved=true', function () {
    const r = llmReview.runLlmReview(baseInput({
      invoke: () => ({
        approved: true,
        confidence: 0.8,
        concerns: ['blast radius too large'],
        summary: 'risky',
      }),
    }));
    assert.equal(r.status, 'rejected');
    assert.equal(r.approved, false);
    assert.equal(r.decision.reason, 'review_concerns_present');
    assert.equal(r.recovery.action, 'address_review_concerns_and_retry');
    assert.equal(llmReview.isApprovedReview(r), false);
  });

  it('rejects explicit approved=false as rejected', function () {
    const r = llmReview.runLlmReview(baseInput({
      reviewInvoker: () => ({
        approved: false,
        confidence: 0.4,
        concerns: [],
        summary: 'nope',
      }),
    }));
    assert.equal(r.status, 'rejected');
    assert.equal(r.approved, false);
    assert.equal(r.decision.reason, 'review_explicitly_rejected');
  });

  it('does not approve truthy non-boolean approved or string confidence', function () {
    const truthy = llmReview.normalizeReviewResult({
      approved: 1,
      confidence: 0.9,
      concerns: [],
      summary: 'truthy',
    });
    assert.equal(truthy.status, 'inconclusive');
    assert.equal(truthy.approved, false);
    assert.match(truthy.decision.reason, /invalid_review_fields:approved/);

    const stringConf = llmReview.normalizeReviewResult({
      approved: true,
      confidence: '0.9',
      concerns: [],
      summary: 'string conf',
    });
    assert.equal(stringConf.status, 'inconclusive');
    assert.equal(stringConf.approved, false);
    assert.match(stringConf.decision.reason, /invalid_review_fields:confidence/);
  });

  it('maps legacy parse/execution fallbacks to inconclusive/failed', function () {
    const parse = llmReview.normalizeReviewResult({
      approved: true,
      confidence: 0.5,
      concerns: ['failed to parse review response'],
      summary: 'review parse error',
    });
    assert.equal(parse.status, 'inconclusive');
    assert.equal(parse.approved, false);
    assert.equal(parse.decision.reason, 'legacy_review_parse_error');

    const exec = llmReview.normalizeReviewResult({
      approved: true,
      confidence: 0.5,
      concerns: ['review execution failed'],
      summary: 'review timeout or error',
    });
    assert.equal(exec.status, 'failed');
    assert.equal(exec.approved, false);
    assert.equal(exec.decision.reason, 'legacy_review_execution_error');
  });

  it('keeps local evidence/provenance over provider-supplied audit fields', function () {
    const r = llmReview.normalizeReviewResult({
      status: 'unavailable',
      reason: 'provider_said_unavailable',
      concerns: ['x'],
      summary: 'provider summary',
      evidence: {
        prompt_sha256: 'forged',
        contract_version: '0.0.0',
      },
      provenance: {
        invocation: 'forged',
        provider: 'forged-provider',
      },
    }, {
      prompt: 'hello',
      provenance: {
        invocation: 'local',
        provider: 'local-provider',
      },
    });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.approved, false);
    assert.equal(r.evidence.prompt_sha256, crypto.createHash('sha256').update('hello', 'utf8').digest('hex'));
    assert.notEqual(r.evidence.prompt_sha256, 'forged');
    assert.equal(r.evidence.contract_version, llmReview.REVIEW_CONTRACT_VERSION);
    assert.equal(r.provenance.invocation, 'local');
    assert.equal(r.provenance.provider, 'local-provider');
  });
});
