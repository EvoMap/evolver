'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTask, validateTask, VALID_TASK_STATUSES } = require('../src/gep/schemas/task');

describe('createTask', () => {
  it('returns a fully-formed Task with all defaults when called with empty object', () => {
    const t = createTask({});
    assert.equal(t.type, 'Task');
    assert.equal(t.task_id, null);
    assert.equal(t.title, '');
    assert.equal(t.signals, '');
    assert.equal(t.status, 'open');
    assert.equal(t.claimed_by, null);
    assert.equal(t.bounty_id, null);
    assert.equal(t.bounty_amount, 0);
    assert.equal(t.complexity_score, null);
    assert.equal(t.historical_completion_rate, null);
    assert.equal(t.expires_at, null);
    assert.equal(t.body, '');
    assert.equal(t.description, '');
    assert.equal(t.nonce, null);
    assert.deepEqual(t.validation_commands, []);
    assert.equal(t.result_asset_id, null);
    assert.equal(t.atp_order_id, null);
    assert.equal(t._commitment_deadline, null);
    assert.equal(t._worker_pending, false);
  });

  it('preserves provided fields', () => {
    const t = createTask({
      task_id: 'task_abc',
      title: 'Fix the bug',
      signals: 'error,crash',
      status: 'claimed',
      bounty_amount: 50,
    });
    assert.equal(t.task_id, 'task_abc');
    assert.equal(t.title, 'Fix the bug');
    assert.equal(t.signals, 'error,crash');
    assert.equal(t.status, 'claimed');
    assert.equal(t.bounty_amount, 50);
  });

  it('is idempotent — createTask(createTask(x)) equals createTask(x)', () => {
    const input = { task_id: 't1', title: 'Do it', status: 'open', bounty_amount: 10 };
    const once = createTask(input);
    const twice = createTask(once);
    assert.deepEqual(once, twice);
  });

  it('normalizes invalid status to "open"', () => {
    const t = createTask({ status: 'unknown_status' });
    assert.equal(t.status, 'open');
  });

  it('normalizes null status to "open"', () => {
    const t = createTask({ status: null });
    assert.equal(t.status, 'open');
  });

  it('normalizes non-string title to empty string', () => {
    const t = createTask({ title: 42 });
    assert.equal(t.title, '');
  });

  it('normalizes non-string signals to empty string', () => {
    const t = createTask({ signals: ['a', 'b'] });
    assert.equal(t.signals, '');
  });

  it('normalizes non-number bounty_amount to 0', () => {
    const t = createTask({ bounty_amount: 'fifty' });
    assert.equal(t.bounty_amount, 0);
  });

  it('normalizes NaN bounty_amount to 0', () => {
    const t = createTask({ bounty_amount: NaN });
    assert.equal(t.bounty_amount, 0);
  });

  it('normalizes non-array validation_commands to []', () => {
    const t = createTask({ validation_commands: 'npm test' });
    assert.deepEqual(t.validation_commands, []);
  });

  it('accepts all valid statuses', () => {
    for (const status of VALID_TASK_STATUSES) {
      const t = createTask({ status });
      assert.equal(t.status, status);
    }
  });

  it('returns independent validation_commands array — mutation does not contaminate other tasks', () => {
    const t1 = createTask({ task_id: 't1' });
    const t2 = createTask({ task_id: 't2' });
    t1.validation_commands.push('npm test');
    assert.deepEqual(t2.validation_commands, [], 'validation_commands should be independent');
  });

  it('returns independent array even when partial provides validation_commands', () => {
    const shared = ['npm test'];
    const t1 = createTask({ validation_commands: shared });
    const t2 = createTask({ validation_commands: shared });
    t1.validation_commands.push('npm run lint');
    assert.equal(t2.validation_commands.length, 1, 'arrays should not share references');
    assert.equal(shared.length, 1, 'original array should not be mutated');
  });

  it('passes through extra fields not in defaults (e.g. domain, nonce)', () => {
    const t = createTask({ task_id: 't1', nonce: 'abc123', domain: 'web' });
    assert.equal(t.nonce, 'abc123');
    assert.equal(t.domain, 'web');
  });
});

describe('validateTask', () => {
  function validTask(overrides) {
    return createTask({ task_id: 'task-valid', status: 'open', ...overrides });
  }

  it('passes for a valid Task', () => {
    assert.doesNotThrow(() => validateTask(validTask()));
  });

  it('throws when task is null', () => {
    assert.throws(() => validateTask(null), /must be an object/);
  });

  it('throws when task_id is missing', () => {
    assert.throws(() => validateTask(validTask({ task_id: null })), /task_id is required/);
  });

  it('throws when task_id is empty string', () => {
    assert.throws(() => validateTask(validTask({ task_id: '' })), /task_id is required/);
  });

  it('throws when status is invalid', () => {
    assert.throws(
      () => validateTask({ task_id: 'tid', status: 'pending' }),
      /status must be one of/,
    );
  });

  it('returns true on success', () => {
    assert.equal(validateTask(validTask()), true);
  });
});
