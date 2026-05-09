'use strict';

// ---------------------------------------------------------------------------
// Task Schema — single source of truth for the Task object shape.
// Tasks are received from the Hub (not created locally), so createTask()
// primarily normalizes fields for safe access. validateTask() guards the
// pipeline entry points before any processing begins.
// ---------------------------------------------------------------------------

const VALID_TASK_STATUSES = ['open', 'claimed', 'completed', 'expired', 'cancelled'];

const TASK_DEFAULTS = {
  type: 'Task',
  task_id: null,
  title: '',
  signals: '',
  status: 'open',
  claimed_by: null,
  bounty_id: null,
  bounty_amount: 0,
  complexity_score: null,
  historical_completion_rate: null,
  expires_at: null,
  body: '',
  description: '',
  nonce: null,
  validation_commands: [],
  result_asset_id: null,
  atp_order_id: null,
  _commitment_deadline: null,
  _worker_pending: false,
};

// createTask: normalize a Hub-received task object against known defaults.
// Safe to call with a fully-formed Task (idempotent).
function createTask(partial) {
  const t = Object.assign({}, TASK_DEFAULTS, partial);

  // Normalize validation_commands — the only array field
  t.validation_commands = Array.isArray(t.validation_commands)
    ? t.validation_commands.slice()
    : [];

  // Normalize string fields
  if (typeof t.title !== 'string')       t.title = '';
  if (typeof t.signals !== 'string')     t.signals = '';
  if (typeof t.body !== 'string')        t.body = '';
  if (typeof t.description !== 'string') t.description = '';

  // Normalize numeric fields
  if (typeof t.bounty_amount !== 'number' || !isFinite(t.bounty_amount)) {
    t.bounty_amount = 0;
  }

  // Normalize status
  if (!VALID_TASK_STATUSES.includes(t.status)) {
    t.status = 'open';
  }

  return t;
}

// validateTask: throw if required fields are missing or malformed.
// Use at pipeline entry points before processing or claiming a task.
function validateTask(t) {
  if (!t || typeof t !== 'object')           throw new Error('Task must be an object');
  if (!t.task_id || typeof t.task_id !== 'string')
                                             throw new Error('Task.task_id is required and must be a string');
  if (!VALID_TASK_STATUSES.includes(t.status))
                                             throw new Error('Task.status must be one of: ' + VALID_TASK_STATUSES.join(', ') + ', got: ' + t.status);
  return true;
}

module.exports = { createTask, validateTask, TASK_DEFAULTS, VALID_TASK_STATUSES };
