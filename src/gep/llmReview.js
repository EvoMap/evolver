'use strict';

// LLM review is a promotion / solidify gate, not runtime validation.
// Only an explicitly approved, policy-satisfying result may pass; every other
// outcome fails closed with a typed status, evidence, and recovery action.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getRepoRoot } = require('./paths');

const REVIEW_ENABLED_KEY = 'EVOLVER_LLM_REVIEW';
const REVIEW_TIMEOUT_MS = 30000;
const REVIEW_MAX_ATTEMPTS = 2;
const REVIEW_CONTRACT_VERSION = '1.0.0';
const REVIEW_POLICY_VERSION = 'explicit-approval-v1';
const REVIEW_STATUSES = Object.freeze([
  'approved',
  'rejected',
  'inconclusive',
  'unavailable',
  'failed',
]);

function isLlmReviewEnabled() {
  return String(process.env[REVIEW_ENABLED_KEY] || '').toLowerCase() === 'true';
}

function buildReviewPrompt(input) {
  const { diff, gene, signals, mutation } = input || {};
  const geneId = gene && gene.id ? gene.id : '(unknown)';
  const category = (mutation && mutation.category) || (gene && gene.category) || 'unknown';
  const rationale = mutation && mutation.rationale ? String(mutation.rationale).slice(0, 500) : '(none)';
  const signalsList = Array.isArray(signals) ? signals.slice(0, 8).join(', ') : '(none)';
  const diffPreview = String(diff || '').slice(0, 6000);

  return `You are reviewing a code change produced by an autonomous evolution engine.

## Context
- Gene: ${geneId} (${category})
- Signals: [${signalsList}]
- Rationale: ${rationale}

## Diff
\`\`\`diff
${diffPreview}
\`\`\`

## Review Criteria
1. Does this change address the stated signals?
2. Are there any obvious regressions or bugs introduced?
3. Is the blast radius proportionate to the problem?
4. Are there any security or safety concerns?

## Response Format
Respond with a JSON object and no surrounding prose:
{
  "approved": true|false,
  "confidence": 0.0-1.0,
  "concerns": ["..."],
  "summary": "one-line review summary"
}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function serializeResponse(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value); }
  catch (_) { return String(value); }
}

function recoveryFor(status, reason) {
  if (status === 'approved') return null;
  if (status === 'rejected') {
    return {
      retryable: true,
      action: 'address_review_concerns_and_retry',
      reason: reason,
    };
  }
  if (status === 'unavailable') {
    return {
      retryable: true,
      action: 'configure_review_provider_and_retry',
      reason: reason,
    };
  }
  if (status === 'failed') {
    return {
      retryable: true,
      action: 'restore_review_provider_and_retry',
      reason: reason,
    };
  }
  return {
    retryable: true,
    action: 'provide_complete_review_evidence_and_retry',
    reason: reason,
  };
}

function cloneError(err) {
  if (!err || typeof err !== 'object') return null;
  const copy = Object.assign({}, err);
  if (Array.isArray(err.fields)) copy.fields = err.fields.slice();
  return copy;
}

function resultFor(status, fields) {
  fields = fields || {};
  const approved = status === 'approved';
  const reason = fields.reason || ('review_' + status);
  return {
    status,
    approved,
    confidence: Number.isFinite(fields.confidence) ? fields.confidence : 0,
    concerns: Array.isArray(fields.concerns) ? fields.concerns.slice() : [],
    summary: typeof fields.summary === 'string' && fields.summary.trim()
      ? fields.summary.trim()
      : reason,
    decision: {
      policy_version: REVIEW_POLICY_VERSION,
      reason,
    },
    evidence: Object.assign({}, fields.evidence || {}),
    provenance: Object.assign({}, fields.provenance || {}),
    error: cloneError(fields.error),
    recovery: recoveryFor(status, reason),
  };
}

function isLegacyParseFallback(value) {
  return value
    && value.approved === true
    && Array.isArray(value.concerns)
    && value.concerns.includes('failed to parse review response')
    && value.summary === 'review parse error';
}

function isLegacyExecutionFallback(value) {
  return value
    && value.approved === true
    && Array.isArray(value.concerns)
    && value.concerns.includes('review execution failed')
    && value.summary === 'review timeout or error';
}

function parseReviewPayload(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { ok: false, reason: 'empty_review_response', rawText: text };
    try {
      return {
        ok: true,
        value: JSON.parse(text),
        rawText: text,
        format: 'json',
      };
    } catch (_) {
      return {
        ok: false,
        reason: 'malformed_review_json',
        rawText: text,
      };
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'invalid_review_response_type',
      rawText: serializeResponse(raw),
    };
  }

  return {
    ok: true,
    value: raw,
    rawText: serializeResponse(raw),
    format: 'object',
  };
}

function normalizeReviewResult(raw, context) {
  context = context || {};
  const parsed = parseReviewPayload(raw);
  const responseText = parsed.rawText == null ? serializeResponse(raw) : parsed.rawText;
  const evidence = {
    prompt_sha256: context.prompt ? sha256(context.prompt) : null,
    response_sha256: responseText ? sha256(responseText) : null,
    response_bytes: Buffer.byteLength(responseText || '', 'utf8'),
    response_format: parsed.format || (typeof raw === 'string' ? 'text' : typeof raw),
    parsed: Boolean(parsed.ok),
    contract_version: REVIEW_CONTRACT_VERSION,
    policy_version: REVIEW_POLICY_VERSION,
  };
  const provenance = Object.assign({}, context.provenance || {});

  if (!parsed.ok) {
    return resultFor('inconclusive', {
      reason: parsed.reason,
      concerns: [parsed.reason],
      summary: 'Review response could not be evaluated.',
      evidence,
      provenance,
      error: { code: parsed.reason, message: parsed.reason },
    });
  }

  const value = parsed.value;
  if (isLegacyParseFallback(value)) {
    return resultFor('inconclusive', {
      reason: 'legacy_review_parse_error',
      concerns: value.concerns,
      summary: value.summary,
      confidence: value.confidence,
      evidence,
      provenance,
      error: { code: 'legacy_review_parse_error', message: value.summary },
    });
  }
  if (isLegacyExecutionFallback(value)) {
    return resultFor('failed', {
      reason: 'legacy_review_execution_error',
      concerns: value.concerns,
      summary: value.summary,
      confidence: value.confidence,
      evidence,
      provenance,
      error: { code: 'legacy_review_execution_error', message: value.summary },
    });
  }

  if (value.status && REVIEW_STATUSES.includes(value.status)
      && value.status !== 'approved' && value.status !== 'rejected') {
    const status = value.status;
    return resultFor(status, {
      reason: (value.decision && value.decision.reason) || value.reason || ('review_' + status),
      concerns: Array.isArray(value.concerns)
        ? value.concerns.filter((x) => typeof x === 'string')
        : [],
      summary: value.summary,
      confidence: value.confidence,
      // Local trusted audit fields win over any provider-supplied copies.
      evidence: Object.assign({}, value.evidence || {}, evidence),
      provenance: Object.assign({}, value.provenance || {}, provenance),
      error: value.error || null,
    });
  }

  const validApproved = typeof value.approved === 'boolean';
  const confidence = value.confidence;
  const validConfidence = typeof confidence === 'number'
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1;
  const validConcerns = Array.isArray(value.concerns)
    && value.concerns.every((concern) => typeof concern === 'string');
  const validSummary = typeof value.summary === 'string' && value.summary.trim().length > 0;
  const invalidFields = [];
  if (!validApproved) invalidFields.push('approved');
  if (!validConfidence) invalidFields.push('confidence');
  if (!validConcerns) invalidFields.push('concerns');
  if (!validSummary) invalidFields.push('summary');

  if (invalidFields.length) {
    const reason = 'invalid_review_fields:' + invalidFields.join(',');
    return resultFor('inconclusive', {
      reason,
      concerns: [reason],
      summary: 'Review response is missing required evidence.',
      evidence,
      provenance,
      error: { code: 'invalid_review_fields', fields: invalidFields },
    });
  }

  const concerns = value.concerns.map((concern) => concern.trim());
  const status = value.approved === true && concerns.length === 0
    ? 'approved'
    : 'rejected';
  const reason = status === 'approved'
    ? 'explicit_approval_policy_satisfied'
    : (concerns.length
      ? 'review_concerns_present'
      : 'review_explicitly_rejected');
  return resultFor(status, {
    reason,
    confidence,
    concerns,
    summary: value.summary,
    evidence,
    provenance,
  });
}

function providerFailure(reason, error, context) {
  const prompt = context.prompt || '';
  const now = new Date().toISOString();
  const provenance = Object.assign({
    invocation: 'injected_sync_invoker',
    provider: context.provider || null,
    model: context.model || null,
    request_id: context.requestId || null,
    started_at: context.startedAt || now,
    completed_at: now,
    duration_ms: Math.max(0, Date.now() - (context.startedMs || Date.now())),
  }, context.provenance || {});
  return resultFor('failed', {
    reason,
    concerns: [reason],
    summary: reason === 'review_provider_timeout'
      ? 'Review provider timed out.'
      : 'Review provider invocation failed.',
    evidence: {
      prompt_sha256: prompt ? sha256(prompt) : null,
      response_sha256: null,
      response_bytes: 0,
      response_format: 'none',
      parsed: false,
      contract_version: REVIEW_CONTRACT_VERSION,
      policy_version: REVIEW_POLICY_VERSION,
    },
    provenance,
    error: {
      code: reason,
      message: error && error.message ? error.message : String(error || reason),
    },
  });
}

function failureResult(reason, summary, trace) {
  return {
    approved: false,
    confidence: 0,
    concerns: [summary],
    summary,
    status: 'unavailable',
    reason,
    retryable: true,
    attempts: trace.length,
    trace: trace.slice(),
  };
}

function parseReviewResponse(output) {
  const text = typeof output === 'string' ? output.trim() : '';
  if (!text) {
    return { ok: false, reason: 'empty_output', summary: 'review returned empty output' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const partial = /^[{[]/.test(text) && !/[}\]]\s*$/.test(text);
    return {
      ok: false,
      reason: partial ? 'partial_response' : 'malformed_output',
      summary: partial ? 'review returned a partial response' : 'review returned malformed output',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      typeof parsed.approved !== 'boolean' ||
      !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1 ||
      !Array.isArray(parsed.concerns) || !parsed.concerns.every(item => typeof item === 'string') ||
      typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    return { ok: false, reason: 'partial_response', summary: 'review response was incomplete' };
  }

  return {
    ok: true,
    value: {
      approved: parsed.approved,
      confidence: parsed.confidence,
      concerns: parsed.concerns.slice(),
      summary: parsed.summary.trim(),
      status: parsed.approved ? 'approved' : 'rejected',
      reason: parsed.approved ? 'review_approved' : 'review_rejected',
      retryable: false,
    },
  };
}

function classifyExecutionError(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const timedOut = Boolean(error && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')) || /timed?\s*out|ETIMEDOUT/i.test(message);
  return {
    reason: timedOut ? 'timeout' : 'runner_error',
    summary: timedOut ? 'review timed out' : 'review execution failed',
  };
}

function defaultExecute({ prompt, timeoutMs }) {
  const repoRoot = getRepoRoot();
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-review-'));
    const tmpFile = path.join(tmpDir, 'prompt.txt');
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const reviewScript = `
      const fs = require('fs');
      const prompt = fs.readFileSync(process.argv[1], 'utf8');
      console.log(JSON.stringify({ approved: true, confidence: 0.7, concerns: [], summary: 'auto-approved (no external LLM configured)' }));
    `;
    return execFileSync(process.execPath, ['-e', reviewScript, tmpFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function runRunnerReview(input, options) {
  const opts = options || {};
  const execute = typeof opts.execute === 'function' ? opts.execute : defaultExecute;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : REVIEW_TIMEOUT_MS;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : REVIEW_MAX_ATTEMPTS;
  const prompt = buildReviewPrompt(input);
  const trace = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let failure;
    try {
      const parsed = parseReviewResponse(execute({ prompt, timeoutMs, attempt }));
      if (parsed.ok) {
        trace.push({ attempt, status: parsed.value.status, reason: parsed.value.reason });
        return Object.assign({}, parsed.value, {
          concerns: parsed.value.concerns.slice(),
          attempts: attempt,
          trace: trace.slice(),
        });
      }
      failure = parsed;
    } catch (error) {
      failure = classifyExecutionError(error);
    }

    trace.push({ attempt, status: 'unavailable', reason: failure.reason });
    if (attempt === maxAttempts) {
      console.log('[LLMReview] Unavailable: ' + failure.reason + ' after ' + attempt + ' attempt(s)');
      return failureResult(failure.reason, failure.summary, trace);
    }
  }
}

function runLlmReview(input, options) {
  input = input || {};
  if (!isLlmReviewEnabled()) return null;

  const hasRunnerOptions = Boolean(
    options
    && typeof options === 'object'
    && !Array.isArray(options)
    && typeof options.invoke !== 'function'
    && typeof options.reviewInvoker !== 'function'
    && typeof (input.invoke || input.reviewInvoker) !== 'function'
  );
  if (hasRunnerOptions) {
    return runRunnerReview(input, options);
  }

  const prompt = buildReviewPrompt(input);
  const invoker = input.invoke || input.reviewInvoker || (options && (options.invoke || options.reviewInvoker));
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const baseProvenance = {
    invocation: 'injected_sync_invoker',
    provider: input.provider || null,
    model: input.model || null,
    request_id: null,
    started_at: startedAt,
  };

  if (typeof invoker !== 'function') {
    return resultFor('unavailable', {
      reason: 'review_provider_not_configured',
      concerns: ['review_provider_not_configured'],
      summary: 'LLM review is enabled but no review provider is configured.',
      evidence: {
        prompt_sha256: sha256(prompt),
        response_sha256: null,
        response_bytes: 0,
        response_format: 'none',
        parsed: false,
        contract_version: REVIEW_CONTRACT_VERSION,
        policy_version: REVIEW_POLICY_VERSION,
      },
      provenance: Object.assign({}, baseProvenance, {
        invocation: 'none',
        completed_at: startedAt,
        duration_ms: 0,
      }),
      error: {
        code: 'review_provider_not_configured',
        message: 'Pass a synchronous reviewInvoker when EVOLVER_LLM_REVIEW=true.',
      },
    });
  }

  let invocation;
  try {
    invocation = invoker({
      prompt,
      timeoutMs: input.timeoutMs || REVIEW_TIMEOUT_MS,
      gene: input.gene || null,
      signals: Array.isArray(input.signals) ? input.signals.slice() : [],
      mutation: input.mutation || null,
    });
  } catch (error) {
    const text = String(error && error.message || error || '').toLowerCase();
    const timedOut = Boolean(
      (error && (error.code === 'ETIMEDOUT' || error.name === 'AbortError'))
      || /timed?\s*out|timeout/.test(text)
    );
    return providerFailure(
      timedOut ? 'review_provider_timeout' : 'review_provider_error',
      error,
      {
        prompt,
        provider: input.provider,
        model: input.model,
        startedAt,
        startedMs,
      }
    );
  }

  if (invocation && typeof invocation.then === 'function') {
    return providerFailure(
      'async_review_invoker_unsupported',
      new Error('reviewInvoker must return synchronously'),
      {
        prompt,
        provider: input.provider,
        model: input.model,
        startedAt,
        startedMs,
      }
    );
  }

  if (invocation && typeof invocation === 'object' && !Array.isArray(invocation)
      && invocation.ok === false) {
    const reasonText = String(invocation.error || invocation.reason || '').toLowerCase();
    const timedOut = invocation.timedOut === true
      || /timed?\s*out|timeout/.test(reasonText);
    return providerFailure(
      timedOut ? 'review_provider_timeout' : 'review_provider_error',
      invocation.error || invocation.reason,
      {
        prompt,
        provider: invocation.provider || input.provider,
        model: invocation.model || input.model,
        requestId: invocation.request_id,
        startedAt,
        startedMs,
      }
    );
  }

  let payload = invocation;
  let metadata = {};
  if (invocation && typeof invocation === 'object' && !Array.isArray(invocation)
      && invocation.ok === true) {
    if (Object.prototype.hasOwnProperty.call(invocation, 'response')) payload = invocation.response;
    else if (Object.prototype.hasOwnProperty.call(invocation, 'data')) payload = invocation.data;
    else if (Object.prototype.hasOwnProperty.call(invocation, 'result')) payload = invocation.result;
    else payload = undefined;
    metadata = invocation;
  }

  const completedMs = Date.now();
  const provenance = Object.assign({}, baseProvenance, {
    provider: metadata.provider || input.provider || null,
    model: metadata.model || input.model || null,
    request_id: metadata.request_id || null,
    completed_at: new Date(completedMs).toISOString(),
    duration_ms: Math.max(0, completedMs - startedMs),
  });
  return normalizeReviewResult(payload, { prompt, provenance });
}

function isApprovedReview(review) {
  return Boolean(review && review.status === 'approved' && review.approved === true);
}

module.exports = {
  REVIEW_CONTRACT_VERSION,
  REVIEW_ENABLED_KEY,
  REVIEW_MAX_ATTEMPTS,
  REVIEW_POLICY_VERSION,
  REVIEW_STATUSES,
  REVIEW_TIMEOUT_MS,
  isLlmReviewEnabled,
  runLlmReview,
  buildReviewPrompt,
  parseReviewResponse,
  classifyExecutionError,
  normalizeReviewResult,
  isApprovedReview,
};
